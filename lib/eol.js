// dsh-openspec-taskloop — the line endings of the files a GitButler commit carries
// (task 5.4, design D8).
//
// `but commit` composes the new blob out of the old one and the changed regions of the
// working copy, and it does not tell CRLF from LF (D8): `but diff` calls a file that
// differs only in its endings unchanged, and `but status` keeps listing it. A file whose
// blob ends its lines with LF while the working copy uses CRLF therefore arrives mixed —
// the untouched lines keep the ending of the old blob, the changed ones carry CR — and
// `git status` reports it as modified after the commit, because git stops normalising a
// blob that already holds CR.
//
// The step below removes that dirt at its source: right before `but commit` the plugin
// rewrites the files of the commit to LF, the form in which the repository stores its
// blobs. `runCommit()` receives it as a dependency, the way it receives the runner
// `run`, with this implementation as the default, so the commit stays testable without
// a file system and this module is testable without a commit.
//
// What is rewritten is decided by the blob in `HEAD`, not by the working copy (D8):
//
//   no CRLF                         → untouched, and no request is made for the file
//   binary (NUL in the first 8 KB)  → untouched
//   a directory, a symlink, a path that is gone → untouched
//   i/crlf                          → untouched: the file agrees with its blob, while LF
//                                     in the working copy of a CR blob would leave it
//                                     dirty for good (git turns autocrlf off for it)
//   i/mixed                         → rewritten, but not healed: the lines this group
//                                     did not touch keep the bytes of the old blob, so
//                                     the caller is told the file stays dirty instead of
//                                     being promised a clean tree
//   i/lf, i/none, untracked         → rewritten to LF
//
// The step never fails the commit. A file it cannot read or write is left as it is, and
// an inspection it could not make rewrites nothing at all: the commit is the user's
// finished work, and a repair that cannot run must not throw that work away. `git` needs
// none of it — `git add -A` normalises on its own and `git commit` reads the index.

