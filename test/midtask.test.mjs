// Tests for the step-boundary compaction gate (task 6.3).
//
// The gate is the one mechanism that reaches into a turn: it listens on an agent's
// own context, asks the compaction service for a `'pressure'` compaction before each
// step, and must never change what the step decides. These tests pin the two
// properties the task asks for — off means no listener and no call, a failure means
// a warning and a step that still enters — plus the lifecycle the host would
// otherwise expose: one listener per managed agent, removed when the run settles.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMidTaskGate } from '../lib/midtask.js'

/**
 * An agent whose context records the listeners registered on it.
 *
 * @param {string} [id] - agent id.
 * @returns {{agent: object, registered: object[], disposed: string[]}} the agent, the
 *   registrations it received and the events that were disposed.
 */
function recordingAgent(id = 'agent-1') {
  const registered = []
  const disposed = []
  const ctx = {
    on(event, listener) {
      registered.push({ event, listener })
      return () => {
        disposed.push(event)
      }
    },
  }
  return { agent: { id, ctx }, registered, disposed }
}

/**
 * Run one proposed step through the gate.
 *
 * The decision is the downstream chain's own value: the gate wraps `next()` and must
 * hand it back unchanged, because a step's admission is not the gate's to alter.
 *
 * @param {Function} listener - the registered `agent/pre-step` listener.
 * @param {object} agent - agent whose step is proposed.
 * @param {AbortSignal} [signal] - cancellation of the current turn.
 * @returns {Promise<object>} the decision the step goes on with.
 */
function step(listener, agent, signal) {
  const decision = { kind: 'enter', messages: [] }
  return listener({ agent, signal }, async () => decision)
}

/**
 * A compaction failure of the kind the service reports.
 *
 * @param {string} code - `ManualCompactionError` code.
 * @returns {Error} the error.
 */
function failure(code) {
  return Object.assign(new Error(`manual compaction failed: ${code}`), { code })
}

test('with the option off no listener is registered and the service is never called', async () => {
  const calls = []
  const gate = createMidTaskGate({
    enabled: false,
    compactIfNeeded: async (...args) => {
      calls.push(args)
      return null
    },
  })
  const { agent, registered } = recordingAgent()

  gate.note({ id: '5', description: '2.3 Write the gate', sourcePath: 'tasks.md', line: 12 })
  gate.adopt(agent)
  gate.close()

  // Off must mean "never touched": a listener that exists and does nothing would
  // still put this plugin on the step path of every run (D11).
  assert.equal(gate.enabled, false)
  assert.deepEqual(registered, [])
  assert.deepEqual(calls, [])
  assert.deepEqual(gate.warnings, [])
})

test('the gate asks for pressure before each step and delegates the decision', async () => {
  const calls = []
  const gate = createMidTaskGate({
    enabled: true,
    compactIfNeeded: async (agent, signal) => {
      calls.push({ agent, signal })
      return null // "nothing worth compacting" is a success, not a failure.
    },
  })
  const { agent, registered } = recordingAgent()
  const signal = new AbortController().signal

  gate.adopt(agent)

  assert.equal(gate.enabled, true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].event, 'agent/pre-step')
  // Every step of the turn is gated, not just the first: a task can grow across
  // tool calls, and each step derives its own request.
  assert.deepEqual(await step(registered[0].listener, agent, signal), { kind: 'enter', messages: [] })
  assert.deepEqual(await step(registered[0].listener, agent, signal), { kind: 'enter', messages: [] })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].agent, agent)
  assert.equal(calls[0].signal, signal)
  assert.deepEqual(gate.warnings, [])
})

test('a failed step compaction is recorded and the step still enters', async () => {
  const gate = createMidTaskGate({
    enabled: true,
    compactIfNeeded: async () => {
      throw failure('busy')
    },
  })
  const { agent, registered } = recordingAgent()
  const task = { id: '5', description: '2.3 Write the gate', sourcePath: 'tasks.md', line: 12 }
  gate.adopt(agent)
  gate.note(task)

  // The task is not lost to an opportunistic compaction (spec "Сбой сжатия внутри
  // задачи"): the same decision goes downstream as without the gate.
  assert.deepEqual(await step(registered[0].listener, agent), { kind: 'enter', messages: [] })
  assert.deepEqual(gate.warnings, [{ task, code: 'busy' }])
})

