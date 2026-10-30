// Tests for the single-run slot (task 4.3).
//
// The slot is what makes "one active run per process" true: a second start meets
// the run that already owns the slot instead of getting a second one, and a stop is
// a signal the loop watches rather than a flag it may notice later. The handle also
// owns the run's lifetime: the request that started it can end at any moment, and
// the run does not. All of that is pinned here without a loop or a CLI, because the
// guarantees belong to the handle a run is given — the loop's own reaction is
// covered in `test/loop.test.mjs`.
//
// The handle also owns the pause gate (design D2 of the UI change): `/taskloop pause`
// closes it, and the loop waits there before sending the next message. Both ways out
// of the gate are pinned here — a resume, and a stop, because a stop must end a parked
// run instead of waiting for a resume nobody will send.
//
// Where the run is belongs to the handle as well (design D5/D7 of the UI change): the
// phase the loop reports, and the session the work is in now. The loop is what discovers
// both, so the handle only records them — and refusing a phase it does not know is the
// one thing it can still check.
//
// The snapshot is the same knowledge in the shape a reader asks for: the pause phase, the
// change, the directory, the task, the last progress and the session, all from memory so a
// badge can poll it. What it does not know it reports as unknown: a run that has sent
// nothing has no task, and the slot never invents one from the change it drives.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { PAUSE_STATE, RUN_PHASE, RUN_START, createRuns } from '../lib/runs.js'

/**
 * A task as the slot records it; only the label matters here.
 *
 * @param {number} line - line of the task in `tasks.md`.
 * @returns {{line: number}} the recorded task.
 */
const task = (line) => ({ line })

/** Settle every pending microtask. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Await a gate a command must open, failing instead of hanging forever.
 *
 * `waitWhilePaused()` is a gate: a bug that never opens it would turn a broken test
 * into a test run that never ends. The timer does not keep the process alive, so the
 * assertions that follow are what report the gate that stayed shut.
 *
 * @param {Promise<unknown>} gate - the wait under test.
 * @returns {Promise<void>} resolves when the gate opened, or when the timer expired.
 */
const releasedWithin = (gate) => Promise.race([gate, delay(500, undefined, { ref: false })])

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

