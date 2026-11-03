// Tests for `openspec instructions apply --json` parsing and task selection
// (task 2.3).
//
// Fixtures under `fixtures/apply/` are captured from openspec 1.14.1:
// `ready.json` is the live state of this change, `all-done.json` the same change
// with every checkbox ticked, `blocked.json` a change whose tracking file does
// not exist yet. Only the machine-specific temp paths were rewritten to
// `C:\projects\demo`; everything else is the CLI's own output. The remaining
// documents in these tests are written inline because they describe edge cases
// the CLI does not produce on demand (blocked with a full task list, unknown
// state, inconsistent progress).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APPLY_ERROR,
  ApplyError,
  NEXT_TASK,
  findListedTask,
  findTaskByNumber,
  parseApplyInstructions,
  RUN_STATE,
  selectNextTask,
} from '../lib/tasks.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apply')

/**
 * Parse one apply-instructions fixture.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {import('../lib/tasks.js').ApplyInstructions} parsed document.
 */
const instructionsOf = (name) => parseApplyInstructions(readFileSync(join(fixturesDir, name), 'utf8'))

/**
 * Build a minimal well-formed document around the given tasks.
 *
 * @param {object} overrides - fields merged over the defaults.
 * @returns {string} JSON text.
 */
const documentOf = (overrides = {}) =>
  JSON.stringify({
    changeName: 'demo',
    schemaName: 'spec-driven',
    state: 'ready',
    instruction: '',
    progress: { total: 0, complete: 0, remaining: 0 },
    tasks: [],
    ...overrides,
  })

test('reads a ready document without losing its task list', () => {
  const instructions = instructionsOf('ready.json')

  assert.equal(instructions.change, 'add-taskloop-plugin')
  assert.equal(instructions.schema, 'spec-driven')
  assert.equal(instructions.state, RUN_STATE.ready)
  assert.deepEqual(instructions.progress, { total: 20, complete: 4, remaining: 16 })
  assert.equal(instructions.tasks.length, 20)
  assert.deepEqual(instructions.missingArtifacts, [])
})

test('selects the first uncompleted task in file order', () => {
  const instructions = instructionsOf('ready.json')

  const selection = selectNextTask(instructions)
  assert.equal(selection.kind, NEXT_TASK.task)
  // 2.3 is the next open task in the captured document, and it sits at line 12.
  assert.match(selection.task.description, /^2\.3 /)
  assert.equal(selection.task.line, 12)
  assert.equal(selection.task.id, '5')
  assert.equal(selection.task.done, false)
  assert.ok(selection.task.sourcePath.endsWith('tasks.md'))
  // The caller keeps this object to re-find the task after the turn, so the
  // selection has to hand over the parsed entry itself, not a copy.
  assert.equal(selection.task, instructions.tasks[4])
})

test('a completed change ends the run', () => {
  const instructions = instructionsOf('all-done.json')

  assert.equal(instructions.state, RUN_STATE.allDone)
  assert.deepEqual(instructions.progress, { total: 20, complete: 20, remaining: 0 })
  assert.ok(instructions.tasks.every((task) => task.done))
  assert.match(instructions.instruction, /All tracked tasks are complete/)

  assert.deepEqual(selectNextTask(instructions), { kind: NEXT_TASK.done })
})

test('a blocked change reports the CLI reason and sends nothing', () => {
  const instructions = instructionsOf('blocked.json')

  assert.equal(instructions.state, RUN_STATE.blocked)
  assert.deepEqual(instructions.missingArtifacts, ['tasks'])
  assert.deepEqual(instructions.tasks, [])

  const selection = selectNextTask(instructions)
  assert.equal(selection.kind, NEXT_TASK.blocked)
  assert.equal(selection.reason, instructions.instruction)
  assert.match(selection.reason, /Missing artifacts: tasks/)
})

test('blocked wins over a task list that still has open work', () => {
  // The CLI blocks before reading tasks when an artifact is missing, but the
  // selection must not depend on that: a blocked state sends no task, period.
  const instructions = parseApplyInstructions(
    documentOf({
      state: 'blocked',
      instruction: 'Cannot apply this change yet. Missing artifacts: specs.',
      tasks: [{ id: '1', description: '1.1 Do the thing', done: false, sourcePath: 'C:/p/tasks.md', line: 5 }],
    }),
  )

  const selection = selectNextTask(instructions)
  assert.equal(selection.kind, NEXT_TASK.blocked)
  assert.match(selection.reason, /Missing artifacts: specs/)
})

test('a state the plugin does not know stops the run instead of running a task', () => {
  const instructions = parseApplyInstructions(
    documentOf({
      state: 'paused',
      instruction: '',
      tasks: [{ id: '1', description: '1.1 Do the thing', done: false, sourcePath: 'C:/p/tasks.md', line: 5 }],
    }),
  )

  const selection = selectNextTask(instructions)
  assert.equal(selection.kind, NEXT_TASK.blocked)
  assert.match(selection.reason, /"paused"/)
})

