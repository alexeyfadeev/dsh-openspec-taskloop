// Tests for the task loop (tasks 4.2–4.3, 5.1–5.4): the wait between a message and the
// next reading, the two ways a run can end — the task is checked and the run
// advances, or it is not and the run stops without sending anything else — the
// stop that ends a run from outside, and the session handoff at a group boundary,
// including the phase and the session id the loop publishes as the work moves.
// The one exception to "unchecked ends the run" is pinned with the parking tests: a run
// resumed after a pause re-sends the task whose turn that pause cancelled, once, and the
// unchecked box of any other turn stops it as before (design D6 of the UI change). The same
// tests pin the phase a pause may not cut short: a pause that lands while a finished group
// is being reviewed and committed parks the run after that hook, not inside it (design D5).
//
// The ladder of the divergence change is pinned here from the loop's side (5.1–5.4): a row
// whose wording drifted is looked up by number, the accepted drift replaces the identity the
// run holds, and the two bands the plugin may not settle alone are driven by the seams it is
// given — one adjudication turn for `gray`, a question alone for `major` — with the calls
// counted, because "no turn was sent" is part of the contract (design D5, D6). The stops the
// ladder can end with are pinned apart as well (5.3, 5.4): a row whose number is gone is
// `gone`, the three ways of leaving a wording unvouched-for are one `diverged` kind told apart
// by its `decision` (design D7), and a row the reading cannot identify at all is
// `unidentified` with the refusal that made it so (design D10).
//
// The agent is scripted rather than real: `whenIdle()` resolves on demand, so the
// tests can pin that the plugin reads `tasks.md` only *after* the turn went quiet
// — the ordering is the contract, not just the final outcome.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { COMPACTION_END, ON_FAILURE } from '../lib/compaction.js'
import { ADJUDICATION_END, DIVERGENCE, DIVERGENCE_ANSWER, DIVERGENCE_REFUSAL, classifyDivergence } from '../lib/diverged.js'
import { DIVERGENCE_DECISION, GROUP_END, LOOP_END, runLoop } from '../lib/loop.js'
import { RUN_PHASE, createRuns } from '../lib/runs.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apply')

/**
 * Read one captured apply fixture.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {string} raw document text.
 */
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8')

const CWD = 'C:\\projects\\demo'
const CHANGE = 'add-taskloop-plugin'

/**
 * Build the exit facts of one CLI call.
 *
 * @param {string} stdout - collected stdout.
 * @param {number} [exitCode] - process exit code.
 * @returns {object} a settled CLI result.
 */
const cliResult = (stdout, exitCode = 0) => ({ exitCode, stdout, stderr: '', truncated: false })

/**
 * The captured ready document with task 2.3 ticked, as it looks after its turn.
 *
 * Derived from `ready.json` instead of being a second captured file, so the two
 * documents cannot drift apart in anything but the checkbox under test.
 *
 * @returns {string} JSON text of the progressed document.
 */
function progressedDocument() {
  const document = JSON.parse(fixture('ready.json'))
  document.tasks.find((task) => task.line === 12).done = true
  document.progress = { total: 20, complete: 5, remaining: 15 }
  return JSON.stringify(document)
}

/**
 * The captured ready document with the given rows ticked, as it looks after their
 * turns.
 *
 * @param {number[]} lines - rows to tick.
 * @returns {string} JSON text of the progressed document.
 */
function tickedDocument(lines) {
  const document = JSON.parse(fixture('ready.json'))
  for (const task of document.tasks) {
    if (lines.includes(task.line)) task.done = true
  }
  document.progress = { total: 20, complete: 4 + lines.length, remaining: 16 - lines.length }
  return JSON.stringify(document)
}

/**
 * A captured document with the given rows ticked, leaving its counts alone.
 *
 * Used for the unnumbered document, where only the checkboxes matter to the test.
 *
 * @param {string} text - document to tick rows in.
 * @param {number[]} lines - rows to tick.
 * @returns {string} JSON text of the changed document.
 */
function tickedDocumentIn(text, lines) {
  const document = JSON.parse(text)
  for (const task of document.tasks) {
    if (lines.includes(task.line)) task.done = true
  }
  return JSON.stringify(document)
}

/**
 * The captured ready document with every `N.M` prefix stripped, i.e. a flat run.
 *
 * Built from the numbered document so the two differ in nothing but the numbering,
 * which is the whole input of the grouping decision (design D5).
 *
 * @returns {string} JSON text of the unnumbered document.
 */
function flatDocument() {
  const document = JSON.parse(fixture('ready.json'))
  for (const task of document.tasks) {
    task.description = task.description.replace(/^\d+\.\d+ /u, '')
  }
  return JSON.stringify(document)
}

/**
 * The captured ready document with the row at `line` removed, as it looks after
 * an edit that moved the task out from under the run.
 *
 * @param {number} line - line of the row to drop.
 * @returns {string} JSON text of the shortened document.
 */
function withoutLine(line) {
  const document = JSON.parse(fixture('ready.json'))
  document.tasks = document.tasks.filter((task) => task.line !== line)
  return JSON.stringify(document)
}

/** Note a model appends to a row it also ticks: the incident's shape (design D4). */
const NOTE = ' (примечание: резолвер вынесен в отдельный модуль)'

/**
 * A document with one row's wording edited, as `tasks.md` reads after the model
 * reworded the row it was given.
 *
 * The appended note keeps the sent text intact, which is the `minor` drift of the
 * incident: the row is still the same task, and the run has to accept it.
 *
 * @param {string} text - document to edit.
 * @param {number} line - row to reword.
 * @param {string} [note] - text appended to that row.
 * @returns {string} JSON text of the edited document.
 */
function reworded(text, line, note = NOTE) {
  const document = JSON.parse(text)
  document.tasks.find((task) => task.line === line).description += note
  return JSON.stringify(document)
}

/**
 * The same edit with a line inserted above the row, as `tasks.md` reads when the
 * model also wrote something above the task it reworded.
 *
 * @param {string} text - document to edit.
 * @param {number} line - row to reword, in the reading before the insertion.
 * @param {string} [note] - text appended to that row.
 * @returns {string} JSON text of the edited document.
 */
function rewordedBelow(text, line, note = NOTE) {
  const document = JSON.parse(text)
  for (const task of document.tasks) {
    if (task.line >= line) task.line += 1
    if (task.line === line + 1) task.description += note
  }
  return JSON.stringify(document)
}

/** The wording task 2.3 carries in the captured document, as the run sends it. */
const SENT_2_3 = '2.3 Реализовать разбор `openspec instructions apply --json` и выбор первой '
  + 'невыполненной задачи; проверить тестами состояния `ready`, `blocked` и `all_done`'

/** Row 2.3 with its opening rewritten and its tail kept: the uncertain band (design D5). */
const GRAY_2_3 = '2.3 Разобрать JSON-вывод `openspec instructions apply` и выбрать первую '
  + 'невыполненную задачу; проверить тестами состояния `ready`, `blocked` и `all_done`'

/** Row 2.3 replaced by an unrelated task under the same number: the major band (design D6). */
const MAJOR_2_3 = '2.3 Обновить README и раздел про настройки'

/**
 * A document with one row's wording replaced wholesale, as `tasks.md` reads when the
 * model rewrote the row it was given rather than appending to it.
 *
 * @param {string} text - document to edit.
 * @param {number} line - row to rewrite.
 * @param {string} description - the wording that row now carries.
 * @returns {string} JSON text of the edited document.
 */
function renamed(text, line, description) {
  const document = JSON.parse(text)
  document.tasks.find((task) => task.line === line).description = description
  return JSON.stringify(document)
}

/**
 * The captured ready document with every checkbox ticked, as it reads after the
 * last task of the run.
 *
 * @returns {string} JSON text of the completed document.
 */
