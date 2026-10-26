/**
 * The run configuration file: one JSON document per run, read at mount.
 *
 * Why this exists. A run is started by the **host** (dsh), not by `cli/run.js`, and until this module
 * the only way to tell the host which workspace and which repository to use was to hand-edit the
 * profile's `cordis.patch.yml`. An operator's real task run is not a YAML file in a profile: its
 * workspace lives at `~/runs/<task>`, its model repository is a checkout somewhere else, and neither
 * belongs in a patch that is shared by every run on the machine. So the plugin accepts a
 * `config_file`, read once at mount, and the environment variable `DSH_REPRISE_CONFIG` names the same
 * file for a launcher that would rather not rewrite a patch at all.
 *
 * Three rules, and each one is a refusal rather than a fallback:
 *
 *   - **The file is the base; the inline keys win key by key.** The merge is *shallow*: an inline
 *     `stop: {max_rounds: 5}` replaces the file's whole `stop` object. A deep merge would make "which
 *     of these two numbers is the run using?" unanswerable without diffing two documents, and the one
 *     thing a run may never be is ambiguous about its own configuration.
 *   - **A missing, unreadable or malformed file is a named boot failure** that quotes the path and the
 *     operating system's (or the parser's) words. Falling back to defaults here would start a run
 *     against whatever the defaults happen to name, which is how a run writes its facts into the
 *     wrong directory and discovers it hours later.
 *   - **`workspace` inside the file resolves against the file's own directory.** This is the one path
 *     rule that differs from inline config, deliberately: the file travels with the run it describes
 *     (next to its workspace, in a checkout, in a tarball), while an inline value was typed in the
 *     host's cwd and means what it says there. Every other path keeps the host-cwd rule, because
 *     `domain`, `runner.repo`/`runner.dir` and the script paths in an argv are read by code that has
 *     no idea a file was involved.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { isPlainObject } from '@dsh-reprise/contract'

const isText = (value) => typeof value === 'string' && value.trim() !== ''

/** How a document is described in a refusal: `a JSON object` is what the reader was meant to write. */
function kindOf(document) {
  if (Array.isArray(document)) return 'an array'
  if (document === null) return 'null'
  return `a ${typeof document}`
}

/**
 * Read the configuration file a run names, and answer the configuration the run will be resolved from.
 *
 * @param {{
 *   raw?: unknown, cwd?: string, env?: Record<string, string | undefined>,
 *   readFile?: (path: string) => string,
 * }} [options] `readFile` is the seam a test uses to hand over a document without a file on disk;
 *   `env` is passed rather than read so a test cannot inherit the machine it runs on.
 * @returns {{ok: true, raw: object, workspaceFromFile: boolean, file?: {path: string, dir: string, keys: string[]}}
 *         | {ok: false, problems: string[]}}
 */
export function loadConfigFile({ raw = {}, cwd = process.cwd(), env = process.env, readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const inline = isPlainObject(raw) ? raw : {}

  if (inline.config_file !== undefined && !isText(inline.config_file)) {
    return {
      ok: false,
      problems: [
        `config_file must be the path of one JSON run configuration file (got ${JSON.stringify(inline.config_file)})` +
          ' — or set DSH_REPRISE_CONFIG to it instead',
      ],
    }
  }
  // The key wins over the environment: a value typed into the plugin configuration is the more
  // specific statement, exactly as `workspace` in configuration outranks `DSH_REPRISE_WORKSPACE`.
  const declared = isText(inline.config_file)
    ? { path: inline.config_file, source: 'config_file' }
    : isText(env?.DSH_REPRISE_CONFIG)
      ? { path: env.DSH_REPRISE_CONFIG, source: 'DSH_REPRISE_CONFIG' }
      : undefined
  if (declared === undefined) return { ok: true, raw: inline, workspaceFromFile: false }

  const path = isAbsolute(declared.path) ? declared.path : resolve(cwd, declared.path)
  const named = `the run configuration file ${path} (from ${declared.source})`

  let text
  try {
    text = readFile(path)
  } catch (error) {
    return { ok: false, problems: [`${named} could not be read: ${error?.message ?? String(error)}`] }
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { ok: false, problems: [`${named} is not valid JSON: ${error?.message ?? String(error)}`] }
  }
  if (!isPlainObject(document)) {
    return { ok: false, problems: [`${named} must contain a JSON object of configuration keys, not ${kindOf(document)}`] }
  }

  // The file-relative rule, applied *before* the merge so the precedence is about the values and not
  // about which of two path rules produced them: an absolute workspace here is already the answer,
  // and an inline `workspace` below still goes through the host-cwd rule in `config.js`.
  const dir = dirname(path)
  const base = { ...document }
  if (isText(base.workspace)) base.workspace = isAbsolute(base.workspace) ? base.workspace : resolve(dir, base.workspace)

  const merged = { ...base, ...inline, config_file: path }
  return {
    ok: true,
    raw: merged,
    workspaceFromFile: isText(document.workspace) && !isText(inline.workspace),
    file: { path, dir, keys: Object.keys(document).sort() },
  }
}