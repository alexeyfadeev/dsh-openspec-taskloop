// dsh-openspec-taskloop — the commit message that outlives a run (task 5.1).
//
// Design D16: the message is the user's, it is asked once per change, and it has to
// survive a stopped run — the next `/taskloop` must not ask again for a text the
// user has already typed. It cannot live in the profile config: that is edited
// through Settings, and a free-form string belongs next to the switches about as
// much as a log line does. It cannot live in the repository either — the run
// commits the whole tree (`git add -A`, design D15), so a file kept there would
// land in the very commit it describes. It goes to the harness home, beside the
// other profile-level state:
//
//     <home>/storages/openspec-taskloop.json
//     {
//       "changes": {
//         "C:\\repo#add-taskloop-review-commit": {
//           "message": "Добавить эндпоинт",
//           "updatedAt": "2026-10-25T07:10:42.386Z"
//         }
//       }
//     }
//
// `home` is `profileContext.home` — `$DSH_HOME`, normally `~/.dsh` — and the caller
// passes it in: resolving it needs the host, and this module stays a plain function
// of its arguments, with `lib/environment.js` the only seam that knows services.
//
// Three decisions shape the contract:
//
//   - the key is `<cwd>#<change>`, because a message belongs to one change of one
//     project. A second checkout of the same change is a different run with a
//     different history, and the same directory working on another change has other
//     tasks and another sentence to say. The spelling of `cwd` is the caller's: a
//     directory has to be named the same way twice for its record to be found.
//   - writes are atomic. The new content goes to a temporary file in the same
//     directory and is renamed over the old one, so a process that dies mid-write
//     leaves the previous file intact instead of a truncated one — a half-written
//     state file would cost the user every stored message at once. The directory is
//     created on demand: a fresh profile has no `storages/` yet, and failing the
//     first `/taskloop` over a missing folder would be absurd.
//   - a damaged file means "nothing stored". The file holds one convenience string
//     per change; a run that cannot parse it asks the user again — which is exactly
//     what a first run does — instead of refusing to work because of a cache. Only a
//     file that cannot be read at all is an error, and it is rethrown rather than
//     hidden: it would resurface on the write anyway, and a message that silently
//     did not persist would be discovered only after the run it was meant to survive.
//
// The three operations are deliberately small: each loads the file, changes one key
// and puts it back, so a record stored for another change — or another checkout — is
// never lost on the way. `deleteCommitMessage` leaves the file in place with an empty
// `changes`: the record is what D16 says to drop when the change is done, and a later
// change reuses the same container.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Directory of profile-level state files, inside the harness home (D16). */
export const STATE_DIRECTORY = 'storages'

/** Name of this plugin's state file. */
export const STATE_FILE_NAME = 'openspec-taskloop.json'

/** Character between the project directory and the change name in a key. */
export const STATE_KEY_SEPARATOR = '#'

/**
 * One stored message.
 *
 * `updatedAt` is ISO-8601 and is written for orientation only: nothing reads it back,
 * but a person opening the file can tell which record is recent, and the field costs
 * one line.
 *
 * @typedef {object} CommitMessageRecord
 * @property {string} message - text the user entered, trimmed of surrounding space.
 * @property {string} [updatedAt] - when the record was last written.
 */

/**
 * Contents of the state file.
 *
 * @typedef {object} CommitMessageState
 * @property {Record<string, CommitMessageRecord>} changes - records by
 *   {@link stateKeyOf} key.
 */

/**
 * Path of the state file for one harness home.
 *
 * @param {string} home - `profileContext.home` (`$DSH_HOME`, normally `~/.dsh`).
 * @returns {string} absolute path of `storages/openspec-taskloop.json` under `home`.
 * @throws {TypeError} when `home` is not a non-empty string.
 */
export function stateFileOf(home) {
  assertText(home, 'home')
  return join(home, STATE_DIRECTORY, STATE_FILE_NAME)
}

/**
 * Key a message is stored under: the project directory and the change name.
 *
 * @param {object} options
 * @param {string} options.cwd - project directory the run works in.
 * @param {string} options.change - OpenSpec change the message is for.
 * @returns {string} `<cwd>#<change>`.
 * @throws {TypeError} when either part is not a non-empty string.
 */
export function stateKeyOf({ cwd, change } = {}) {
  assertText(cwd, 'cwd')
  assertText(change, 'change')
  return `${cwd}${STATE_KEY_SEPARATOR}${change}`
}

/**
 * The message stored for one change of one project, if any (task 5.2 reads it).
 *
 * A missing file, a missing key and an unparsable file all answer the same way — no
 * message — because the caller's next step is identical in all three cases: ask the
 * user (design D16).
 *
 * @param {object} options
 * @param {string} options.home - `profileContext.home`.
 * @param {string} options.cwd - project directory the run works in.
 * @param {string} options.change - OpenSpec change the message is for.
 * @returns {Promise<string|undefined>} the stored text, or `undefined`.
 * @throws {TypeError} when an argument is missing, or `home` is not a string.
 * @throws {Error} when the state file exists but cannot be read.
 */
export async function readCommitMessage({ home, cwd, change } = {}) {
  const state = await readState(stateFileOf(home))
  const record = state.changes[stateKeyOf({ cwd, change })]
  return record === undefined ? undefined : record.message
}