test('a failure before the run named a task still becomes a warning', async () => {
  const gate = createMidTaskGate({
    enabled: true,
    compactIfNeeded: async () => {
      throw failure('persistence')
    },
  })
  const { agent, registered } = recordingAgent()
  gate.adopt(agent)

  await step(registered[0].listener, agent)

  // A step in the managed session before the first message of the run has no task
  // to name; the warning is still recorded rather than dropped.
  assert.deepEqual(gate.warnings, [{ code: 'persistence' }])
})

test('a failed step compaction is logged for the session that outlives the report', async () => {
  const lines = []
  const gate = createMidTaskGate({
    enabled: true,
    compactIfNeeded: async () => {
      throw failure('summary')
    },
    logger: {
      warn: (text) => {
        lines.push(text)
      },
    },
  })
  const { agent, registered } = recordingAgent()
  gate.adopt(agent)

  await step(registered[0].listener, agent)

  assert.equal(lines.length, 1)
  assert.match(lines[0], /step compaction failed \(summary\): manual compaction failed: summary/u)
  assert.match(lines[0], /continuing the task/u)
})

test('a stop during a step is not a compaction failure', async () => {
  const controller = new AbortController()
  const calls = []
  const gate = createMidTaskGate({
    enabled: true,
    compactIfNeeded: async () => {
      // The turn is cancelled while the backend works: the service reports it the
      // same way it reports any aborted call.
      controller.abort()
      calls.push('called')
      throw Object.assign(new Error('compaction aborted'), { code: 'cancelled' })
    },
  })
  const { agent, registered } = recordingAgent()
  gate.adopt(agent)

  assert.deepEqual(await step(registered[0].listener, agent, controller.signal), {
    kind: 'enter',
    messages: [],
  })
  assert.equal(calls.length, 1)
  // The run is ending anyway; a warning here would describe a stop as a failure.
  assert.deepEqual(gate.warnings, [])
})

test('an already cancelled step is not compacted at all', async () => {
  const calls = []
  const controller = new AbortController()
  controller.abort()
  const gate = createMidTaskGate({
    enabled: true,
    compactIfNeeded: async (...args) => {
      calls.push(args)
      return null
    },
  })
  const { agent, registered } = recordingAgent()
  gate.adopt(agent)

  assert.deepEqual(await step(registered[0].listener, agent, controller.signal), {
    kind: 'enter',
    messages: [],
  })
  assert.deepEqual(calls, [])
})

test('the same agent is gated once, and every managed agent gets its own listener', () => {
  const gate = createMidTaskGate({ enabled: true, compactIfNeeded: async () => null })
  const first = recordingAgent('agent-1')
  const second = recordingAgent('agent-2')

  // The agent of a new session is met twice — when the session opens and when its
  // idleness is awaited — and one scope must not receive a duplicate listener (5.1).
  gate.adopt(first.agent)
  gate.adopt(first.agent)
  gate.adopt(second.agent)

  assert.equal(first.registered.length, 1)
  assert.equal(second.registered.length, 1)

  gate.close()

  assert.deepEqual(first.disposed, ['agent/pre-step'])
  assert.deepEqual(second.disposed, ['agent/pre-step'])
})

test('close removes every listener once and keeps the warnings readable', async () => {
  const gate = createMidTaskGate({
    enabled: true,
    compactIfNeeded: async () => {
      throw failure('busy')
    },
  })
  const { agent, registered, disposed } = recordingAgent()
  gate.adopt(agent)
  await step(registered[0].listener, agent)

  gate.close()
  // Closing twice must not dispose a listener that is already gone.
  gate.close()

  assert.deepEqual(disposed, ['agent/pre-step'])
  // The report is written after the gate is closed, so the warnings must survive it.
  assert.deepEqual(gate.warnings, [{ code: 'busy' }])
})

test('an agent without a context that registers listeners is skipped, not fatal', () => {
  const gate = createMidTaskGate({ enabled: true, compactIfNeeded: async () => null })

  assert.doesNotThrow(() => {
    gate.adopt({ id: 'agent-1' })
    gate.adopt({ id: 'agent-2', ctx: {} })
    gate.adopt({ id: 'agent-3', ctx: { on: 'not a function' } })
    gate.adopt(undefined)
    gate.close()
  })
  assert.deepEqual(gate.warnings, [])
})

test('without the compaction seam nothing is registered', () => {
  const gate = createMidTaskGate({ enabled: true })
  const { agent, registered } = recordingAgent()

  gate.adopt(agent)

  // There is nothing to ask, so the gate is not enabled in any useful sense and
  // stays off the step path entirely.
  assert.equal(gate.enabled, false)
  assert.deepEqual(registered, [])
})
