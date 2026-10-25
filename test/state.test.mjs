// Tests for the commit message that outlives a run (task 5.1).
//
// The module is pinned here against a real directory rather than a fake filesystem:
// what matters is the contract with the disk — the path under `$DSH_HOME`, the
// `<cwd>#<change>` key, a write that keeps the other records, a delete that touches
// one key, and a damaged file that reads as "nothing stored" instead of failing the
// run (design D16). Atomicity is pinned the way it can be observed from outside: the
// file always holds parseable JSON, and no temporary file is left behind.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  STATE_DIRECTORY,
  STATE_FILE_NAME,
  deleteCommitMessage,
  readCommitMessage,
  stateFileOf,
  stateKeyOf,
  writeCommitMessage,
} from '../lib/state.js'

const CHANGE = 'add-taskloop-review-commit'
const OTHER_CHANGE = 'add-taskloop-settings'
const CWD = 'C:\\work\\_dsh\\dsh-openspec-taskloop'
const OTHER_CWD = 'C:\\work\\_dsh\\dsh-ssh-ops'
const TEXT = 'Добавить эндпоинт'

/**
 * A throwaway harness home, removed when its test ends.
 *
 * @param {object} t - node:test context.
 * @returns {Promise<string>} path of an empty directory to use as `profileContext.home`.
 */
async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'openspec-taskloop-state-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

/**
 * The state file as parsed JSON, for asserting what was actually written.
 *
 * @param {string} file - path of the state file.
 * @returns {Promise<object>} its parsed contents.
 */
async function stateOf(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/**
 * Leave raw text where the state file lives, creating `storages/` on the way.
 *
 * Used to rehearse a file this module did not write: damaged JSON, or a shape a
 * hand edit could produce.
 *
 * @param {string} home - harness home to write under.
 * @param {string} text - raw contents of the state file.
 * @returns {Promise<string>} path of the file written.
 */
async function writeRawState(home, text) {
  const file = stateFileOf(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

test('the file lives in storages under the harness home, and the key joins the directory and the change', () => {
  assert.equal(stateFileOf('/home/user/.dsh'), join('/home/user/.dsh', STATE_DIRECTORY, STATE_FILE_NAME))
  assert.equal(stateKeyOf({ cwd: CWD, change: CHANGE }), `${CWD}#${CHANGE}`)
})

test('a stored message comes back for the same project and change, and for nothing else', async (t) => {
  const home = await temporaryHome(t)
  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: TEXT })

  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), TEXT)
  // Another change, another checkout, and another spelling of the directory are
  // different runs: each asks for its own message.
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: OTHER_CHANGE }), undefined)
  assert.equal(await readCommitMessage({ home, cwd: OTHER_CWD, change: CHANGE }), undefined)
  assert.equal(await readCommitMessage({ home, cwd: `${CWD}\\`, change: CHANGE }), undefined)
})

test('the stored file holds the documented shape, with a timestamp and no debris', async (t) => {
  const home = await temporaryHome(t)
  const file = stateFileOf(home)
  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: `  ${TEXT}\n` })

  const stored = await stateOf(file)
  assert.deepEqual(Object.keys(stored), ['changes'])
  const record = stored.changes[`${CWD}#${CHANGE}`]
  assert.equal(record.message, TEXT, 'the text is trimmed before it is stored')
  assert.equal(new Date(record.updatedAt).toISOString(), record.updatedAt)

  // The temporary sibling the atomic write uses is renamed over the target, not left
  // next to it.
  assert.deepEqual(await readdir(join(home, STATE_DIRECTORY)), [STATE_FILE_NAME])
})

test('a message for a second change keeps the first record', async (t) => {
  const home = await temporaryHome(t)
  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: TEXT })
  await writeCommitMessage({ home, cwd: CWD, change: OTHER_CHANGE, message: 'Настроить вкладку' })
  await writeCommitMessage({ home, cwd: OTHER_CWD, change: CHANGE, message: 'Поправить панель' })

  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), TEXT)
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: OTHER_CHANGE }), 'Настроить вкладку')
  assert.equal(await readCommitMessage({ home, cwd: OTHER_CWD, change: CHANGE }), 'Поправить панель')
})

test('rewriting a record replaces its text instead of duplicating it', async (t) => {
  const home = await temporaryHome(t)
  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: TEXT })
  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: 'Добавить эндпоинт и тест' })

  const stored = await stateOf(stateFileOf(home))
  assert.equal(Object.keys(stored.changes).length, 1)
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), 'Добавить эндпоинт и тест')
})

