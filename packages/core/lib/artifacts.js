/**
 * Where a phase artifact lands.
 *
 * Artifacts stay files rather than database rows, and the reason is not nostalgia for `cat`: the
 * validator's object is a document that gets carried away by git and read by tools outside this
 * process (a dashboard projection, an operator's script, a reviewer's diff). The database holds the
 * fact plane; the artifact is the evidence the fact plane points at.
 *
 * Writes are atomic — write a sibling, then rename — so a reader never sees half a document. A crash
 * between the two leaves a stray `.tmp-<pid>` file and nothing else, which is a strictly better
 * failure than a truncated artifact that still parses.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/**
 * `verify_verdict:c1` is the reference the fact plane records, and on disk it becomes
 * `verify_verdict/c1.json`: a colon is legal on Unix and not on Windows, and a nested directory is
 * easier to read than an escaped name.
 */
export const artifactFileName = (name) => `${String(name).replace(/:/g, '/')}.json`

const digest = (text) => createHash('sha256').update(text).digest('hex')

/**
 * @typedef {{
 *   write: (name: string, value: unknown) => { path: string, sha256: string, bytes: number },
 *   read: (name: string) => unknown,
 *   list: (prefix?: string) => string[],
 *   dir?: string,
 * }} ArtifactStore
 *
 * `list` is read-only and exists for the display layer: the audit panel has to say which judgements
 * the run asked for, and those records are files, not rows. It is part of the port (rather than a
 * `readdir` in the renderer) so a store with no directory behind it can answer the same question.
 */

/**
 * @param {string} dir
 * @returns {ArtifactStore & { dir: string }}
 */
export function fileArtifacts(dir) {
  const pathFor = (name) => join(dir, artifactFileName(name))
  return {
    dir,
    write(name, value) {
      const path = pathFor(name)
      mkdirSync(dirname(path), { recursive: true })
      const document = `${JSON.stringify(value, null, 2)}\n`
      const temporary = `${path}.tmp-${process.pid}`
      writeFileSync(temporary, document, 'utf8')
      renameSync(temporary, path)
      return { path, sha256: digest(document), bytes: Buffer.byteLength(document) }
    },
    read(name) {
      try {
        return JSON.parse(readFileSync(pathFor(name), 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined
        throw error
      }
    },
    list(prefix = '') {
      let entries
      try {
        entries = readdirSync(dir, { recursive: true })
      } catch (error) {
        // A workspace that never wrote an artifact is empty, not broken. Anything else (a permission
        // problem, a file where the directory should be) belongs to the caller.
        if (error?.code === 'ENOENT') return []
        throw error
      }
      return entries
        .filter((entry) => entry.endsWith('.json'))
        // A crashed write leaves a `.tmp-<pid>` sibling; it is not an artifact and must not be listed
        // as one, or the audit would show a document that may not parse.
        .filter((entry) => !entry.includes('.tmp-'))
        .map((entry) => entry.split(sep).join(':').replace(/\.json$/, ''))
        .filter((name) => prefix === '' || name === prefix || name.startsWith(`${prefix}:`))
        .sort()
    },
  }
}

/** For a fact plane with no directory behind it (a fake store in a test): same port, no files. */
export function memoryArtifacts() {
  const documents = new Map()
  const pathFor = (name) => `memory://${artifactFileName(name)}`
  return {
    write(name, value) {
      const document = `${JSON.stringify(value, null, 2)}\n`
      const path = pathFor(name)
      documents.set(path, document)
      return { path, sha256: digest(document), bytes: Buffer.byteLength(document) }
    },
    read(name) {
      const document = documents.get(pathFor(name))
      return document === undefined ? undefined : JSON.parse(document)
    },
    list(prefix = '') {
      return [...documents.keys()]
        .map((path) => path.slice('memory://'.length).replace(/\.json$/, '').split('/').join(':'))
        .filter((name) => prefix === '' || name === prefix || name.startsWith(`${prefix}:`))
        .sort()
    },
    documents,
  }
}