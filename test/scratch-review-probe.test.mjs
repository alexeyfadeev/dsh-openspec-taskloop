// Temporary review probe — not part of the change. Deleted after the review.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LOOP_END, runLoop } from '../lib/loop.js'
import { createRuns } from '../lib/runs.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apply')
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8')
const CWD = 'C:\\projects\\demo'
const CHANGE = 'add-taskloop-plugin'
const cliResult = (stdout) => ({ exitCode: 0, stdout, stderr: '', truncated: false })

function progressedDocument() {
  const document = JSON.parse(fixture('ready.json'))
  document.tasks.find((task) => task.line === 12).done = true
  document.progress = { total: 20, complete: 5, remaining: 15 }
  return JSON.stringify(document)
}

const ticked = (lines) => {
  const document = JSON.parse(fixture('ready.json'))
  for (const task of document.tasks) if (lines.includes(task.line)) task.done = true
  return JSON.stringify(document)
}

const labelOf = (message) => /выполни task ([^,]+),/u.exec(message.content[0].text)[1]

function harness(responses, agentOverrides = {}) {
  const messages = []
  const calls = []
  const agent = {
    id: 'agent-1',
    followup(message) {
      messages.push(message)
    },
    async whenIdle() {},
    ...agentOverrides,
  }
  const cli = {
    calls,
    async run(args) {
      calls.push(args)
      const next = responses.shift()
      if (next === undefined) throw new Error('unexpected CLI call')
      return next
    },
  }
  return { cli, agent, messages, loop: (overrides = {}) => runLoop({
    cli, cwd: CWD, change: CHANGE, agent, signal: undefined, ...overrides,
  }) }
}

async function until(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition never held')
}

test('probe: task checked while parked at the turn gate advances without a re-send', async () => {
  const { run } = createRuns().start(CHANGE)
  let pausedOnce = false
  const { cli, messages, loop } = harness(
    [cliResult(fixture('ready.json')), cliResult(progressedDocument()), cliResult(progressedDocument())],
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
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4'])
  assert.equal(outcome.kind, LOOP_END.unmarked)
})

test('probe: stop instead of resume ends a parked run as cancelled with the task named', async () => {
  const { run } = createRuns().start(CHANGE)
  let stopped = false
  const { messages, loop } = harness([cliResult(fixture('ready.json'))], {
    async whenIdle() {
      if (stopped) return
      stopped = true
      run.pause()
      setImmediate(() => run.stop())
    },
  })
  const running = loop({
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
    resumePending: () => run.takeResumePending(),
  })
  const outcome = await running
  assert.equal(outcome.kind, LOOP_END.cancelled)
  assert.equal(outcome.task.line, 12)
  assert.equal(messages.length, 1)
  assert.equal(run.takeResumePending(), false)
})

test('probe: pause during the read that closes a group, resume, hook runs once', async () => {
  const both = ticked([12, 13])
  const { cli, messages, loop } = harness([cliResult(fixture('ready.json')), cliResult(progressedDocument()), cliResult(both), cliResult(both)])
  const { run } = createRuns().start(CHANGE, { sessionId: 'session-1' })
  const reviews = []
  let pausedOnce = false
  const running = loop({
    signal: run.signal,
    waitWhilePaused: (signal) => run.waitWhilePaused(signal),
    resumePending: () => run.takeResumePending(),
    onGroupComplete: async (context) => {
      reviews.push(`${context.range.from}-${context.range.to}`)
    },
    openSession: async () => ({
      sessionId: 'session-2',
      followup(message) {
        messages.push(message)
      },
      async whenIdle() {},
    }),
  })
  // Pause while the third read is in flight.
  await until(() => cli.calls.length === 3)
  // The read is already awaited; pause now, then let the loop reach the gate.
  run.pause()
  await until(() => run.paused)
  assert.deepEqual(reviews, [], 'the hook has not run before the gate')
  run.resume()
  const outcome = await running
  assert.deepEqual(reviews, ['2.1-2.4'], 'the group is reviewed once')
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.4', '3.1'])
  assert.equal(outcome.kind, LOOP_END.unmarked)
})

test('probe: two pause/resume cycles keep exactly one re-send', async () => {
  const { run } = createRuns().start(CHANGE)
  let pauses = 0
  const { messages, loop } = harness(
    [cliResult(fixture('ready.json')), cliResult(fixture('ready.json')), cliResult(fixture('ready.json'))],
    {
      async whenIdle() {
        if (pauses >= 1) return
        pauses += 1
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
  run.pause()
  assert.equal(run.takeResumePending(), true, 'allowance is still outstanding while it parks again')
  run.resume()
  const outcome = await running
  assert.deepEqual(messages.map(labelOf), ['2.3', '2.3'], 'one re-send, not two')
  assert.equal(outcome.kind, LOOP_END.unmarked)
})
