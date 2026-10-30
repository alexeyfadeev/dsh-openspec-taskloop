// dsh-openspec-taskloop — the one-active-run slot (task 4.3).
//
// The loop drives one agent through one turn per task. Two loops at once would
// send the same task twice, double-report, and leave `/taskloop stop` ambiguous
// about which run it ends — so "one run per process" is a fact of this module
// rather than a convention each caller remembers. `start()` either hands out a
// fresh run or the run that already holds the slot; a caller that receives the
// second refuses to start anything.
//
//     /taskloop ──start()──▶ started ──▶ loop(signal) ──▶ finish()
//                    │
//                    └──busy───────▶ { kind: 'busy', run }   (refused, untouched)
//
// A run carries the three things the command surface needs to say about it: the
// change it drives, the task its last message named, and a signal that only
// `/taskloop stop` aborts. The run deliberately does *not* follow the command
// invocation's own signal. That signal belongs to the UI request, and the host
// aborts it when the response connection closes — a reloaded tab, a closed window,
// a dropped socket — none of which mean the run should end. A run is minutes to
// hours of model turns; a request is not, and tying them together is what once
// killed a healthy run between two tasks. Stopping is an explicit act
// (`/taskloop stop`), and a turn that fails ends the run through its own reading
// of `tasks.md` (design D4), so nothing is lost by not watching the request.
//
// A run can be parked as well as stopped (design D2 of the UI change). `pause()`
// closes a gate the loop waits at before it sends the next message, `resume()`
// opens it again, and `stop()` opens it too: a stop must end a parked run instead
// of waiting for a resume nobody is going to send. The gate never replaces
// `signal` — `signal` stays the one cancellation the loop obeys, so a parked run
// is a live run that has not been cancelled rather than a second kind of ending.
//
// A resume leaves one allowance behind (design D6 of the UI change). The box a
// pause left unchecked belongs to a turn the user cancelled rather than to a task
// the model failed, so the loop is allowed to send that task again instead of
// stopping; `takeResumePending()` hands that allowance out once, and the check
// after it sees a plain run. An allowance is a moment, not a mode: it is spent by
// the first reading that asks, which is what keeps it from excusing a later task.
//
// The slot also says where the run is (design D5/D7 of the UI change): the phase it
// is in — driving a task, or closing a finished group — and the session it leads
// right now. Both are the loop's knowledge, so the loop reports them and the slot
// only records them: the phase is how a pause decides whether a turn may be
// cancelled (a review and a commit are never cut short), and the session is what a
// badge names once a boundary has moved the work into a session of its own.
//
// The slot also says what a run *is* to readers that are not the loop (design D7 of the
// UI change): a snapshot of the phase a badge shows, the change, the directory, the task,
// the progress of the last reading and the session. It is assembled from what the slot
// already holds — no CLI, no file, no await — because the UI polls it every other second,
// and it answers `undefined` where the run does not know something rather than inventing
// a task or a directory nobody sent.
//
// The slot lives in the closure of `createRuns()` — one per mounted plugin, which
// is one per process — and is the only state a run has outside `tasks.md` (design
// D8). Nothing is persisted: after a restart no run is active, and `/taskloop`
// re-derives its position from the file.

import { aborted } from './wait.js'

/**
 * Values of {@link StartOutcome.kind}; callers switch on them.
 */
export const RUN_START = Object.freeze({
  /** This call owns the slot and may drive a run. */
  started: 'started',
  /** Another run owns the slot; nothing was started and nothing was touched. */
  busy: 'busy',
})

/**
 * What {@link createRuns}'s `start` settled with.
 *
 * @typedef {object} StartOutcome
 * @property {'started'|'busy'} kind - whether this caller owns the slot.
 * @property {ActiveRun} run - the run that owns the slot, this caller's or the active one.
 */

/**
 * Values of {@link ActiveRun.phase}; the loop names them as it moves.
 *
 * `task` is a run that may have a turn in its session; `boundary` is a run that is
 * closing a finished group (design D5 of the UI change), where the review and the
 * commit may not be cut short. A boundary is a moment, not a mode: the run goes back
 * to `task` as soon as the group is closed.
 */
export const RUN_PHASE = Object.freeze({
  /** The run is driving a task (or waiting between two of them). */
  task: 'task',
  /** The run is closing a finished group: reviewing it and committing it. */
  boundary: 'boundary',
})

