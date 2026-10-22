// Tests for the task loop (tasks 4.2–4.3, 5.1): the wait between a message and the
// next reading, the two ways a run can end — the task is checked and the run
// advances, or it is not and the run stops without sending anything else — the
// stop that ends a run from outside, and the session handoff at a group boundary.
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
import { LOOP_END, runLoop } from '../lib/loop.js'

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
