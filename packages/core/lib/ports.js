/**
 * The ports a real run needs, built from configuration instead of from a test's fakes.
 *
 * The kernel takes five injected ports (`clock`, `platform`, `harness`, `judge`, `baseline`). A test
 * hands over fakes; a host or the `run` CLI hands over the real thing, and *which* real thing is a
 * configuration question — that is the whole "executor is swappable" claim (user stories 30/31).
 *
 * Three decisions worth naming:
 *
 *   - **The candidate worktree is created here, by the runner role.** `packages/exec` refuses to
 *     create git state (its git access is allow-listed to `rev-parse`/`diff`/`ls-files`), because a
 *     harness that can move refs is a harness that can lie about the diff. The outer runner owns
 *     worktrees and `refs/*`; when the host plugin is the whole process, `worktrees.js` is that
 *     runner. Keeping the two apart is what makes the identity chain checkable.
 *   - **No port invents judgement.** With no `model.command` there is no judge at all rather than a
 *     stand-in that answers "probably fine" — the configuration layer refuses that combination
 *     before a tick happens (see `config.js`).
 *   - **`baseline` is a file the run writes once.** BASELINE freezes evidence the run already
 *     produced; reading it from `<workspace>/baseline.json` keeps it a fact (git-able, diff-able)
 *     instead of a number remembered in config.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { safeSlug } from '@dsh-reprise/exec'
import { landWithCli } from '@dsh-reprise/exec/harness'
import { createClaudeHarness } from '@dsh-reprise/exec/harness/claude'
import { createDshHarness } from '@dsh-reprise/exec/harness/dsh'
import { createModelPort, modelCallName } from '@dsh-reprise/exec/model'
import { createLocalPlatform } from '@dsh-reprise/exec/platform/local'
import { createRayPlatform } from '@dsh-reprise/exec/platform/ray'

import { fileArtifacts } from './artifacts.js'
import { metricFromContract } from './domain.js'
import { createJudge } from './judge.js'
import { readRoundsState } from './rounds.js'

/** Where the run keeps the evidence it froze: one directory, copyable as a unit. */
export const BASELINE_FILENAME = 'baseline.json'

const isText = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Make the file arguments of a configured argv absolute, relative to where the run was started.
 *
 * Why this is needed at all: the candidate implementer is spawned with `cwd` set to the candidate's
 * worktree (that is the whole point of the port), so a *relative* script path in its argv resolves
 * against the wrong tree — a worktree holds the candidate's repository, not the checkout the run was
 * started from. Only elements that name a file which actually exists under the launch directory are
 * rewritten, so a bare binary (`node`), a flag and a worktree-relative data path are all left alone.
 * `{launch_dir}`, `{candidate}` and `{worktree}` are also substituted for configurations that would
 * rather be explicit.
 */
function absoluteise(argv, launchDir, variables = {}) {
  const substitute = (value) =>
    value
      .replaceAll('{launch_dir}', launchDir)
      .replaceAll('{candidate}', variables.candidate ?? '{candidate}')
      .replaceAll('{worktree}', variables.worktree ?? '{worktree}')

  return argv.map((value, index) => {
    const replaced = substitute(value)
    if (index === 0 || replaced.startsWith('-') || replaced.includes('{')) return replaced
    if (isAbsolute(replaced)) return replaced
    const candidate = resolve(launchDir, replaced)
    return existsSync(candidate) ? candidate : replaced
  })
}

/**
 * The runner role: candidate worktrees, branched from one base ref, owned by one module.
 *
 * `--detach` on purpose. The runner is not a branch manager, and a candidate that leaves a branch
 * behind makes the next run's `git worktree list` a history lesson. The commit each candidate
 * branched from is frozen into `parent_binding` at LAND, so identity survives the detach.
 *
 * @param {{repo: string, dir: string, base_ref?: string}} options `repo`/`dir` are relative to the
 *   workspace unless absolute
 * @param {{workspaceDir: string, log?: Function, git?: Function}} context
 */