function completedDocument() {
  const document = JSON.parse(fixture('ready.json'))
  for (const task of document.tasks) task.done = true
  document.state = 'all_done'
  document.progress = { total: 20, complete: 20, remaining: 0 }
  document.instruction = 'All tracked tasks are complete.'
  return JSON.stringify(document)
}

/**
 * A document with every checkbox but one ticked, as it reads just before that
 * task's turn — the run has a single task left to send.
 *
 * @param {number} line - row to leave unchecked.
 * @returns {string} JSON text of the document.
 */
function documentWithOnly(line) {
  const document = JSON.parse(fixture('ready.json'))
  for (const task of document.tasks) task.done = task.line !== line
  document.progress = { total: 20, complete: 19, remaining: 1 }
  return JSON.stringify(document)
}

/**
 * The given document with every checkbox ticked, in whatever numbering it has.
 *
 * @param {string} text - document to complete.
 * @returns {string} JSON text of the completed document.
 */
function completedIn(text) {
  const document = JSON.parse(text)
  for (const task of document.tasks) task.done = true
  document.state = 'all_done'
  document.progress = { total: 20, complete: 20, remaining: 0 }
  return JSON.stringify(document)
}

/**
 * The given document with every checkbox but one ticked, leaving its counts alone.
 *
 * @param {string} text - document to change.
 * @param {number} line - row to leave unchecked.
 * @returns {string} JSON text of the document.
 */
function onlyLineUndone(text, line) {
  const document = JSON.parse(text)
  for (const task of document.tasks) task.done = task.line !== line
  return JSON.stringify(document)
}

/**
 * The progressed document with the CLI blocking the change, as it reads when an
 * artifact disappears between two tasks.
 *
 * @returns {string} JSON text of the blocked document.
 */
function blockedDocument() {
  const document = JSON.parse(progressedDocument())
  document.state = 'blocked'
  document.instruction = 'Cannot apply this change yet. Missing artifacts: specs.'
  return JSON.stringify(document)
}

/**
 * A fake CLI that answers each call from a script and records the calls.
 *
 * @param {object[]} responses - settled results, consumed in call order.
 * @param {string[]} events - shared ordering log.
 * @returns {object} the fake wrapper with a `calls` log.
 */
