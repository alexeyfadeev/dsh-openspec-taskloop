// dsh-openspec-taskloop — what a run is, for readers outside the loop (task 6.1).
//
// Design D7: a badge and a dialog ask the same two questions every other second — is a
// run active, and which phase is it in — and the answer has to cost nothing. The slot
// already holds everything a reader needs (`lib/runs.js` records the phase, the change,
// the directory, the task, the progress of the last reading and the session as the loop
// reports them), so this module only changes the shape: it adds `active` to the run's
// snapshot and answers an empty presence when the slot is free.
//
// Two rules come from the spec ("Состояние прогона для интерфейса") and are the reason
// this is a module rather than three lines at the call site:
//
//   - fields the run does not know stay unknown. A run that has sent nothing reports no
//     task, and an unnamed directory or session stays blank. Guessing a task from the
//     change's listing, or a directory from the process, would tell the user the run is
//     somewhere it never said it was.
//   - a free slot answers `{ active: false }` and nothing else. A stopped run must not
//     keep appearing in a header, and a response that carried its change or task would be
//     the past leaking into a poll.
//
// There is no persistence here and no CLI: `progress` is the pair of counts the loop last
// read, kept in the slot by `setProgress()`, so a poll neither spawns `openspec` nor
// touches `tasks.md`. That is what makes it safe to ask from every session every two
// seconds (design D7/D8).
//
// The module is a plain function of the slot, like the actions of `lib/control.js`: a
// route, a command and a test can each hand it a slot they built themselves, and the
// module never reaches for a host service of its own.

/**
 * What a reader is told about an active run (spec "Состояние прогона для интерфейса").
 *
 * `phase` is the pause phase a badge shows, not the slot's working phase
 * (`ActiveRun.phase`): the first says whether the run may send, the second where it is
 * in its work, and only the first is the interface's business. `cwd`, `task`, `progress`
 * and `sessionId` are `undefined` until the run knows them — the snapshot reports what
 * happened rather than what could be assumed.
 *
 * @typedef {object} ActiveRunStatus
 * @property {true} active - a run holds the slot.
 * @property {'running'|'paused'} phase - whether the run may send (design D7).
 * @property {string} change - change the run drives.
 * @property {string|undefined} cwd - directory the run drives, when it named one.
 * @property {import('./tasks.js').ApplyTask|undefined} task - task whose message left last.
 * @property {{complete: number, total: number}|undefined} progress - counts of the last reading.
 * @property {string|undefined} sessionId - session the run leads now.
 */

/**
 * What a reader is told when the slot is free.
 *
 * Nothing about the previous run: the slot keeps no history (design D7), so a poll after
 * a stop cannot resurrect the change, the directory or the task of a run that ended.
 *
 * @typedef {object} InactiveRunStatus
 * @property {false} active - no run holds the slot.
 */

/**
 * The state of the run slot, as the interface reads it (task 6.1).
 *
 * The answer is synchronous and free: every field comes from what the slot already
 * holds, so a badge polling this never waits on a process, a file or a lock. A parked
 * run is reported as active but paused — the slot stays taken while it waits (design
 * D1) — which is what lets a badge distinguish "working" from "waiting for
 * `/taskloop resume`" without asking the command.
 *
 * @param {{current: () => import('./runs.js').ActiveRun|null}} runs - the process's run slot.
 * @returns {ActiveRunStatus|InactiveRunStatus} the snapshot, or `{ active: false }`.
 * @throws {TypeError} when the argument is not a run slot.
 */
export function statusOf(runs) {
  // A caller that passes nothing would otherwise fail on `current` with a message about
  // an undefined property; naming the argument is what makes a miswired route obvious.
  if (typeof runs?.current !== 'function') {
    throw new TypeError('statusOf requires the run slot')
  }
  const run = runs.current()
  if (run === null) return { active: false }
  // `active` first, then exactly what the run says about itself: the slot is the one
  // place that knows where the run is, and this module repeats it without adding to it.
  return { active: true, ...run.snapshot() }
}
