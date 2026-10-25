// Tests for the review that closes a task group (task 3.2).
//
// The review is the one turn the plugin sends that nobody asked for in the session
// it lands in, so its contract is pinned here without a host: the text names the
// change and the group, the session is opened before anything is sent into it, the
// approval policy is narrowed to `'never'` before the turn exists, exactly one
// instruction leaves, and a stop abandons the wait as `cancelled` instead of
// failing the run.
//
// The fakes record the order of the calls rather than only their arguments: the
// order is the property that keeps an unattended turn from hanging (design D14).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { REVIEW_END, buildReviewPrompt, runReview } from '../lib/review.js'

const CHANGE = 'add-taskloop-review-commit'
const RANGE = { from: '2.1', to: '2.4' }

/**
 * A promise whose settlement the test controls.
 *
 * @returns {{promise: Promise<unknown>, resolve: (value?: unknown) => void}} the deferred.
 */
function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/**
 * Let every already-resolved promise run before the test looks at the fakes.
 *
 * @returns {Promise<void>} resolves after the next macrotask.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('the review prompt names the change and the group, and forbids questions', () => {
  const text = buildReviewPrompt({ change: CHANGE, range: RANGE })

  assert.match(text, /change "add-taskloop-review-commit"/u)
  assert.match(text, /задачи 2\.1 - 2\.4/u)
  assert.match(text, /Работай автономно/u)
  assert.match(text, /не задавай вопросов пользователю/u)
  assert.match(text, /не жди подтверждений/u)
  // One instruction, and the pause that keeps the review a single turn.
  assert.match(text, /далее - пауза/u)
  // Only an unambiguous defect may be fixed, in the tree the commit will take.
  assert.match(text, /только однозначные значимые дефекты/u)
})

test('a flat run is reviewed as one list, without a task range', () => {
  const text = buildReviewPrompt({ change: CHANGE })

  assert.match(text, /весь список задач/u)
  assert.doesNotMatch(text, /\d+\.\d+ - \d+\.\d+/u)
})

test('a review message needs a change and a complete range', () => {
  assert.throws(() => buildReviewPrompt({ change: '' }), /requires the change name/u)
  assert.throws(() => buildReviewPrompt({ change: CHANGE, range: { from: '2.1' } }), /range\.to/u)
  assert.throws(() => buildReviewPrompt({ change: CHANGE, range: { to: '2.4' } }), /range\.from/u)
})

test('the review opens a session, denies approvals there, then sends one instruction', async () => {
  const events = []
  const runner = {
    sessionId: 'review-1',
    followup(message) {
      events.push({ at: 'prompt', message })
    },
    async whenIdle() {
      events.push({ at: 'idle' })
    },
  }

  const outcome = await runReview({
    change: CHANGE,
    range: RANGE,
    signal: new AbortController().signal,
    openSession: async (context) => {
      events.push({ at: 'open', context })
      return runner
    },
    setApproval: async (sessionId) => {
      events.push({ at: 'approval', sessionId })
    },
  })

  // The approval policy is in place before the turn exists: a review that asked
  // for confirmation would wait for an answer nobody is there to give.
  assert.deepEqual(events.map((event) => event.at), ['open', 'approval', 'prompt', 'idle'])
  // The opener receives the group, not the whole run: it is what the review is about.
  assert.deepEqual(events[0].context, { change: CHANGE, range: RANGE })
  assert.equal(events[1].sessionId, 'review-1')

  const message = events[2].message
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'user')
  assert.equal(message.content.length, 1)
  assert.match(message.content[0].text, /задачи 2\.1 - 2\.4/u)

  assert.deepEqual(outcome, { kind: REVIEW_END.reviewed, sessionId: 'review-1' })
})

test('exactly one instruction is sent to the review session', async () => {
  const sent = []
  const runner = {
    sessionId: 'review-1',
    followup(message) {
      sent.push(message)
    },
    async whenIdle() {},
  }

  await runReview({ change: CHANGE, range: RANGE, openSession: () => runner })

  assert.equal(sent.length, 1)
})

test('the review settles only after the turn went quiet', async () => {
  const idle = deferred()
  const runner = {
    sessionId: 'review-1',
    followup() {},
    whenIdle: () => idle.promise,
  }
  let settled = false

  const pending = runReview({ change: CHANGE, range: RANGE, openSession: () => runner }).then((outcome) => {
    settled = true
    return outcome
  })

  await settle()
  assert.equal(settled, false)

  idle.resolve()
  assert.equal((await pending).kind, REVIEW_END.reviewed)
})

test('a run stopped before the review opens no session and sends nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  let opened = 0

  const outcome = await runReview({
    change: CHANGE,
    range: RANGE,
    signal: controller.signal,
    openSession: () => {
      opened += 1
      return { sessionId: 'review-1', followup() {}, whenIdle() {} }
    },
  })

  assert.equal(opened, 0)
  assert.deepEqual(outcome, { kind: REVIEW_END.cancelled })
})

test('a stop while the review session is opening leaves it without an instruction', async () => {
  const controller = new AbortController()
  const opened = deferred()
  let sent = 0

  const pending = runReview({
    change: CHANGE,
    range: RANGE,
    signal: controller.signal,
    openSession: () => opened.promise,
  })

  await settle()
  controller.abort()
  opened.resolve({ sessionId: 'review-2', followup() { sent += 1 }, whenIdle() {} })

  const outcome = await pending
  // The session exists, so the report can name it, but the run is over and no
  // instruction enters it.
  assert.equal(sent, 0)
  assert.deepEqual(outcome, { kind: REVIEW_END.cancelled, sessionId: 'review-2' })
})

test('a stop during the review ends it as cancelled, not as a failed turn', async () => {
  const controller = new AbortController()
  let sent = 0
  const runner = {
    sessionId: 'review-1',
    followup() {
      sent += 1
    },
    // The turn never finishes: only the stop can end the wait.
    whenIdle: () => new Promise(() => {}),
  }

  const pending = runReview({
    change: CHANGE,
    range: RANGE,
    signal: controller.signal,
    openSession: () => runner,
  })

  await settle()
  // The message is the turn being interrupted, not one that never started.
  assert.equal(sent, 1)
  controller.abort()

  assert.deepEqual(await pending, { kind: REVIEW_END.cancelled, sessionId: 'review-1' })
})

test('a review turn that fails to start is an error, not a stop', async () => {
  const runner = {
    sessionId: 'review-1',
    followup() {},
    whenIdle: () => Promise.reject(new Error('the agent is gone')),
  }

  await assert.rejects(
    () => runReview({ change: CHANGE, openSession: () => runner }),
    /the agent is gone/u,
  )
})

test('a review without a session opener is refused', async () => {
  await assert.rejects(() => runReview({ change: CHANGE }), /requires an openSession/u)
})
