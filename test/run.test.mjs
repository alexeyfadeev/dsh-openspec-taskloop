// Tests for one step of an apply run (task 4.1): which document is read, which
// task is sent, and that nothing else reaches the model.
//
// The step is driven with a scripted CLI, so the tests pin the two facts the loop
// depends on: `instructions apply` is read for the selected change, and exactly
// one follow-up is produced for a ready change — none for `blocked`/`all_done`.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { APPLY_SKILL_PATH } from '../lib/step.js'
import { NEXT_TASK, parseApplyInstructions } from '../lib/tasks.js'
import { applyArgs, readApplyInstructions, runOneStep } from '../lib/run.js'

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
      return next
    },
  }
}

/**
 * Drive one step against a scripted CLI and record what the agent received.
 *
 * @param {object[]} responses - settled CLI results, consumed in call order.
 * @returns {{cli: object, messages: object[], agent: object, step: Function}} the harness.
 */
function harness(responses) {
  const messages = []
  const agent = {
    id: 'agent-1',
    followup(message) {
      messages.push(message)
    },
  }
  const cli = scriptedCli(responses)
  return {
    cli,
    messages,
    agent,
    step: (overrides = {}) => runOneStep({
      cli,
      cwd: CWD,
      change: CHANGE,
      agent,
      signal: undefined,
      ...overrides,
    }),
  }
}

test('a ready change sends exactly one message for the first undone task', async () => {
  const { cli, messages, step } = harness([cliResult(fixture('ready.json'))])

  const outcome = await step()

  assert.equal(outcome.kind, NEXT_TASK.task)
  // `ready.json` records 2.3 as the first unchecked box, on line 12.
  assert.equal(outcome.task.description.slice(0, 3), '2.3')
  assert.equal(outcome.task.line, 12)
  assert.equal(messages.length, 1)
  assert.equal(messages[0], outcome.message)

  const text = messages[0].content[0].text
  assert.ok(text.startsWith(`Используя навык ${APPLY_SKILL_PATH} выполни task 2.3, далее - пауза.`))
  assert.ok(text.includes(`Change: ${CHANGE}; файл: ${outcome.task.sourcePath}:12.`))
  // One read, for the selected change: no listing, no extra `instructions apply`.
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(cli.calls[0].args, applyArgs(CHANGE))
  assert.equal(cli.calls[0].options.cwd, CWD)
})

test('a step can act on a reading the caller already has', async () => {
  // The loop verifies the previous task with a fresh read and then passes that
  // same reading in: a transition must cost one `instructions apply` call.
  const instructions = parseApplyInstructions(fixture('ready.json'))
  const { cli, messages, step } = harness([])

  const outcome = await step({ instructions })

  assert.equal(outcome.kind, NEXT_TASK.task)
  assert.equal(outcome.instructions, instructions)
  assert.equal(messages.length, 1)
  assert.equal(cli.calls.length, 0)
})

test('an all-done change sends nothing', async () => {
  const { messages, step } = harness([cliResult(fixture('all-done.json'))])

  const outcome = await step()

  assert.equal(outcome.kind, NEXT_TASK.done)
  assert.equal(messages.length, 0)
})

test('a blocked change sends nothing and reports the CLI instruction', async () => {
  const { messages, step } = harness([cliResult(fixture('blocked.json'), 1)])

  const outcome = await step()

  assert.equal(outcome.kind, NEXT_TASK.blocked)
  assert.match(outcome.reason, /Missing artifacts: tasks/)
  assert.equal(messages.length, 0)
})

test('an answer without a change name falls back to the requested change', async () => {
  const document = {
    progress: { total: 1, complete: 0, remaining: 1 },
    tasks: [{ id: '1', description: '1.1 Do the thing', done: false, sourcePath: `${CWD}\\tasks.md`, line: 5 }],
    state: 'ready',
    instruction: '',
  }
  const { messages, step } = harness([cliResult(JSON.stringify(document))])

  await step()

  assert.equal(messages.length, 1)
  assert.ok(messages[0].content[0].text.includes(`Change: ${CHANGE}; файл: ${CWD}\\tasks.md:5.`))
})

test('a document that is not apply instructions fails the step instead of sending a task', async () => {
  const { messages, step } = harness([cliResult('not json')])

  await assert.rejects(() => step(), /did not return JSON/)
  assert.equal(messages.length, 0)
})

test('the apply read refuses to run without a change name', async () => {
  const { cli } = harness([])

  await assert.rejects(
    () => readApplyInstructions({ cli, cwd: CWD, change: '' }),
    /requires the change name/,
  )
  assert.equal(cli.calls.length, 0)
})
