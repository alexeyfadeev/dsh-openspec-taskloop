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
// change it drives, the task its last message named, and a signal that both the
// caller's cancellation (the UI aborts `invocation.signal` when the request goes
// away) and `/taskloop stop` abort. Composing them in one signal means the loop
// watches a single `AbortSignal` however the run ends, and needs no second way to
// learn that it was stopped.
//
// The slot lives in the closure of `createRuns()` — one per mounted plugin, which
// is one per process — and is the only state a run has outside `tasks.md` (design
// D8). Nothing is persisted: after a restart no run is active, and `/taskloop`
// re-derives its position from the file.

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
 * One in-flight run: its identity, its position and its two ways of stopping.
 *
 * `tasks` grows as messages leave, so `task` is always the task a report should
 * name and `tasks.length` is always the number of turns this run started. The
 * object is mutated only through `note()` and `stop()`; `finish()` is the
 * registry's, and releases `settled`.
 */
export class ActiveRun {
  /** @type {AbortController} */
  #stopController

  /** @type {() => void} */
  #release

  /** Was the run ended by `/taskloop stop` (as opposed to the request going away)? */
  stopped = false

  /** @type {import('./tasks.js').ApplyTask[]} */
  tasks = []

  /**
   * @param {string} change - change the run drives.
   * @param {AbortSignal} [signal] - the command invocation's own cancellation.
   */
  constructor(change, signal) {
    if (typeof change !== 'string' || change === '') {
      throw new TypeError('ActiveRun requires the change name')
    }
    this.change = change
    this.#stopController = new AbortController()
    // `AbortSignal.any` keeps the run's own abort and the invocation's distinct:
    // cancelling one never reaches the other's owners.
    this.signal = signal === undefined || signal === null
      ? this.#stopController.signal
      : AbortSignal.any([signal, this.#stopController.signal])
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
   * Ask the run to stop after the turn it is in.
   *
   * Aborting is what the loop observes: it races the wait for quiescence, cuts a
   * read in flight short, and sends nothing more. The turn itself is not killed —
   * it belongs to the agent and finishes in the session.
   *
   * @returns {void}
   */
  stop() {
    this.stopped = true
    this.#stopController.abort()
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
     * @param {AbortSignal} [signal] - the command invocation's own cancellation.
     * @returns {StartOutcome} the run to drive, or the one already active.
     */
    start(change, signal) {
      if (current !== null) return { kind: RUN_START.busy, run: current }
      current = new ActiveRun(change, signal)
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
