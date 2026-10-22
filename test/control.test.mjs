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
import { resolveConfig } from '../lib/config.js'
import { createControl } from '../lib/control.js'
import { EXPLORE_ANSWER, EXPLORE_SKILL_PATH, sendExplorePrompt } from '../lib/explore.js'
import { PROTOCOL_SECTION } from '../lib/protocol.js'

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
 * @param {object[]} responses - settled results, consumed in call order.
 * @returns {object} the fake wrapper with a `calls` log.
 */
function scriptedCli(responses) {
  const calls = []
  return {
    calls,
    async run(args, options) {
      calls.push({ args, options })
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`)
      if (next instanceof Error) throw next
      return next
    },
  }
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
 * @returns {{control: object, asked: object[], descriptions: object[], messages: object[], agent: object}}
 *   the control, the initialisation questions, the description questions, the
 *   follow-up messages and the agent that received them.
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
}) {
  const asked = []
  const descriptions = []
  const messages = []
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
    openSession,
    compactNow,
    compactIfNeeded,
  })
  return { control, asked, descriptions, messages, agent }
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
    config: { protocol: { systemSection: true } },
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
    config: { compaction: { midTask: true } },
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
