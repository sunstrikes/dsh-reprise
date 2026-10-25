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
 *   - **The baseline is measured by the executor, not read from a file.** The BASELINE phase submits
 *     its own job through the same port (see `baseline.js`). The `baseline.json` port below survives
 *     only as the source for a workspace whose baseline was measured before the loop could do it,
 *     and for a run with no executor port at all — never as the normal way to obtain a denominator.
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
import {
  MODEL_UNAVAILABLE,
  buildQuestion,
  createModelPort,
  isNoAnswerClass,
  modelCallName,
  modelCallRecord,
} from '@dsh-reprise/exec/model'
import { createLocalPlatform } from '@dsh-reprise/exec/platform/local'
import { createRayPlatform } from '@dsh-reprise/exec/platform/ray'

import { fileArtifacts } from './artifacts.js'
import { BASELINE_SUBJECT } from './baseline.js'
import { cudaVisibleDevicesOf, MARKER_KEY, submissionIdFor } from './jobs.js'
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

/**
 * What one job is asked to run for one subject, expressed in the vocabulary of its executor.
 *
 * The two kinds answer different questions and must not share a shape:
 *
 *  - `local` runs an argv on *this* machine, so the candidate's worktree is simply its `cwd`: the
 *    files the job reads are already the files the candidate wrote.
 *  - `ray` runs on a cluster whose nodes share no filesystem with us, so there is no directory to
 *    point at. The plan names the tree to **ship** (`worktreeDir` + the runner's `baseRef`) and the
 *    argv that runs *inside the unpacked package*. Handing a laptop path to a Ray plan would be a
 *    job that fails on a node with "no such directory" three minutes into a GPU reservation.
 *
 * **The baseline is a subject too**, and its plan differs in exactly one respect: there is no
 * candidate worktree. The baseline measures the tree the candidates branch *from*, so it runs in the
 * runner's repository at the runner's base ref — the untouched base tree — rather than in a worktree
 * some candidate has already edited. Everything else (the argv, the GPU count, the environment) is
 * the same as a candidate's, because the whole point is that the denominator is measured by the same
 * executor run as the numerator.
 *
 * The plan is chosen by `candidateId`, which is what the platform port passes in; the reserved
 * baseline subject is the only id that means "the base tree". Ticket 16's cluster marker reads the
 * same distinction from `metadata.kind`, set here so the cluster listing says it too.
 */
export function planForConfig(config, { workspaceDir, runner }) {
  const executor = config.executor ?? { kind: 'local' }
  const isBaseline = (candidateId) => candidateId === BASELINE_SUBJECT

  // Two things every job of ours carries, whichever executor runs it:
  //
  //  - the **marker**, so the job can be recognised again in the cluster's own listing afterwards
  //    (`jobs.js` reads it back). It goes into `metadata` *and* it is the submission id the job is
  //    submitted under: measured on the live cluster, a listing row's `job_id` may be null and no
  //    listing row carries `metadata` at all, so `submission_id` is the channel that always survives.
  //  - the **device list**, when that is the run's GPU-exclusivity choice — written by the submission
  //    itself, because nothing in the cluster does it for us.
  const devices = cudaVisibleDevicesOf(config)

  if ((executor.kind ?? 'local') === 'ray') {
    return ({ candidateId, round, submissionId }) => ({
      // Runnable inside the unpacked package: relative paths resolve against the shipped tree, which
      // is the whole point of shipping it. For the baseline that tree is the base ref, unmodified.
      entrypoint: executor.command,
      worktreeDir: runner === undefined ? undefined : isBaseline(candidateId) ? runner.repoDir : runner.worktreeFor(candidateId),
      baseRef: runner?.baseRef,
      runtimeEnv: {
        env_vars: { ...(executor.env ?? {}), ...(devices === undefined ? {} : { CUDA_VISIBLE_DEVICES: devices }) },
      },
      ...(executor.num_gpus === undefined ? {} : { numGpus: executor.num_gpus }),
      // The marker says which job of ours this is — and it is the submission id itself, so the two
      // channels a cluster may answer on cannot disagree about which job ran. When the caller passes
      // the id it is submitting under, that is the marker; when it does not, the same builder derives
      // it. The baseline has no candidate and no round, so it carries its own marker form rather than
      // a candidate marker with two invented fields.
      metadata: { [MARKER_KEY]: submissionId ?? submissionIdFor({ candidateId, round, baseline: isBaseline(candidateId) }) },
    })
  }

  return ({ candidateId, round }) => ({
    command: executor.command,
    // The candidate's worktree is the execution directory: the job evaluates the candidate's tree,
    // not the checkout the loop happens to live in. The baseline has no worktree by definition, so it
    // runs in the repository the worktrees branch from — the same tree, unedited.
    cwd:
      runner === undefined
        ? executor.cwd === undefined
          ? process.cwd()
          : resolve(workspaceDir, executor.cwd)
        : isBaseline(candidateId)
          ? runner.repoDir
          : runner.worktreeFor(candidateId),
    env: { ...(executor.env ?? {}), ...(devices === undefined ? {} : { CUDA_VISIBLE_DEVICES: devices }) },
  })
}