/**
 * The phase a snapshot reports (design D7 of the UI change); a badge and a dialog show
 * these words as the run's state.
 *
 * This is a different axis from {@link RUN_PHASE}: that one says where the run is in its
 * work (`task` or `boundary`), this one says whether it may send. They are true at the
 * same time — a run parked while a group closes is `paused` here and passed through
 * `boundary` there — and only this one is the UI's business.
 */
export const PAUSE_STATE = Object.freeze({
  /** The run may send: it is driving a task or closing a group. */
  running: 'running',
  /** The run is parked at its gate, waiting for `/taskloop resume` or a stop. */
  paused: 'paused',
})

/**
 * One in-flight run: its identity, its position and the one way it is stopped.
 *
 * `tasks` grows as messages leave, so `task` is always the task a report should
 * name and `tasks.length` is always the number of turns this run started. The
 * object is mutated only through `note()`, `setPhase()`, `setSession()`,
 * `setProgress()`, `pause()`, `resume()`, `takeResumePending()` and `stop()`;
 * `snapshot()` is what the rest of the plugin reads, and `finish()` is the
 * registry's, which releases `settled`.
 */
export class ActiveRun {
  /** @type {AbortController} */
  #stopController

  /** @type {() => void} */
  #release

  /** @type {Set<() => void>} */
  #waiters = new Set()

  /**
   * Is a one-shot allowance to re-send an unchecked task outstanding (design D6 of the
   * UI change)? True only from `resume()` to the first `takeResumePending()`, so it
   * cannot outlive the check that spends it.
   */
  #resumePending = false

  /** Did the user end this run with `/taskloop stop` (rather than the loop settling on its own)? */
  stopped = false

  /**
   * Is the run parked between messages (design D2)? True only while a live run
   * waits for `/taskloop resume`; a stopped run is not parked.
   */
  paused = false

  /**
   * Phase of the run (design D5 of the UI change): `task` while it drives a task,
   * `boundary` while it closes a finished group. Only the loop knows this, and it
   * says so through {@link setPhase}.
   */
  phase = RUN_PHASE.task

  /**
   * Directory the run drives (design D7 of the UI change), when its command named one.
   * Kept unguessed rather than read from the process: a snapshot says where *this* run
   * works, and a caller that knows nothing better leaves it `undefined`.
   *
   * @type {string|undefined}
   */
  cwd = undefined

  /**
   * Session the run leads right now (design D7 of the UI change), or `undefined`
   * while none is known: a run begins in the session its command came from and
   * follows the work into the session every group boundary opens.
   *
   * @type {string|undefined}
   */
  sessionId = undefined

  /**
   * Counts of the run's last reading of `tasks.md` (design D7 of the UI change), or
   * `undefined` before the first reading. Stored here so a snapshot can draw the run's
   * progress from memory: a poll must never run the CLI to find out how far it got.
   *
   * @type {{complete: number, total: number}|undefined}
   */
  progress = undefined

  /** @type {import('./tasks.js').ApplyTask[]} */
  tasks = []