test('ready without an uncompleted listed task is idle, not done', () => {
  // Checkboxes with no text count in `progress` but are not listed, so a ready
  // document can run out of listed work while work remains in the file.
  const instructions = parseApplyInstructions(
    documentOf({
      progress: { total: 2, complete: 1, remaining: 1 },
      tasks: [{ id: '1', description: '1.1 Do the thing', done: true, sourcePath: 'C:/p/tasks.md', line: 5 }],
    }),
  )

  const selection = selectNextTask(instructions)
  assert.equal(selection.kind, NEXT_TASK.idle)
  assert.match(selection.reason, /1 incomplete task/)
})

test('picks the first uncompleted task rather than the first task', () => {
  const instructions = parseApplyInstructions(
    documentOf({
      progress: { total: 3, complete: 1, remaining: 2 },
      tasks: [
        { id: '1', description: '1.1 Done', done: true, sourcePath: 'C:/p/tasks.md', line: 5 },
        { id: '2', description: '1.2 Open', done: false, sourcePath: 'C:/p/tasks.md', line: 6 },
        { id: '3', description: '1.3 Also open', done: false, sourcePath: 'C:/p/tasks.md', line: 7 },
      ],
    }),
  )

  const selection = selectNextTask(instructions)
  assert.equal(selection.kind, NEXT_TASK.task)
  assert.equal(selection.task.description, '1.2 Open')
  assert.equal(selection.task.line, 6)
})

test('a sent task is found again by file, line and text, whatever its checkbox says', () => {
  const sent = { id: '5', description: '2.3 Do', done: false, sourcePath: 'C:/p/tasks.md', line: 12 }

  // The checkbox is the answer the loop is looking for, so a ticked row still
  // has to be recognised as the same task.
  const after = parseApplyInstructions(documentOf({ tasks: [{ ...sent, done: true }] }))
  assert.equal(findListedTask(after, sent)?.done, true)

  // A row that moved is not the same task even when the text is identical: the
  // run cannot tell whether the tick belongs to it, so it stops instead.
  const moved = parseApplyInstructions(documentOf({ tasks: [{ ...sent, line: 13 }] }))
  assert.equal(findListedTask(moved, sent), undefined)

  const rewritten = parseApplyInstructions(documentOf({ tasks: [{ ...sent, description: '2.3 Do more' }] }))
  assert.equal(findListedTask(rewritten, sent), undefined)
})

test('a task that only moved down is found again by its number', () => {
  const sent = { id: '5', description: '2.3 Добавить парсер', done: false, sourcePath: 'C:/p/tasks.md', line: 12 }

  // A row was inserted above, so the checkbox sits two lines lower while the
  // text is untouched. The verbatim triple misses; the number does not.
  const moved = parseApplyInstructions(
    documentOf({
      tasks: [
        { id: '4', description: '2.2 Сделать что-то раньше', done: true, sourcePath: 'C:/p/tasks.md', line: 31 },
        { id: '5', description: '2.3 Добавить парсер', done: true, sourcePath: 'C:/p/tasks.md', line: 12 + 2 },
      ],
    }),
  )

  assert.equal(findListedTask(moved, sent), undefined)

  const found = findTaskByNumber(moved, sent)
  // The tick is the answer the loop is looking for, so the found row speaks for
  // itself rather than being judged by the number alone.
  assert.equal(found?.line, 14)
  assert.equal(found?.description, '2.3 Добавить парсер')
  assert.equal(found?.done, true)
})

test('a task that moved and was edited is still found by its number', () => {
  const sent = { id: '5', description: '2.3 Добавить парсер', done: false, sourcePath: 'C:/p/tasks.md', line: 12 }

  // Both halves of the identity drift at once: the line shifts and the model
  // appended a note. Only the number links the row to what was sent; whether the
  // wording is still the same task is the classifier's question, not this one's.
  const rewritten = parseApplyInstructions(
    documentOf({
      tasks: [
        { id: '5', description: '2.3 Добавить парсер — готово, покрыто тестами', done: true, sourcePath: 'C:/p/tasks.md', line: 13 },
      ],
    }),
  )

  assert.equal(findListedTask(rewritten, sent), undefined)

  const found = findTaskByNumber(rewritten, sent)
  assert.equal(found?.line, 13)
  assert.equal(found?.description, '2.3 Добавить парсер — готово, покрыто тестами')
})

test('a number the fresh reading no longer lists is not found', () => {
  const sent = { id: '5', description: '2.3 Добавить парсер', done: false, sourcePath: 'C:/p/tasks.md', line: 12 }

  const withoutIt = parseApplyInstructions(
    documentOf({
      tasks: [{ id: '5', description: '2.4 Сделать другое', done: false, sourcePath: 'C:/p/tasks.md', line: 12 }],
    }),
  )

  // No number match means the row was deleted or replaced: `gone` is the caller's
  // answer, and guessing another row would be worse than stopping.
  assert.equal(findTaskByNumber(withoutIt, sent), undefined)
})