test('nothing is stored until something is written: no file, no storages directory, no message', async (t) => {
  const home = await temporaryHome(t)

  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), undefined)
  assert.deepEqual(await readdir(join(home, STATE_DIRECTORY)).catch(() => []), [])
})

test('a damaged file reads as no message, and the next write replaces it', async (t) => {
  const home = await temporaryHome(t)
  const file = await writeRawState(home, '{ this is not json')

  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), undefined)

  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: TEXT })
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), TEXT)
  assert.equal((await stateOf(file)).changes[`${CWD}#${CHANGE}`].message, TEXT)
})

test('a file with the wrong shape keeps only the records it can read', async (t) => {
  const home = await temporaryHome(t)
  const changes = {
    [`${CWD}#${CHANGE}`]: { message: 42 },
    [`${CWD}#${OTHER_CHANGE}`]: { message: `  ${TEXT}  ` },
    'no-separator': { message: 'not a record either' },
  }
  // `__proto__` has to arrive as an own key of the parsed object, which an object
  // literal cannot express — it would set the prototype instead — so it is spliced
  // into the JSON text.
  const text = JSON.stringify({ changes, extra: 'ignored' })
    .replace('{"changes":{', '{"changes":{"__proto__":{"message":"not a record"},')
  const file = await writeRawState(home, text)

  assert.equal(
    await readCommitMessage({ home, cwd: CWD, change: CHANGE }),
    undefined,
    'a message that is not a string is not a message',
  )
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: OTHER_CHANGE }), TEXT)

  // The next write keeps what was readable and rewrites the file in the documented
  // shape, dropping the rest.
  await writeCommitMessage({ home, cwd: CWD, change: OTHER_CHANGE, message: 'Настроить вкладку' })
  const stored = await stateOf(file)
  assert.deepEqual(Object.keys(stored), ['changes'])
  assert.deepEqual(Object.keys(stored.changes), [`${CWD}#${OTHER_CHANGE}`])
  assert.equal(stored.changes[`${CWD}#${OTHER_CHANGE}`].message, 'Настроить вкладку')
})

test('a changes map that is not an object reads as nothing stored', async (t) => {
  const home = await temporaryHome(t)
  await writeRawState(home, JSON.stringify({ changes: 'not a map' }))

  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), undefined)
  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: TEXT })
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), TEXT)
})

test('deleting drops one record, keeps the others, and is a no-op the second time', async (t) => {
  const home = await temporaryHome(t)
  const file = stateFileOf(home)
  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: TEXT })
  await writeCommitMessage({ home, cwd: CWD, change: OTHER_CHANGE, message: 'Настроить вкладку' })

  await deleteCommitMessage({ home, cwd: CWD, change: CHANGE })
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), undefined)
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: OTHER_CHANGE }), 'Настроить вкладку')

  // The record is what is deleted when the change is done, not the container: the
  // file stays, so the next run of this change finds an empty state rather than none.
  await deleteCommitMessage({ home, cwd: CWD, change: CHANGE })
  assert.deepEqual(
    Object.keys((await stateOf(file)).changes),
    [stateKeyOf({ cwd: CWD, change: OTHER_CHANGE })],
  )
})

test('deleting from a state that does not exist does not create the file', async (t) => {
  const home = await temporaryHome(t)

  await deleteCommitMessage({ home, cwd: CWD, change: CHANGE })
  assert.deepEqual(await readdir(join(home, STATE_DIRECTORY)).catch(() => []), [])
})

test('writing creates the storages directory of a fresh home', async (t) => {
  const home = await temporaryHome(t)
  await writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: TEXT })

  assert.deepEqual(await readdir(home), [STATE_DIRECTORY])
})

test('empty arguments are rejected instead of writing a record nothing could find', async (t) => {
  const home = await temporaryHome(t)

  await assert.rejects(
    () => writeCommitMessage({ home, cwd: CWD, change: CHANGE, message: '   ' }),
    /requires a non-empty message text/u,
  )
  await assert.rejects(() => writeCommitMessage({ home, cwd: '', change: CHANGE, message: TEXT }), /non-empty cwd/u)
  await assert.rejects(() => writeCommitMessage({ home, cwd: CWD, change: '', message: TEXT }), /non-empty change/u)
  await assert.rejects(() => readCommitMessage({ home: '', cwd: CWD, change: CHANGE }), /non-empty home/u)
  assert.throws(() => stateFileOf(''), /non-empty home/u)
  assert.throws(() => stateKeyOf({ cwd: CWD, change: '' }), /non-empty change/u)
})
