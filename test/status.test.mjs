// Tests for the run snapshot the interface polls (tasks 6.1–6.2).
//
// `lib/status.js` is the one reader of the run slot that answers instead of acting: it
// says whether a run is active and, if it is, repeats what the run already knows. Three
// states matter to a badge and a dialog, so all three are pinned here: a working run, a
// parked one, and no run at all.
//
// The rule behind every assertion is that nothing is invented. A field the run has not
// filled in stays unknown, and a freed slot says only that it is free — the previous
// run's change and task must not survive it (design D7).
//
// The last test is the one that needs a loop: a badge polls the snapshot every other
// second, so the answer must come from the slot's memory and never from a CLI call. It
// runs the loop against a counting CLI, parks the run at its gate, polls the snapshot
// many times and pins that the count did not move — with `progress` being the counts of
// the last reading the loop made (task 6.2).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LOOP_END, runLoop } from '../lib/loop.js'
import { PAUSE_STATE, createRuns } from '../lib/runs.js'
import { statusOf } from '../lib/status.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apply')
const CWD = 'C:\\projects\\demo'
const CHANGE = 'add-taskloop-plugin'

/**
 * Read one captured apply fixture.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {string} raw document text.
 */
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8')

/**
 * Build the exit facts of one CLI call.
 *
 * @param {string} stdout - collected stdout.
 * @returns {object} a settled CLI result.
 */
const cliResult = (stdout) => ({ exitCode: 0, stdout, stderr: '', truncated: false })

/**
 * The captured ready document with task 2.3 ticked, as it looks after its turn.
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
 * Wait until a condition the loop is expected to reach holds.
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

/**
 * A task as the loop records it; the snapshot hands the same object through.
 *
 * @param {number} line - line of the task in `tasks.md`.
 * @returns {import('../lib/tasks.js').ApplyTask} the task.
 */
const task = (line) => ({
  id: `task-${line}`,
  description: `${line}. Do the work`,
  done: false,
  sourcePath: 'tasks.md',
  line,
})

test('a working run is reported with everything the slot knows', () => {
  const runs = createRuns()
  const { run } = runs.start('add-a', { cwd: 'C:\\work\\add-a', sessionId: 'session-1' })
  const current = task(12)
  run.note(current)
  run.setProgress({ complete: 5, total: 24 })

  assert.deepEqual(statusOf(runs), {
    active: true,
    phase: PAUSE_STATE.running,
    change: 'add-a',
    cwd: 'C:\\work\\add-a',
    task: current,
    progress: { complete: 5, total: 24 },
    sessionId: 'session-1',
  })
})

test('a parked run reports the paused phase and the task it stopped on', () => {
  const runs = createRuns()
  const { run } = runs.start('add-a', { cwd: 'C:\\work\\add-a', sessionId: 'session-1' })
  const current = task(12)
  run.note(current)
  run.setProgress({ complete: 5, total: 24 })
  run.pause()

  const status = statusOf(runs)

  // Parked is still active: the slot stays taken while the run waits (design D1).
  assert.equal(status.active, true)
  assert.equal(status.phase, PAUSE_STATE.paused)
  assert.equal(status.change, 'add-a')
  assert.equal(status.task, current, 'the paused run still names where it stopped')
  assert.deepEqual(status.progress, { complete: 5, total: 24 })
  assert.equal(status.sessionId, 'session-1')
})

test('a free slot reports only that no run is active', () => {
  const runs = createRuns()
  const { run } = runs.start('add-a', { cwd: 'C:\\work\\add-a', sessionId: 'session-1' })
  run.note(task(12))
  run.setProgress({ complete: 1, total: 2 })
  runs.finish(run)

  const status = statusOf(runs)

  // Exactly the absence, with no field of the run that just ended.
  assert.deepEqual(status, { active: false })
  for (const field of ['change', 'cwd', 'task', 'progress', 'sessionId']) {
    assert.equal(field in status, false, `the free slot does not mention ${field}`)
  }
})

test('a run that has sent nothing reports no task rather than the change', () => {
  const runs = createRuns()
  runs.start('add-a', { cwd: 'C:\\work\\add-a', sessionId: 'session-1' })

  const status = statusOf(runs)

  assert.equal(status.active, true)
  assert.equal(status.task, undefined, 'the change is not a task')
  assert.equal(status.progress, undefined, 'no reading has happened yet')
})

test('the slot is required, so a miswired caller is named', () => {
  assert.throws(() => statusOf(undefined), /requires the run slot/)
})

test('polling a parked run costs no CLI call and reports the last reading', async () => {
  // The pause lands while the second reading is in flight, so the counts the slot holds are
  // the ones from that reading (5/20) and not from the first (4/20): `progress` follows the
  // loop's latest reading. Once the run is parked at its gate, polling the snapshot must
  // answer from memory — no `openspec` call, no message, no await (task 6.2).
  const runs = createRuns()
  const { run } = runs.start(CHANGE, { cwd: CWD, sessionId: 'session-1' })
  const messages = []
  const agent = {
    id: 'agent-1',
    followup(message) {
      messages.push(message)
    },
    async whenIdle() {},
  }
  let settleReading
  const cli = {
    calls: [],
    async run(args) {
      cli.calls.push(args)
      if (cli.calls.length === 1) return cliResult(fixture('ready.json'))
      if (cli.calls.length === 2) {
        // Held open until the test pauses: the pause has to land inside this reading.
        await new Promise((resolve) => {
          settleReading = resolve
        })
        return cliResult(progressedDocument())
      }
      throw new Error('a parked run read the task file')
    },
  }

  const running = runLoop({
    cli,
    cwd: CWD,
    change: CHANGE,
    agent,
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
    resumePending: () => run.takeResumePending(),
    // The wiring `lib/control.js` uses: the loop's counts travel through `setProgress()`.
    onProgress: (progress) => run.setProgress(progress),
  })

  await until(() => cli.calls.length === 2 && messages.length === 1)
  run.pause()
  settleReading()
  // The gate the run parks at is right before the message the reading chose.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages.length, 1, 'the parked run sent nothing after 2.3')

  const callsBefore = cli.calls.length
  const polls = []
  for (let attempt = 0; attempt < 25; attempt += 1) polls.push(statusOf(runs))

  assert.equal(cli.calls.length, callsBefore, 'a poll of the snapshot runs no CLI')
  assert.equal(messages.length, 1, 'a poll sends nothing')
  const last = polls.at(-1)
  assert.equal(last.active, true)
  assert.equal(last.phase, PAUSE_STATE.paused)
  assert.deepEqual(last.progress, { complete: 5, total: 20 }, 'the last reading is the one reported')
  for (const poll of polls) {
    assert.deepEqual(poll.progress, { complete: 5, total: 20 }, 'every poll answers the same counts')
    // No promise means no await inside the reader, so no process or file can be behind it.
    assert.equal(typeof poll?.then, 'undefined', 'the snapshot is answered synchronously')
  }

  // A stop ends the parked run without reading either: polling was the only thing the test
  // asked of the snapshot, and it cost the run nothing.
  run.stop()
  const outcome = await running
  assert.equal(outcome.kind, LOOP_END.cancelled)
  assert.equal(cli.calls.length, callsBefore, 'a stopped parked run reads nothing')
})