import { lstat, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { aborted } from './wait.js'

/**
 * How much of a file is read before it is called binary, in bytes.
 *
 * The same window git itself looks at when it decides whether a blob is text, so the
 * plugin calls a file binary where the tool would, and the two cannot disagree about a
 * file neither of them can normalise.
 */
export const EOL_BINARY_SCAN_BYTES = 8_192

/** Byte values the scan looks for; the file itself is never decoded as text. */
const CR = 0x0d
const LF = 0x0a

/**
 * What the index says about the endings of one file, and what that means here (D8).
 *
 * Three answers, because a skipped file and a file that stays dirty are not the same
 * fact: the first needs no sentence, the second one does — a user who sees `git status`
 * still naming a file the plugin just committed must not be left guessing why.
 *
 * @param {string|undefined} index - `<form>` of the `i/<form>` column of
 *   `git ls-files --eol`, or `undefined` when the file has no entry there.
 * @returns {'rewrite'|'mixed'|'skip'} whether to rewrite the file, rewrite it and report
 *   it, or leave it alone.
 */
export function eolRewriteOf(index) {
  // No entry means untracked: there is no blob for the working copy to disagree with, so
  // whatever the file holds is new content and goes in as LF.
  if (index === undefined) return 'rewrite'
  // The file is stored the way it lies in the working copy. LF would break that agreement
  // and leave `i/crlf w/lf` behind — a file git keeps reporting as modified forever.
  if (index === 'crlf') return 'skip'
  if (index === 'mixed') return 'mixed'
  if (index === 'lf' || index === 'none') return 'rewrite'
  // `-text` (binary in the index) and any form a later git invents: the plugin does not
  // know what rewriting would do to them, so it does nothing.
  return 'skip'
}

/**
 * The request that tells how git stores each of these files (D8).
 *
 * `--eol` prints the form of the blob in the index next to the form of the working copy,
 * which is exactly the question the rewrites depend on. `-z` keeps a path with a space or
 * a non-ASCII name one field; the trailing `--` keeps a path that looks like a revision
 * from being read as one.
 *
 * The request is made only when at least one file holds a CRLF (see {@link normalizeEol}),
 * so a commit of ordinary LF files never pays for it.
 *
 * @param {readonly string[]} files - paths about to be rewritten, relative to the project
 *   directory; at least one.
 * @returns {{executable: string, args: readonly string[]}} the request.
 * @throws {TypeError} when the list is empty, or holds something else than a non-empty
 *   path — a listing of nothing would answer about a different set of files.
 */
export function lsFilesEolCommand(files) {
  const paths = checkedPaths(files)
  if (paths.length === 0) {
    throw new TypeError('lsFilesEolCommand requires at least one path to inspect')
  }
  return Object.freeze({
    executable: 'git',
    args: Object.freeze(['ls-files', '--eol', '-z', '--', ...paths]),
  })
}

/**
 * The `<form>` of the index column, per path, as `git ls-files --eol -z` printed it.
 *
 * The columns are fixed-width and padded, and the path follows a tab:
 * `i/lf    w/lf    attr/                  \tlib/a.js`, one record per NUL. Only the `i/`
 * column is read — the working copy is what this module has in hand already — and a
 * record without one is skipped rather than guessed at, so a format change degrades to
 * "nothing is rewritten" instead of to a wrong rewrite.
 *
 * A path that is absent from the answer has no entry in the index: an untracked file, or
 * one git has already forgotten.
 *
 * @param {unknown} stdout - what the request printed.
 * @returns {Map<string, string>} index form per path, in the order git printed them.
 */
export function parseEolListing(stdout) {
  const listing = new Map()
  if (typeof stdout !== 'string') return listing
  for (const record of stdout.split('\0')) {
    if (record === '') continue
    // The path is everything after the first tab: the columns before it hold no tabs, so
    // a path that contains one still arrives whole.
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const path = record.slice(tab + 1)
    if (path === '') continue
    const column = record.slice(0, tab).split(/\s+/u).find((part) => part.startsWith('i/'))
    if (column === undefined) continue
    listing.set(path, column.slice(2))
  }
  return listing
}

/**
 * Rewrite the files of a commit to LF, so that `but commit` cannot mix their endings (D8).
 *
 * The files are given as `git status` named them, relative to `cwd`, and only the ones
 * that hold a CRLF are touched: a file already in LF costs one read and nothing else, and
 * a file without a CRLF is left byte for byte as it is, because there is nothing in it to
 * normalise. The binary and the non-file cases are filtered out by the same read (see
 * {@link readTextFile}).
 *
 * The decision to rewrite comes from the index ({@link eolRewriteOf}), and it costs one
 * request: `git ls-files --eol -z -- <files>`, made only when some file does hold a CRLF.
 * An inspection that failed returns nothing rewritten — the plugin cannot tell a file
 * that agrees with its blob from one that does not, and rewriting the wrong one would
 * leave it permanently dirty.
 *
 * A stop is honoured between the files: the commit that follows will not run anyway, and
 * halving the work of a run that is over is not a reason to keep writing.
 *
 * @param {readonly string[]} files - paths of the commit, relative to `cwd`; may be empty,
 *   in which case nothing is read and no request is made.
 * @param {object} [options]
 * @param {string} [options.cwd] - project directory the paths are relative to.
 * @param {(request: {executable: string, args: readonly string[]}, options: {cwd: string, signal?: AbortSignal}) => Promise<{exitCode: number|null, stdout: string, stderr: string}>} [options.run] -
 *   runner of the inspection request; needed only when a file has to be inspected.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<{rewritten: string[], mixed: string[]}>} the files rewritten to LF, in
 *   the order they were given, and the subset whose history stays mixed — the files a
 *   report has to warn about.
 * @throws {TypeError} when a file has a CRLF and no runner was given to inspect it.
 */
export async function normalizeEol(files, { cwd, run, signal } = {}) {
  const directory = cwd ?? '.'
  const pending = []
  for (const path of Array.isArray(files) ? files : []) {
    if (typeof path !== 'string' || path === '') continue
    const bytes = await readTextFile(join(directory, path))
    if (bytes === undefined || !hasCrlf(bytes)) continue
    pending.push({ path, bytes })
  }
  if (pending.length === 0) return { rewritten: [], mixed: [] }
  if (typeof run !== 'function') {
    throw new TypeError('normalizeEol requires a run() to inspect the files it rewrites')
  }

  const listing = await inspectEol(pending.map((file) => file.path), { cwd: directory, run, signal })
  if (listing === undefined) return { rewritten: [], mixed: [] }

  const rewritten = []
  const mixed = []
  for (const file of pending) {
    if (aborted(signal)) break
    const action = eolRewriteOf(listing.get(file.path))
    if (action === 'skip') continue
    try {
      await writeFile(join(directory, file.path), toLf(file.bytes))
    } catch {
      // A file the process may not write — locked, read-only, gone since the status check
      // — stays as it is: see the module header.
      continue
    }
    rewritten.push(file.path)
    if (action === 'mixed') mixed.push(file.path)
  }
  return { rewritten, mixed }
}

/**
 * Read a file that may be a candidate for the rewrite, or `undefined` when it is not one.
 *
 * The answer is the whole content, so the caller does not read the file twice, but only
 * the first {@link EOL_BINARY_SCAN_BYTES} are taken before the file is known not to be
 * binary: a commit that names a large untracked archive must not read it into memory to
 * find out that it holds no line endings at all.
 *
 * @param {string} path - absolute path of the candidate.
 * @returns {Promise<Buffer|undefined>} the content, or `undefined` for a binary file, a
 *   directory, a symlink and a path that cannot be read.
 */
async function readTextFile(path) {
  try {
    const stats = await lstat(path)
    // `lstat`, not `stat`: writing through a symlink would rewrite the file it points at,
    // which is not this commit's file at all.
    if (!stats.isFile()) return undefined
    const handle = await open(path, 'r')
    try {
      const head = Buffer.alloc(Math.min(EOL_BINARY_SCAN_BYTES, stats.size))
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      const bytes = head.subarray(0, bytesRead)
      if (bytes.includes(0)) return undefined
      if (stats.size <= EOL_BINARY_SCAN_BYTES) return bytes
      return await readFile(path)
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    // Gone since the status check, unreadable, or a link to something that is not a file:
    // whatever the reason, there is nothing of this commit to normalise behind it.
    return undefined
  }
}

/**
 * Whether the content holds a CRLF pair.
 *
 * Only the pair counts: a lone CR is not a line ending this step knows anything about, and
 * rewriting it would change the content rather than the endings.
 *
 * @param {Buffer} bytes - content of a file.
 * @returns {boolean} whether any line of it ends with CRLF.
 */
function hasCrlf(bytes) {
  for (let index = bytes.indexOf(CR); index !== -1; index = bytes.indexOf(CR, index + 1)) {
    if (bytes[index + 1] === LF) return true
  }
  return false
}

/**
 * The same content with every CRLF replaced by LF.
 *
 * latin1 is byte-transparent — every byte is a code point of the same value and back — so
 * a file survives the rewrite byte for byte apart from the endings, whatever encoding it is
 * in. Decoding as UTF-8 would be the wrong guess for a file in a legacy code page and would
 * turn its bytes into replacement characters.
 *
 * @param {Buffer} bytes - content of a file.
 * @returns {Buffer} the content with LF endings.
 */
function toLf(bytes) {
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/gu, '\n'), 'latin1')
}

