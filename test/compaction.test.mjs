// Tests for compaction between tasks of one group (task 6.1).
//
// The retry policy is the whole contract of this module: a transient backend
// failure is retried with a growing delay, a terminal one is not retried at all,
// and the budget is counted in calls to `compactNow` rather than in retries. The
// clock is a recording `sleep`, so the assertions cost no wall-clock time and can
// pin the exact delays a real run would wait — including the configured ceiling.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMPACTION_END, TERMINAL_CODES, compactBetweenTasks, isRetryable } from '../lib/compaction.js'
import { resolveConfig } from '../lib/config.js'

const AGENT = { id: 'agent-1' }
const SIGNAL = new AbortController().signal

/**
 * A compaction failure shaped like `ManualCompactionError`.
 *
 * The module reads `code`, not the class, so the test does not need the host's
 * compaction package to describe a failure.
 *
 * @param {string} code - failure class.
 * @returns {Error} the failure.
 */
function failure(code) {
  return Object.assign(new Error(`manual compaction failed: ${code}`), {
    name: 'ManualCompactionError',
    code,
  })
}

/**
 * A fake `compactNow()` that answers from a script and records its calls.
 *
 * @param {unknown[]} steps - results or thrown values, consumed in call order.
 * @param {object[]} calls - shared call log.
 * @returns {Function} the fake compactor.
 */
function scriptedCompact(steps, calls) {
  return async (agent, signal) => {
    calls.push({ agent, signal })
    const next = steps.shift()
    if (next === undefined) throw new Error('unexpected compactNow call')
    if (next instanceof Error) throw next
    return next
  }
}

/**
 * A sleep that records the delay instead of waiting for it.
 *
 * @param {number[]} delays - shared delay log.
 * @returns {Function} the fake sleep.
 */
function recordedSleep(delays) {
  return async (ms) => {
    delays.push(ms)
  }
}

/**
 * The resolved retry configuration, with the given fields overridden.
 *
 * @param {object} [overrides] - `compaction.retry` fields.
 * @returns {object} resolved retry block.
 */
const retryConfig = (overrides = {}) =>
  resolveConfig({ compaction: { retry: overrides } }).compaction.retry

test('a successful compaction is one call and no delay', async () => {
  const calls = []
  const delays = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([null], calls),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig(),
    sleep: recordedSleep(delays),
  })

  assert.equal(result.kind, COMPACTION_END.compacted)
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.delays, [])
  assert.deepEqual(delays, [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, AGENT)
  assert.equal(calls[0].signal, SIGNAL)
})

test('a transient code is retried with the configured growing delay until it succeeds', async () => {
  const calls = []
  const delays = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([failure('summary'), failure('summary'), null], calls),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig({ attempts: 3, delayMs: 1000, factor: 2, maxDelayMs: 10_000 }),
    sleep: recordedSleep(delays),
  })

  assert.equal(result.kind, COMPACTION_END.compacted)
  assert.equal(result.attempts, 3)
  // The first retry waits delayMs, the second delayMs * factor (design D11).
  assert.deepEqual(result.delays, [1000, 2000])
  assert.deepEqual(delays, [1000, 2000])
  assert.equal(calls.length, 3)
})

test('the attempt budget ends the transition when every call fails', async () => {
  const calls = []
  const delays = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([failure('persistence'), failure('persistence'), failure('persistence')], calls),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig({ attempts: 3, delayMs: 1000, factor: 2, maxDelayMs: 10_000 }),
    sleep: recordedSleep(delays),
  })

  assert.equal(result.kind, COMPACTION_END.failed)
  assert.equal(result.attempts, 3)
  assert.equal(result.code, 'persistence')
  assert.deepEqual(result.delays, [1000, 2000])
  assert.equal(calls.length, 3, 'the budget counts calls, not retries')
})

test('a retry delay does not grow past the configured ceiling', async () => {
  const delays = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([failure('summary'), failure('summary'), failure('summary'), failure('summary')], []),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig({ attempts: 4, delayMs: 1000, factor: 5, maxDelayMs: 3000 }),
    sleep: recordedSleep(delays),
  })

  assert.equal(result.kind, COMPACTION_END.failed)
  // 1000, then 5000 capped to 3000, then 15 000 capped to 3000.
  assert.deepEqual(delays, [1000, 3000, 3000])
})