export function createWorktreeRunner({ repo, dir, base_ref: baseRef = 'HEAD' }, { workspaceDir, log = () => {}, git }) {
  if (!isText(repo)) throw new TypeError('the runner needs runner.repo — the repository candidates are branched from')
  if (!isText(dir)) throw new TypeError('the runner needs runner.dir — where candidate worktrees are created')

  const repoDir = resolve(workspaceDir, repo)
  const worktreesDir = resolve(workspaceDir, dir)
  const gitRun = git ?? ((args, options) => spawnSync('git', args, { encoding: 'utf8', ...options }))
  const created = new Map()

  return {
    repoDir,
    worktreesDir,
    baseRef,

    /** Deterministic, because a worktree path is part of what a dump has to be able to explain. */
    pathFor(candidateId) {
      return join(worktreesDir, safeSlug(candidateId))
    },

    /**
     * The candidate's worktree, created on first request.
     *
     * Creating it lazily — at LAND, not when the plan is accepted — means a candidate that is planned
     * but never lands costs no disk. Failure is loud: a run whose runner cannot branch has nothing
     * meaningful to do next, and a candidate rejected for it would hide the real problem.
     */
    worktreeFor(candidateId) {
      if (!isText(candidateId)) throw new TypeError('worktreeFor needs a candidate id')
      const path = created.get(candidateId) ?? this.pathFor(candidateId)
      if (created.has(candidateId) && existsSync(path)) return path

      mkdirSync(worktreesDir, { recursive: true })
      if (!existsSync(path)) {
        const result = gitRun(['worktree', 'add', '--detach', path, baseRef], { cwd: repoDir })
        if (result?.error || result?.status !== 0) {
          throw new Error(
            `the runner could not create a worktree for ${candidateId} from ${baseRef} in ${repoDir}: ` +
              `${(result?.stderr ?? result?.error?.message ?? '').toString().trim() || 'git said nothing'}`,
          )
        }
        log(`runner: created worktree ${path} from ${baseRef}`)
      }
      created.set(candidateId, path)
      return path
    },
  }
}

/**
 * The model port: one process per judgement, one structured question in, one structured answer out.
 *
 * The adapter itself lives in `@dsh-reprise/exec/model` (it is a CLI's wire format, not a kernel
 * concern). This function is the wiring decision: where the call's record is filed, and which argv
 * reaches which engine.
 *
 * **The record lands in the artifact store**, under `model_call/<call site>/<subject>[/<ref>].json`.
 * That is the audit trail ticket 29 renders: the prompt a model was given, the words it returned,
 * and the object those words became. It is an artifact rather than a table row because a reader with
 * the workspace directory and no database can open it, and because the record is content-addressed —
 * asking the same question twice rewrites the same bytes instead of appending a second history.
 *
 * @param {{model: object, artifacts: object, cwd?: string}} options
 */
export function createModelFromConfig({ model, artifacts, cwd = process.cwd() }) {
  const kind = model.kind ?? 'command'
  const argv = kind === 'command' ? absoluteise(model.command, cwd) : model.command
  return createModelPort({
    kind,
    command: argv,
    timeout_ms: model.timeout_ms,
    env: model.env,
    record: (call) => artifacts.write(modelCallName(call), call),
  })
}

/** What the executor is asked to run for one candidate: one argv, in the candidate's own worktree. */
function planFor(config, { workspaceDir, runner }) {
  const executor = config.executor ?? { kind: 'local' }
  return ({ candidateId }) => ({
    command: executor.command,
    // The candidate's worktree is the execution directory: the job evaluates the candidate's tree,
    // not the checkout the loop happens to live in.
    cwd: runner === undefined ? (executor.cwd === undefined ? process.cwd() : resolve(workspaceDir, executor.cwd)) : runner.worktreeFor(candidateId),
    env: { ...(executor.env ?? {}) },
  })
}

/**
 * The external-job port. `local` is the laptop path (a subprocess, no GPU, no cluster); `ray` is the
 * one real cluster adapter this repo ships. Both are held to the same conformance suite in
 * `packages/exec`, which is what makes this a configuration choice rather than a fork.
 */
export function createPlatform(config, context) {
  const executor = config.executor ?? { kind: 'local' }
  const plan = planFor(config, context)
  const limits = config.limits ?? {}
  const metricsRequired = executor.metrics_required !== false

  if ((executor.kind ?? 'local') === 'local') {
    return createLocalPlatform({
      rootDir: resolve(context.workspaceDir, executor.root_dir ?? 'jobs'),
      plan,
      limits,
      metricsRequired,
    })
  }
  if (executor.kind === 'ray') {
    return createRayPlatform({
      fetch: globalThis.fetch,
      plan,
      baseUrl: executor.base_url,
      metricsDir: resolve(context.workspaceDir, executor.metrics_dir ?? 'metrics'),
      limits,
      metricsRequired,
    })
  }
  throw new TypeError(`unknown executor.kind ${JSON.stringify(executor.kind)}`)
}