/**
 * Store the message of one change, keeping every other record in the file (5.2 writes it).
 *
 * The text is trimmed before it is stored: it is later joined with the range of a
 * group (`<text>. Tasks 2.1 - 2.4`, design D16), and a trailing newline the user
 * happened to type would otherwise sit in the middle of the commit message. Inner
 * line breaks are kept — a multi-line body is a legitimate message, and the commit
 * passes it as one argv element.
 *
 * @param {object} options
 * @param {string} options.home - `profileContext.home`.
 * @param {string} options.cwd - project directory the run works in.
 * @param {string} options.change - OpenSpec change the message is for.
 * @param {string} options.message - text the user entered.
 * @returns {Promise<void>} resolves once the file holds the new record.
 * @throws {TypeError} when an argument is missing, `home` is not a string, or the
 *   message is empty after trimming.
 * @throws {Error} when the state file cannot be read or written.
 */
export async function writeCommitMessage({ home, cwd, change, message } = {}) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (text === '') {
    throw new TypeError('writeCommitMessage requires a non-empty message text')
  }
  const file = stateFileOf(home)
  const key = stateKeyOf({ cwd, change })
  const state = await readState(file)
  state.changes[key] = { message: text, updatedAt: new Date().toISOString() }
  await writeState(file, state)
}

/**
 * Drop the message of one change, keeping every other record (task 5.3 does it when the change is done).
 *
 * Deleting a key that is not there is a no-op and does not touch the file: a run that
 * ends in `all_done` without ever having asked a message — a flat change that was
 * already finished, say — must not create state as a side effect of cleaning up.
 *
 * @param {object} options
 * @param {string} options.home - `profileContext.home`.
 * @param {string} options.cwd - project directory the run works in.
 * @param {string} options.change - OpenSpec change whose message is dropped.
 * @returns {Promise<void>} resolves once the record is gone (or was never there).
 * @throws {TypeError} when an argument is missing, or `home` is not a string.
 * @throws {Error} when the state file cannot be read or written.
 */
export async function deleteCommitMessage({ home, cwd, change } = {}) {
  const file = stateFileOf(home)
  const key = stateKeyOf({ cwd, change })
  const state = await readState(file)
  if (state.changes[key] === undefined) return
  delete state.changes[key]
  await writeState(file, state)
}

/**
 * Load the state file, treating "absent" and "damaged" as "nothing stored".
 *
 * `ENOENT` is the ordinary first-run answer. Any other read failure is rethrown: a
 * file the process is not allowed to read is a broken deployment, and pretending it
 * holds nothing would ask the user for a message and then fail on the write, after
 * the run has already started.
 *
 * A file that parses to something other than the documented shape is normalised
 * rather than trusted: `changes` that is not an object, entries without a non-empty
 * string `message`, and keys that cannot be a {@link stateKeyOf} key are all dropped.
 * That keeps a hand-edited file from reaching a caller as a malformed record, and the
 * next write rewrites the file in the documented shape.
 *
 * @param {string} file - path of the state file.
 * @returns {Promise<CommitMessageState>} the records found, possibly none.
 * @throws {Error} when the file exists but cannot be read.
 */
async function readState(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw error
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyState()
  }
  return normaliseState(parsed)
}

/**
 * Keep the part of a parsed file this module understands.
 *
 * @param {unknown} value - result of `JSON.parse`.
 * @returns {CommitMessageState} a well-formed state, possibly empty.
 */
function normaliseState(value) {
  const changes = value?.changes
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
    return emptyState()
  }

  const state = emptyState()
  for (const [key, record] of Object.entries(changes)) {
    // The key shape is checked too, so a key such as `__proto__` — which a
    // hand-edited file could carry and which would otherwise change the prototype of
    // the map instead of adding a record — can never become part of the state.
    if (!key.includes(STATE_KEY_SEPARATOR)) continue
    const message = typeof record?.message === 'string' ? record.message.trim() : ''
    if (message === '') continue
    /** @type {CommitMessageRecord} */
    const entry = { message }
    if (typeof record.updatedAt === 'string' && record.updatedAt !== '') {
      entry.updatedAt = record.updatedAt
    }
    state.changes[key] = entry
  }
  return state
}

/**
 * An empty state: a file that exists but holds no record.
 *
 * @returns {CommitMessageState} the empty state.
 */
function emptyState() {
  return { changes: {} }
}

/**
 * Write the state atomically: a temporary sibling file, then a rename over the target.
 *
 * The temporary file lives in the same directory on purpose: a rename across
 * directories is a copy followed by a delete on some systems, which loses the
 * atomicity this exists for. Its name carries the process id and a random suffix so
 * two runs cannot collide, and it is removed again when anything between the write and
 * the rename fails — a failed write must not leave debris in `storages/`.
 *
 * The JSON is pretty-printed with a trailing newline, so the file stays something a
 * person can open and edit by hand, which is the only reason the format is documented
 * in the header at all.
 *
 * @param {string} file - path of the state file.
 * @param {CommitMessageState} state - records to write.
 * @returns {Promise<void>} resolves once the target holds the new content.
 * @throws {Error} when the directory cannot be created or the file cannot be written.
 */
async function writeState(file, state) {
  const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } catch (error) {
    // Best effort: the original error is what the caller needs to see, and a missing
    // temporary file is already the desired end state.
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Reject a value that cannot be part of a state key or path.
 *
 * @param {unknown} value - candidate part.
 * @param {string} field - name to put in the message.
 * @returns {string} the value, when it is usable.
 * @throws {TypeError} when it is not a non-empty string.
 */
function assertText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`the commit message state requires a non-empty ${field}`)
  }
  return value
}