test('a changed code is terminal and is not retried', async () => {
  const calls = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([failure('changed'), null], calls),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig({ attempts: 3 }),
    sleep: recordedSleep([]),
  })

  assert.equal(result.kind, COMPACTION_END.failed)
  assert.equal(result.code, 'changed')
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.delays, [])
  assert.equal(calls.length, 1)
})

test('a commit code is terminal and is not retried, even when its budget is left', async () => {
  const calls = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([failure('commit'), null], calls),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig({ attempts: 5 }),
    sleep: recordedSleep([]),
  })

  assert.equal(result.kind, COMPACTION_END.failed)
  assert.equal(result.code, 'commit')
  assert.equal(result.attempts, 1)
  assert.equal(calls.length, 1)
})

test('a cancelled compaction is terminal even when the configuration lists it', async () => {
  const calls = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([failure('cancelled'), null], calls),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig({ attempts: 3, codes: ['summary', 'cancelled'] }),
    sleep: recordedSleep([]),
  })

  assert.equal(result.kind, COMPACTION_END.failed)
  assert.equal(result.code, 'cancelled')
  assert.equal(calls.length, 1)
  assert.deepEqual(TERMINAL_CODES, ['changed', 'commit', 'cancelled'])
})

test('a code outside the configured transient set is not retried', async () => {
  const calls = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([failure('busy'), null], calls),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig({ attempts: 3, codes: ['summary'] }),
    sleep: recordedSleep([]),
  })

  assert.equal(result.kind, COMPACTION_END.failed)
  assert.equal(result.code, 'busy')
  assert.equal(calls.length, 1)
  assert.equal(isRetryable('busy', ['summary']), false)
  assert.equal(isRetryable('summary', ['summary']), true)
})

test('a failure without a code is not classified as transient', async () => {
  const calls = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([new Error('backend exploded'), null], calls),
    agent: AGENT,
    signal: SIGNAL,
    retry: retryConfig({ attempts: 3 }),
    sleep: recordedSleep([]),
  })

  assert.equal(result.kind, COMPACTION_END.failed)
  assert.equal(result.code, undefined)
  assert.equal(result.attempts, 1)
  assert.equal(calls.length, 1)
})

test('a run cancelled before the first attempt never calls the backend', async () => {
  const controller = new AbortController()
  controller.abort()
  const calls = []
  const delays = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([], calls),
    agent: AGENT,
    signal: controller.signal,
    retry: retryConfig(),
    sleep: recordedSleep(delays),
  })

  assert.equal(result.kind, COMPACTION_END.cancelled)
  assert.equal(result.attempts, 0)
  assert.deepEqual(delays, [])
  assert.equal(calls.length, 0)
})

test('a stop during the backoff ends the transition as cancelled, not as a failure', async () => {
  const controller = new AbortController()
  const calls = []
  const delays = []

  const result = await compactBetweenTasks({
    compactNow: scriptedCompact([failure('summary'), null], calls),
    agent: AGENT,
    signal: controller.signal,
    retry: retryConfig({ attempts: 3, delayMs: 1000 }),
    // The stop lands exactly while the run is waiting to retry.
    sleep: async (ms) => {
      delays.push(ms)
      controller.abort()
    },
  })

  assert.equal(result.kind, COMPACTION_END.cancelled)
  assert.equal(result.attempts, 1)
  assert.deepEqual(delays, [1000])
  assert.equal(calls.length, 1, 'no attempt after the stop')
})

test('a stop during the backend call wins over the failure code', async () => {
  const controller = new AbortController()
  const calls = []

  const result = await compactBetweenTasks({
    compactNow: async () => {
      calls.push('compact')
      controller.abort()
      throw failure('summary')
    },
    agent: AGENT,
    signal: controller.signal,
    retry: retryConfig({ attempts: 3 }),
    sleep: recordedSleep([]),
  })

  assert.equal(result.kind, COMPACTION_END.cancelled)
  assert.equal(result.attempts, 1)
  assert.equal(calls.length, 1)
})
