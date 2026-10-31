// Tests for the command actions (tasks 3.2–4.3): root check, change selection,
// the task loop's report, the single-run slot and the result text a user sees.
//
// The actions are driven with fakes for all three dependencies, so these tests
// pin the contract the Cordis seam has to satisfy — which directory the CLI is
// asked about, that a refusal writes nothing, that a second run cannot start while
// one is active, and that a failure becomes a result instead of a thrown handler —
// without a host and without `openspec` installed.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { INIT_ARGS, INIT_ANSWER } from '../lib/bootstrap.js'
import { createButBranch } from '../lib/commit.js'
import { COMMIT_TEXT } from '../lib/commit-text.js'
import { resolveConfig } from '../lib/config.js'
import { createControl } from '../lib/control.js'
import {
  EXPLORE_ANSWER,
  EXPLORE_MODE_PROMPT,
  EXPLORE_SKILL_PATH,
  sendExploreModePrompt,
  sendExplorePrompt,
} from '../lib/explore.js'
import { MIN_OPENSPEC_VERSION, OpenSpecCli } from '../lib/openspec.js'
import { PROTOCOL_SECTION } from '../lib/protocol.js'
import { createRuns } from '../lib/runs.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'listing')
const applyFixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apply')

/**
 * Read one captured listing fixture.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {string} raw document text.
 */
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8')

/**
 * Read one captured apply fixture.
 *
 * @param {string} name - file name inside the apply fixture directory.
 * @returns {string} raw document text.
 */
const applyFixture = (name) => readFileSync(join(applyFixturesDir, name), 'utf8')

/**
 * The captured ready document with task 2.3 ticked, as it looks after its turn.
 *
 * @returns {string} JSON text of the progressed document.
 */
function progressedApply() {
  const document = JSON.parse(applyFixture('ready.json'))
  document.tasks.find((task) => task.line === 12).done = true
  document.progress = { total: 20, complete: 5, remaining: 15 }
  return JSON.stringify(document)
}

const CWD = 'C:\\projects\\demo'

/**
 * The captured ready document with the given rows ticked.
 *
 * @param {number[]} lines - rows to tick.
 * @returns {string} JSON text of the progressed document.
 */
function tickedApply(lines) {
  const document = JSON.parse(applyFixture('ready.json'))
  for (const task of document.tasks) {
    if (lines.includes(task.line)) task.done = true
  }
  document.progress = { total: 20, complete: 4 + lines.length, remaining: 16 - lines.length }
  return JSON.stringify(document)
}

/**
 * The captured ready document with every `N.M` prefix stripped, i.e. a flat run.
 *
 * Built from the numbered document so the two differ in nothing but the numbering,
 * which is what makes a flat run compact on every transition (design D5).
 *
 * @returns {string} JSON text of the unnumbered document.
 */
function flatApply() {
  const document = JSON.parse(applyFixture('ready.json'))
  for (const task of document.tasks) {
    task.description = task.description.replace(/^\d+\.\d+ /u, '')
  }
  return JSON.stringify(document)
}

/**
 * Two tasks of the captured document, without their numbers, ticked as asked.
 *
 * A flat run has no groups, so the whole listed set is the unit the loop announces
 * (design D13): two tasks are enough to reach that moment, and the document stays
 * small enough to follow through the readings of one test.
 *
 * @param {number[]} done - lines that are ticked.
 * @returns {string} JSON text of the document.
 */
function twoTaskFlat(done) {
  const document = JSON.parse(applyFixture('ready.json'))
  document.tasks = document.tasks.filter((task) => task.line === 12 || task.line === 13)
  for (const task of document.tasks) {
    task.description = task.description.replace(/^\d+\.\d+ /u, '')
    task.done = done.includes(task.line)
  }
  document.progress = { total: 2, complete: done.length, remaining: 2 - done.length }
  // The CLI is what decides the run is over; a ready document with nothing left
  // unchecked is `idle` (design D4), not a completed change.
  document.state = done.length === 2 ? 'all_done' : 'ready'
  return JSON.stringify(document)
}

/**
 * A captured document with the given rows ticked, leaving its counts alone.
 *
 * @param {string} text - document to tick rows in.
 * @param {number[]} lines - rows to tick.
 * @returns {string} JSON text of the changed document.
 */
function tickedApplyIn(text, lines) {
  const document = JSON.parse(text)
  for (const task of document.tasks) {
    if (lines.includes(task.line)) task.done = true
  }
  return JSON.stringify(document)
}

/**
 * Build the exit facts of one CLI call.
 *
 * @param {string} stdout - collected stdout.
 * @param {number} [exitCode] - process exit code.
 * @returns {object} a settled CLI result.
 */
const cliResult = (stdout, exitCode = 0) => ({ exitCode, stdout, stderr: '', truncated: false })

/**
 * A fake CLI that answers each call from a script and records the calls.
 *
 * The version gate (9.2) is a method of its own, so a run that passes it spends no
 * scripted answer; `order` records both kinds of step, which is how a test sees that the
 * gate came first.
 *
 * @param {object[]} responses - settled results, consumed in call order.
 * @returns {object} the fake wrapper with a `calls` log, a `versions` count and an `order` log.
 */