test('two rows with the same number are told apart by the sent line', () => {
  const sent = { id: '9', description: '11.4 Проверить дубль', done: false, sourcePath: 'C:/p/tasks.md', line: 40 }

  // A list can hold the same number twice, after a copy-paste or a merge, and the
  // number alone then names two rows. Guessing would let the loop read a
  // stranger's tick as its own answer, so proximity to the sent line decides.
  const near = { id: '9', description: '11.4 Проверить дубль', done: true, sourcePath: 'C:/p/tasks.md', line: 38 }
  const far = { id: '9', description: '11.4 Проверить дубль', done: false, sourcePath: 'C:/p/tasks.md', line: 120 }

  const doubled = parseApplyInstructions(documentOf({ tasks: [far, near] }))
  assert.equal(findListedTask(doubled, sent), undefined)
  assert.equal(findTaskByNumber(doubled, sent)?.line, 38)

  // Order in the array is an accident of the document's layout, not evidence: the
  // near copy wins whether it is listed before or after the far one.
  const reversed = parseApplyInstructions(documentOf({ tasks: [near, far] }))
  assert.equal(findTaskByNumber(reversed, sent)?.line, 38)
})

test('a number that only appears in another file is not the sent task', () => {
  const sent = { id: '5', description: '2.3 Добавить парсер', done: false, sourcePath: 'C:/p/tasks.md', line: 12 }

  // Numbers are unique inside one list, not across a project: another change's
  // file also has a `2.3`, and it is even ticked. Accepting it would report
  // someone else's completed task as this run's answer.
  const elsewhere = parseApplyInstructions(
    documentOf({
      tasks: [
        { id: '5', description: '2.3 Добавить парсер', done: true, sourcePath: 'C:/p/other/tasks.md', line: 12 },
      ],
    }),
  )

  assert.equal(findTaskByNumber(elsewhere, sent), undefined)
})

test('rejects output that is not a usable document', () => {
  const cases = {
    'not JSON': 'openspec: command not found',
    'an array': '[]',
    'no state': '{"tasks":[]}',
    'no task list': '{"state":"ready"}',
    'a task without a description': documentOf({
      tasks: [{ id: '1', done: false, sourcePath: 'C:/p/tasks.md', line: 5 }],
    }),
    'a task without a source file': documentOf({
      tasks: [{ id: '1', description: '1.1 Do', done: false, line: 5 }],
    }),
    'a task without a usable line': documentOf({
      tasks: [{ id: '1', description: '1.1 Do', done: false, sourcePath: 'C:/p/tasks.md', line: 0 }],
    }),
    'a task without a boolean done flag': documentOf({
      tasks: [{ id: '1', description: '1.1 Do', sourcePath: 'C:/p/tasks.md', line: 5 }],
    }),
  }

  for (const [label, text] of Object.entries(cases)) {
    assert.throws(
      () => parseApplyInstructions(text),
      (error) => {
        assert.ok(error instanceof ApplyError, `${label}: expected ApplyError`)
        assert.equal(error.code, APPLY_ERROR.malformed, label)
        return true
      },
      label,
    )
  }
})

test('keeps additive fields out of the way and accepts a numeric id', () => {
  const instructions = parseApplyInstructions(
    JSON.stringify({
      changeName: 'demo',
      changeDir: 'C:/projects/demo/openspec/changes/demo',
      schemaName: 'spec-driven',
      contextFiles: { proposal: ['C:/projects/demo/proposal.md'] },
      progress: { total: 1, complete: 0, remaining: 1 },
      tasks: [{ id: 7, description: '1.1 Do', done: false, sourcePath: 'C:/projects/demo/tasks.md', line: 5 }],
      taskTrackingConfigured: true,
      state: 'ready',
      warnings: ['something worth knowing'],
      missingArtifacts: [],
      instruction: 'Read context files.',
    }),
  )

  assert.equal(instructions.tasks[0].id, '7')
  assert.equal(instructions.instruction, 'Read context files.')
  assert.deepEqual(instructions.missingArtifacts, [])
})

test('a missing or unusable progress block does not stop selection', () => {
  const withoutProgress = parseApplyInstructions(
    JSON.stringify({
      state: 'ready',
      tasks: [{ id: '1', description: '1.1 Do', done: false, sourcePath: 'C:/p/tasks.md', line: 5 }],
    }),
  )
  assert.equal(withoutProgress.progress, null)
  assert.equal(selectNextTask(withoutProgress).kind, NEXT_TASK.task)

  const brokenProgress = parseApplyInstructions(documentOf({ progress: { total: 1, complete: -1, remaining: 'many' } }))
  assert.equal(brokenProgress.progress, null)
})