  /**
   * @param {string} change - change the run drives.
   * @param {{cwd?: string, sessionId?: string}} [position] - where the run starts: the
   *   directory it drives and the session it leads, when the caller knows them.
   */
  constructor(change, { cwd, sessionId } = {}) {
    if (typeof change !== 'string' || change === '') {
      throw new TypeError('ActiveRun requires the change name')
    }
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) {
      throw new TypeError('ActiveRun requires a non-empty directory for the run')
    }
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId === '')) {
      throw new TypeError('ActiveRun requires a non-empty session id')
    }
    this.change = change
    this.cwd = cwd
    this.sessionId = sessionId
    this.#stopController = new AbortController()
    // The run's own abort is its only cancellation: `/taskloop stop` is the one
    // caller that may end a run from outside, and the invocation's request signal
    // must not (see the module comment).
    this.signal = this.#stopController.signal
    this.settled = new Promise((resolve) => {
      this.#release = resolve
    })
  }

  /** The task whose message left last, or `undefined` before the first one. */
  get task() {
    return this.tasks.at(-1)
  }

  /**
   * Record a task whose step message just left.
   *
   * @param {import('./tasks.js').ApplyTask} task - task the run is now on.
   * @returns {void}
   */
  note(task) {
    this.tasks.push(task)
  }

  /**
   * Record the phase the run is in now (design D5 of the UI change).
   *
   * The loop owns this fact and reports it as it moves — into `boundary` when a
   * finished group is being closed, back into `task` once it is closed — so the slot
   * only validates what it is told. A pause reads the phase to decide whether a turn
   * of this run may be cancelled.
   *
   * @param {'task'|'boundary'} phase - phase the run entered.
   * @returns {void}
   * @throws {TypeError} when the value is not one of {@link RUN_PHASE}.
   */
  setPhase(phase) {
    if (phase !== RUN_PHASE.task && phase !== RUN_PHASE.boundary) {
      throw new TypeError(`ActiveRun got an unknown phase: ${String(phase)}`)
    }
    this.phase = phase
  }

  /**
   * Record the session the run leads now (design D7 of the UI change).
   *
   * The loop reports the session a boundary moved the run into; the session the run
   * started in is the one its command came from, so that one arrives through the
   * constructor. `undefined` is the one value that is not an id: a caller that could
   * not name a session has nothing better to record than the session already known,
   * and a slot that forgot it would report a run without a place.
   *
   * @param {string|undefined} sessionId - id of the session the run is in now.
   * @returns {void}
   * @throws {TypeError} when the value is neither a non-empty string nor `undefined`.
   */
  setSession(sessionId) {
    if (sessionId === undefined) return
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('ActiveRun requires a non-empty session id')
    }
    this.sessionId = sessionId
  }

  /**
   * Record the counts of the run's latest reading of `tasks.md` (design D7 of the UI change).
   *
   * The numbers are copied, so the caller's object cannot change what a snapshot reports
   * afterwards. `undefined` is the one value that is not a reading: a caller holding no
   * counts has nothing better than the counts already known, and a bar that forgot them
   * would redraw a run as unmeasured. Anything else must be two counts in order — a
   * progress that has done more than it has is a caller's bug, not a number to publish.
   *
   * @param {{complete: number, total: number}|undefined} progress - counts of the last reading.
   * @returns {void}
   * @throws {TypeError} when the counts are not two non-negative integers with `complete <= total`.
   */
  setProgress(progress) {
    if (progress === undefined) return
    const counts = typeof progress === 'object' && progress !== null ? progress : {}
    const { complete, total } = counts
    if (!Number.isSafeInteger(complete) || !Number.isSafeInteger(total)
      || complete < 0 || complete > total) {
      throw new TypeError('ActiveRun requires progress as { complete, total } with complete <= total')
    }
    this.progress = { complete, total }
  }

  /**
   * What this run is, for readers that are not the loop (design D7 of the UI change).
   *
   * Every field comes from what the run already holds, so asking is synchronous and free:
   * a badge polls this every other second, and a dialog draws its header from it without
   * a CLI call. `active` is the caller's to add — the slot only exists while a run does.
   *
   * `phase` here is the pause phase ({@link PAUSE_STATE}), not {@link ActiveRun.phase}:
   * the second says where the run is in its work, the first whether it may send, and only
   * the first is shown to a user. Fields the run does not know stay `undefined` rather
   * than being guessed — a run that has sent nothing has no task to report.
   *
   * @returns {{phase: string, change: string, cwd: string|undefined, task: import('./tasks.js').ApplyTask|undefined, progress: {complete: number, total: number}|undefined, sessionId: string|undefined}} the snapshot.
   */
  snapshot() {
    return {
      phase: this.paused ? PAUSE_STATE.paused : PAUSE_STATE.running,
      change: this.change,
      cwd: this.cwd,
      task: this.task,
      progress: this.progress,
      sessionId: this.sessionId,
    }
  }

  /**
   * Ask the run to stop after the turn it is in.
   *
   * Aborting is what the loop observes: it races the wait for quiescence, cuts a
   * read in flight short, and sends nothing more. The turn itself is not killed —
   * it belongs to the agent and finishes in the session.
   *
   * A parked run is released here as well (design D2): `stop()` is the one command
   * that must not wait for a resume, so the gate opens and the loop leaves through
   * `signal`. A stopped run is not parked, which is why the flag is cleared.
   *
   * @returns {void}
   */
  stop() {
    this.stopped = true
    this.paused = false
    // A stop ends the run, so the allowance a resume granted is moot: nothing may take it
    // and read a cancelled run as one that may send again (design D6).
    this.#resumePending = false
    this.#stopController.abort()
    this.#wakeAll()
  }

  /**
   * Park the run at its next safe point (spec "Пауза прогона").
   *
   * The gate is what the loop waits at, so this call only closes it: a task whose
   * turn is already running finishes before the run stops sending. Idempotent — a
   * run that is already parked stays parked and the call reports that nothing
   * changed, which is what lets `/taskloop pause` answer "already paused" without
   * reading the flag first. A run that is over cannot be parked: a pause that
   * arrives after a stop must not leave a paused flag on a slot about to be freed.
   *
   * @returns {boolean} true when this call parked the run.
   */
  pause() {
    if (aborted(this.signal) || this.paused) return false
    this.paused = true
    return true
  }

  /**
   * Release a parked run (spec "Возобновление прогона").
   *
   * Nothing about the position is restored here: the loop re-reads `tasks.md` once
   * it wakes and continues from what the file says, which is what makes a resumed
   * run the same run rather than a new one (design D6).
   *
   * The resume also grants the one allowance a run may hold: the task the pause left
   * unchecked was cancelled by the user, so the loop may send it again instead of
   * reporting a failure. Only a resume grants it — a stop ends the run, and a pause
   * with no resume behind it has released nothing.
   *
   * @returns {boolean} true when the run was parked and may send again.
   */
  resume() {
    if (!this.paused) return false
    this.paused = false
    this.#resumePending = true
    this.#wakeAll()
    return true
  }

  /**
   * Take the allowance a resume granted, if any (design D6 of the UI change).
   *
   * Taking is what keeps an allowance from outliving its check: the loop asks once at
   * the reading that follows a resume, so a second unanswered reading sees an ordinary
   * run and an unchecked box ends it as it always did. A run that was never resumed —
   * and one whose resume has already been spent — answers `false`.
   *
   * @returns {boolean} true when the run was resumed since the last take.
   */
  takeResumePending() {
    if (!this.#resumePending) return false
    this.#resumePending = false
    return true
  }

  /**
   * Wait while the run is parked, until it is resumed or stopped (task 3.1).
   *
   * The loop calls this at its parking points and reads `signal` again afterwards:
   * a stop that ended the wait is a cancelled run, not a resumed one, so the wait
   * resolves either way and lets the caller decide. The signal is the run's own
   * (`run.signal`); watching it here as well is what keeps a stop from having to
   * know that somebody is waiting. The listener is removed whichever way the wait
   * ends, so a long run does not accumulate one per task.
   *
   * @param {AbortSignal} [signal] - cancellation of the whole run.
   * @returns {Promise<void>} resolves once the run may send again, or is over.
   */
  async waitWhilePaused(signal) {
    while (this.paused && !aborted(signal)) {
      await new Promise((resolve) => {
        const wake = () => {
          this.#waiters.delete(wake)
          signal?.removeEventListener('abort', wake)
          resolve()
        }
        this.#waiters.add(wake)
        signal?.addEventListener('abort', wake, { once: true })
        // A resume or a stop that landed between the test above and this
        // registration would otherwise leave the loop parked for good.
        if (!this.paused || aborted(signal)) wake()
      })
    }
  }

  /**
   * Release every wait the gate is holding.
   *
   * Called by `resume()` and `stop()`; iterating a copy keeps a waiter that wakes
   * another one from mutating the set under the loop.
   *
   * @returns {void}
   */
  #wakeAll() {
    for (const wake of [...this.#waiters]) wake()
  }

  /**
   * Release the run's `settled` promise.
   *
   * @returns {void}
   */
  release() {
    this.#release()
  }
}

/**
 * Create the process-wide slot that allows one active run.
 *
 * @returns {{start: Function, current: Function, finish: Function}} the slot.
 */
export function createRuns() {
  /** @type {ActiveRun|null} */
  let current = null

  return {
    /**
     * Claim the slot, or report the run that holds it.
     *
     * @param {string} change - change the new run would drive.
     * @param {{cwd?: string, sessionId?: string}} [position] - where the new run starts: the
     *   directory it drives and the session it leads, when the caller knows them (design D7
     *   of the UI change).
     * @returns {StartOutcome} the run to drive, or the one already active.
     */
    start(change, position) {
      if (current !== null) return { kind: RUN_START.busy, run: current }
      current = new ActiveRun(change, position)
      return { kind: RUN_START.started, run: current }
    },

    /**
     * The run holding the slot, or `null`.
     *
     * @returns {ActiveRun|null} the active run.
     */
    current() {
      return current
    },

    /**
     * Give the slot back and let a waiting `stop` see the run as finished.
     *
     * Only the run that holds the slot can release it: a stale handle from a
     * finished run must not free the slot of a newer one.
     *
     * @param {ActiveRun} run - the run that is ending.
     * @returns {void}
     */
    finish(run) {
      if (current !== run) return
      current = null
      run.release()
    },
  }
}