function scriptedCli(responses) {
  const calls = []
  const order = []
  const cli = {
    calls,
    order,
    versions: 0,
    async ensureSupportedVersion() {
      cli.versions += 1
      order.push('version')
      return { major: 1, minor: 14, patch: 1 }
    },
    async run(args, options) {
      calls.push({ args, options })
      order.push(args.join(' '))
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`)
      if (next instanceof Error) throw next
      return next
    },
  }
  return cli
}

/**
 * A prompt service that records the sections a run registers on an agent.
 *
 * @returns {object} the service with `sections` and `disposed` logs.
 */
function recordingPrompt() {
  const sections = []
  const disposed = []
  return {
    sections,
    disposed,
    getSectionOrder: () => 500,
    section(section) {
      sections.push(section)
      return () => {
        disposed.push(section.name)
      }
    },
  }
}

/**
 * Build a control with fakes for the directory, the CLI, the confirmations and
 * the description question.
 *
 * @param {object} options
 * @param {() => object} options.createCli - factory for the fake CLI.
 * @param {Function} [options.confirm] - confirmation decision for `openspec init`.
 * @param {Function} [options.describe] - answer to the task-description question.
 * @param {object} [options.config] - raw config block.
 * @param {object} [options] - see below.
 * @param {object} [options.agent] - methods merged over the scripted agent, e.g. a
 *   `whenIdle()` the test releases to keep a run active.
 * @param {Function} [options.openSession] - way to open the session a new group runs in.
 * @param {Function} [options.compactNow] - one compaction call for the session a task runs in (6.1).
 * @param {Function} [options.compactIfNeeded] - one step-boundary compaction call (6.3).
 * @param {Function} [options.setApproval] - approval narrowing of a review session (3.3).
 * @param {Function} [options.runCommitCommand] - runner of the commit tool (4.2/4.3).
 * @param {Function} [options.normalizeEol] - the rewrite of the committed files' endings
 *   to LF that a GitButler commit performs (5.4, design D8).
 * @param {Function} [options.commitInput] - the input of this change's commits: the message
 *   text and, for GitButler, the branch (5.2, 7.3).
 * @param {Function} [options.forgetCommitText] - dropping the stored text of a finished change (5.3).
 * @param {Function} [options.cancelTurn] - the session turn a pause or a stop ends (5.2).
 * @param {object} [options.runs] - the run slot the control should use instead of creating
 *   one (7.3): the mount passes the slot its routes read, so both surfaces see one run.
 * @returns {{control: object, asked: object[], descriptions: object[], messages: object[], approvals: string[], cancellations: string[], agent: object, forgotten: object[]}}
 *   the control, the initialisation questions, the description questions, the
 *   follow-up messages, the sessions whose approvals were narrowed, the sessions whose
 *   turn a pause or a stop asked to end, the agent that received the tasks, and the
 *   changes whose stored message was dropped.
 */
function harness({
  createCli,
  confirm = async () => INIT_ANSWER.cancel,
  describe = async () => ({ kind: EXPLORE_ANSWER.cancelled }),
  config = {},
  agent: agentOverrides = {},
  openSession,
  compactNow,
  compactIfNeeded,
  setApproval,
  runCommitCommand,
  normalizeEol,
  commitInput,
  forgetCommitText,
  appendNotice,
  cancelTurn,
  runs,
}) {
  const asked = []
  const descriptions = []
  const messages = []
  const approvals = []
  const cancellations = []
  const forgotten = []
  const agent = {
    id: 'agent-1',
    followup(message) {
      messages.push(message)
    },
    async whenIdle() {},
    ...agentOverrides,
  }
  const control = createControl({
    config: resolveConfig(config),
    createCli,
    runs,
    cwdOf: () => CWD,
    askInit: async (invocation, cwd) => {
      asked.push({ invocation, cwd })
      return confirm({ cwd })
    },
    askDescription: async (invocation, cwd) => {
      descriptions.push({ invocation, cwd })
      return describe({ cwd })
    },
    followupExplore: (invocation, description) => sendExplorePrompt({
      agent: invocation.agent,
      description,
    }),
    followupExploreMode: (invocation) => sendExploreModePrompt({ agent: invocation.agent }),
    openSession,
    compactNow,
    compactIfNeeded,
    setApproval: async (sessionId) => {
      approvals.push(sessionId)
      await setApproval?.(sessionId)
    },
    runCommitCommand,
    normalizeEol,
    commitInput,
    appendNotice,
    // Every test gets the seam, so "nothing was cancelled" is a recorded answer rather
    // than the absence of a dependency (5.2). An answer that is not `true` stands for the
    // refusals the real seam turns into a log line instead of a throw.
    cancelTurn: async (sessionId) => {
      cancellations.push(sessionId)
      return await cancelTurn?.(sessionId) ?? true
    },
    forgetCommitText: async (context) => {
      forgotten.push(context)
      await forgetCommitText?.(context)
    },
  })
  return { control, asked, descriptions, messages, approvals, cancellations, agent, forgotten }
}

/** An invocation shaped like the registry's. */
const invocation = (agent = { id: 'agent-1' }) => ({
  commandId: 'command-1',
  agent,
  rawInput: '',
  attachments: [],
  signal: new AbortController().signal,
})

test('a run stops with a report when the task is left unchecked', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, messages, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /^taskloop: OpenSpec root: .*dsh-openspec-taskloop\./)
  assert.match(result.text, /Change "add-taskloop-plugin" \(4\/20 tasks done\)/)
  assert.match(result.text, /sent task 2\.3, but tasks\.md still leaves 2\.3 unchecked/u)
  assert.match(result.text, /the run stopped and no further task was sent/)
  assert.equal(messages.length, 1)
  assert.match(messages[0].content[0].text, /выполни task 2\.3/u)
  // The listing, then the read that sent 2.3, then the read after its turn.
  assert.equal(cli.calls.length, 3)
  assert.equal(cli.calls[1].options.cwd, CWD)
})

test('a checked task advances the run to the next one', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(progressedApply()),
  ])
  const { control, messages, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /sent tasks 2\.3 and 2\.4/u)
  assert.match(result.text, /still leaves 2\.4 unchecked/)
  // The report uses the last reading, not the counts the listing carried.
  assert.match(result.text, /\(5\/20 tasks done\)/)
  assert.equal(messages.length, 2)
  assert.match(messages[1].content[0].text, /выполни task 2\.4/u)
  assert.equal(cli.calls.length, 4)
})

test('a run outlives the request that started it, and its report lands in the session', async () => {
  // The user's tab goes away — a reload, a closed window, a dropped socket — while
  // the task is still running. The host aborts the invocation's signal at that
  // moment. The run must keep driving: finish 2.3, compact, send 2.4.
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(progressedApply()),
  ])
  const request = new AbortController()
  const appended = []
  let finishTurn
  const turn = new Promise((resolve) => {
    finishTurn = resolve
  })
  const { control, messages, agent } = harness({
    createCli: () => cli,
    agent: {
      session: {
        append(type, message, options) {
          appended.push({ type, message, options })
        },
      },
      whenIdle: () => turn,
    },
  })

  const running = control.run(
    { ...invocation(agent), signal: request.signal },
    { change: null },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages.length, 1, 'the first task was sent before the request ended')

  request.abort()
  finishTurn()
  const result = await running

  // The run did not stop at 2.3: it read the file again and sent the next task.
  assert.equal(messages.length, 2)
  assert.match(messages[1].content[0].text, /выполни task 2\.4/u)
  // The command result has no reader any more, so the report is appended to the
  // session as a notice: same sentences, a channel the user still has.
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'user/message')
  assert.deepEqual(appended[0].options, { surfaceOp: 'append' })
  assert.equal(appended[0].message.source.kind, 'runtime-context')
  assert.equal(appended[0].message.source.form, 'notice')
  assert.equal(appended[0].message.content[0].text, result.text)
  assert.match(result.text, /sent tasks 2\.3 and 2\.4/u)
})

test('a live request keeps the report as the command result and appends nothing', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(progressedApply()),
  ])
  const appended = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    agent: {
      session: { append: (...args) => appended.push(args) },
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.match(result.text, /sent tasks 2\.3 and 2\.4/u)
  assert.equal(messages.length, 2)
  assert.deepEqual(appended, [], 'the user reads the report as the command result')
})

test('a run that crosses a group boundary continues in a new session and names it', async () => {
  // 2.3 and 2.4 are ticked by their turns; 3.1 opens group 3 and runs elsewhere.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const opened = []
  const sessionMessages = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    // The review that closes group 2 is a session of its own (3.3) and has its own
    // tests; here it would only add a second `openSession()` to count.
    config: { review: { enabled: false } },
    openSession: async (invocation, context) => {
      opened.push({ invocation, context })
      return {
        sessionId: 'session-2',
        followup(message) {
          sessionMessages.push(message)
        },
        async whenIdle() {},
      }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /sent tasks 2\.3, 2\.4 and 3\.1/u)
  assert.match(result.text, /still leaves 3\.1 unchecked/u)
  // The original session is told where the work went: it is the only session the
  // user is looking at, and the plugin cannot move their view (design risk).
  assert.match(result.text, /The run moved to session session-2 \(task 3\.1\) at the group boundary\./u)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].context.cwd, CWD)
  assert.equal(opened[0].context.change, 'add-taskloop-plugin')
  assert.equal(opened[0].context.previous.line, 13)
  assert.equal(opened[0].context.task.line, 17)
  assert.equal(messages.length, 2)
  assert.equal(sessionMessages.length, 1)
  assert.match(sessionMessages[0].content[0].text, /выполни task 3\.1, далее - пауза\./u)
})

test('a finished group is reviewed in a session of its own before the next group opens one', async () => {
  // 2.4's turn completes group 2, and the review settles before the loop selects
  // 3.1 — which is the moment the session of group 3 is opened (design D13). The
  // two sessions therefore cannot be the same one.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const opened = []
  const sent = []
  const { control, messages, agent, approvals } = harness({
    createCli: () => cli,
    openSession: async (invocation, context) => {
      // A review asks for its session by the work it will do; a boundary asks for
      // the session that takes over from `previous` at `task`.
      const sessionId = context.range === undefined ? 'session-2' : 'review-1'
      opened.push({ sessionId, context })
      return {
        sessionId,
        followup(message) {
          sent.push({ sessionId, message })
        },
        async whenIdle() {},
      }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.deepEqual(opened.map((entry) => entry.sessionId), ['review-1', 'session-2'])
  assert.equal(opened[0].context.change, 'add-taskloop-plugin')
  assert.deepEqual(opened[0].context.range, { from: '2.1', to: '2.4' })
  // The review borrows the opener but not the run's task machinery: neither the
  // protocol section nor the step gate describes a one-turn review.
  assert.equal('adoptAgent' in opened[0].context, false)
  assert.equal('adoptAgent' in opened[1].context, true)
  // Unattended: the policy is narrowed before the instruction enters the session.
  assert.deepEqual(approvals, ['review-1'])
  // One instruction, naming the change and the group. The run waits for the review
  // turn, so the next task leaves only after the review session went idle.
  assert.equal(sent.length, 2)
  assert.match(
    sent[0].message.content[0].text,
    /Проведи код-ревью .*change "add-taskloop-plugin" \(задачи 2\.1 - 2\.4\), далее - пауза\./u,
  )
  assert.equal(sent[1].sessionId, 'session-2')
  assert.match(sent[1].message.content[0].text, /выполни task 3\.1/u)
  assert.equal(messages.length, 2, 'the task messages stayed in the session the run started in')
  // Both ids reach the report: the review session is a place the user never watched.
  assert.match(result.text, /The review of tasks 2\.1 - 2\.4 ran in session review-1\./u)
  assert.match(result.text, /The run moved to session session-2 \(task 3\.1\) at the group boundary\./u)
})

test('a flat list is reviewed once, at the end of the run, by one instruction', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const opened = []
  const reviews = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    openSession: async (invocation, context) => {
      opened.push(context)
      return {
        sessionId: 'review-1',
        followup(message) {
          reviews.push(message)
        },
        async whenIdle() {},
      }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /all tracked tasks are complete/u)
  assert.equal(messages.length, 2)
  // No numbering, no range: the instruction names the whole list instead (D13).
  assert.equal(opened.length, 1)
  assert.equal('range' in opened[0], false)
  assert.equal(reviews.length, 1)
  assert.match(reviews[0].content[0].text, /\(весь список задач\)/u)
  assert.match(result.text, /The review of the whole task list ran in session review-1\./u)
})

test('a stop during the review ends the run and sends the next task to nobody', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  let reviewSent
  const reviewArrived = new Promise((resolve) => {
    reviewSent = resolve
  })
  const { control, messages, agent } = harness({
    createCli: () => cli,
    openSession: async () => ({
      sessionId: 'review-1',
      followup() {
        reviewSent()
      },
      // Never settles on its own: the stop is what ends the wait.
      whenIdle: () => new Promise(() => {}),
    }),
  })

  const running = control.run(invocation(agent), { change: null })
  await reviewArrived
  const stopped = await control.stop()
  const result = await running

  assert.match(stopped.text, /stopped the run for change "add-taskloop-plugin" on task/u)
  assert.match(stopped.text, /no further task was sent\./u)
  assert.match(result.text, /the run was stopped by \/taskloop stop/u)
  // The review did not finish, so the report says so instead of claiming one.
  assert.match(result.text, /The review of the whole task list was stopped in session review-1\./u)
  assert.equal(messages.length, 2, 'the task after the review was never sent')
  assert.equal(cli.calls.length, 4, 'no reading followed the stopped review')
})

test('review off means a finished group is not reviewed and the run completes', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const opened = []
  const { control, agent } = harness({
    createCli: () => cli,
    config: { review: { enabled: false } },
    openSession: async (invocation, context) => {
      opened.push(context)
      return { sessionId: 'session-2', followup() {}, async whenIdle() {} }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.doesNotMatch(result.text, /The review of/u)
  assert.deepEqual(opened, [])
})

test('a review that cannot open a session is an error, not a silent skip', async () => {
  // A deployment that composes no session opener cannot review a group, and the
  // review is required behaviour: the run says so instead of completing as if the
  // group had been checked.
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const { control, messages, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /the review of a finished group cannot open a session/u)
  assert.equal(messages.length, 2)
})

/**
 * Build the exit facts of one commit request that succeeded.
 *
 * @param {string} [stdout] - what the tool printed.
 * @returns {object} a settled request result.
 */
const toolOk = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })

/**
 * Build the exit facts of a commit request the tool refused.
 *
 * @param {number} exitCode - code the request exited with.
 * @param {object} [streams] - `stdout`/`stderr` overrides.
 * @returns {object} a settled request result.
 */
const toolNo = (exitCode, { stdout = '', stderr = '' } = {}) => ({ exitCode, stdout, stderr })

/**
 * A fake commit tool that answers by request name and records what it was asked.
 *
 * The runner is the environment's (4.2), so these tests see exactly what the plugin
 * would spawn: an argv array and a directory, never a command line.
 *
 * @param {object} answers - settled results by request name, e.g. `{ 'git status': … }`.
 * @param {string[]} [events] - shared ordering log, to pin when the tool ran (4.3).
 * @returns {object} the runner with a `calls` log.
 */
function scriptedCommitTool(answers, events = []) {
  const calls = []
  return {
    calls,
    async run(request, options) {
      const name = [request.executable, request.args[0]].join(' ')
      calls.push({ name, request, options })
      events.push(name)
      const next = answers[name]
      if (next === undefined) throw new Error(`unexpected commit request: ${name}`)
      return next
    },
  }
}

test('a finished group is committed after its review, with the message as one argument', async () => {
  // 2.4's turn completes group 2, so the review and then the commit settle before the
  // loop selects 3.1 (design D13): the review's fixes are in the tree this commit takes.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const events = []
  const tool = scriptedCommitTool({
    'git status': toolOk(' M lib/control.js\n?? lib/commit.js\n'),
    'git add': toolOk(),
    'git commit': toolOk('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n 2 files changed, 40 insertions(+)\n'),
  }, events)
  const { control, agent } = harness({
    createCli: () => cli,
    commitInput: async (invocation, context) => {
      events.push('text')
      assert.equal(context.change, 'add-taskloop-plugin')
      assert.equal(context.cwd, CWD)
      // The tool the run started with decides whether a branch question exists (D18).
      assert.equal(context.tool, 'git')
      return { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }
    },
    runCommitCommand: tool.run,
    openSession: async (invocation, context) => {
      events.push(context.range === undefined ? 'open group' : 'open review')
      return {
        sessionId: context.range === undefined ? 'session-2' : 'review-1',
        followup() {},
        async whenIdle() {},
      }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  // The text is settled before the first turn (5.2), the group is reviewed, and only
  // then does the tree get committed.
  assert.deepEqual(events, ['text', 'open review', 'git status', 'git add', 'git commit', 'open group'])
  // One argv element: no shell can split the message, and the range is the group's.
  assert.deepEqual(tool.calls[2].request.args, ['commit', '-m', 'Добавить эндпоинт. Tasks 2.1 - 2.4'])
  assert.equal(tool.calls[0].options.cwd, CWD)
  // The tool's own line is quoted: that is where the commit id is (design D17).
  assert.match(result.text, /The review of tasks 2\.1 - 2\.4 ran in session review-1\./u)
  assert.match(
    result.text,
    /The commit of tasks 2\.1 - 2\.4 through git went through: \[main 1a2b3c4\] Добавить эндпоинт\. Tasks 2\.1 - 2\.4\./u,
  )
})

test('a run asked to stop at a group boundary ends there and opens no session for the next one', async () => {
  // 2.4's turn closes group 2. With the boundary stop on (10.4, design D21) the boundary
  // still reviews and commits the group — the stop is the last step of that boundary, not
  // a branch around it — and only then ends the run, instead of opening the session that
  // would take group 3.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
  ])
  const events = []
  const tool = scriptedCommitTool({
    'git status': toolOk(' M lib/control.js\n'),
    'git add': toolOk(),
    'git commit': toolOk('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n 2 files changed, 40 insertions(+)\n'),
  }, events)
  const opened = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { boundary: { enabled: true } },
    commitInput: async () => {
      events.push('text')
      return { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }
    },
    runCommitCommand: tool.run,
    openSession: async (invocation, context) => {
      events.push(context.range === undefined ? 'open group' : 'open review')
      const sessionId = context.range === undefined ? 'session-2' : 'review-1'
      opened.push(sessionId)
      return { sessionId, followup() {}, async whenIdle() {} }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  // The whole boundary ran, in order, and the stop came after the commit: the session
  // of group 3 was never even asked for.
  assert.deepEqual(events, ['text', 'open review', 'git status', 'git add', 'git commit'])
  assert.deepEqual(opened, ['review-1'])
  // The run ended rather than waiting in the slot: the next `/taskloop` starts a run.
  assert.match(control.status().text, /no run is active/u)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /sent tasks 2\.3 and 2\.4/u)
  // Three sentences of one boundary: the group, what became of its commit, and where
  // the next `/taskloop` continues (design D21).
  assert.match(result.text, /The commit of tasks 2\.1 - 2\.4 through git went through/u)
  assert.match(
    result.text,
    /The run stopped at the boundary of task group 2 \(tasks 2\.1 - 2\.4\): no further task was sent, and the next \/taskloop continues from task 3\.1\./u,
  )
  assert.doesNotMatch(result.text, /The run moved to/u)
  // 3.1 was never sent: both messages are the tasks of the group that closed.
  assert.equal(messages.length, 2)
  assert.equal(cli.calls.length, 4, 'no reading followed the boundary stop')
})

test('a boundary stop needs no commit switch: the boundary alone ends the run', async () => {
  // The boundary stop is a setting of its own (10.4): a run with reviews and commits off
  // still has group boundaries, and the hook exists for them. Without it the loop would
  // open the session of group 3 exactly as it did before the setting existed.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
  ])
  const opened = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { review: { enabled: false }, commit: { enabled: false }, boundary: { enabled: true } },
    commitInput: async () => {
      throw new Error('a run with commits off must not ask for a commit message')
    },
    openSession: async (invocation, context) => {
      opened.push(context)
      return { sessionId: 'session-2', followup() {}, async whenIdle() {} }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.deepEqual(opened, [])
  assert.equal(messages.length, 2)
  assert.match(
    result.text,
    /The run stopped at the boundary of task group 2 \(tasks 2\.1 - 2\.4\): no further task was sent, and the next \/taskloop continues from task 3\.1\./u,
  )
  // Nothing was reviewed or committed, so the report claims neither.
  assert.doesNotMatch(result.text, /The review of/u)
  assert.doesNotMatch(result.text, /The commit of/u)
})

test('a group whose commit has no message text still stops at its boundary', async () => {
  // A boundary stop is not a reward for a commit that went through: the group is closed
  // either way, and the skip already has a sentence of its own (5.2). The run therefore
  // ends at the boundary rather than opening the next group's session over an uncommitted
  // tree.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({})
  const opened = []
  const { control, agent } = harness({
    createCli: () => cli,
    config: { review: { enabled: false }, boundary: { enabled: true } },
    runCommitCommand: tool.run,
    openSession: async (invocation, context) => {
      opened.push(context)
      return { sessionId: 'session-2', followup() {}, async whenIdle() {} }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.deepEqual(tool.calls, [])
  assert.deepEqual(opened, [])
  assert.match(
    result.text,
    /The commit of tasks 2\.1 - 2\.4 was skipped: the run has no commit message text\./u,
  )
  assert.match(result.text, /The run stopped at the boundary of task group 2/u)
})

test('the session that drove the group gets the commit id as soon as the tool commits', async () => {
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M lib/control.js\n'),
    'git add': toolOk(),
    'git commit': toolOk('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n 2 files changed, 40 insertions(+)\n'),
  })
  const notices = []
  const { control, agent } = harness({
    createCli: () => cli,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    appendNotice: async (recipient, text) => {
      notices.push({ recipient, text })
      return true
    },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  // The run itself stops on 3.1 (the scripted CLI never ticks it); what this test
  // pins is the line the commit left behind on its way out (4.3).
  assert.match(result.text, /The commit of tasks 2\.1 - 2\.4 through git went through/u)
  // The line lands in the group's own transcript, addressed to the recipient that
  // drove it (4.3): the report is read wherever the work went next, and until it
  // arrives this is the only place the id can be found.
  assert.deepEqual(notices.map((entry) => entry.text), ['taskloop: commit 1a2b3c4 for tasks 2.1 - 2.4 (git).'])
  assert.equal(notices[0].recipient, agent)
})

test('the commit line quotes the tool when its output names no id', async () => {
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk('M lib/control.js\n'),
    'git add': toolOk(),
    'git commit': toolOk('committed the tree\n'),
  })
  const notices = []
  const { control, agent } = harness({
    createCli: () => cli,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    appendNotice: async (recipient, text) => {
      notices.push({ recipient, text })
      return true
    },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  await control.run(invocation(agent), { change: null })

  // No hash is invented: the sentence says what did happen and quotes the tool.
  assert.deepEqual(notices.map((entry) => entry.text), [
    'taskloop: the commit of tasks 2.1 - 2.4 through git went through: committed the tree.',
  ])
})

test('a commit line that cannot be appended leaves the finished run a success', async () => {
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk('M lib/control.js\n'),
    'git add': toolOk(),
    'git commit': toolOk('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n'),
  })
  const { control, agent } = harness({
    createCli: () => cli,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    appendNotice: async () => {
      throw new Error('the session is already closed')
    },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  // The work is in the history and the tasks are ticked; a lost transcript line is
  // not a reason to report a failed run (design D17).
  assert.match(result.text, /went through: \[main 1a2b3c4\]/u)
})

test('an empty working tree commits nothing and appends no commit line', async () => {
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({ 'git status': toolOk('') })
  const notices = []
  const { control, agent } = harness({
    createCli: () => cli,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    appendNotice: async (recipient, text) => {
      notices.push({ recipient, text })
      return true
    },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  await control.run(invocation(agent), { change: null })

  assert.deepEqual(notices, [], 'there is no commit id to name')
})

test('a commit the tool refused stops the run and the report names the tool, the code and the reason', async () => {
  const both = tickedApply([12, 13])
  // Only four readings: a commit that failed ends the run, so nothing follows it.
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
  ])
  const opened = []
  const tool = scriptedCommitTool({
    'git status': toolOk('M lib/control.js\n'),
    'git add': toolOk(),
    'git commit': toolNo(128, { stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }),
  })
  const { control, messages, agent } = harness({
    createCli: () => cli,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    openSession: async () => {
      opened.push('review')
      return { sessionId: 'review-1', followup() {}, async whenIdle() {} }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  // The tool, its code and its own account of the failure: the user can retry by hand.
  assert.match(
    result.text,
    /the commit of tasks 2\.1 - 2\.4 through git failed at git commit with exit code 128: fatal: not a git repository/u,
  )
  assert.match(result.text, /the run stopped and no further task was sent/u)
  // The group is ticked off and the next one never starts: no message, no session.
  assert.equal(messages.length, 2)
  assert.equal(cli.calls.length, 4, 'no reading followed the failed commit')
  assert.deepEqual(opened, ['review'], 'the session of the next group was never opened')
})

test('an empty working tree is not committed and the report says there was nothing to commit', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const tool = scriptedCommitTool({ 'git status': toolOk('\n') })
  const { control, agent } = harness({
    createCli: () => cli,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    openSession: async () => ({ sessionId: 'review-1', followup() {}, async whenIdle() {} }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  // The status check is the whole commit: nothing is staged on a tree with no changes.
  assert.deepEqual(tool.calls.map((call) => call.name), ['git status'])
  assert.match(
    result.text,
    /The commit of the whole task list was skipped: the working tree had no uncommitted changes\./u,
  )
})

test('with the setting off, a tree that changed only under openspec/ is skipped and says what stayed', async () => {
  // The gate filters before it counts (D2), so this tree has nothing to commit — but it
  // is not the empty tree above, and the report has to say which one it met: a user who
  // turned the setting off needs to know the work is sitting in `openspec/` rather than
  // missing (D5). The skip is still the same outcome, so the run ends as it always did.
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M openspec/changes/c/tasks.md\0?? openspec/specs/new.md\0'),
  })
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { openspec: false } },
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    openSession: async () => ({ sessionId: 'review-1', followup() {}, async whenIdle() {} }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  // Nothing outside `openspec/` means the tool is never asked to commit anything.
  assert.deepEqual(tool.calls.map((call) => call.name), ['git status'])
  assert.match(
    result.text,
    /The commit of the whole task list was skipped: the working tree had no uncommitted changes outside openspec\/\./u,
  )
})

test('with the setting off, a commit that went through says how many openspec/ changes it left', async () => {
  // The count is the only trace of what the boundary kept out of the history (D5): the
  // commit went through and the group is closed, so a tree that still holds `openspec/`
  // changes would otherwise read exactly like a clean one. Both numbers are checked
  // because the sentence is the only place the report says "1" or "2", and a count that
  // is reported wrongly is worse than one that is not reported.
  for (const [dropped, phrase] of [[1, '1 change'], [2, '2 changes']]) {
    const cli = scriptedCli([
      cliResult(fixture('repo.json')),
      cliResult(twoTaskFlat([])),
      cliResult(twoTaskFlat([12])),
      cliResult(twoTaskFlat([12, 13])),
    ])
    const status = [' M lib/control.js', ' M openspec/changes/c/tasks.md', '?? openspec/specs/new.md']
    const tool = scriptedCommitTool({
      'git status': toolOk(`${status.slice(0, dropped + 1).join('\0')}\0`),
      'git add': toolOk(),
      'git commit': toolOk('[main 1a2b3c4] Добавить эндпоинт\n'),
    })
    const { control, agent } = harness({
      createCli: () => cli,
      config: { commit: { openspec: false } },
      commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
      runCommitCommand: tool.run,
      openSession: async () => ({ sessionId: 'review-1', followup() {}, async whenIdle() {} }),
    })

    const result = await control.run(invocation(agent), { change: null })

    assert.equal(result.kind, 'success')
    // One file outside `openspec/` was committed, the rest stayed in the tree.
    assert.deepEqual(
      tool.calls.map((call) => call.name),
      ['git status', 'git add', 'git commit'],
    )
    assert.match(
      result.text,
      /The commit of the whole task list through git went through: \[main 1a2b3c4\] Добавить эндпоинт\./u,
    )
    assert.match(
      result.text,
      new RegExp(`The commit left ${phrase} under openspec/ uncommitted in the working tree\\.`, 'u'),
    )
  }
})

test('with the setting on, a commit that went through carries no sentence about what it left', async () => {
  // The setting on is the default and the whole tree is the change set, `openspec/`
  // included: nothing was dropped, the outcome has no count, and the sentence must read
  // exactly as it did before this setting existed — a run that never touched it must not
  // even hint at the boundary (D5).
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M openspec/changes/c/tasks.md\0?? openspec/specs/new.md\0'),
    'git add': toolOk(),
    'git commit': toolOk('[main 1a2b3c4] Добавить эндпоинт\n'),
  })
  const { control, agent } = harness({
    createCli: () => cli,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    openSession: async () => ({ sessionId: 'review-1', followup() {}, async whenIdle() {} }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(
    result.text,
    /The commit of the whole task list through git went through: \[main 1a2b3c4\] Добавить эндпоинт\./u,
  )
  assert.doesNotMatch(result.text, /The commit left/u)
})

test('with the setting off, a group whose work stayed in openspec/ still stops at its boundary', async () => {
  // The empty outcome is the same outcome it has always been (D5): a tree with nothing
  // to commit outside `openspec/` is a skip, not a failing commit. The boundary still
  // runs — the review of the finished group comes first — and the boundary stop is its
  // last step (design D21), exactly as it is after a commit that went through. A run must
  // not read as broken because the work it just finished happened to land where the
  // setting keeps it out of the history.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M openspec/changes/c/tasks.md\0?? openspec/specs/new.md\0'),
  })
  const opened = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { commit: { openspec: false }, boundary: { enabled: true } },
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    openSession: async (invocation, context) => {
      const sessionId = context.range === undefined ? 'session-2' : 'review-1'
      opened.push(sessionId)
      return { sessionId, followup() {}, async whenIdle() {} }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  // The gate ran, found nothing outside `openspec/`, and nothing was staged or committed.
  assert.deepEqual(tool.calls.map((call) => call.name), ['git status'])
  // The review happened at the boundary; the session of group 3 was never opened.
  assert.deepEqual(opened, ['review-1'])
  assert.equal(result.kind, 'success')
  assert.match(result.text, /The review of tasks 2\.1 - 2\.4 ran in session review-1\./u)
  assert.match(
    result.text,
    /The commit of tasks 2\.1 - 2\.4 was skipped: the working tree had no uncommitted changes outside openspec\/\./u,
  )
  assert.match(
    result.text,
    /The run stopped at the boundary of task group 2 \(tasks 2\.1 - 2\.4\): no further task was sent, and the next \/taskloop continues from task 3\.1\./u,
  )
  // No commit failed: the skip is a sentence of the boundary, and the boundary stop is the
  // only thing that ended the run.
  assert.doesNotMatch(result.text, /the commit of tasks 2\.1 - 2\.4 through git failed/u)
  assert.doesNotMatch(result.text, /The run moved to/u)
  assert.match(control.status().text, /no run is active/u)
  assert.equal(messages.length, 2)
  assert.equal(cli.calls.length, 4, 'no reading followed the boundary stop')
})

test('with the setting off, an empty filtered tree does not end the run before the next group', async () => {
  // Without the boundary stop the loop goes on to group 3, exactly as it does after any
  // other skip (D5): the empty tree is a sentence of the report, never a result of the run.
  // The session that takes over is the same one a commit that went through would open.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M openspec/changes/c/tasks.md\0'),
  })
  const opened = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { review: { enabled: false }, commit: { openspec: false } },
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    openSession: async (invocation, context) => {
      opened.push(context)
      return { sessionId: 'session-2', followup() {}, async whenIdle() {} }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.deepEqual(tool.calls.map((call) => call.name), ['git status'])
  // The group was closed and the next one opened in a session of its own.
  assert.equal(opened.length, 1)
  assert.equal(opened[0].task.line, 17)
  assert.match(result.text, /The run moved to session session-2 \(task 3\.1\) at the group boundary\./u)
  assert.match(
    result.text,
    /The commit of tasks 2\.1 - 2\.4 was skipped: the working tree had no uncommitted changes outside openspec\/\./u,
  )
  assert.equal(messages.length, 2)
})

test('a run without a commit message text does not commit and says why', async () => {
  // A deployment with no source for the text — nothing stored and nobody to ask — is the
  // `unavailable` case of the seam (5.2). The group must not read as committed, so the
  // report names the reason instead of staying silent.
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const tool = scriptedCommitTool({})
  const { control, agent } = harness({
    createCli: () => cli,
    runCommitCommand: tool.run,
    openSession: async () => ({ sessionId: 'review-1', followup() {}, async whenIdle() {} }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.deepEqual(tool.calls, [])
  assert.match(result.text, /The commit of the whole task list was skipped: the run has no commit message text\./u)
})

test('a cancelled commit message question starts no run and sends nothing', async () => {
  // The question is the last thing that may end the command with nothing started (5.2,
  // spec "Отмена ввода"): the refusal must not claim the run slot, read `tasks.md` or send
  // a message, so the next `/taskloop` starts from exactly where this one stood.
  const cli = scriptedCli([cliResult(fixture('repo.json'))])
  const tool = scriptedCommitTool({})
  const { control, messages, agent } = harness({
    createCli: () => cli,
    commitInput: async () => ({ kind: COMMIT_TEXT.cancelled }),
    runCommitCommand: tool.run,
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(
    result.text,
    /no commit message was given for change "add-taskloop-plugin", so the run was not started/u,
  )
  assert.match(result.text, /nothing was sent to the model and no files were changed/u)
  assert.equal(messages.length, 0)
  // The listing was the only CLI call: no task list was read, and no tool was started.
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(tool.calls, [])
  assert.match(control.status().text, /no run is active/u)
})

test('commit off means a finished group is not committed and no message is asked for', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const tool = scriptedCommitTool({})
  const asked = []
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { enabled: false } },
    commitInput: async () => {
      asked.push('text')
      return { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }
    },
    runCommitCommand: tool.run,
    openSession: async () => ({ sessionId: 'review-1', followup() {}, async whenIdle() {} }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.deepEqual(tool.calls, [])
  // A text nobody will commit with must not be asked for: the setting is off, so the
  // question would be a demand for input the run cannot use (design D16).
  assert.deepEqual(asked, [])
  assert.doesNotMatch(result.text, /The commit of/u)
})

test('the commit tool is read at the moment of the commit, so a switch applies to the next group', async () => {
  // The tool is the one volatile setting read late (D12): a run that started with `git`
  // commits through `but` when the setting changed after its first turn. A snapshot
  // taken at the start of the run would keep staging the tree with `git add`.
  const base = resolveConfig({})
  const live = { tool: 'git' }
  const config = {
    ...base,
    commit: { ...base.commit, tool: { get: () => live.tool } },
  }
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk('M lib/commit.js\n'),
    'but commit': toolOk('Committed as 1a2b3c4\n'),
  })
  const { control, agent } = harness({
    createCli: () => cli,
    config,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    openSession: async () => ({ sessionId: 'review-1', followup() {}, async whenIdle() {} }),
    agent: {
      async whenIdle() {
        live.tool = 'gitbutler'
      },
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  // GitButler stages on its own, so the plan is the status check and one request — and
  // a flat run's message carries no task range (design D13). No branch was asked for
  // (the tool was `git` when the input was settled), so `but commit` gets no branch
  // argument and the report says exactly that (D18).
  assert.deepEqual(tool.calls.map((call) => call.name), ['git status', 'but commit'])
  assert.deepEqual(tool.calls[1].request.args, ['commit', '-m', 'Добавить эндпоинт'])
  assert.match(
    result.text,
    /The commit of the whole task list through gitbutler without naming a branch went through: Committed as 1a2b3c4\./u,
  )
})

test('the openspec setting is read at the moment of the commit, so a switch applies to the next group', async () => {
  // `commit.openspec` is volatile for the same reason as the tool (D1, D12): a run that
  // started with the whole tree in scope commits with the pathspec exclusion when the
  // setting was turned off after its first turn. A snapshot taken at the start of the run
  // would still stage `openspec/` with a bare `git add -A`.
  const base = resolveConfig({})
  const live = { openspec: true }
  const config = {
    ...base,
    commit: { ...base.commit, openspec: { get: () => live.openspec } },
  }
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(twoTaskFlat([])),
    cliResult(twoTaskFlat([12])),
    cliResult(twoTaskFlat([12, 13])),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M lib/commit.js\n'),
    'git add': toolOk(),
    'git commit': toolOk('[main 1a2b3c4] Добавить эндпоинт\n'),
  })
  const { control, agent } = harness({
    createCli: () => cli,
    config,
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' }),
    runCommitCommand: tool.run,
    openSession: async () => ({ sessionId: 'review-1', followup() {}, async whenIdle() {} }),
    agent: {
      async whenIdle() {
        live.openspec = false
      },
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  // The exclusion reached both requests of the commit, which is the only way `git`
  // keeps a staged `openspec/` file out of the commit (D3).
  assert.deepEqual(tool.calls.map((call) => call.name), ['git status', 'git add', 'git commit'])
  assert.deepEqual(tool.calls[1].request.args, ['add', '-A', '--', '.', ':(exclude)openspec'])
  assert.deepEqual(
    tool.calls[2].request.args,
    ['commit', '-m', 'Добавить эндпоинт', '--', '.', ':(exclude)openspec'],
  )
})

test('a GitButler run commits into the branch its input named', async () => {
  // The branch is an input of the run (7.3, design D18): the plan the seam settled is
  // what every commit of the run names, and both the report and the transcript line say
  // where the history moved (7.4).
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk('M lib/control.js\n'),
    'but commit': toolOk('Committed as 1a2b3c4\n'),
  })
  const notices = []
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async (invocation, context) => {
      // The tool the run started with is what decides there is a branch to ask about.
      assert.equal(context.tool, 'gitbutler')
      return {
        kind: COMMIT_TEXT.text,
        text: 'Добавить эндпоинт',
        branch: createButBranch({ name: 'feature-a', exists: true }),
      }
    },
    runCommitCommand: tool.run,
    appendNotice: async (recipient, text) => {
      notices.push(text)
      return true
    },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  // The tree is checked once and the commit names the branch before the message.
  assert.deepEqual(tool.calls.map((call) => call.name), ['git status', 'but commit'])
  assert.deepEqual(
    tool.calls[1].request.args,
    ['commit', '-b', 'feature-a', '-m', 'Добавить эндпоинт. Tasks 2.1 - 2.4'],
  )
  assert.match(
    result.text,
    /The commit of tasks 2\.1 - 2\.4 through gitbutler into branch "feature-a" went through: Committed as 1a2b3c4\./u,
  )
  assert.deepEqual(notices, [
    'taskloop: commit 1a2b3c4 for tasks 2.1 - 2.4 into branch "feature-a" (gitbutler).',
  ])
})

test('a new branch is created right before the first commit, and only there', async () => {
  // The plan starts as "does not exist" (D18): the branch is created after the status
  // check of the first commit that has something in it, never at the start of the run.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M lib/loop.js\n'),
    'but branch': toolOk(),
    'but commit': toolOk('Committed as 1a2b3c4\n'),
  })
  const plan = createButBranch({ name: 'feature-x', anchor: 'feature-a' })
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт', branch: plan }),
    runCommitCommand: tool.run,
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.deepEqual(tool.calls.map((call) => call.name), ['git status', 'but branch', 'but commit'])
  assert.deepEqual(tool.calls[1].request.args, ['branch', 'new', 'feature-x', '-A', 'feature-a'])
  assert.deepEqual(
    tool.calls[2].request.args,
    ['commit', '-b', 'feature-x', '-m', 'Добавить эндпоинт. Tasks 2.1 - 2.4'],
  )
  // The plan is the run's own memory: `exists` is flipped once the creation went through,
  // so a later group of the same run cannot try to create the branch again.
  assert.equal(plan.exists, true)
  assert.match(result.text, /through gitbutler into branch "feature-x" went through/u)
})

test('an empty tree creates no branch and commits nothing', async () => {
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({ 'git status': toolOk('') })
  const plan = createButBranch({ name: 'feature-x', anchor: 'feature-a' })
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => ({ kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт', branch: plan }),
    runCommitCommand: tool.run,
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.deepEqual(tool.calls.map((call) => call.name), ['git status'])
  assert.equal(plan.exists, false, 'no branch may be left behind with no commit in it')
  assert.match(result.text, /The commit of tasks 2\.1 - 2\.4 was skipped: the working tree had no uncommitted changes\./u)
})

test('a commit that cannot heal the endings of a file says which file stays modified', async () => {
  // The step before `but commit` normalises only the lines this group changed (D8), so a
  // file whose blob already mixes the two endings stays modified however often it is
  // committed. The report is the only place the user learns that, and it names the file:
  // a count would send them looking for which one.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M lib/control.js\0 M test/control.test.mjs\0'),
    'but commit': toolOk('Committed as 1a2b3c4\n'),
  })
  const rewrites = []
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => ({
      kind: COMMIT_TEXT.text,
      text: 'Добавить эндпоинт',
      branch: createButBranch({ name: 'feature-a', exists: true }),
    }),
    runCommitCommand: tool.run,
    normalizeEol: async (files, options) => {
      rewrites.push({ files, cwd: options.cwd })
      return { rewritten: files, mixed: ['lib/control.js'] }
    },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  // The setting is on, so the whole change set is what the commit composes the tree from.
  assert.deepEqual(rewrites, [{ files: ['lib/control.js', 'test/control.test.mjs'], cwd: CWD }])
  // The rewrite opens no request of its own: the injected one stands for the file system.
  assert.deepEqual(tool.calls.map((call) => call.name), ['git status', 'but commit'])
  assert.match(
    result.text,
    /went through: Committed as 1a2b3c4\. The file lib\/control\.js keeps a mixed history of CRLF and LF: this commit normalised only the lines it changed, so git status will keep reporting it as modified\./u,
  )
})

test('every file a commit could not heal is named in the warning', async () => {
  // One sentence for the files of one commit, not one sentence each: they are the same
  // fact about the same step, and a run that left two files dirty must name both.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M lib/control.js\0 M lib/eol.js\0'),
    'but commit': toolOk('Committed as 1a2b3c4\n'),
  })
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => ({
      kind: COMMIT_TEXT.text,
      text: 'Добавить эндпоинт',
      branch: createButBranch({ name: 'feature-a', exists: true }),
    }),
    runCommitCommand: tool.run,
    normalizeEol: async (files) => ({ rewritten: files, mixed: ['lib/control.js', 'lib/eol.js'] }),
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.match(
    result.text,
    /The files lib\/control\.js and lib\/eol\.js keep a mixed history of CRLF and LF: this commit normalised only the lines it changed, so git status will keep reporting them as modified\./u,
  )
})

test('a commit that healed every file it normalised carries no warning', async () => {
  // The rewrite of the endings is silent when it worked: every file it touched came out
  // consistent, and a report that warned here would make the ordinary commit sound broken.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({
    'git status': toolOk(' M lib/control.js\0'),
    'but commit': toolOk('Committed as 1a2b3c4\n'),
  })
  let rewrote = false
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => ({
      kind: COMMIT_TEXT.text,
      text: 'Добавить эндпоинт',
      branch: createButBranch({ name: 'feature-a', exists: true }),
    }),
    runCommitCommand: tool.run,
    normalizeEol: async (files) => {
      rewrote = true
      return { rewritten: files, mixed: [] }
    },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(rewrote, true, 'the step ran, and the report stayed silent about it')
  assert.match(result.text, /went through: Committed as 1a2b3c4\./u)
  assert.doesNotMatch(result.text, /mixed history/u)
})

test('a commit that never happened says nothing about a history it did not touch', async () => {
  // The warning belongs to a commit that went through (D8): an empty tree normalises
  // nothing, so there is no file whose endings this run could have left half-repaired.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const tool = scriptedCommitTool({ 'git status': toolOk('') })
  const { control, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => ({
      kind: COMMIT_TEXT.text,
      text: 'Добавить эндпоинт',
      branch: createButBranch({ name: 'feature-a', exists: true }),
    }),
    runCommitCommand: tool.run,
    normalizeEol: async () => {
      throw new Error('an empty tree must not reach the rewrite of the endings')
    },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      async whenIdle() {},
    }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.match(result.text, /was skipped: the working tree had no uncommitted changes\./u)
  assert.doesNotMatch(result.text, /mixed history/u)
})

test('a cancelled branch question starts no run and says which question it was', async () => {
  // One refused card is the end of the command (spec "Отмена выбора ветки"), and the
  // sentence names the branch, because blaming the message would send the user to the
  // wrong question on the next `/taskloop` (7.3).
  const cli = scriptedCli([cliResult(fixture('repo.json'))])
  const tool = scriptedCommitTool({})
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => ({ kind: COMMIT_TEXT.cancelled, step: 'branch' }),
    runCommitCommand: tool.run,
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(
    result.text,
    /no GitButler branch was chosen for change "add-taskloop-plugin", so the run was not started/u,
  )
  assert.match(result.text, /nothing was sent to the model and no files were changed/u)
  assert.equal(messages.length, 0)
  // The listing was the only CLI call: no task list was read, and no tool was started.
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(tool.calls, [])
  assert.match(control.status().text, /no run is active/u)
})

test('a refused anchor of a new branch is reported as that question', async () => {
  const cli = scriptedCli([cliResult(fixture('repo.json'))])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => ({ kind: COMMIT_TEXT.cancelled, step: 'anchor' }),
    runCommitCommand: scriptedCommitTool({}).run,
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(
    result.text,
    /no anchor branch was chosen for the new GitButler branch of change "add-taskloop-plugin", so the run was not started/u,
  )
  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 1)
})

test('a branch listing that cannot be read stops the command before the first task', async () => {
  // A `but status --json` failure is fail-fast (7.3, spec "Сбой чтения веток"): the run
  // must not start and fail at the end of the first group instead, after the work is
  // done. The command result carries the tool's words and the hint to set the project up.
  const cli = scriptedCli([cliResult(fixture('repo.json'))])
  const tool = scriptedCommitTool({})
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { commit: { tool: 'gitbutler' } },
    commitInput: async () => {
      throw new Error(
        'but status --json failed with exit code 1: fatal: not a GitButler project. '
          + 'The project must be a GitButler project (`but setup` in it) and `but` must be on PATH.',
      )
    },
    runCommitCommand: tool.run,
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /^taskloop: /u)
  assert.match(result.text, /but status --json failed with exit code 1/u)
  assert.match(result.text, /but setup/u)
  // Nothing was sent, no task list was read, no tool was started and the slot is free.
  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(tool.calls, [])
  assert.match(control.status().text, /no run is active/u)
})

test('the protocol section is off by default and the prompt is never touched', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const prompt = recordingPrompt()
  const { control, agent } = harness({
    createCli: () => cli,
    agent: { ctx: { systemPrompt: prompt } },
  })

  await control.run(invocation(agent), { change: null })

  // Off must mean "never registered", not "registered and then removed": the
  // command's default is the documented `protocol.systemSection: false` (D11).
  assert.deepEqual(prompt.sections, [])
  assert.deepEqual(prompt.disposed, [])
})

test('the protocol section lives for one run: registered before the first task, removed at the end', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const events = []
  const messages = []
  const prompt = {
    getSectionOrder: () => 500,
    section(section) {
      events.push(`section ${section.name}`)
      return () => {
        events.push(`dispose ${section.name}`)
      }
    },
  }
  const { control, agent } = harness({
    createCli: () => cli,
    config: { protocol: { systemSection: true } },
    agent: {
      ctx: { systemPrompt: prompt },
      followup(message) {
        events.push('followup')
        messages.push(message)
      },
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.equal(messages.length, 1)
  // The section is in place before the first message and gone after the run: a
  // section that outlived the run would shape a session that runs no tasks.
  assert.deepEqual(events, [
    `section ${PROTOCOL_SECTION.name}`,
    'followup',
    `dispose ${PROTOCOL_SECTION.name}`,
  ])
})

test('a registration that fails ends the run without leaving the slot claimed', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const prompt = {
    getSectionOrder: () => 500,
    section() {
      throw new Error('prompt section "openspec-taskloop:protocol" is already registered in this scope')
    },
  }
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { protocol: { systemSection: true } },
    agent: { ctx: { systemPrompt: prompt } },
  })

  const failed = await control.run(invocation(agent), { change: null })
  // A session without the failing prompt service: the second run must be able to
  // start at all, which is what proves the slot was released.
  const second = {
    id: 'agent-2',
    followup(message) {
      messages.push(message)
    },
    async whenIdle() {},
  }
  const next = await control.run(invocation(second), { change: null })

  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /already registered/u)
  // Nothing left the failed run, and the slot was released: the next `/taskloop`
  // is answered by the loop, not by a refusal about the run that just failed.
  assert.equal(messages.length, 1)
  assert.match(next.text, /still leaves 2\.3 unchecked/u)
})

test('a session opened at a boundary receives the same protocol section, and both are removed', async () => {
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const source = recordingPrompt()
  const session = recordingPrompt()
  const sessionAgent = {
    sessionId: 'session-2',
    ctx: { systemPrompt: session },
    async whenIdle() {},
  }
  const adopted = []
  const { control, agent } = harness({
    createCli: () => cli,
    config: { protocol: { systemSection: true }, review: { enabled: false } },
    agent: { ctx: { systemPrompt: source } },
    openSession: async (invocation, context) => {
      adopted.push(typeof context.adoptAgent)
      context.adoptAgent(sessionAgent)
      return {
        sessionId: 'session-2',
        followup() {},
        async whenIdle() {},
      }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  // The seam gets a way to hand the new agent to the run's tracker.
  assert.deepEqual(adopted, ['function'])
  // The new session carries the same protocol as the one it continues (spec
  // "Новая сессия на границе группы"), and the run removes every copy it made.
  assert.equal(source.sections.length, 1)
  assert.equal(session.sections.length, 1)
  assert.equal(session.sections[0].text, source.sections[0].text)
  assert.deepEqual(source.disposed, [PROTOCOL_SECTION.name])
  assert.deepEqual(session.disposed, [PROTOCOL_SECTION.name])
})

test('a change with every task done reports completion and sends nothing', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('all-done.json')),
  ])
  const { control, messages, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /all tracked tasks are complete; no turn was started\./)
  assert.equal(messages.length, 0)
})

test('a finished change drops its stored commit message', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('all-done.json')),
  ])
  const { control, forgotten, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /all tracked tasks are complete/)
  // Asked once, for the change the run finished, in the directory it worked in (5.3).
  assert.deepEqual(forgotten, [{ change: 'add-taskloop-plugin', cwd: CWD }])
  // Nothing to report: the record went away as it should.
  assert.doesNotMatch(result.text, /could not be removed/)
})

test('a run that does not finish the change keeps the stored message', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, forgotten, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  // The tasks are not done, so the next `/taskloop` continues with the same sentence.
  assert.equal(result.kind, 'error')
  assert.deepEqual(forgotten, [])
})

test('a message that cannot be dropped is a warning, not a failed run', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('all-done.json')),
  ])
  const { control, forgotten, agent } = harness({
    createCli: () => cli,
    forgetCommitText: async () => {
      throw new Error('EACCES: permission denied')
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  // The work is finished and that is what the user must read; the stale record is a
  // sentence, because it decides what the next run does (design D16).
  assert.equal(result.kind, 'success')
  assert.match(result.text, /all tracked tasks are complete/)
  assert.match(
    result.text,
    /Warning: the stored commit message of this change could not be removed \(EACCES: permission denied\); the next run will reuse it\./,
  )
  assert.deepEqual(forgotten, [{ change: 'add-taskloop-plugin', cwd: CWD }])
})

test('a blocked change reports the CLI instruction and sends nothing', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('blocked.json'), 1),
  ])
  const { control, messages, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /openspec blocked the change: Cannot apply this change yet\./)
  assert.match(result.text, /Missing artifacts: tasks/)
  assert.equal(messages.length, 0)
})

test('the configured change is used when the argument is absent', async () => {
  const cli = scriptedCli([
    cliResult(fixture('multi.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, messages, agent } = harness({ createCli: () => cli, config: { change: 'add-billing' } })

  const result = await control.run(invocation(agent), { change: null })

  assert.match(result.text, /Change "add-billing"/)
  assert.match(result.text, /still leaves 2\.3 unchecked/)
  // The configured name wins even though `fix-login-redirect` is newer, and it is
  // the change whose task file is read.
  assert.doesNotMatch(result.text, /fix-login-redirect/)
  assert.equal(cli.calls[1].args[3], 'add-billing')
  assert.equal(messages.length, 1)
})

test('an unknown change is an error that lists the alternatives', async () => {
  const cli = scriptedCli([cliResult(fixture('multi.json'))])
  const { control } = harness({ createCli: () => cli })

  const result = await control.run(invocation(), { change: 'add-biling' })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /no change named "add-biling"/)
  assert.match(result.text, /add-billing/u)
  assert.match(result.text, /refactor-cli/u)
  // The listing ran once and nothing else: no init, no run.
  assert.equal(cli.calls.length, 1)
})

test('a refusal leaves the project as it was and reports the cancellation', async () => {
  const cli = scriptedCli([cliResult(fixture('no-root.json'), 1)])
  const { control, asked } = harness({
    createCli: () => cli,
    confirm: async () => INIT_ANSWER.cancel,
  })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /initialization cancelled/)
  assert.match(result.text, /no files were created/)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].cwd, CWD)
  assert.equal(cli.calls.length, 1)
})

test('a confirmed initialisation continues into the description question', async () => {
  const cli = scriptedCli([
    cliResult(fixture('no-root.json'), 1),
    cliResult('OpenSpec Setup Complete'),
    cliResult(fixture('empty.json')),
  ])
  const { control, descriptions, messages, agent } = harness({
    createCli: () => cli,
    confirm: async () => INIT_ANSWER.initialize,
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /initialized OpenSpec; the root is C:\\projects\\empty-project\./)
  assert.match(result.text, /no task description was given/)
  assert.deepEqual(cli.calls[1].args, INIT_ARGS)
  assert.equal(descriptions.length, 1)
  assert.equal(descriptions[0].cwd, CWD)
  // A cancelled description sends nothing: the init wrote the root, not the plugin's message.
  assert.equal(messages.length, 0)
})

test('a project without changes sends exactly one explore message and starts no loop', async () => {
  const cli = scriptedCli([cliResult(fixture('empty.json'))])
  const description = 'Add a CSV export endpoint to the report page.'
  const { control, asked, descriptions, messages, agent } = harness({
    createCli: () => cli,
    describe: async () => ({ kind: EXPLORE_ANSWER.described, description }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /OpenSpec root: C:\\projects\\empty-project\./)
  assert.match(result.text, /explore mode/)
  assert.match(result.text, /no task loop was started/)
  assert.equal(asked.length, 0, 'the project was already initialised')
  assert.equal(descriptions.length, 1)
  assert.equal(descriptions[0].cwd, CWD)
  // Exactly one message, carrying the raw description and naming the skill.
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content.length, 1)
  assert.ok(messages[0].content[0].text.includes(EXPLORE_SKILL_PATH))
  assert.ok(messages[0].content[0].text.includes(description))
  // The only CLI call was the listing: no `instructions apply`, no task turn.
  assert.equal(cli.calls.length, 1)
})

test('`/taskloop explore` sends the fixed instruction once and reads nothing', async () => {
  // The scripted CLI has no answer to give, so any call to it fails the test: this
  // form must not read the project at all (design D19).
  const cli = scriptedCli([])
  const { control, asked, descriptions, messages, agent } = harness({ createCli: () => cli })

  const result = control.explore(invocation(agent))

  assert.equal(result.kind, 'success')
  assert.match(result.text, /^taskloop: explore mode requested/)
  assert.match(result.text, /no task loop was started/)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content.length, 1)
  assert.equal(messages[0].content[0].text, EXPLORE_MODE_PROMPT)
  assert.equal(cli.calls.length, 0, 'explore reads no project')
  assert.equal(asked.length, 0, 'explore asks no initialisation question')
  assert.equal(descriptions.length, 0, 'explore asks for no description')
  // ...and it does not become a run: the slot is still free.
  assert.match(control.status().text, /no run is active/)
})

test('`explore` leaves the run slot free for the next `/taskloop`', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, agent } = harness({ createCli: () => cli })

  control.explore(invocation(agent))
  const result = await control.run(invocation(agent), { change: null })

  // The run took the slot itself, so it neither met a refusal nor found one taken.
  assert.match(result.text, /^taskloop: OpenSpec root:/)
  assert.doesNotMatch(result.text, /already active/)
  assert.equal(cli.calls.length, 3)
})

test('`explore` works during an active run and leaves that run alone', async () => {
  let release
  const idle = new Promise((resolve) => {
    release = resolve
  })
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(progressedApply()),
  ])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    agent: { whenIdle: () => idle },
  })
  const otherMessages = []
  const otherAgent = {
    id: 'agent-2',
    followup(message) {
      otherMessages.push(message)
    },
    async whenIdle() {},
  }

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))
  const callsBefore = cli.calls.length

  const result = control.explore(invocation(otherAgent))

  assert.equal(result.kind, 'success')
  assert.equal(otherMessages.length, 1, 'the other session received the instruction')
  assert.equal(otherMessages[0].content[0].text, EXPLORE_MODE_PROMPT)
  assert.equal(messages.length, 1, 'the active run sent its task and nothing else')
  assert.equal(cli.calls.length, callsBefore, 'the active run was not disturbed')
  assert.match(control.status().text, /a run for change "add-taskloop-plugin" is active/)

  release()
  assert.match((await running).text, /sent tasks 2\.3 and 2\.4/)
})

test('an agent that cannot take a follow-up becomes an error result, not a throw', () => {
  const { control } = harness({ createCli: () => scriptedCli([]) })

  const result = control.explore(invocation({ id: 'agent-without-followup' }))

  assert.equal(result.kind, 'error')
  assert.match(result.text, /^taskloop: the explore mode message needs an agent that accepts a follow-up/)
})

test('a cancelled description reports the cancellation and sends nothing', async () => {
  const cli = scriptedCli([cliResult(fixture('empty.json'))])
  const { control, messages, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /no task description was given; nothing was sent to the model/)
  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 1)
})

test('a session without a description channel reports the failure and sends nothing', async () => {
  const cli = scriptedCli([cliResult(fixture('empty.json'))])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    describe: async () => ({ kind: EXPLORE_ANSWER.unavailable }),
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /cannot ask for a task description/)
  assert.equal(messages.length, 0)
  assert.equal(cli.calls.length, 1)
})

test('a session without a confirmation channel reports the failure, not a refusal', async () => {
  const cli = scriptedCli([cliResult(fixture('no-root.json'), 1)])
  const { control } = harness({
    createCli: () => cli,
    confirm: async () => INIT_ANSWER.unavailable,
  })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /cannot ask for confirmation/)
  assert.match(result.text, /openspec init --tools dsh/)
  assert.equal(cli.calls.length, 1)
})

test('a CLI that cannot be built becomes an error result, not a thrown handler', async () => {
  const { control } = harness({
    createCli: () => {
      throw new Error('the openspec CLI cannot run because the subprocess service is not composed')
    },
  })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /subprocess service is not composed/)
})

test('a CLI that fails mid-call becomes an error result with its own message', async () => {
  const cli = scriptedCli([Object.assign(new Error('openspec CLI is not available: not found'), {
    name: 'OpenSpecError',
    code: 'missing',
  })])
  const { control } = harness({ createCli: () => cli })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /^taskloop: openspec CLI is not available/)
})

test('the version gate is settled before the first read of a run', async () => {
  const cli = scriptedCli([cliResult(fixture('repo.json'))])
  const { control } = harness({ createCli: () => cli })

  await control.run(invocation(), { change: 'no-such-change' })

  // The gate is asked once, and before the listing: a CLI of the wrong vintage must be
  // refused without any document being read (9.2, design D20).
  assert.deepEqual(cli.order, ['version', 'list --json'])
  assert.equal(cli.versions, 1)
})

test('a run refuses to start on an openspec older than the minimum, before any read', async () => {
  // The wrapper is the real one and only the host's subprocess is fake, so the refusal is
  // the shipped message rather than a restatement of it (9.2, design D20).
  const spawned = []
  const subprocess = {
    async resolveExecutable() {
      return 'C:\\tools\\openspec.exe'
    },
    spawn(spec) {
      spawned.push(spec.argv)
      const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      return {
        collected: { stdout: reader('0.9.0\n'), stderr: reader('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
      }
    },
  }
  const cli = new OpenSpecCli(subprocess, { timeoutMs: 120_000 })
  const { control, messages, agent } = harness({ createCli: () => cli })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /^taskloop: openspec 0\.9\.0 is older than the minimum 0\.14\.0/u)
  assert.ok(result.text.includes(`update OpenSpec to ${MIN_OPENSPEC_VERSION} or newer`))
  // The project was never read, the model heard nothing, and the slot is free: a run that
  // refused its CLI is not a run that later `/taskloop` calls have to wait for.
  assert.deepEqual(spawned, [['C:\\tools\\openspec.exe', '--version']])
  assert.equal(messages.length, 0)
  assert.match(control.status().text, /no run is active/)
  assert.match((await control.stop()).text, /no run is active/)
})

test('explore, stop and status never build a CLI, so the version is never read', async () => {
  const { control, messages, agent } = harness({
    createCli: () => {
      throw new Error('the version gate must not run for explore, stop or status')
    },
  })

  const explored = control.explore(invocation(agent))
  assert.equal(explored.kind, 'success')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content[0].text, EXPLORE_MODE_PROMPT)

  assert.match((await control.stop()).text, /no run is active/)
  assert.match(control.status().text, /no run is active/)
})

test('a second `/taskloop` from another session is refused while a run is active', async () => {
  // The first run sends 2.3 and stays in its turn until the test releases it.
  let release
  const idle = new Promise((resolve) => {
    release = resolve
  })
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(progressedApply()),
  ])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    agent: { whenIdle: () => idle },
  })
  const otherMessages = []
  const otherAgent = {
    id: 'agent-2',
    followup(message) {
      otherMessages.push(message)
    },
    async whenIdle() {},
  }

  const running = control.run(invocation(agent), { change: null })
  // Let the first run reach its turn before the second session asks.
  await new Promise((resolve) => setImmediate(resolve))

  const refused = await control.run(invocation(otherAgent), { change: null })

  assert.equal(refused.kind, 'error')
  assert.match(
    refused.text,
    /^taskloop: a run for change "add-taskloop-plugin" is already active \(on task 2\.3\)/,
  )
  assert.match(refused.text, /no second run was started and the active run was left as it was/)
  // The refusal read nothing and sent nothing: the listing count is still the
  // first run's two calls.
  assert.equal(cli.calls.length, 2)
  assert.equal(otherMessages.length, 0)

  release()
  const result = await running

  // The active run was untouched: it carried on from where it was and reported its own stop.
  assert.match(result.text, /sent tasks 2\.3 and 2\.4/)
  assert.match(result.text, /still leaves 2\.4 unchecked/)
  assert.equal(messages.length, 2)
  assert.equal(cli.calls.length, 4)
})

test('two runs started at the same moment leave exactly one active', async () => {
  // Both invocations pass the cheap check before either claims the slot, so the
  // claim itself has to decide: the one that arrives second is refused there —
  // after its listing, before it reads a task file.
  let resolveFirstListing
  const firstListing = new Promise((resolve) => {
    resolveFirstListing = resolve
  })
  let rejectRead
  const pendingRead = new Promise((resolve, reject) => {
    rejectRead = reject
  })
  const calls = []
  const cli = {
    async ensureSupportedVersion() {},
    async run(args, options) {
      calls.push(args)
      if (calls.length === 1) return firstListing
      if (args[1] === 'apply') {
        // The read of the run that owns the slot; it fails when that run is stopped,
        // exactly as the real wrapper rejects an aborted call.
        options.signal.addEventListener(
          'abort',
          () => rejectRead(new Error('openspec instructions apply was aborted')),
          { once: true },
        )
        return pendingRead
      }
      return cliResult(fixture('repo.json'))
    },
  }
  const { control, messages, agent } = harness({ createCli: () => cli })
  const otherAgent = { id: 'agent-2', followup() {}, async whenIdle() {} }

  const first = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))
  const second = control.run(invocation(otherAgent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))

  resolveFirstListing(cliResult(fixture('repo.json')))
  const refused = await first

  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /already active \(no task sent yet\)/)
  assert.equal(calls.length, 3, 'the refused run never read a task file')

  const stopped = await control.stop()
  const result = await second

  assert.match(stopped.text, /stopped the run for change "add-taskloop-plugin" before any task was sent/)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /the run was stopped by \/taskloop stop before any task was sent/)
  // No reading completed, so the report keeps the listing's counts.
  assert.match(result.text, /\(3\/20 tasks done\)/)
  assert.equal(messages.length, 0)
})

test('`/taskloop stop` ends the active run and names the task it interrupted', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    // The turn never ends on its own, so only the stop can finish the run.
    agent: { whenIdle: () => new Promise(() => {}) },
  })

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))

  const status = control.status()
  assert.match(
    status.text,
    /^taskloop: a run for change "add-taskloop-plugin" is active on task 2\.3; 1 task sent so far\./,
  )

  const stopped = await control.stop()
  const result = await running

  assert.match(
    stopped.text,
    /^taskloop: stopped the run for change "add-taskloop-plugin" on task 2\.3 \(1 task sent\)/,
  )
  assert.match(stopped.text, /no further task was sent/)
  // The session whose run was stopped hears about it, from the run's own result.
  assert.equal(result.kind, 'success')
  assert.match(result.text, /sent task 2\.3; the run was stopped by \/taskloop stop after that turn\./)
  assert.equal(messages.length, 1)
  // Status changed nothing; the stop ended the wait instead of paying for a re-read.
  assert.equal(cli.calls.length, 2)
  assert.match(control.status().text, /no run is active/)
})

test('a run stopped before its first task reports where it was honestly', async () => {
  // The apply read hangs and fails the way the real wrapper does on abort: a
  // cancelled call rejects, and the loop must read that as the stop, not as an error.
  const calls = []
  const cli = {
    async ensureSupportedVersion() {},
    async run(args, options) {
      calls.push({ args, options })
      if (args[1] === 'apply') {
        return new Promise((resolve, reject) => {
          const abort = () => reject(new Error('openspec instructions apply was aborted'))
          options.signal.addEventListener('abort', abort, { once: true })
        })
      }
      return cliResult(fixture('repo.json'))
    },
  }
  const { control, messages, agent } = harness({ createCli: () => cli })

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))

  const stopped = await control.stop()
  const result = await running

  assert.match(stopped.text, /stopped the run for change "add-taskloop-plugin" before any task was sent/)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /the run was stopped by \/taskloop stop before any task was sent/)
  assert.equal(messages.length, 0)
  assert.equal(calls.length, 2, 'the listing and the read that was cut short')
})

test('stop and status answer that no run is active when nothing was started', async () => {
  const { control } = harness({ createCli: () => ({}) })

  assert.deepEqual(await control.stop(), { kind: 'success', text: 'taskloop: no run is active.' })
  assert.deepEqual(control.status(), { kind: 'success', text: 'taskloop: no run is active.' })
})

test('pause and resume answer that there is nothing to park or release', async () => {
  const { control } = harness({ createCli: () => ({}) })

  assert.deepEqual(await control.pause(), { kind: 'success', text: 'taskloop: no run is active.' })
  assert.deepEqual(await control.resume(), {
    kind: 'success',
    text: 'taskloop: no run is active; nothing was resumed.',
  })
})

test('`/taskloop pause` parks the active run and leaves the slot taken', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    // The turn never ends on its own, so the run stays live until the stop below.
    agent: { whenIdle: () => new Promise(() => {}) },
  })

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))

  const parked = await control.pause()
  assert.equal(parked.kind, 'success')
  // The report names the task the run stopped at and the command that releases it: a
  // park without either is a run the user cannot place or continue (task 4.3).
  assert.match(
    parked.text,
    /^taskloop: parked the run for change "add-taskloop-plugin" \(on task 2\.3\); it stays paused until \/taskloop resume\./,
  )

  // A second pause changes nothing and says so (spec "Повторная пауза"), and the slot
  // still holds the run: a pause does not end the work, so the next `/taskloop` is refused.
  const again = await control.pause()
  assert.match(
    again.text,
    /the run for change "add-taskloop-plugin" is already paused \(on task 2\.3\); nothing was changed/,
  )
  // A parked run is a run that still owns the slot, so `/taskloop status` reports the
  // pause on the task it stopped at and names the command that continues it (task 4.3).
  const status = control.status().text
  assert.match(status, /the run for change "add-taskloop-plugin" is paused \(on task 2\.3\)/)
  assert.match(status, /\/taskloop resume continues it/)
  // And a second `/taskloop` meets that same slot: refused, with the command that
  // releases the parked run instead of an explanation of a run that is not moving
  // (spec "Запуск во время паузы").
  const otherMessages = []
  const refusal = await control.run(
    invocation({ id: 'agent-2', followup: (message) => otherMessages.push(message), async whenIdle() {} }),
    { change: null },
  )
  assert.equal(refusal.kind, 'error')
  assert.match(
    refusal.text,
    /^taskloop: a run for change "add-taskloop-plugin" is paused \(on task 2\.3\); \/taskloop resume continues it, and no second run was started\./,
  )
  assert.equal(otherMessages.length, 0)

  const stopped = await control.stop()
  const result = await running

  assert.match(stopped.text, /^taskloop: stopped the run for change "add-taskloop-plugin" on task 2\.3/)
  assert.equal(result.kind, 'success')
  assert.equal(messages.length, 1)
  // Neither the pause nor the stop of a parked run read a task file.
  assert.equal(cli.calls.length, 2)
})

test('a control built around a passed slot acts on the run that slot holds', async () => {
  const runs = createRuns()
  const { run } = runs.start('add-a', { cwd: CWD })
  const { control } = harness({ runs })

  // No CLI and no invocation: the report reads the slot, and the slot is the deployment's
  // own — the one the HTTP surface is handed (7.3). A control that had made its own slot
  // would answer "no run is active" here while the badge showed one.
  assert.equal(
    control.status().text,
    'taskloop: a run for change "add-a" is active; no task has been sent yet.',
  )

  run.pause()
  assert.match(control.status().text, /the run for change "add-a" is paused/)

  // The other direction of the same sharing: a resume through the command releases the
  // gate the slot's own `pause()` closed.
  await control.resume()
  assert.equal(run.paused, false)
  assert.equal(runs.current(), run, 'the slot still holds the same run')
})

test('a passed slot without the three slot methods is refused at build time', () => {
  // A mount that passes a half-built slot is a composition mistake; failing at the mount
  // names it, instead of a `/taskloop` that throws per invocation (task 7.3).
  assert.throws(
    () => harness({ runs: { current: () => null } }),
    /createControl requires runs\.start/,
  )
})

test('a pause ends the turn of the session the run leads', async () => {
  // Design D4: a parked run whose turn keeps going is a pause in name only, so the
  // pause asks the session service to end the turn of the task in flight.
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, messages, agent, cancellations } = harness({
    createCli: () => cli,
    agent: { sessionId: 'session-1', whenIdle: () => new Promise(() => {}) },
  })

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))

  const parked = await control.pause()

  assert.match(parked.text, /parked the run for change "add-taskloop-plugin" \(on task 2\.3\)/)
  // The session the run leads is the one the turn is ended in, and it is the only one.
  assert.deepEqual(cancellations, ['session-1'])
  assert.equal(messages.length, 1, 'the pause sent nothing')

  await control.stop()
  await running
  assert.equal(messages.length, 1, 'the parked run sent nothing while it was stopped')
})

test('a stop ends the turn of the session the run leads', async () => {
  // The run's signal ends the loop; the turn is the agent's, and only the session
  // service can end it (5.2, design D4).
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, messages, agent, cancellations } = harness({
    createCli: () => cli,
    // The turn never ends on its own: only the stop can finish the run.
    agent: { sessionId: 'session-1', whenIdle: () => new Promise(() => {}) },
  })

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))

  const stopped = await control.stop()
  await running

  assert.match(stopped.text, /^taskloop: stopped the run for change "add-taskloop-plugin" on task 2\.3/)
  assert.deepEqual(cancellations, ['session-1'])
  assert.equal(messages.length, 1)
})

test('a pause that lands while a group is being reviewed ends no turn', async () => {
  // Design D5: the review and the commit of a finished group are not cut short, because a
  // review whose turn was cancelled reports as one that ran. The pause parks the run after
  // the hook instead, on the task the next `/taskloop` would continue from.
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
  ])
  let releaseReview
  const reviewTurn = new Promise((resolve) => {
    releaseReview = resolve
  })
  const { control, messages, agent, cancellations } = harness({
    createCli: () => cli,
    agent: { sessionId: 'session-1' },
    openSession: async (invocation, context) => ({
      sessionId: context.range === undefined ? 'session-2' : 'review-1',
      followup() {},
      whenIdle: () => reviewTurn,
    }),
  })

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))
  // `tasks.md` is read with both tasks of group 2 checked, so 2.3 and 2.4 had their turns
  // and the review of the closed group is the turn in flight when the pause arrives: the run
  // is in the `boundary` phase, not driving a task.
  assert.equal(messages.length, 2)

  const parked = await control.pause()

  assert.match(parked.text, /parked the run for change "add-taskloop-plugin" \(on task 2\.4\)/)
  // No turn was ended for the review: a cancelled review would read as a review that ran,
  // and the commit would follow it as if the group had been checked (design D5).
  assert.deepEqual(cancellations, [])

  releaseReview()
  await new Promise((resolve) => setImmediate(resolve))

  // The boundary closed — the review ran to its end, the commit was skipped for lack of a
  // message — and the gate then parked the run before the next task was chosen.
  assert.match(control.status().text, /is paused \(on task 2\.4\)/)
  assert.equal(messages.length, 2, 'the next group opened no message')
  assert.equal(cli.calls.length, 4, 'the parked run read nothing after the boundary')

  await control.stop()
  await running
})

test('a pause that lands during the between-task compaction lets it finish and ends no turn', async () => {
  // The session service aborts the agent's maintenance task together with its turn, so a
  // pause that asked it during a compaction would end the wait the pause is documented to
  // let finish (design D4, "Risks") — and the run would stop as a compaction failure
  // instead of parking. The pause is taken from inside the compaction to pin that moment.
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
  ])
  let parked
  const harnessed = harness({
    createCli: () => cli,
    compactNow: async () => {
      parked = harnessed.control.pause()
      await parked
      return null
    },
  })
  const { control, messages, agent, cancellations } = harnessed

  const running = control.run(invocation(agent), { change: null })
  for (let attempt = 0; attempt < 50 && parked === undefined; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.ok(parked !== undefined, 'the run reached the compaction')
  assert.match(
    (await parked).text,
    /parked the run for change "add-taskloop-plugin" \(on task 2\.3\)/,
  )
  // No turn was handed to the service: the compaction was still the run's activity, and
  // cancelling it would have failed the transition instead of parking the run.
  assert.deepEqual(cancellations, [])
  await new Promise((resolve) => setImmediate(resolve))
  // The compaction finished, the gate parked the run before task 2.4 left, and the slot
  // still holds the parked run.
  assert.match(control.status().text, /is paused \(on task 2\.3\)/)
  assert.equal(messages.length, 1)
  assert.equal(cli.calls.length, 3)

  await control.stop()
  await running
})

test('`/taskloop resume` releases a parked run and re-sends the task the pause interrupted', async () => {
  // After the resume the file still shows 2.3 unchecked, because the pause cancelled its
  // turn: that box is the user's cancellation, so the same task goes out again instead of
  // ending the run as a failure (design D6).
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  let release
  const turn = new Promise((resolve) => {
    release = resolve
  })
  const { control, messages, agent } = harness({
    createCli: () => cli,
    agent: { whenIdle: () => turn },
  })

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages.length, 1)

  const parked = await control.pause()
  assert.match(parked.text, /parked the run for change "add-taskloop-plugin" \(on task 2\.3\)/)
  // The turn ends, so the run reaches its gate and parks there: the parked run reads
  // nothing, which is why the CLI count stays at the listing and the one read.
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cli.calls.length, 2, 'a parked run reads no task file')

  const resumed = await control.resume()
  assert.equal(resumed.kind, 'success')
  // The resume names the task that goes out again, which is the one the pause stopped:
  // without it the user cannot tell a resumed run from a run that never stopped, and the
  // re-sent task below would be the only evidence (task 4.3).
  assert.match(
    resumed.text,
    /^taskloop: resumed the run for change "add-taskloop-plugin"; the run re-reads tasks\.md and re-sends task 2\.3 unless it is now checked\./,
  )

  const result = await running

  // The re-sent task is the same one, and the run goes on with it instead of stopping
  // the moment the resume released the gate.
  assert.equal(messages.length, 2)
  assert.match(messages[1].content[0].text, /выполни task 2\.3/u)
  assert.match(result.text, /sent tasks 2\.3 and 2\.3/)
  assert.match(result.text, /still leaves 2\.3 unchecked/)
  assert.equal(cli.calls.length, 4)
})

test('`/taskloop resume` refuses when the run is still working', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    agent: { whenIdle: () => new Promise(() => {}) },
  })

  const running = control.run(invocation(agent), { change: null })
  await new Promise((resolve) => setImmediate(resolve))

  const refused = await control.resume()

  assert.equal(refused.kind, 'success')
  assert.match(
    refused.text,
    /^taskloop: no run is parked: the run for change "add-taskloop-plugin" is still working; nothing was resumed\./,
  )
  // The refusal touched nothing: the run kept its task and the slot.
  assert.match(control.status().text, /is active on task 2\.3/)
  await control.stop()
  await running
  assert.equal(messages.length, 1)
})

test('a transient compaction failure is retried under the configured policy', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(progressedApply()),
  ])
  let compactions = 0
  const { control, messages, agent } = harness({
    createCli: () => cli,
    // One delay round-trip is enough to prove the retry happened without waiting.
    config: { compaction: { retry: { attempts: 2, delayMs: 0 } } },
    compactNow: async () => {
      compactions += 1
      if (compactions === 1) {
        throw Object.assign(new Error('manual compaction failed: busy'), { code: 'busy' })
      }
      return null
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  // The run continued after the retry: 2.4 was sent and left unchecked.
  assert.equal(result.kind, 'error')
  assert.match(result.text, /sent tasks 2\.3 and 2\.4/)
  assert.match(result.text, /tasks\.md still leaves 2\.4 unchecked/)
  assert.equal(compactions, 2)
  assert.equal(messages.length, 2)
})

test('retry numbers are read per transition: a change reaches the next one, never mid-series', async () => {
  // Design D5: the compactor is one per plugin, but the three volatile numbers are
  // resolved on every transition. `live` stands in for the settings record a write
  // changes and the config holds references to it, so nothing is rebuilt between the
  // two transitions below — the control, the config object and the run stay the same.
  const live = { attempts: 2, delayMs: 0, factor: 1 }
  const base = resolveConfig()
  const config = {
    ...base,
    compaction: {
      ...base.compaction,
      // The continue policy is what lets the failed transition reach the next one.
      onFailure: { get: () => 'continue' },
      retry: {
        ...base.compaction.retry,
        attempts: { get: () => live.attempts },
        delayMs: { get: () => live.delayMs },
        factor: { get: () => live.factor },
      },
    },
  }
  const flat = flatApply()
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(flat),
    cliResult(tickedApplyIn(flat, [12])),
    cliResult(tickedApplyIn(flat, [12, 13])),
    cliResult(tickedApplyIn(flat, [12, 13])),
  ])
  // Each call records how many tasks had been sent when it happened: 1 for the
  // transition after task 12, 2 for the transition after task 13. That is what tells
  // the two series apart without relying on the order of the warnings alone.
  const sent = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config,
    compactNow: async () => {
      sent.push(messages.length)
      // The budget is raised while the first series is still running: that series must
      // keep the two calls it was promised (D5), while the next transition reads 3.
      if (sent.length === 1) live.attempts = 3
      throw Object.assign(new Error('manual compaction failed: busy'), { code: 'busy' })
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.equal(messages.length, 3, 'the continue policy sent every task')
  assert.deepEqual(sent, [1, 1, 2, 2, 2], 'two calls for the first transition, three for the second')
  assert.equal(cli.calls.length, 5, 'no extra reading: the report came from the last one')
  // The counts in the report are the ones each transition entered with, so the raised
  // setting never stretched the series already under way.
  assert.match(
    result.text,
    /Warnings: compaction before task [\s\S]*failed after 2 attempts \(busy\): manual compaction failed: busy; compaction before task [\s\S]*failed after 3 attempts \(busy\): manual compaction failed: busy; the run continued without compaction\./,
  )
})

test('a compaction that runs out of attempts stops the run and reports the code', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
  ])
  const compacted = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { compaction: { retry: { attempts: 1 } } },
    compactNow: async (target, signal) => {
      compacted.push({ target, signal })
      throw Object.assign(new Error('manual compaction failed: summary'), { code: 'summary' })
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(
    result.text,
    /sent task 2\.3; compaction before task 2\.4 failed after 1 attempt \(summary\): manual compaction failed: summary; the run stopped and no further task was sent\./,
  )
  // Nothing was carried past a stop: the break policy reports the stop alone.
  assert.doesNotMatch(result.text, /Warning:/)
  // The compactor is the environment's, and it is called with the agent whose
  // session continues the group — the invocation's, here.
  assert.equal(compacted.length, 1)
  assert.equal(compacted[0].target, agent)
  assert.equal(messages.length, 1, '2.4 was never sent')
  assert.equal(cli.calls.length, 3, 'no reading after the failed compaction')
})

test('a compaction that runs out of attempts under the continue policy sends the task and warns', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(progressedApply()),
  ])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { compaction: { onFailure: 'continue', retry: { attempts: 1 } } },
    compactNow: async () => {
      throw Object.assign(new Error('manual compaction failed: busy'), { code: 'busy' })
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  // The run went on and 2.4 was sent uncompacted; its unchecked box is still what
  // ends the run, so the warning rides along with an error rather than a success.
  assert.equal(result.kind, 'error')
  assert.match(result.text, /sent tasks 2\.3 and 2\.4/)
  assert.match(result.text, /tasks\.md still leaves 2\.4 unchecked/)
  assert.match(
    result.text,
    /Warning: compaction before task 2\.4 failed after 1 attempt \(busy\): manual compaction failed: busy; the run continued without compaction\./,
  )
  assert.equal(messages.length, 2)
  assert.equal(cli.calls.length, 4)
})

test('several survived compactions are reported together under the continue policy', async () => {
  // A flat run compacts on every transition (design D5), and the backend stays
  // down: two tasks go out uncompacted and the report names both failures, in the
  // order they happened, without turning the run into a success.
  const flat = flatApply()
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(flat),
    cliResult(tickedApplyIn(flat, [12])),
    cliResult(tickedApplyIn(flat, [12, 13])),
    cliResult(tickedApplyIn(flat, [12, 13])),
  ])
  let compactions = 0
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { compaction: { onFailure: 'continue', retry: { attempts: 1 } } },
    compactNow: async () => {
      compactions += 1
      const code = compactions === 1 ? 'busy' : 'summary'
      throw Object.assign(new Error(`manual compaction failed: ${code}`), { code })
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.equal(compactions, 2)
  assert.match(
    result.text,
    /Warnings: compaction before task .+ failed after 1 attempt \(busy\): manual compaction failed: busy; compaction before task .+ failed after 1 attempt \(summary\): manual compaction failed: summary; the run continued without compaction\./,
  )
  assert.equal(messages.length, 3)
  assert.equal(cli.calls.length, 5)
})

/**
 * An agent context that records the listeners the run registers on it.
 *
 * @param {string} scope - name the registrations and disposals are recorded under.
 * @param {object[]} listeners - shared registration log.
 * @param {string[]} disposed - shared disposal log.
 * @returns {object} the fake context.
 */
function gatedContext(scope, listeners, disposed) {
  return {
    on(event, listener) {
      listeners.push({ scope, event, listener })
      return () => {
        disposed.push(scope)
      }
    },
  }
}

test('a volatile setting changed between runs is read by the next run, not the next mount', async () => {
  // The resolved config carries references, and D12 says the run reads them when
  // it starts: the same control must see a new value on its second run without
  // being mounted again. The option fields are replaced with references over a
  // value the test mutates between the two runs.
  const base = resolveConfig({ compaction: { retry: { attempts: 1, delayMs: 0 } } })
  const live = { onFailure: 'break', midTask: false, systemSection: false }
  const config = {
    ...base,
    compaction: {
      ...base.compaction,
      onFailure: { get: () => live.onFailure },
      midTask: { get: () => live.midTask },
    },
    protocol: { ...base.protocol, systemSection: { get: () => live.systemSection } },
  }
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(progressedApply()),
  ])
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config,
    compactNow: async () => {
      throw Object.assign(new Error('manual compaction failed: busy'), { code: 'busy' })
    },
  })

  const stopped = await control.run(invocation(agent), { change: null })
  assert.match(stopped.text, /the run stopped and no further task was sent/)
  assert.doesNotMatch(stopped.text, /Warning:/, 'the break policy reports the stop alone')
  assert.equal(messages.length, 1)

  live.onFailure = 'continue'
  const continued = await control.run(invocation(agent), { change: null })
  assert.match(continued.text, /Warning: compaction before task 2\.4 failed after 1 attempt \(busy\)/)
  assert.equal(messages.length, 3, 'the second run sent 2.3 and 2.4')
  assert.equal(cli.calls.length, 7)
})

test('step compaction is off by default: no listener is registered and nothing is called', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const listeners = []
  const stepCalls = []
  const { control, agent } = harness({
    createCli: () => cli,
    agent: { ctx: gatedContext('agent-1', listeners, []) },
    compactIfNeeded: async (...args) => {
      stepCalls.push(args)
      return null
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /still leaves 2\.3 unchecked/)
  // Off is the documented default (D11): a listener that existed would put this
  // plugin on the step path of a deployment that never asked for it.
  assert.deepEqual(listeners, [])
  assert.deepEqual(stepCalls, [])
  assert.doesNotMatch(result.text, /Warning:/)
})

test('a failed step compaction warns in the report and the task still runs', async () => {
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(applyFixture('ready.json')),
  ])
  const listeners = []
  const disposed = []
  const stepCalls = []
  const { control, messages, agent } = harness({
    createCli: () => cli,
    config: { compaction: { midTask: true } },
    agent: { ctx: gatedContext('agent-1', listeners, disposed) },
    compactIfNeeded: async (target, signal) => {
      stepCalls.push({ target, signal })
      throw Object.assign(new Error('manual compaction failed: busy'), { code: 'busy' })
    },
  })
  // The host proposes the step before deriving its request; the gate is a
  // participant, so the test drives it the way the waterfall would.
  agent.whenIdle = async () => {
    const decision = { kind: 'enter', messages: [] }
    for (const { listener } of listeners) {
      assert.deepEqual(await listener({ agent, signal: undefined }, async () => decision), decision)
    }
  }

  const result = await control.run(invocation(agent), { change: null })

  // The task ran: the failed bound is a warning, not the end of the run (spec
  // "Сбой сжатия внутри задачи").
  assert.equal(result.kind, 'error')
  assert.match(result.text, /sent task 2\.3, but tasks\.md still leaves 2\.3 unchecked/u)
  assert.match(
    result.text,
    /Warning: compaction during task 2\.3 failed \(busy\); the task continued without compaction\./,
  )
  assert.equal(messages.length, 1)
  assert.equal(stepCalls.length, 1)
  assert.equal(stepCalls[0].target, agent)
  // The gate belongs to the run: the listener is gone when the run is over.
  assert.deepEqual(disposed, ['agent-1'])
})

test('a session opened at a boundary is handed the step gate too', async () => {
  const both = tickedApply([12, 13])
  const cli = scriptedCli([
    cliResult(fixture('repo.json')),
    cliResult(applyFixture('ready.json')),
    cliResult(progressedApply()),
    cliResult(both),
    cliResult(both),
  ])
  const listeners = []
  const disposed = []
  const adopted = []
  const sessionAgent = {
    sessionId: 'session-2',
    ctx: gatedContext('session-2', listeners, disposed),
  }
  const { control, agent } = harness({
    createCli: () => cli,
    config: { compaction: { midTask: true }, review: { enabled: false } },
    compactIfNeeded: async () => null,
    agent: { ctx: gatedContext('agent-1', listeners, disposed) },
    openSession: async (invocation, context) => {
      adopted.push(typeof context.adoptAgent)
      context.adoptAgent(sessionAgent)
      return { sessionId: 'session-2', followup() {}, async whenIdle() {} }
    },
  })

  const result = await control.run(invocation(agent), { change: null })

  assert.equal(result.kind, 'error')
  // The gate is a property of the run, not of the session it started in: without
  // this handoff a boundary would silently end the pressure gate for the rest of
  // the run (6.3).
  assert.deepEqual(adopted, ['function'])
  assert.deepEqual(listeners.map((entry) => entry.scope), ['agent-1', 'session-2'])
  assert.equal(listeners[0].event, 'agent/pre-step')
  assert.deepEqual(disposed.sort(), ['agent-1', 'session-2'])
  assert.doesNotMatch(result.text, /Warning:/)
})