/**
 * The candidate implementer, pinned to the runner's worktree.
 *
 * The three kinds differ only in the argv they build: `claude`, `dsh`, or a plain command. The
 * placeholders `{candidate}` and `{worktree}` are substituted so a configuration file can name the
 * files it wants without knowing the ids in advance.
 */
export function createHarness(config, { runner, launchDir = process.cwd() }) {
  const candidate = config.candidate
  if (candidate === undefined) return undefined
  if (runner === undefined) {
    throw new TypeError(
      'a candidate implementer needs a runner (runner.repo + runner.dir): LAND pins the child cwd to a worktree this process owns',
    )
  }
  const kind = candidate.kind ?? 'command'
  const timeoutMs = candidate.timeout_ms

  if (kind === 'claude' || kind === 'dsh') {
    const options = { ...(candidate.options ?? {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) }
    const adapter = kind === 'claude' ? createClaudeHarness(options) : createDshHarness(options)
    return {
      engine: adapter.engine,
      land: (request) =>
        adapter.land({
          ...request,
          worktreeDir: runner.worktreeFor(request.candidateId),
          baseRef: runner.baseRef,
        }),
    }
  }

  return {
    engine: 'command',
    land: (request) => {
      const worktreeDir = runner.worktreeFor(request.candidateId)
      const argv = absoluteise(candidate.command, launchDir, { candidate: request.candidateId, worktree: worktreeDir })
      return landWithCli({
        engine: 'command',
        command: argv[0],
        args: argv.slice(1),
        worktreeDir,
        baseRef: runner.baseRef,
        candidateId: request.candidateId,
        hypothesis: request.hypothesis,
        round: request.round,
        parentId: request.parentId ?? null,
        env: { ...process.env, ...(candidate.env ?? {}) },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    },
  }
}

/**
 * The frozen baseline, as a file the run wrote once.
 *
 * Two readers, one answer: BASELINE copies it into the workspace state (and from then on the state is
 * authoritative), and CAND_ANALYZE compares against the same value. If the file is edited mid-run the
 * frozen state wins, which is the point of freezing it.
 *
 * @param {{workspaceDir: string, store?: any}} options
 */
export function baselinePort({ workspaceDir, store }) {
  const path = join(workspaceDir, BASELINE_FILENAME)
  return {
    path,
    read() {
      const frozen = store === undefined ? undefined : readRoundsState(store)?.baseline
      if (frozen !== undefined && typeof frozen.value === 'number') return { metric: frozen.metric, value: frozen.value }
      if (!existsSync(path)) return undefined
      try {
        const document = JSON.parse(readFileSync(path, 'utf8'))
        const value = typeof document === 'number' ? document : document.value
        if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
        return { metric: isText(document.metric) ? document.metric : undefined, value }
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Every port the kernel needs, from configuration. Missing optional pieces come back `undefined` —
 * never as a stand-in that answers for them.
 */
export function portsFromConfig({ config, workspaceDir, store, log = () => {}, launchDir = process.cwd() }) {
  const runner = config.runner === undefined ? undefined : createWorktreeRunner(config.runner, { workspaceDir, log })
  const baseline = baselinePort({ workspaceDir, store })
  const artifacts = fileArtifacts(join(workspaceDir, 'artifacts'))

  const ports = {
    clock: { now: () => Date.now() },
    platform: createPlatform(config, { workspaceDir, runner }),
    harness: createHarness(config, { runner, launchDir }),
    baseline,
    artifacts,
    runner,
  }

  if (config.model !== undefined) {
    const pack = config.domainPack
    if (pack === undefined) {
      throw new TypeError(
        'the judge needs a domain pack: config.domain names the directory its five prompts and metric contract come from',
      )
    }
    ports.judge = createJudge({
      model: createModelFromConfig({ model: config.model, artifacts, cwd: launchDir }),
      // The pack declares "better"; a run may restate the metric it optimises for this round, which
      // is the shape `rounds.metric` already had. Prompts and the adjustable surface come from the
      // pack only: there is no second home for them to drift to.
      metric: { ...metricFromContract(pack.metricContract), ...(config.rounds?.metric ?? {}) },
      baseline: () => baseline.read()?.value,
      skillsDir: pack.promptsDir,
      surface: pack.surface,
      artifacts,
    })
  }
  return ports
}