function scriptedCli(responses, events) {
  const calls = []
  return {
    calls,
    async run(args, options) {
      calls.push({ args, options })
      events.push('read')
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`)
      return next
    },
  }
}

/**
 * The label a step message names, e.g. `2.3`.
 *
 * @param {object} message - user message produced by the step.
 * @returns {string} the task label.
 */
function labelOf(message) {
  const match = /выполни task ([^,]+),/u.exec(message.content[0].text)
  assert.ok(match, `message does not name a task: ${message.content[0].text}`)
  return match[1]
}

/**
 * Drive the loop against a scripted CLI and an agent that goes idle immediately.
 *
 * @param {object[]} responses - settled CLI results, consumed in call order.
 * @param {object} [agentOverrides] - methods merged over the scripted agent.
 * @returns {{cli: object, agent: object, messages: object[], events: string[], loop: Function}} the harness.
 */
function harness(responses, agentOverrides = {}) {
  const messages = []
  const events = []
  const agent = {
    id: 'agent-1',
    followup(message) {
      messages.push(message)
      events.push(`followup ${labelOf(message)}`)
    },
    async whenIdle() {
      events.push('idle')
    },
    ...agentOverrides,
  }
  const cli = scriptedCli(responses, events)
  return {
    cli,
    agent,
    messages,
    events,
    loop: (overrides = {}) => runLoop({
      cli,
      cwd: CWD,
      change: CHANGE,
      agent,
      signal: undefined,
      ...overrides,
    }),
  }
}

/**
 * Wait until a condition the loop is expected to reach holds.
 *
 * Used by the parking tests: the loop is entreated to reach a gate or a reading, and
 * there is no event to subscribe to — the run slot only records that the state changed.
 * Each attempt is one event-loop turn, so the loop's own awaits run in between.
 *
 * @param {() => boolean} predicate - condition to wait for.
 * @returns {Promise<void>} resolves once the condition held at least once.
 */
async function until(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('the condition did not hold within 500 event-loop turns')
}

test('a checked task advances the run to the next one, and the file is read after the turn', async () => {
  // 2.3 is ticked after its turn; 2.4 is sent next and stays unchecked.
  const { cli, messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(progressedDocument()),
  ])
  const noted = []

  const outcome = await loop({ onTask: (task) => noted.push(task.line) })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  // No row was reworded, so the outcome carries no acceptances at all — not an empty list: the
  // report only learns about a change of wording when there was one (6.2).
  assert.equal(outcome.accepted, undefined)
  // The run's position is published task by task, as each message leaves.
  assert.deepEqual(noted, [12, 13])
  assert.equal(messages.length, 2)
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
  // The re-reading only happens once the agent is idle: a read taken during the
  // turn would see the old checkbox and stop a healthy run.
  assert.deepEqual(events, [
    'read',
    'followup 2.3',
    'idle',
    'read',
    'followup 2.4',
    'idle',
    'read',
  ])
  assert.equal(cli.calls.length, 3)
})

test('a task left unchecked stops the run with no further message', async () => {
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(fixture('ready.json')),
  ])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.equal(outcome.task.line, 12)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(messages.length, 1)
  assert.equal(cli.calls.length, 2)
  assert.deepEqual(outcome.instructions.progress, { total: 20, complete: 4, remaining: 16 })
})

test('the last checked task completes the run', async () => {
  const { messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(completedDocument()),
  ])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.completed)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(messages.length, 1)
})

test('a change that is already complete sends nothing and never waits', async () => {
  const { cli, messages, loop } = harness([cliResult(fixture('all-done.json'))])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.completed)
  assert.deepEqual(outcome.sent, [])
  assert.equal(outcome.task, undefined)
  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 1)
})

test('a change blocked after a turn stops before the next task', async () => {
  // The model ticked 2.3, and the next read now blocks the change: the run stops
  // instead of sending the task that follows.
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(blockedDocument()),
  ])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.blocked)
  assert.match(outcome.reason, /Missing artifacts: specs/)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(messages.length, 1)
  assert.equal(cli.calls.length, 2)
})

test('a task whose row is gone from the file stops the run as `gone`', async () => {
  // Design D7: the number is the second key, and it found nothing in the file the task came
  // from — the row was deleted, not reworded. With no second wording there is nothing to
  // classify, so the stop is named after what is missing rather than after a drift.
  const sentRow = JSON.parse(fixture('ready.json')).tasks.find((task) => task.line === 12)
  const { cli, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(withoutLine(12)),
  ])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.gone)
  // Neither a decision nor a band belongs to this stop: nobody was asked and nothing was compared.
  assert.equal('decision' in outcome, false)
  assert.equal('divergence' in outcome, false)
  // The report names the row where it was sent, which is what the user has to go looking for.
  assert.equal(outcome.task.line, 12)
  assert.equal(outcome.task.sourcePath, sentRow.sourcePath)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(cli.calls.length, 2)
})

test('a reworded row in a flat list stops as `unidentified` with `number-missing`', async () => {
  // Design D10 and the spec's «Задача без номера»: a flat row has no second key, so a reworded
  // one can be told neither from the task that was sent nor from a replacement. The stop says
  // that — not `gone`, which claims the row was removed while it is still in the file — and it
  // asks nobody: there is no band to settle, because nothing could be compared.
  const adjudicated = []
  const asked = []
  const flat = flatDocument()
  const edited = renamed(flat, 12, 'Разобрать вывод CLI и выбрать первую невыполненную задачу')
  const { cli, messages, loop } = harness([
    cliResult(flat),
    cliResult(edited),
  ])

  const outcome = await loop({
    adjudicate: async (context) => {
      adjudicated.push(context)
      return { kind: ADJUDICATION_END.untouched }
    },
    confirmDiverged: async (context) => {
      asked.push(context)
      return { kind: DIVERGENCE_ANSWER.continue }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unidentified)
  // The reason names the key the reading lacked, which is what makes the stop actionable.
  assert.equal(outcome.reason, DIVERGENCE_REFUSAL.numberMissing)
  // Nobody decided anything and no band was measured, so neither field belongs to this stop.
  assert.equal('decision' in outcome, false)
  assert.equal('divergence' in outcome, false)
  // The row is named where it was sent: without a number, that address is all the user has.
  assert.equal(outcome.task.line, 12)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(messages.length, 1)
  assert.equal(adjudicated.length, 0)
  assert.equal(asked.length, 0)
  assert.equal(cli.calls.length, 2)
})

test('a numbered row left with nothing but its number stops as `unidentified` too', async () => {
  // The same impossibility from the other side (design D10): the number was found, and the row
  // says nothing else, so no band may be measured. The reason travels with the stop rather than
  // collapsing into the flat list's, because the report names them apart (task 6.1).
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(renamed(fixture('ready.json'), 12, '2.3')),
  ])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.unidentified)
  assert.equal(outcome.reason, DIVERGENCE_REFUSAL.emptyText)
  assert.equal('decision' in outcome, false)
  assert.equal('divergence' in outcome, false)
  assert.equal(outcome.task.line, 12)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(messages.length, 1)
  assert.equal(cli.calls.length, 2)
})

test('a ticked task with an appended note is accepted and the run moves on', async () => {
  // The incident's shape (design D4): the model ticked 2.3 and rewrote its text, so the
  // verbatim triple misses. The sent wording survived inside the new one, which is a
  // minor drift: the run reads the new row as the same task and continues to 2.4.
  const { cli, messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(reworded(progressedDocument(), 12)),
    cliResult(progressedDocument()),
  ])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
  assert.deepEqual(events, [
    'read',
    'followup 2.3',
    'idle',
    'read',
    'followup 2.4',
    'idle',
    'read',
  ])
  assert.equal(cli.calls.length, 3)
  // The wording the run adopted travels with the outcome, band included, so the report can
  // name the change without turning it into a stop (6.2).
  assert.deepEqual(
    outcome.accepted.map((entry) => [entry.task.description.split(' ')[0], entry.divergence]),
    [['2.3', DIVERGENCE.minor]],
  )
})

test('an accepted wording on an unchecked row is sent again with the new text', async () => {
  // The model reworded 2.3, left it unchecked and pushed it down a line. The accepted row
  // replaces the run's position (design D4), so the task goes out again — at its new line
  // and with the wording the file now holds — instead of stopping as unmarked.
  const edited = rewordedBelow(fixture('ready.json'), 12)
  const moved = JSON.parse(edited).tasks.find((task) => task.line === 13)
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(edited),
    cliResult(edited),
  ])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.3'])
  assert.equal(outcome.sent[1].description, moved.description)
  assert.equal(outcome.sent[1].line, 13)
  assert.equal(cli.calls.length, 3)
})

test('the rows the ladder tests use fall in the bands they claim', () => {
  // The precondition of the tests below: the appended-note row is `minor`, the rewritten one
  // is `gray` and the replaced one is `major`. Pinning it here means a change of thresholds
  // cannot quietly move a case out of the band whose branch the test is meant to exercise.
  const row = JSON.parse(fixture('ready.json')).tasks.find((task) => task.line === 12)

  assert.equal(row.description, SENT_2_3)
  assert.equal(classifyDivergence(SENT_2_3, GRAY_2_3).kind, DIVERGENCE.gray)
  assert.equal(classifyDivergence(SENT_2_3, MAJOR_2_3).kind, DIVERGENCE.major)
})

test('an uncertain divergence the model ticks is taken as the same task', async () => {
  // Design D5: the gray band gets exactly one turn, and its verdict is read off the row's
  // checkbox — so the run adopts the wording the model confirmed and moves on to 2.4.
  const adjudicated = []
  const asked = []
  const grayUnchecked = renamed(fixture('ready.json'), 12, GRAY_2_3)
  const grayTicked = renamed(tickedDocument([12]), 12, GRAY_2_3)
  const { agent, cli, messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(grayUnchecked),
    cliResult(grayTicked),
    cliResult(grayTicked),
  ])

  const outcome = await loop({
    adjudicate: async (context) => {
      adjudicated.push(context)
      return { kind: ADJUDICATION_END.ticked }
    },
    confirmDiverged: async (context) => {
      asked.push(context)
      return { kind: DIVERGENCE_ANSWER.continue }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
  // The turn names both wordings of the one row and the recipient that received it.
  assert.equal(adjudicated.length, 1)
  assert.equal(adjudicated[0].change, CHANGE)
  assert.equal(adjudicated[0].agent, agent)
  assert.equal(adjudicated[0].previous, SENT_2_3)
  assert.equal(adjudicated[0].task.description, GRAY_2_3)
  assert.equal(asked.length, 0, 'a ticked row is the verdict, so nobody is asked')
  // The turn is followed by a reading of the file rather than by the verdict itself: only a
  // checkbox in `tasks.md` may declare a task done.
  assert.deepEqual(events, [
    'read',
    'followup 2.3',
    'idle',
    'read',
    'read',
    'followup 2.4',
    'idle',
    'read',
  ])
  assert.equal(cli.calls.length, 4)
  // The wording the turn confirmed is an adopted one too, and its band says which rung of the
  // ladder adopted it (6.2).
  assert.deepEqual(
    outcome.accepted.map((entry) => [entry.task.description.split(' ')[0], entry.divergence]),
    [['2.3', DIVERGENCE.gray]],
  )
})

test('an uncertain divergence the model leaves alone asks the user, who sends it again', async () => {
  // Design D5: an untouched row means the same task is unproven, so the question of design D6
  // is asked. `Продолжить` sends the task again with the wording the file now holds.
  const adjudicated = []
  const asked = []
  const gray = renamed(fixture('ready.json'), 12, GRAY_2_3)
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(gray),
    cliResult(gray),
  ])

  const outcome = await loop({
    adjudicate: async (context) => {
      adjudicated.push(context)
      return { kind: ADJUDICATION_END.untouched }
    },
    confirmDiverged: async (context) => {
      asked.push(context)
      return { kind: DIVERGENCE_ANSWER.continue }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 12])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.3'])
  // The re-sent task carries the wording the file holds, not the one that was sent first:
  // an adopted wording replaces the identity the run compares against.
  assert.equal(outcome.sent[1].description, GRAY_2_3)
  assert.equal(adjudicated.length, 1)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].previous, SENT_2_3)
  assert.equal(asked[0].task.description, GRAY_2_3)
  assert.equal(cli.calls.length, 3)
})

test('an uncertain divergence on a ticked row asks the user without a turn', async () => {
  // Design D5: the work is done and there is no verdict left to observe, so the model is not
  // asked at all. The question decides whether the ticked row is the task that was sent.
  const adjudicated = []
  const asked = []
  const grayTicked = renamed(tickedDocument([12]), 12, GRAY_2_3)
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(grayTicked),
    cliResult(grayTicked),
  ])

  const outcome = await loop({
    adjudicate: async (context) => {
      adjudicated.push(context)
      return { kind: ADJUDICATION_END.ticked }
    },
    confirmDiverged: async (context) => {
      asked.push(context)
      return { kind: DIVERGENCE_ANSWER.continue }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
  assert.equal(adjudicated.length, 0, 'a ticked row is not worth an adjudication turn')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].task.done, true)
  assert.equal(cli.calls.length, 3)
})

test('a significant divergence asks the user without a turn', async () => {
  // Design D6: a wording with almost nothing in common with the one that was sent is nobody's
  // call but the user's, and the model is not asked — the gray band's turn settles
  // uncertainty, it does not grant a rewrite.
  const adjudicated = []
  const asked = []
  const major = renamed(fixture('ready.json'), 12, MAJOR_2_3)
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(major),
    cliResult(major),
  ])

  const outcome = await loop({
    adjudicate: async (context) => {
      adjudicated.push(context)
      return { kind: ADJUDICATION_END.ticked }
    },
    confirmDiverged: async (context) => {
      asked.push(context)
      return { kind: DIVERGENCE_ANSWER.continue }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 12])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.3'])
  assert.equal(outcome.sent[1].description, MAJOR_2_3)
  assert.equal(adjudicated.length, 0, 'the significant band gets no turn')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].task.description, MAJOR_2_3)
  assert.equal(cli.calls.length, 3)
})

test('a user who declines the question ends the run as `diverged` with `declined`', async () => {
  // Design D6/D7: `Остановить taskloop` — and a closed card, which the question service reports
  // as the same answer — leaves the wording unvouched-for. The task is not sent, and the stop
  // says which of the ways it ended: a person said no.
  const asked = []
  const major = renamed(fixture('ready.json'), 12, MAJOR_2_3)
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(major),
  ])

  const outcome = await loop({
    confirmDiverged: async (context) => {
      asked.push(context)
      return { kind: DIVERGENCE_ANSWER.stop }
    },
  })

  assert.equal(outcome.kind, LOOP_END.diverged)
  assert.equal(outcome.decision, DIVERGENCE_DECISION.declined)
  // The band travels with the decision, so the report can name how far the wording drifted.
  assert.equal(outcome.divergence, DIVERGENCE.major)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(outcome.task.line, 12)
  assert.equal(messages.length, 1, 'a wording nobody vouched for is not sent again')
  assert.equal(asked.length, 1)
  assert.equal(cli.calls.length, 2)
})

test('a stop that lands while the question is open ends the run as cancelled', async () => {
  // `/taskloop stop` aborts the run's signal, and the card is asked with that signal, so the
  // question service reports a dismissal rather than an answer (4.2). That must not be read as
  // a person declining the wording (5.3): the run was stopped, and the stop wins over whatever
  // the card was about — the same way it wins over a completed turn, a review and a compaction.
  const controller = new AbortController()
  const major = renamed(fixture('ready.json'), 12, MAJOR_2_3)
  const { messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(major),
  ])

  const outcome = await loop({
    signal: controller.signal,
    confirmDiverged: async () => {
      controller.abort()
      return { kind: DIVERGENCE_ANSWER.stop }
    },
  })

  assert.equal(outcome.kind, LOOP_END.cancelled)
  // Nothing decided the wording, because nobody was left to decide it.
  assert.equal('decision' in outcome, false)
  assert.equal('divergence' in outcome, false)
  assert.equal(messages.length, 1, 'a stopped run sends nothing after the card')
})

test('a deployment nobody can ask ends the run as `diverged` with `no-channel`', async () => {
  // The same place in the ladder, told apart by design D7: the question reports that this
  // deployment has no channel (task 4.2), so nobody declined — there was nobody to decline.
  const major = renamed(fixture('ready.json'), 12, MAJOR_2_3)
  const { messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(major),
  ])

  const outcome = await loop({
    confirmDiverged: async () => ({ kind: DIVERGENCE_ANSWER.unavailable }),
  })

  assert.equal(outcome.kind, LOOP_END.diverged)
  assert.equal(outcome.decision, DIVERGENCE_DECISION.noChannel)
  assert.equal(outcome.divergence, DIVERGENCE.major)
  assert.equal(messages.length, 1)
})

test('a run with no seam to ask through stops as `diverged` with `no-channel`', async () => {
  // Design D8: both seams are optional and either absence is a stop rather than a guess. Two
  // absences meet the same decision, because in both the band needs an answer the deployment
  // cannot obtain: a significant row nobody was asked about, and an uncertain row with no turn
  // to settle it.
  const major = renamed(fixture('ready.json'), 12, MAJOR_2_3)
  const significant = harness([cliResult(fixture('ready.json')), cliResult(major)])
  const withoutQuestion = await significant.loop()

  assert.equal(withoutQuestion.kind, LOOP_END.diverged)
  assert.equal(withoutQuestion.decision, DIVERGENCE_DECISION.noChannel)
  assert.equal(withoutQuestion.divergence, DIVERGENCE.major)

  const gray = renamed(fixture('ready.json'), 12, GRAY_2_3)
  const uncertain = harness([cliResult(fixture('ready.json')), cliResult(gray)])
  const withoutTurn = await uncertain.loop()

  assert.equal(withoutTurn.kind, LOOP_END.diverged)
  assert.equal(withoutTurn.decision, DIVERGENCE_DECISION.noChannel)
  assert.equal(withoutTurn.divergence, DIVERGENCE.gray)
  assert.equal(uncertain.messages.length, 1, 'neither a task nor a turn is sent')
})

test('a ticked row under a replaced wording stops as `diverged` with `already-done`', async () => {
  // Design D7: the work happened, but under a wording nobody recognises, so nothing is left to
  // send and nothing is asked — not the model (5.2), and not the user, who could only answer a
  // question about a task that is already performed.
  const adjudicated = []
  const asked = []
  const tickedMajor = renamed(tickedDocument([12]), 12, MAJOR_2_3)
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(tickedMajor),
  ])

  const outcome = await loop({
    adjudicate: async (context) => {
      adjudicated.push(context)
      return { kind: ADJUDICATION_END.ticked }
    },
    confirmDiverged: async (context) => {
      asked.push(context)
      return { kind: DIVERGENCE_ANSWER.continue }
    },
  })

  assert.equal(outcome.kind, LOOP_END.diverged)
  assert.equal(outcome.decision, DIVERGENCE_DECISION.alreadyDone)
  assert.equal(outcome.divergence, DIVERGENCE.major)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(messages.length, 1)
  assert.equal(adjudicated.length, 0, 'the significant band gets no turn')
  assert.equal(asked.length, 0, 'a ticked row leaves nothing to ask about')
  assert.equal(cli.calls.length, 2)
})

test('an agent without whenIdle is refused before anything is read or sent', async () => {
  const { cli, messages, loop } = harness([], { whenIdle: undefined })

  await assert.rejects(() => loop(), /whenIdle/)
  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 0)
})

test('an agent without followup is refused before anything is read or sent', async () => {
  const { cli, messages, loop } = harness([], { followup: undefined })

  await assert.rejects(() => loop(), /followup/)
  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 0)
})

test('a cancelled run stops waiting and sends nothing more', async () => {
  const controller = new AbortController()
  let idleCalls = 0
  const { cli, messages, loop } = harness(
    [cliResult(fixture('ready.json')), cliResult(progressedDocument())],
    {
      whenIdle() {
        idleCalls += 1
        return new Promise(() => {})
      },
    },
  )

  const running = loop({ signal: controller.signal })
  // Let the first message leave and the wait begin before cancelling.
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()

  const outcome = await running

  assert.equal(outcome.kind, LOOP_END.cancelled)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(messages.length, 1)
  assert.equal(cli.calls.length, 1, 'no re-read after a cancelled wait')
  assert.equal(idleCalls, 1)
})

test('a run cancelled before its first read sends nothing and has no reading', async () => {
  const { cli, messages, loop } = harness([])
  const controller = new AbortController()
  controller.abort()

  const outcome = await loop({ signal: controller.signal })

  assert.equal(outcome.kind, LOOP_END.cancelled)
  assert.deepEqual(outcome.sent, [])
  assert.equal(outcome.task, undefined)
  // The report falls back to the listing's counts instead of inventing a reading.
  assert.equal(outcome.instructions, undefined)
  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 0)
})

test('a read cut short by a stop ends the run as cancelled, not as a failure', async () => {
  const controller = new AbortController()
  const calls = []
  const cli = {
    async run(args) {
      calls.push(args)
      // The stop lands while the read is in flight; the real wrapper rejects an
      // aborted call, and the loop must report the stop rather than the error.
      controller.abort()
      throw new Error('openspec instructions apply --change add-taskloop-plugin --json was aborted')
    },
  }
  const messages = []
  const agent = {
    id: 'agent-1',
    followup(message) {
      messages.push(message)
    },
    async whenIdle() {},
  }

  const outcome = await runLoop({
    cli,
    cwd: CWD,
    change: CHANGE,
    agent,
    signal: controller.signal,
  })

  assert.equal(outcome.kind, LOOP_END.cancelled)
  assert.equal(calls.length, 1)
  assert.equal(messages.length, 0)
})

test('a pause during a turn parks the run before it reads the next task', async () => {
  // The pause lands while 2.3's turn is still running. The first parking point is right
  // after that turn went quiet (design D3 of the UI change), so the reading that follows
  // belongs to the resumed run: a parked run must not spend a CLI call or a task on it.
  const { run } = createRuns().start(CHANGE)
  let pausedOnce = false
  const { cli, messages, loop } = harness(
    [
      cliResult(fixture('ready.json')),
      cliResult(progressedDocument()),
      cliResult(progressedDocument()),
    ],
    {
      async whenIdle() {
        if (pausedOnce) return
        pausedOnce = true
        // Inside the turn: the loop is waiting for exactly this call to resolve.
        run.pause()
      },
    },
  )

  const running = loop({
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
  })

  await until(() => cli.calls.length === 1 && messages.length === 1)
  // Give the loop the turns it would need to read: the gate holds it before the read.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cli.calls.length, 1, 'a parked run reads nothing')
  assert.equal(messages.length, 1, 'a parked run sends nothing')

  run.resume()
  const outcome = await running

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.equal(cli.calls.length, 3, 'the reading after the pause is the resumed run\'s first')
  assert.equal(messages.length, 2)
})

test('a pause during a reading parks the run before the task leaves', async () => {
  // The reading is in flight when the pause arrives. The second parking point is right
  // before the message (design D3 of the UI change): the task the reading chose waits for
  // the resume instead of being sent into a run the user asked to hold.
  const { run } = createRuns().start(CHANGE)
  const calls = []
  const messages = []
  let settleFirstRead
  const cli = {
    run(args) {
      calls.push(args)
      if (calls.length === 1) {
        return new Promise((resolve) => {
          settleFirstRead = () => resolve(cliResult(fixture('ready.json')))
        })
      }
      return Promise.resolve(cliResult(fixture('ready.json')))
    },
  }
  const agent = {
    id: 'agent-1',
    followup(message) {
      messages.push(message)
    },
    async whenIdle() {},
  }

  const running = runLoop({
    cli,
    cwd: CWD,
    change: CHANGE,
    agent,
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
  })

  await until(() => calls.length === 1)
  run.pause()
  settleFirstRead()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(messages, [], 'the reading the pause interrupted sends nothing')

  run.resume()
  const outcome = await running

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.equal(messages.length, 1)
  assert.equal(labelOf(messages[0]), '2.3', 'the resumed run sends the task it had selected')
  assert.equal(calls.length, 2)
})

test('a resumed run re-sends the task its pause left unchecked', async () => {
  // The pause lands inside 2.3's turn, so that turn ends with the box unticked. That is the
  // user's cancellation rather than a failed task (design D6 of the UI change), and the
  // resumed run sends 2.3 again. The allowance is spent by that check: the task after it
  // (2.4) leaves its box unchecked and stops the run as it always did.
  const { run } = createRuns().start(CHANGE)
  let pausedOnce = false
  const { cli, messages, loop } = harness(
    [
      cliResult(fixture('ready.json')),
      cliResult(fixture('ready.json')),
      cliResult(progressedDocument()),
      cliResult(progressedDocument()),
    ],
    {
      async whenIdle() {
        if (pausedOnce) return
        pausedOnce = true
        // Inside the turn: the pause arrives while the loop is waiting for this turn.
        run.pause()
      },
    },
  )

  const running = loop({
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
    resumePending: () => run.takeResumePending(),
  })

  await until(() => run.paused)
  run.resume()
  const outcome = await running

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.equal(outcome.task.line, 13)
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.3', '2.4'], 'the cancelled task went out again')
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 12, 13])
  assert.equal(cli.calls.length, 4)
})

test('the allowance a resume grants is spent by the first check', async () => {
  // The task sent after the resume stays unchecked as well. The second check is an ordinary
  // failure: the allowance belonged to the resumption and not to the task, so the run stops
  // instead of sending 2.3 a third time (design D6 of the UI change).
  const { run } = createRuns().start(CHANGE)
  let pausedOnce = false
  const { cli, messages, loop } = harness(
    [
      cliResult(fixture('ready.json')),
      cliResult(fixture('ready.json')),
      cliResult(fixture('ready.json')),
    ],
    {
      async whenIdle() {
        if (pausedOnce) return
        pausedOnce = true
        run.pause()
      },
    },
  )

  const running = loop({
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
    resumePending: () => run.takeResumePending(),
  })

  await until(() => run.paused)
  run.resume()
  const outcome = await running

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.3'])
  assert.equal(cli.calls.length, 3)
})

test('a resume that released a pause taken before the message grants no allowance', async () => {
  // This pause parked the run before 2.3 left, so no turn was cancelled. The resumed run's
  // own turn leaves 2.3 unchecked, and that is the ordinary failure: the run stops instead of
  // sending the task a second time (design D6 of the UI change).
  const { run } = createRuns().start(CHANGE)
  const calls = []
  const messages = []
  let settleFirstRead
  const cli = {
    run(args) {
      calls.push(args)
      if (calls.length === 1) {
        return new Promise((resolve) => {
          settleFirstRead = () => resolve(cliResult(fixture('ready.json')))
        })
      }
      return Promise.resolve(cliResult(fixture('ready.json')))
    },
  }
  const agent = {
    id: 'agent-1',
    followup(message) {
      messages.push(message)
    },
    async whenIdle() {},
  }

  const running = runLoop({
    cli,
    cwd: CWD,
    change: CHANGE,
    agent,
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
    resumePending: () => run.takeResumePending(),
  })

  await until(() => calls.length === 1)
  run.pause()
  settleFirstRead()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(messages, [], 'the reading the pause interrupted sends nothing')

  run.resume()
  const outcome = await running

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.equal(messages.length, 1, 'the resumed task went out once')
  assert.equal(labelOf(messages[0]), '2.3')
  assert.equal(calls.length, 2)
})

test('a pause during the review of a finished group parks the run only after the hook', async () => {
  // 2.4's turn completes group 2, so the loop is inside the group hook when the pause
  // arrives — the one phase whose turn a pause may not cancel (design D5 of the UI change).
  // Reviewing and committing work that is already ticked off is allowed to run to its end,
  // and the run then parks before the next task: 3.1 neither leaves nor opens its session.
  const both = tickedDocument([12, 13])
  const { cli, messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(both),
    cliResult(both),
    cliResult(both),
  ])
  const { run } = createRuns().start(CHANGE, { sessionId: 'session-1' })
  const phases = []
  const opens = []
  const prompts = []

  const running = loop({
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
    resumePending: () => run.takeResumePending(),
    onPhase: (phase) => {
      phases.push(phase)
      run.setPhase(phase)
    },
    onGroupComplete: async (context) => {
      // The pause lands while the group is being closed. The phase is what says a turn here
      // may not be cut short, and the hook keeps going: the park waits for it to finish.
      assert.equal(run.phase, RUN_PHASE.boundary, 'the group is closed in the boundary phase')
      run.pause()
      events.push(`review ${context.range.from}-${context.range.to}`)
      await new Promise((resolve) => setImmediate(resolve))
      events.push('commit')
    },
    openSession: async () => {
      opens.push('session-2')
      return {
        sessionId: 'session-2',
        followup(message) {
          prompts.push(labelOf(message))
          events.push(`prompt ${labelOf(message)}`)
        },
        async whenIdle() {},
      }
    },
  })

  // Parked with the hook behind it: the group is closed, and nothing of the next one has
  // started — no message, no CLI call, no session.
  await until(() => run.paused && phases.length === 2)
  assert.deepEqual(phases, [RUN_PHASE.boundary, RUN_PHASE.task],
    'the run leaves the boundary once the group is closed')
  assert.deepEqual(events, [
    'read',
    'followup 2.3',
    'idle',
    'read',
    'followup 2.4',
    'idle',
    'read',
    'review 2.1-2.4',
    'commit',
  ])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'], 'a parked run sends nothing')
  assert.equal(cli.calls.length, 3, 'a parked run reads nothing')
  assert.deepEqual(opens, [], 'the next group\'s session waits for the resume')

  run.resume()
  const outcome = await running

  // The pause released no task whose turn it cancelled, so its allowance is spent at the
  // gate: 3.1's own unchecked box ends the run as an ordinary failure instead of a re-send.
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'],
    'the resumed task left in the new group\'s session, not the invocation\'s')
  assert.deepEqual(prompts, ['3.1'], 'the next task went out once, after the resume')
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13, 17])
  assert.deepEqual(opens, ['session-2'])
  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.equal(cli.calls.length, 4, 'the resumed run reads once and sends 3.1 once')
})

test('a new group continues in a session opened for it, and the run stays there', async () => {
  // 2.3 and 2.4 belong to group 2; 3.1 opens group 3 and must run elsewhere.
  const both = tickedDocument([12, 13])
  const { messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(both),
    cliResult(both),
  ])
  const opened = []
  const sessionMessages = []

  const outcome = await loop({
    openSession: async (context) => {
      opened.push(context)
      events.push('open')
      return {
        sessionId: 'session-2',
        followup(message) {
          sessionMessages.push(message)
          events.push(`prompt ${labelOf(message)}`)
        },
        async whenIdle() {
          events.push('session idle')
        },
      }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13, 17])
  // The first two tasks stayed in the invocation's session; 3.1 went to the new one.
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
  assert.deepEqual(sessionMessages.map(labelOf), ['3.1'])
  assert.deepEqual(outcome.sessions.map((entry) => entry.sessionId), ['session-2'])
  assert.deepEqual(outcome.sessions.map((entry) => entry.task.line), [17])
  // The handoff names the change, the task just completed and the task it leads to:
  // that is everything the environment needs to open the session.
  assert.equal(opened.length, 1)
  assert.equal(opened[0].change, CHANGE)
  assert.equal(opened[0].previous.line, 13)
  assert.equal(opened[0].task.line, 17)
  // The boundary is crossed after the group-2 turn went quiet and before its own
  // task leaves; the wait that follows is for the new session's turn.
  assert.deepEqual(events, [
    'read',
    'followup 2.3',
    'idle',
    'read',
    'followup 2.4',
    'idle',
    'read',
    'open',
    'prompt 3.1',
    'session idle',
    'read',
  ])
})

test('the run slot follows the phase of a boundary and the session the work moves into', async () => {
  // 2.3 and 2.4 close group 2; 3.1 opens group 3 in a session of its own.
  const both = tickedDocument([12, 13])
  const { loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(both),
    cliResult(both),
  ])
  const { run } = createRuns().start(CHANGE, { sessionId: 'session-1' })
  const phases = []

  const outcome = await loop({
    onPhase: (phase) => run.setPhase(phase),
    onSession: (sessionId) => run.setSession(sessionId),
    onGroupComplete: () => {
      // Read from the slot while the group is being closed: this is the moment a pause
      // must not cancel a turn (design D5), so it is the moment the phase has to say so.
      phases.push(run.phase)
    },
    openSession: async () => ({
      sessionId: 'session-2',
      followup() {},
      async whenIdle() {},
    }),
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(phases, [RUN_PHASE.boundary], 'a finished group is closed in the boundary phase')
  assert.equal(run.phase, RUN_PHASE.task, 'the run leaves the boundary once the group is closed')
  assert.equal(run.sessionId, 'session-2', 'the slot names the session the work moved into')
})

test('the run slot keeps the counts of the last reading, so a poll needs no CLI call', async () => {
  // 2.3 is ticked after its turn, so the reading that follows reports one more task done
  // than the one the run started from: the slot must show the latest counts it was told.
  const { cli, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(progressedDocument()),
  ])
  const { run } = createRuns().start(CHANGE)
  const seen = []

  const outcome = await loop({
    onProgress: (progress) => {
      run.setProgress(progress)
      seen.push(run.snapshot().progress)
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  // Every reading publishes its own counts, in the order the loop took them.
  assert.deepEqual(seen, [
    { complete: 4, total: 20 },
    { complete: 5, total: 20 },
    { complete: 5, total: 20 },
  ])
  // The snapshot itself is memory: three reads happened because three turns did, not
  // because anybody asked for the state.
  assert.deepEqual(run.snapshot().progress, { complete: 5, total: 20 })
  assert.equal(cli.calls.length, 3)
})

test('a boundary without a way to open a session stops instead of continuing in place', async () => {
  const both = tickedDocument([12, 13])
  const { messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(both),
  ])

  await assert.rejects(() => loop(), /group boundary but runLoop has no openSession/)

  // The failing step sent nothing: 3.1 never reached the session the run was leaving.
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
})

test('a flat run never opens a session', async () => {
  const flat = flatDocument()
  const { messages, loop } = harness([
    cliResult(flat),
    cliResult(tickedDocumentIn(flat, [12])),
    cliResult(tickedDocumentIn(flat, [12])),
  ])
  let opened = 0

  const outcome = await loop({
    openSession: async () => {
      opened += 1
      throw new Error('a flat run must not open a session')
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.deepEqual(outcome.sessions, [])
  assert.equal(opened, 0)
  // Both tasks were sent to the invocation's session, in order.
  assert.equal(messages.length, 2)
})

test('a stop during the session handoff sends nothing into the new session', async () => {
  const controller = new AbortController()
  const both = tickedDocument([12, 13])
  const { messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(both),
  ])
  const sessionMessages = []

  const outcome = await loop({
    signal: controller.signal,
    openSession: async () => {
      controller.abort()
      return {
        sessionId: 'session-2',
        followup(message) {
          sessionMessages.push(message)
        },
        async whenIdle() {},
      }
    },
  })

  assert.equal(outcome.kind, LOOP_END.cancelled)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.deepEqual(outcome.sessions, [])
  assert.deepEqual(sessionMessages, [])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
})

test('a transition inside a group compacts before the next message, a boundary does not', async () => {
  // 2.3 and 2.4 share group 2; 3.1 opens group 3. Only the first transition is a
  // compaction: the second replaces the session instead, and the new context is
  // empty by construction (design D7).
  const both = tickedDocument([12, 13])
  const { agent, messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(both),
    cliResult(both),
  ])
  const compacted = []
  const sessionMessages = []

  const outcome = await loop({
    compact: async (recipient, signal) => {
      compacted.push({ recipient, signal })
      events.push('compact')
      return { kind: COMPACTION_END.compacted, attempts: 1, delays: [] }
    },
    openSession: async () => {
      events.push('open')
      return {
        sessionId: 'session-2',
        followup(message) {
          sessionMessages.push(message)
          events.push(`prompt ${labelOf(message)}`)
        },
        async whenIdle() {
          events.push('session idle')
        },
      }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13, 17])
  // Compaction happens after the turn of 2.3 went quiet and before 2.4 is sent,
  // and it targets the session that will take the task.
  assert.equal(compacted.length, 1)
  assert.equal(compacted[0].recipient, agent)
  assert.equal(compacted[0].signal, undefined)
  assert.deepEqual(events, [
    'read',
    'followup 2.3',
    'idle',
    'read',
    'compact',
    'followup 2.4',
    'idle',
    'read',
    'open',
    'prompt 3.1',
    'session idle',
    'read',
  ])
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
  assert.deepEqual(sessionMessages.map(labelOf), ['3.1'])
})

test('a flat run compacts on every transition and never opens a session', async () => {
  const flat = flatDocument()
  const { messages, events, loop } = harness([
    cliResult(flat),
    cliResult(tickedDocumentIn(flat, [12])),
    cliResult(tickedDocumentIn(flat, [12])),
  ])
  let compactions = 0

  const outcome = await loop({
    compact: async () => {
      compactions += 1
      events.push('compact')
      return { kind: COMPACTION_END.compacted, attempts: 1, delays: [] }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.equal(compactions, 1)
  assert.deepEqual(outcome.sessions, [])
  // A flat task has no `N.M` label (design D5), so the step names its id.
  assert.deepEqual(events, [
    'read',
    `followup ${labelOf(messages[0])}`,
    'idle',
    'read',
    'compact',
    `followup ${labelOf(messages[1])}`,
    'idle',
    'read',
  ])
})

test('a failed compaction stops the run under the break policy', async () => {
  const { cli, messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
  ])

  const outcome = await loop({
    onFailure: ON_FAILURE.break,
    compact: async () => ({
      kind: COMPACTION_END.failed,
      attempts: 3,
      delays: [1000, 2000],
      code: 'summary',
      error: new Error('manual compaction failed: summary'),
    }),
  })

  assert.equal(outcome.kind, LOOP_END.compaction)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(outcome.task.line, 12)
  assert.equal(outcome.compaction.attempts, 3)
  assert.equal(outcome.compaction.code, 'summary')
  // The backend's own sentence rides along: a code is a category, and a failed
  // compaction without one still has a reason the report must be able to name.
  assert.equal(outcome.compaction.reason, 'manual compaction failed: summary')
  // The withheld task is named by the outcome, and it never reached the session.
  assert.equal(outcome.compaction.task.line, 13)
  // A stop is the whole answer: nothing was carried past the failed compaction.
  assert.deepEqual(outcome.warnings, [])
  assert.equal(messages.length, 1)
  assert.equal(cli.calls.length, 2, 'no reading after the failed compaction')
})

test('a failed compaction under the continue policy warns and sends the task anyway', async () => {
  const { cli, messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(progressedDocument()),
  ])

  const outcome = await loop({
    onFailure: ON_FAILURE.continue,
    compact: async () => {
      events.push('compact')
      return { kind: COMPACTION_END.failed, attempts: 2, delays: [1000], code: 'busy' }
    },
  })

  // 2.4 went out uncompacted and, being unchecked, stopped the run as usual: the
  // policy changes what a failed compaction costs, not what an unfinished task does.
  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  assert.equal(outcome.warnings.length, 1)
  assert.equal(outcome.warnings[0].task.line, 13)
  assert.equal(outcome.warnings[0].attempts, 2)
  assert.equal(outcome.warnings[0].code, 'busy')
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
  // The compaction is still attempted between the two messages: `continue` skips
  // the bound, not the attempt.
  assert.deepEqual(events, [
    'read',
    'followup 2.3',
    'idle',
    'read',
    'compact',
    'followup 2.4',
    'idle',
    'read',
  ])
})

test('each failed compaction under the continue policy leaves its own warning', async () => {
  // A flat run compacts on every transition (design D5), so two failures in a row
  // are two warnings — one per task that went out without compression.
  const flat = flatDocument()
  const { messages, loop } = harness([
    cliResult(flat),
    cliResult(tickedDocumentIn(flat, [12])),
    cliResult(tickedDocumentIn(flat, [12, 13])),
    cliResult(tickedDocumentIn(flat, [12, 13])),
  ])
  let compactions = 0

  const outcome = await loop({
    onFailure: ON_FAILURE.continue,
    compact: async () => {
      compactions += 1
      return {
        kind: COMPACTION_END.failed,
        attempts: 1,
        delays: [],
        code: compactions === 1 ? 'busy' : 'summary',
      }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.equal(compactions, 2)
  assert.deepEqual(outcome.warnings.map((warning) => warning.task.line), [13, 17])
  assert.deepEqual(outcome.warnings.map((warning) => warning.code), ['busy', 'summary'])
  assert.equal(messages.length, 3)
})

test('an unknown compaction policy is refused before anything is read or sent', async () => {
  const { cli, messages, loop } = harness([])

  await assert.rejects(() => loop({ onFailure: 'retry' }), /compaction\.onFailure policy: retry/)

  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 0)
})

test('a stop that lands during compaction ends the run as cancelled', async () => {
  const controller = new AbortController()
  const { messages, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
  ])

  const outcome = await loop({
    signal: controller.signal,
    compact: async () => {
      controller.abort()
      return { kind: COMPACTION_END.cancelled, attempts: 1, delays: [] }
    },
  })

  assert.equal(outcome.kind, LOOP_END.cancelled)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
  assert.equal(messages.length, 1)
})

test('a completed intermediate group is announced before the next group is opened', async () => {
  // 2.3 and 2.4 are the remainder of group 2; once both are ticked the group is
  // whole and group 3 must start in a session of its own.
  const both = tickedDocument([12, 13])
  const { events, agent, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(both),
    cliResult(both),
  ])
  const completed = []

  const outcome = await loop({
    onGroupComplete: async (context) => {
      completed.push(context)
      events.push('group')
      return { kind: GROUP_END.closed }
    },
    openSession: async () => {
      events.push('open')
      return {
        sessionId: 'session-2',
        followup(message) {
          events.push(`prompt ${labelOf(message)}`)
        },
        async whenIdle() {
          events.push('session idle')
        },
      }
    },
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  // One announcement, and it names the whole group, not just the task that closed it.
  assert.equal(completed.length, 1)
  assert.equal(completed[0].change, CHANGE)
  assert.deepEqual(completed[0].tasks.map((task) => task.line), [10, 11, 12, 13])
  assert.deepEqual(completed[0].range, { from: '2.1', to: '2.4' })
  // The group names the recipient that drove it, so an action taken at the boundary
  // (the commit, 4.3) can speak in the session whose transcript the group is in.
  assert.equal(completed[0].agent, agent)
  // The hook answered `closed`, which is what a run with the boundary stop off answers at
  // every boundary (10.3): group 3 still opens a session of its own and takes 3.1 there.
  assert.equal('boundary' in outcome, false)
  assert.deepEqual(outcome.sessions.map((session) => [session.sessionId, session.task.line]), [['session-2', 17]])
  // The break between 2.3 and 2.4 is not a group end, and the announcement comes
  // after verification but before the next group's session exists (design D13).
  assert.deepEqual(events, [
    'read',
    'followup 2.3',
    'idle',
    'read',
    'followup 2.4',
    'idle',
    'read',
    'group',
    'open',
    'prompt 3.1',
    'session idle',
    'read',
  ])
})

test('a group the run reached by a handoff is announced with the session that drove it', async () => {
  // Group 2 closes in the invocation's session; group 3 closes in the session the run
  // moved to at the boundary. The hook must name that runner rather than the original
  // agent: it is the session whose transcript holds the group, and therefore the one a
  // commit taken at the boundary can speak in (4.3).
  const { loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(tickedDocument([12])),
    cliResult(tickedDocument([12, 13])),
    cliResult(tickedDocument([12, 13, 17])),
    cliResult(tickedDocument([12, 13, 17, 18])),
    cliResult(tickedDocument([12, 13, 17, 18, 19])),
  ])
  const completed = []
  const runner = {
    sessionId: 'session-2',
    followup() {},
    async whenIdle() {},
  }

  const outcome = await loop({
    onGroupComplete: (context) => {
      completed.push(context)
      // Stop at the second boundary: the test is about which recipient it names,
      // not about the run that would follow it.
      return completed.length === 2
        ? { kind: GROUP_END.commit, commit: { tool: 'git', message: 'stop here' } }
        : { kind: GROUP_END.closed }
    },
    openSession: async () => runner,
  })

  assert.equal(outcome.kind, LOOP_END.commit)
  assert.equal(completed.length, 2)
  assert.equal(completed[0].agent.id, 'agent-1')
  assert.equal(completed[1].agent, runner)
})

test('a completed final group is announced before the run settles as complete', async () => {
  // Only 7.1 is left, so the turn that ticks it closes group 7 — a group with no
  // following task, which is exactly what the announcement must not depend on.
  const { events, loop } = harness([
    cliResult(documentWithOnly(40)),
    cliResult(completedDocument()),
  ])
  const completed = []

  const outcome = await loop({
    onGroupComplete: (context) => {
      completed.push(context)
      events.push('group')
    },
  })

  assert.equal(outcome.kind, LOOP_END.completed)
  assert.equal(completed.length, 1)
  assert.deepEqual(completed[0].tasks.map((task) => task.line), [40, 41, 42])
  assert.deepEqual(completed[0].range, { from: '7.1', to: '7.3' })
  assert.deepEqual(events, ['read', 'followup 7.1', 'idle', 'read', 'group'])
})

test('a flat run is announced once at the end, with no task range', async () => {
  // A flat list has no groups: the whole set closes together, and only when every
  // checkbox is ticked (design D13).
  const flat = flatDocument()
  const { loop } = harness([
    cliResult(onlyLineUndone(flat, 5)),
    cliResult(completedIn(flat)),
  ])
  const completed = []

  const outcome = await loop({
    onGroupComplete: (context) => completed.push(context),
  })

  assert.equal(outcome.kind, LOOP_END.completed)
  assert.equal(completed.length, 1)
  assert.equal(completed[0].tasks.length, 20)
  assert.equal(completed[0].range, undefined)
  assert.equal('range' in completed[0], false)
})

test('an unchecked task announces no completed group', async () => {
  // The group is complete only when `tasks.md` says so; a task left unchecked stops
  // the run before any review could be due.
  const { loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(fixture('ready.json')),
  ])
  const completed = []

  const outcome = await loop({
    onGroupComplete: (context) => completed.push(context),
  })

  assert.equal(outcome.kind, LOOP_END.unmarked)
  assert.deepEqual(completed, [])
})

test('a commit the group hook could not close stops the run at the boundary', async () => {
  // 2.4's turn completes group 2, and the commit that follows the review is refused by
  // the tool. The group is ticked off, the history did not move, so the run may not
  // carry on into group 3 (4.3, design D15/D17).
  const both = tickedDocument([12, 13])
  const { messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(progressedDocument()),
    cliResult(both),
  ])
  const failure = {
    kind: 'failed',
    tool: 'git',
    message: 'Добавить эндпоинт. Tasks 2.1 - 2.4',
    command: 'git commit',
    exitCode: 128,
    reason: 'fatal: not a git repository',
    range: { from: '2.1', to: '2.4' },
  }

  const outcome = await loop({
    onGroupComplete: async (context) => {
      events.push('group')
      return { kind: GROUP_END.commit, commit: failure }
    },
    openSession: async () => {
      events.push('open')
      throw new Error('the session of group 3 must not be opened after a failed commit')
    },
  })

  assert.equal(outcome.kind, LOOP_END.commit)
  // The hook's account travels unchanged: the loop does not interpret what the tool said.
  assert.deepEqual(outcome.commit, failure)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  // Nothing followed the group: no reading, no session for 3.1, no message.
  assert.deepEqual(events, ['read', 'followup 2.3', 'idle', 'read', 'followup 2.4', 'idle', 'read', 'group'])
  assert.equal(messages.length, 2)
})

test('a group the hook stops at ends the run before the next session exists', async () => {
  // 2.4's turn closes group 2 while group 3 still has tasks: with the boundary stop on,
  // the boundary is where the run ends, not where a session is opened (10.3, design D21).
  const both = tickedDocument([12, 13])
  const { messages, events, loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(tickedDocument([12])),
    cliResult(both),
  ])
  const completed = []

  const outcome = await loop({
    onGroupComplete: (context) => {
      completed.push(context)
      events.push('group')
      return { kind: GROUP_END.boundary }
    },
    openSession: async () => {
      events.push('open')
      throw new Error('the next group must not open a session when the run stops at the boundary')
    },
  })

  assert.equal(outcome.kind, LOOP_END.stoppedAtGroup)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12, 13])
  // The report names the group that closed and the task the next `/taskloop` continues
  // from: the stop was decided against the selection, after the announcement.
  assert.deepEqual(outcome.boundary.range, { from: '2.1', to: '2.4' })
  assert.equal(outcome.boundary.next.line, 17)
  assert.equal(completed.length, 1)
  assert.deepEqual(events, ['read', 'followup 2.3', 'idle', 'read', 'followup 2.4', 'idle', 'read', 'group'])
  assert.equal(messages.length, 2)
})

test('a boundary stop the hook asks for at the final group still ends the run as complete', async () => {
  // A boundary with nothing left to run is not a stop: the final group of the change
  // ends the run as complete, and the report never offers a continuation (10.3, D21).
  const { events, loop } = harness([
    cliResult(documentWithOnly(40)),
    cliResult(completedDocument()),
  ])
  const completed = []

  const outcome = await loop({
    onGroupComplete: (context) => {
      completed.push(context)
      events.push('group')
      return { kind: GROUP_END.boundary }
    },
  })

  assert.equal(outcome.kind, LOOP_END.completed)
  assert.equal(completed.length, 1)
  assert.deepEqual(completed[0].range, { from: '7.1', to: '7.3' })
  // Nothing was left to continue, so the run did not stop at the boundary — it finished.
  assert.equal('boundary' in outcome, false)
  assert.deepEqual(events, ['read', 'followup 7.1', 'idle', 'read', 'group'])
})

test('a flat run that closes its only group completes instead of stopping at a boundary', async () => {
  // A flat list has one group — the whole list — and it closes only when nothing is
  // left unchecked, so there is never a task to leave for the next run (10.3, D21).
  const flat = flatDocument()
  const { loop } = harness([
    cliResult(onlyLineUndone(flat, 5)),
    cliResult(completedIn(flat)),
  ])
  const completed = []

  const outcome = await loop({
    onGroupComplete: (context) => {
      completed.push(context)
      return { kind: GROUP_END.boundary }
    },
  })

  assert.equal(outcome.kind, LOOP_END.completed)
  assert.equal(completed.length, 1)
  assert.equal(completed[0].range, undefined)
  assert.equal('boundary' in outcome, false)
})

test('a refused commit outranks the boundary stop the same boundary would allow', async () => {
  // The hook answers one thing, and a failed commit is that answer: group 3 is still
  // waiting, yet the run ends as `commit`, not `stoppedAtGroup` (10.3, design D21).
  const both = tickedDocument([12, 13])
  const { loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(tickedDocument([12])),
    cliResult(both),
  ])
  const failure = {
    tool: 'git',
    message: 'Добавить эндпоинт. Tasks 2.1 - 2.4',
    exitCode: 1,
    reason: 'nothing to commit, working tree clean',
  }

  const outcome = await loop({
    onGroupComplete: () => ({ kind: GROUP_END.commit, commit: failure }),
  })

  assert.equal(outcome.kind, LOOP_END.commit)
  assert.deepEqual(outcome.commit, failure)
  assert.equal('boundary' in outcome, false)
  // There was a task to stop for, so priority settled the run, not the boundary.
  assert.equal(outcome.instructions.tasks.some((task) => task.line === 17 && !task.done), true)
})