/** The plan `createPlatform` hands the adapter; exported above so a test can read what a job says. */
const planFor = planForConfig

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
      // No `fetch`: the dashboard's CSRF guard refuses Node's global fetch for writes (undici sends
      // `sec-fetch-mode: cors`, which Ray reads as browser traffic). The adapter defaults to
      // `node:http`; see `packages/exec/lib/ray-http.js`.
      plan,
      // The round-less family root, so `find()` can recover a crashed submission whose round nobody
      // remembers any more: the vocabulary lives here, in the ledger, not in the cluster adapter.
      submissionIdFor: (candidateId) => submissionIdFor({ candidateId, probe: true }),
      baseUrl: executor.base_url,
      metricsDir: resolve(context.workspaceDir, executor.metrics_dir ?? 'metrics'),
      limits,
      metricsRequired,
    })
  }
  throw new TypeError(`unknown executor.kind ${JSON.stringify(executor.kind)}`)
}

/**
 * File one landing where the audit page can read it: the briefing the implementer was given, and what
 * it did with it.
 *
 * LAND is the fifth call site, and its model is a coding harness rather than a question-answering
 * port — but the record has the same shape, because a reader asking "what did we ask, and what came
 * back" should not have to learn two formats. `status: 'unavailable'` means the implementer never
 * answered (no binary, a timeout, an unreadable stream): that is the same condition the judgement
 * port reports, and `loop.js` handles both through the same outage path.
 *
 * @param {object} artifacts the workspace artifact store
 * @param {{candidateId: string, round?: number, hypothesis?: string, parentId?: string|null}} request
 * @param {object} result the harness result (`landWithCli`'s shape)
 */
export function recordLandCall(artifacts, request, result) {
  if (typeof artifacts?.write !== 'function') return undefined
  const prompt = typeof result?.prompt === 'string' && result.prompt !== '' ? result.prompt : ''
  if (prompt === '') return undefined

  const question = buildQuestion({
    call_site: 'land',
    subject: request.candidateId,
    prompt,
    facts: {
      candidate_id: request.candidateId,
      round: request.round ?? null,
      hypothesis: request.hypothesis ?? null,
      parent_id: request.parentId ?? null,
      base_ref: result.base_ref ?? null,
      worktree_dir: request.worktreeDir ?? null,
    },
    answer_schema: '{"files": ["path/one", "path/two"]}',
  })
  const unanswered = result.ok === false && isNoAnswerClass(result.error_class)
  return artifacts.write(
    modelCallName(question),
    modelCallRecord({
      question,
      answer: {
        engine: result.engine ?? null,
        files: Array.isArray(result.files) ? result.files : [],
        files_changed: result.files_changed ?? 0,
        parent_commit: result.parent_commit ?? null,
        cross_check: result.cross_check?.status ?? null,
      },
      response: typeof result.output === 'string' ? result.output : '',
      error_class: unanswered ? MODEL_UNAVAILABLE : null,
      cause: unanswered ? (result.error_class ?? null) : null,
      message: unanswered ? (result.message ?? null) : null,
    }),
  )
}

/**
 * The candidate implementer, pinned to the runner's worktree.
 *
 * The three kinds differ only in the argv they build: `claude`, `dsh`, or a plain command. The
 * placeholders `{candidate}` and `{worktree}` are substituted so a configuration file can name the
 * files it wants without knowing the ids in advance.
 */
export function createHarness(config, { runner, launchDir = process.cwd(), artifacts } = {}) {
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
      land: async (request) => {
        const worked = { ...request, worktreeDir: runner.worktreeFor(request.candidateId), baseRef: runner.baseRef }
        const result = await adapter.land(worked)
        recordLandCall(artifacts, worked, result)
        return result
      },
    }
  }

  return {
    engine: 'command',
    async land(request) {
      const worktreeDir = runner.worktreeFor(request.candidateId)
      const argv = absoluteise(candidate.command, launchDir, { candidate: request.candidateId, worktree: worktreeDir })
      const result = await landWithCli({
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
      recordLandCall(artifacts, { ...request, worktreeDir }, result)
      return result
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
    harness: createHarness(config, { runner, launchDir, artifacts }),
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
      // The one contract the run recorded, resolved inside the judge (`metric-contract.js`). It is
      // the same object the ranking and the stop rules read, so "improved" means one thing. A caller
      // that built ports without going through `resolveConfig` still gets the pack's own contract —
      // never a binding, and never nothing.
      metricContract: config.metrics ?? pack.metricContract,
      baseline: () => baseline.read()?.value,
      skillsDir: pack.promptsDir,
      surface: pack.surface,
      artifacts,
    })
  }
  return ports
}
