// Tests for the single-run slot (task 4.3).
//
// The slot is what makes "one active run per process" true: a second start meets
// the run that already owns the slot instead of getting a second one, and a stop is
// a signal the loop watches rather than a flag it may notice later. Both are pinned
// here without a loop or a CLI, because the guarantees belong to the handle a run is
// given — the loop's own reaction is covered in `test/loop.test.mjs`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RUN_START, createRuns } from '../lib/runs.js'

/**
 * A task as the slot records it; only the label matters here.
 *
 * @param {number} line - line of the task in `tasks.md`.
 * @returns {{line: number}} the recorded task.
 */
const task = (line) => ({ line })

/** Settle every pending microtask. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('a second start is refused and leaves the active run untouched', () => {
  const runs = createRuns()
  const first = runs.start('add-a')
  assert.equal(first.kind, RUN_START.started)
  first.run.note(task(12))

  const second = runs.start('add-b')

  assert.equal(second.kind, RUN_START.busy)
  assert.equal(second.run, first.run, 'the refusal names the run that owns the slot')
  assert.equal(runs.current(), first.run)
  // Untouched: same change, same position, and nobody stopped it.
  assert.equal(first.run.change, 'add-a')
  assert.equal(first.run.task.line, 12)
  assert.equal(first.run.stopped, false)
  assert.equal(first.run.signal.aborted, false)
})

test('the slot opens again when the run finishes, and only for its own run', () => {
  const runs = createRuns()
  const first = runs.start('add-a')

  runs.finish(first.run)
  assert.equal(runs.current(), null)

  const second = runs.start('add-b')
  assert.equal(second.kind, RUN_START.started)
  assert.notEqual(second.run, first.run)
  assert.equal(second.run.change, 'add-b')

  // A stale handle cannot release the slot of the run that holds it now.
  runs.finish(first.run)
  assert.equal(runs.current(), second.run)
})

test('stop aborts the run and records who asked', () => {
  const { run } = createRuns().start('add-a')

  run.stop()

  // The abort is what the loop observes; `stopped` tells the report that the user
  // asked, as opposed to the request having gone away on its own.
  assert.equal(run.signal.aborted, true)
  assert.equal(run.stopped, true)
})

test("the run's signal follows the invocation's own cancellation", () => {
  const invocation = new AbortController()
  const { run } = createRuns().start('add-a', invocation.signal)

  invocation.abort()

  assert.equal(run.signal.aborted, true)
  assert.equal(run.stopped, false, 'the run was cancelled, not stopped by the command')
})

test('a run settles only when it is finished', async () => {
  const runs = createRuns()
  const { run } = runs.start('add-a')
  let settled = false
  run.settled.then(() => {
    settled = true
  })

  await flush()
  assert.equal(settled, false, 'an active run keeps its stop waiting')

  runs.finish(run)
  await flush()
  assert.equal(settled, true)
})

test('a run requires the change it drives', () => {
  assert.throws(() => createRuns().start(''), /change name/)
})
