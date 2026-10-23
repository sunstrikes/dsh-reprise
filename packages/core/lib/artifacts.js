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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
 *   dir?: string,
 * }} ArtifactStore
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
    documents,
  }
}