test('the run ignores the request that started it', () => {
  // The invocation's signal belongs to the UI request: the host aborts it when the
  // response connection closes (a reloaded tab, a closed window), which says nothing
  // about the run. Only `/taskloop stop` ends a run from outside.
  const request = new AbortController()
  const { run } = createRuns().start('add-a')

  request.abort()

  assert.equal(run.signal.aborted, false, 'a request that ends does not end the run')
  run.stop()
  assert.equal(run.signal.aborted, true)
  assert.equal(run.stopped, true, 'the run was stopped by the command, not cancelled by a request')
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

test('pause parks the run and a second pause changes nothing', () => {
  const { run } = createRuns().start('add-a')

  assert.equal(run.pause(), true)
  assert.equal(run.paused, true)
  // Idempotent: the command answers "already paused" from this second answer, and the
  // run keeps its slot, its position and an open signal.
  assert.equal(run.pause(), false)
  assert.equal(run.paused, true)
  assert.equal(run.signal.aborted, false, 'parking is not stopping')
  assert.equal(run.stopped, false)
})

test('a run that is not parked lets the loop through at once', async () => {
  const { run } = createRuns().start('add-a')

  await releasedWithin(run.waitWhilePaused(run.signal))

  assert.equal(run.paused, false)
})

test('a parked run waits until it is resumed', async () => {
  const { run } = createRuns().start('add-a')
  run.pause()
  let waiting = true
  const gate = run.waitWhilePaused(run.signal).then(() => {
    waiting = false
  })

  await flush()
  assert.equal(waiting, true, 'a parked run keeps the loop between messages')

  assert.equal(run.resume(), true)
  await releasedWithin(gate)
  assert.equal(waiting, false)
  assert.equal(run.paused, false)
  assert.equal(run.signal.aborted, false, 'resuming is not stopping')
})

test('a stop releases a parked run just as a resume does', async () => {
  const { run } = createRuns().start('add-a')
  run.pause()
  let waiting = true
  const gate = run.waitWhilePaused(run.signal).then(() => {
    waiting = false
  })

  await flush()
  assert.equal(waiting, true)

  run.stop()
  await releasedWithin(gate)
  assert.equal(waiting, false)
  // The loop reads the signal once the gate opens: a stop that ends a parked run is a
  // cancelled run, never a resumed one, and nothing may report it as paused.
  assert.equal(run.signal.aborted, true)
  assert.equal(run.stopped, true)
  assert.equal(run.paused, false)
})

test('an active run has nothing to resume, and a stopped run cannot be parked', () => {
  const { run } = createRuns().start('add-a')

  assert.equal(run.resume(), false, 'there is nothing to resume')

  run.stop()
  assert.equal(run.pause(), false, 'a run that is over cannot be parked')
  assert.equal(run.paused, false)
  assert.equal(run.stopped, true)
})

test('a run starts in its task phase and names the session it begins in', () => {
  const { run } = createRuns().start('add-a', { sessionId: 'session-1' })

  assert.equal(run.phase, RUN_PHASE.task)
  assert.equal(run.sessionId, 'session-1')
  // The slot welcomes a run whose command knew no session: it simply has none to name.
  assert.equal(createRuns().start('add-b').run.sessionId, undefined)
})

test('the slot records the phase and the session a boundary moves the run into', () => {
  const { run } = createRuns().start('add-a')

  run.setPhase(RUN_PHASE.boundary)
  assert.equal(run.phase, RUN_PHASE.boundary)
  // A boundary is a moment, not a mode: the run is back in its task phase afterwards.
  run.setPhase(RUN_PHASE.task)
  assert.equal(run.phase, RUN_PHASE.task)

  run.setSession('session-2')
  assert.equal(run.sessionId, 'session-2')
  // A caller that could not name a session has nothing better than the one already
  // recorded, so the slot keeps it rather than reporting a run without a place.
  run.setSession(undefined)
  assert.equal(run.sessionId, 'session-2')
})

test('an unknown phase and a blank session id are refused', () => {
  const runs = createRuns()
  const { run } = runs.start('add-a')

  // The phase vocabulary has two members, and a third would be a caller's bug.
  assert.throws(() => run.setPhase('paused'), /unknown phase/)
  assert.throws(() => run.setSession(''), /non-empty session id/)
  assert.throws(() => createRuns().start('add-b', { sessionId: '' }), /non-empty session id/)

  assert.equal(run.phase, RUN_PHASE.task)
  assert.equal(run.sessionId, undefined)
  assert.equal(runs.current(), run, 'a refused start left the slot to the run that had it')
})

test('a run requires the change it drives', () => {
  assert.throws(() => createRuns().start(''), /change name/)
})

test('the snapshot names the run wherever it stands', () => {
  const { run } = createRuns().start('add-a', { cwd: 'C:\\work\\add-a', sessionId: 'session-1' })
  run.note(task(12))
  run.setProgress({ complete: 5, total: 24 })

  assert.deepEqual(run.snapshot(), {
    phase: PAUSE_STATE.running,
    change: 'add-a',
    cwd: 'C:\\work\\add-a',
    task: task(12),
    progress: { complete: 5, total: 24 },
    sessionId: 'session-1',
  })

  // A parked run reports the phase a badge shows; the task it stopped on and the counts
  // it stopped with are still the ones the reader needs to draw the run.
  run.pause()
  run.setSession('session-2')
  assert.deepEqual(run.snapshot(), {
    phase: PAUSE_STATE.paused,
    change: 'add-a',
    cwd: 'C:\\work\\add-a',
    task: task(12),
    progress: { complete: 5, total: 24 },
    sessionId: 'session-2',
  })
})

test('a run that has sent nothing has no task to report', () => {
  const { run } = createRuns().start('add-a')

  const snapshot = run.snapshot()

  // The change is known because the command named it; everything else is unknown, and the
  // slot says so instead of guessing a task from the change or a directory from the process.
  assert.deepEqual(snapshot, {
    phase: PAUSE_STATE.running,
    change: 'add-a',
    cwd: undefined,
    task: undefined,
    progress: undefined,
    sessionId: undefined,
  })
  assert.equal(snapshot.task, undefined)
})

test('progress and directory are refused when they cannot be true', () => {
  const runs = createRuns()
  const { run } = runs.start('add-a')

  // More done than exists, a negative count and a count that is not a number are all a
  // caller's bug rather than numbers to publish.
  assert.throws(() => run.setProgress({ complete: 2, total: 1 }), /progress/)
  assert.throws(() => run.setProgress({ complete: -1, total: 3 }), /progress/)
  assert.throws(() => run.setProgress({ complete: '1', total: 3 }), /progress/)
  assert.equal(run.progress, undefined, 'a refused value records nothing')
  // A caller without counts for this reading keeps the numbers the run already has.
  run.setProgress({ complete: 1, total: 2 })
  run.setProgress(undefined)
  assert.deepEqual(run.snapshot().progress, { complete: 1, total: 2 })
  // The counts are copied, so the caller cannot rewrite what a snapshot reports.
  const counts = { complete: 3, total: 7 }
  run.setProgress(counts)
  counts.complete = 0
  assert.deepEqual(run.snapshot().progress, { complete: 3, total: 7 })

  assert.throws(() => createRuns().start('add-b', { cwd: '' }), /non-empty directory/)
  assert.equal(runs.current(), run, 'a refused start left the slot to the run that had it')
})
