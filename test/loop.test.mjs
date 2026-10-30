// Tests for the task loop (tasks 4.2–4.3, 5.1): the wait between a message and the
// next reading, the two ways a run can end — the task is checked and the run
// advances, or it is not and the run stops without sending anything else — the
// stop that ends a run from outside, and the session handoff at a group boundary,
// including the phase and the session id the loop publishes as the work moves.
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
import { GROUP_END, LOOP_END, runLoop } from '../lib/loop.js'
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

test('a task that disappears from the file stops the run instead of guessing', async () => {
  const { loop } = harness([
    cliResult(fixture('ready.json')),
    cliResult(withoutLine(12)),
  ])

  const outcome = await loop()

  assert.equal(outcome.kind, LOOP_END.missing)
  assert.equal(outcome.task.line, 12)
  assert.deepEqual(outcome.sent.map((task) => task.line), [12])
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