/**
 * Ask git how it stores these files, and keep a failed answer as `undefined`.
 *
 * The form of the run is the one the commit itself uses — an argv request through the
 * injected runner, no shell — so the inspection is visible in the same place as the
 * requests it precedes.
 *
 * @param {readonly string[]} files - paths to inspect, at least one.
 * @param {object} options
 * @param {string} options.cwd - project directory.
 * @param {Function} options.run - runner of the request.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<Map<string, string>|undefined>} the listing, or `undefined` when the
 *   request could not be made or refused.
 */
async function inspectEol(files, { cwd, run, signal }) {
  try {
    const result = await run(lsFilesEolCommand(files), { cwd, signal })
    if (result?.exitCode !== 0) return undefined
    return parseEolListing(result.stdout)
  } catch {
    return undefined
  }
}

/**
 * Validate a list of paths and hand it back.
 *
 * A path is passed through as it was read — no trimming, no separator rewriting: it is a
 * name git printed, and it has to reach the tool as the same bytes.
 *
 * @param {unknown} files - candidate paths.
 * @returns {readonly string[]} the paths, in the order they were given.
 * @throws {TypeError} when the list is not an array, or holds something else than a
 *   non-empty path.
 */
function checkedPaths(files) {
  if (!Array.isArray(files)) {
    throw new TypeError('lsFilesEolCommand requires an array of file paths')
  }
  for (const file of files) {
    if (typeof file !== 'string' || file === '') {
      throw new TypeError('lsFilesEolCommand requires a non-empty path for every file it inspects')
    }
  }
  return files
}
