// dsh-openspec-taskloop — the task loop (tasks 4.2–4.3, 5.1–5.4).
//
// One step (`lib/run.js`) reads the task file, sends at most one task and
// returns. The loop is what turns steps into a run: after every message it waits
// for the agent to reach quiescence, re-reads `tasks.md` through the CLI, and
// decides from that reading alone whether the task it sent is done (design D4).
// A checked box advances the run; an unchecked one stops it with a report,
// because a run that marks its own tasks stops being verifiable.
//
//     read ──task──▶ followup ──▶ whenIdle ──▶ read ──checked?──▶ next task
//                                              │
//                                              ├─ unchecked ──▶ { kind: 'unmarked' }
//                                              ├─ gone      ──▶ { kind: 'gone' }
//                                              ├─ flat row  ──▶ { kind: 'unidentified', reason }
//                                              └─ reworded  ──▶ classify
//                                                 ├─ minor ──▶ same task
//                                                 ├─ gray  ──▶ one turn ──ticked────▶ same task
//                                                 │                    └─untouched─┐
//                                                 └─ major ─────────────────────────▶ question
//                                                                                  │
//                          Продолжить ──▶ same task with the new wording ◀──────────┘
//                          stop / no channel / ticked major ──▶ diverged { decision }
//
// A row the model reworded is not a gone row (5.1). When the verbatim triple
// misses, the loop looks for the same `N.M` in the file the task came from
// (design D1, D2) and classifies how far the wording drifted (D3). A `minor`
// drift — the sent wording survived inside the new one, or a typo was fixed — is
// accepted: the row the fresh reading holds replaces `previous` (design D4), so a
// ticked one closes its group like any checked box and an unchecked one goes out
// again with its new wording instead of ending the run.
//
// The two bands the plugin may not settle alone take the ladder's remaining rungs
// (5.2). A `gray` drift gets the one turn design D5 allows it: both wordings and the
// rule that reads the verdict off the checkbox, because `followup()` returns no text.
// A ticked row means the model took it as the same task and did it, so its wording
// becomes the identity the run holds and the next reading sees the box it ticked; an
// untouched row means the same task is unproven, and the user decides — as they do for
// a `major` drift, which gets no turn at all (D6). That question is the only way either
// band continues: its `Продолжить` re-sends the task with the wording the file now
// holds, and every other answer stops the run instead of sending a wording nobody
// vouched for. A row already ticked skips the gray band's turn (D5) — the work is done
// and there is no verdict left to observe — while a ticked row whose wording was
// replaced stops the run rather than asking, because a task performed under a wording
// nobody recognises is not the task the run reported as done.
//
// Those stops are four different facts, and since 5.3 they carry four different names
// (design D7). A row whose number is gone from the file stops as `gone`, because there is
// nothing left to compare — the task was deleted, or moved out of the list, and neither is
// something a run may guess about. Every way of leaving a wording unvouched-for stops as
// `diverged` instead: the user choosing `Остановить taskloop` or closing the card, a
// deployment with nobody to ask, and a ticked row whose wording was replaced — while a card
// cut short by `/taskloop stop` is that stop and not a refusal, so the run ends as `cancelled`.
// Its `decision` says which of the three it was and its `divergence` says how far the wording
// had drifted, so the report turns the two fields into a sentence (6.1) instead of parsing a
// kind.
//
// A row the run cannot identify at all stops as `unidentified`, and its `reason` says which
// identity the reading lacked (5.4, design D10). A flat list has no number to use as the second
// key, so a reworded row there can be told neither from the task that was sent nor from a
// replacement; and a row found under the number may have been left with nothing but that
// number, which is the same impossibility from the other side. Neither stop compared a wording
// or asked anybody, so neither is `gone` — the row is still in the file — nor `diverged`,
// whose subject is a decision somebody made. The reason travels as the classifier's own
// refusal, so the report names the missing key rather than a drift (6.1).
//
// Two consequences of waiting for the whole agent, not for one turn (D1): a user
// message that arrives mid-step is waited for as well, and the run stops if such
// a turn leaves the task unchecked; and a turn that ends in an abort or an error
// lands in the same `unmarked` stop instead of being retried — the cause itself
// stays in the session log, where the user already sees it.
//
// Cancellation (4.3) is the one thing the loop obeys between messages. It is
// checked in four places, because the run can be ended at four different moments:
// before a read, while a read is in flight, while waiting for quiescence, and
// while the finished group is being reviewed (3.3). Any of them ends the run as
// `cancelled`, and none of them sends another message — that is what makes
// `/taskloop stop` a stop rather than a request the next iteration may ignore.
//
// Parking (design D2/D3 of the UI change) is the second thing the loop obeys between
// messages, and unlike a stop it ends nothing: the run stays in the slot and waits
// for a resume. There are exactly two moments a run can be held there without losing
// a turn — right after the turn it sent went quiet, and right before the message the
// reading chose — and both are taken before anything that costs a message or a CLI
// call. A pause that arrives during a turn therefore parks the run before it reads
// again, a pause that arrives during a reading parks it before the task leaves, and a
// stop that ends either wait is an aborted signal at the top of the next iteration.
//
// A resume is more than an open gate (design D6 of the UI change): it carries one allowance to
// send the task again whose turn the pause cancelled. The first check after the resume spends it
// — an unchecked box there is the user's cancellation rather than a failed task, so the same task
// goes out instead of ending the run — while a resume that released a pause taken before the
// message spends it in place, because no turn was cancelled there. Spent, the allowance is gone:
// a task that stays unchecked after the re-send ends the run exactly as it always did.
//
// The loop owns no position of its own: every reading of `tasks.md` comes from
// the CLI, so a run can be re-entered at any time and always starts from what the
// file says (D8). `onTask` publishes each task as its message leaves, which is how
// the run slot can report the task a stop interrupted without the loop knowing
// anything about slots.
//
// The step into another group is where the run changes hands (5.1): the loop asks
// `openSession()` for a session, gets a runner that speaks `followup()` and
// `whenIdle()` like an agent, and stays in it for the rest of that group. The
// first task of a run never crosses a boundary — a run that has sent nothing has
// no group to leave — so it always runs in the session the command came from.
//
// Compaction between tasks of one group (6.1) slots in between the decision and
// the next message: the loop selects the next task, asks `compact()` to shrink the
// context the task is about to inherit when the task continues the group, and only
// then lets the step send it. A boundary is left alone: the run is moving to a
// session with nothing to compact. A compaction that ends `failed` applies the
// configured `onFailure` policy (6.2): `break` stops the run before that message,
// `continue` sends it anyway and records a warning, so the report can say the task
// went out without the bound the run was supposed to have. A run that was stopped
// while compacting ends as `cancelled` like any other stop, whatever the policy.
//
// A finished group is announced before the next one is chosen (3.1, design D13):
// once the task just sent is verified, the same reading says whether every task of
// its group is checked, and `onGroupComplete` receives that group. Taking the check
// there rather than on the transition to the next task is what makes the final
// group reviewable — it has no transition, only an end — and it costs no extra CLI
// call. A flat list has no groups; it is announced once, when nothing is left
// unchecked.
//
// The hook may answer that the group could not be closed (4.3, design D15/D17). A
// commit that failed is such an answer: the group is finished and ticked off, the
// history did not move, and the run stops there with `commit` — the tool, the
// request it refused and the reason it gave — instead of carrying the next group on
// top of work that is not committed. The decision belongs to the caller that owns
// the tool; the loop only knows that a group end can be a stop.
//
// The same answer can be a boundary stop (10.3, design D21). The announcement comes
// before the next task is chosen, so the loop takes that decision against the choice: a
// boundary that leads to another task ends as `stoppedAtGroup`, naming the group that
// closed and the task the next `/taskloop` continues from, while a boundary with nothing
// left to run — the final group of a change, or a flat list whose one group is the whole
// list — goes on to end as it always did, with `completed`. This stop is the old
// «pause after each task group» under its new name (D10 of the UI change): the word
// `pause` belongs to `/taskloop pause`, which parks a live run and does not end it.
//
// The loop also says where the run stands while it stands there (design D5/D7 of the UI
// change): `onPhase` is called as the run enters the boundary of a finished group and as
// it leaves, `onSession` names every session a boundary moves the run into, and
// `onProgress` carries the counts of every reading of the task file. None of them changes
// what the loop does; the slot records them so `/taskloop pause` can tell a turn it may
// cancel from a review it may not, so a badge can name the session the work is in rather
// than the one it left, and so a progress bar is drawn from memory instead of from a CLI
// call on every poll.

import { COMPACTION_END, ON_FAILURE } from './compaction.js'
import { ADJUDICATION_END, DIVERGENCE, DIVERGENCE_ANSWER, DIVERGENCE_REFUSAL, classifyDivergence } from './diverged.js'
import { GROUPING, TRANSITION, classifyTransition, describeGrouping, extractTaskNumber } from './groups.js'
import { NEXT_TASK, findListedTask, findTaskByNumber, selectNextTask } from './tasks.js'
import { readApplyInstructions, runOneStep } from './run.js'
import { RUN_PHASE } from './runs.js'
import { aborted, waitForIdle } from './wait.js'

/**
 * Values of {@link LoopOutcome.kind}; callers switch on them.
 */
export const LOOP_END = Object.freeze({
  /** Every tracked task is checked; the run is complete. */
  completed: 'completed',
  /** The task that was just sent is still unchecked; the run stopped. */
  unmarked: 'unmarked',
  /** The task that was just sent is not listed under its number any more: the row was
   * deleted, or the task was moved out of the file. The run stopped. */
  gone: 'gone',
  /** The wording of the task that was just sent changed further than the run may accept on
   * its own, and nobody let it go ahead: `decision` says how that was settled and
   * `divergence` how far the wording had drifted. The run stopped. */
  diverged: 'diverged',
  /** The task that was just sent cannot be identified from the fresh reading at all: it carries
   * no `N.M` to look a reworded row up by, or the row found under its number has nothing left
   * to compare. `reason` names the identity the reading lacked. The run stopped. */
  unidentified: 'unidentified',
  /** The CLI blocked the change; `reason` says why. */
  blocked: 'blocked',
  /** Ready, yet nothing to run; `reason` says what was observed. */
  idle: 'idle',
  /** The run's signal aborted while waiting; no further task was sent. */
  cancelled: 'cancelled',
  /** Compaction before the next task failed; `compaction` says where and why. */
  compaction: 'compaction',
  /** The commit of the group just finished failed; `commit` says which tool and why. */
  commit: 'commit',
  /** The group just finished ended the run at its boundary; `boundary` names it and
   * the task left for later (10.3). */
  stoppedAtGroup: 'stoppedAtGroup',
})

/**
 * Values of {@link LoopOutcome.decision}: how a `diverged` run settled (task 5.3).
 *
 * Three facts, kept apart because the report turns each into its own sentence and a
 * reader of the outcome must not parse one (design D7). All three leave the task unsent:
 * a wording nobody vouched for is not something the run may carry on with, and the
 * difference between them is who said no.
 */
export const DIVERGENCE_DECISION = Object.freeze({
  /** The user chose `Остановить taskloop`, or closed the card without answering (design D6). */
  declined: 'declined',
  /** Nobody could be asked: no question channel, no adjudication turn, or no seam to ask through. */
  noChannel: 'no-channel',
  /** The box was already ticked while the wording was replaced beyond recognition: nothing
   * was left to run, and the task performed is not the one the run reported (design D6). */
  alreadyDone: 'already-done',
})

/**
 * What a completed group's hook may answer (design D13, D17); callers build one.
 *
 * A hook returns nothing while the group is closed, and this value when the run must
 * stop at the boundary: a commit the tool refused is not something the next group may
 * be built on top of (4.3, design D15), and a boundary stop the user asked for ends the
 * run where the group ended (10.3, design D21). The loop does not look inside `commit` —
 * it carries it to the report as it received it — and decides `stoppedAtGroup` against the
 * next task, because a boundary with nothing to continue is not a stop.
 */
export const GROUP_END = Object.freeze({
  /** The group is closed; the run may select the next task. */
  closed: 'closed',
  /** The commit that closes the group failed; the run stops at that boundary (4.3). */
  commit: 'commit',
  /** The run ends here instead of opening the next group's session (10.3, design D21). */
  boundary: 'boundary',
})

/**
 * How one run of the loop ended.
 *
 * `sent` is the run's audit trail: the tasks whose messages left this call, in
 * order. `task` is the last of them, and is the task a stop report is about; a
 * stop that sent nothing has no `task`.
 *
 * @typedef {object} LoopOutcome
 * @property {'completed'|'unmarked'|'gone'|'diverged'|'unidentified'|'blocked'|'idle'|'cancelled'|'compaction'|'commit'|'stoppedAtGroup'} kind - how the run ended.
 * @property {'declined'|'no-channel'|'already-done'} [decision] - how a `diverged` stop was
 *   settled (5.3): the user said no, nobody could be asked, or the row was already ticked
 *   under a replaced wording. Present only on `diverged`.
 * @property {'gray'|'major'} [divergence] - how far the wording of the task that was just sent
 *   had drifted (design D3), so the report can name the band. Present only on `diverged`.
 * @property {import('./tasks.js').ApplyInstructions} [instructions] - the last reading of the task file;
 *   absent when the run was cancelled before any reading completed.
 * @property {import('./tasks.js').ApplyTask[]} sent - tasks sent during this run, in order.
 * @property {import('./tasks.js').ApplyTask} [task] - last task sent; absent when none was.
 * @property {{sessionId: string, task: import('./tasks.js').ApplyTask}[]} sessions - sessions the run
 *   moved to at a group boundary, in order, with the task each one took over at (5.1).
 * @property {{attempts: number, code?: string, reason?: string, task: import('./tasks.js').ApplyTask}} [compaction] -
 *   the failed compaction that stopped the run: how many calls it took, the last
 *   code and message, and the task whose message was withheld (6.1).
 * @property {{task: import('./tasks.js').ApplyTask, attempts: number, code?: string, reason?: string}[]} warnings -
 *   compactions the run survived: each one names the task that was sent without it,
 *   and the attempts, last code and message of the failed transition (6.2). Empty
 *   unless the `continue` policy turned a spent budget into a warning.
 * @property {{tool: string, message: string, command?: string, exitCode?: number|null, reason?: string, range?: {from: string, to: string}}} [commit] -
 *   the commit that stopped the run (4.3, design D15/D17): the configured tool, the
 *   message it would have carried, the request that failed with its exit code and
 *   account of the failure, and the group it was closing. Present only when the group
 *   hook answered `GROUP_END.commit`.
 * @property {{range?: {from: string, to: string}, next: import('./tasks.js').ApplyTask}} [boundary] -
 *   the boundary a `stoppedAtGroup` run ended at (10.3, design D21): the group it closed, named
 *   by its first and last task as written (`range` is absent for a flat run, which has no
 *   numbering), and the task the next `/taskloop` continues from. Present only when the
 *   group hook answered `GROUP_END.boundary` and the selection still had a task.
 * @property {string} [reason] - the CLI's account of a `blocked` or `idle` stop, or the
 *   `number-missing` / `number-changed` / `empty-text` refusal that left an `unidentified`
 *   task unrecognised (5.4).
 */

/**
 * A group whose last task was just verified (3.1, design D13).
 *
 * `tasks` is the group in file order, all of them checked. `range` names its first
 * and last task as written, which is what a commit message adds to the user's text
 * (`Tasks 2.1 - 2.4`); a flat run has no numbering, so it carries no range.
 *
 * @typedef {object} GroupCompleteContext
 * @property {string} change - change the group belongs to, as the CLI named it.
 * @property {import('./tasks.js').ApplyTask[]} tasks - tasks of the group, in file order
 *   (a flat run: every listed task).
 * @property {{from: string, to: string}} [range] - first and last task labels; absent
 *   for a flat run.
 * @property {object} agent - recipient that drove the group's last task: the invocation's
 *   agent, or the session runner the run moved to at an earlier boundary. The hook names
 *   it so an action taken at the boundary (the commit, 4.3) can speak in the session where
 *   the group's transcript lives.
 */

/**
 * Drive tasks of one change until the file says stop.
 *
 * The first action of a run is a read, so a change that is blocked, complete or
 * has nothing to run sends no message at all. After a message the loop waits for
 * `agent.whenIdle()` before it reads again — never before (spec "Один turn на
 * задачу") — and treats only a checked box as progress (spec "Завершение задачи
 * определяется по tasks.md"). An aborted `signal` ends the run as `cancelled`
 * without sending anything else (spec "Один активный прогон"). Between two tasks of
 * one group it compacts the session before the next message; a compaction that
 * fails is handled by `onFailure` — `break` stops the run with `compaction` instead
 * of sending into an unbounded context, `continue` sends the task and carries a
 * warning to the report (spec "Сжатие между задачами внутри группы").
 *
 * @param {object} options
 * @param {{run: Function}} options.cli - the `openspec` wrapper.
 * @param {string} options.cwd - project directory the CLI runs in.
 * @param {string} options.change - change to run.
 * @param {object} options.agent - live agent that receives the task messages and reports idleness.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @param {(signal?: AbortSignal) => Promise<void>} [options.waitWhilePaused] - the run's gate
 *   (design D2/D3 of the UI change): resolves once a parked run may send again or is over.
 *   Called at the two parking points — after a turn went quiet, and before the task the
 *   reading chose leaves — and never while a message is in flight. Absent, the loop never
 *   parks: a deployment without pause, and every test that does not care about one.
 * @param {() => boolean} [options.resumePending] - takes the one allowance a resume leaves
 *   behind (design D6 of the UI change). It answers true once, at the first check after
 *   `/taskloop resume`: an unchecked box there is a turn the user cancelled, so that task
 *   is sent again instead of ending the run. A resume that released a pause taken before the
 *   message spends the allowance in place, because no turn was cancelled there. Absent, every
 *   unchecked box is a failure, which is what every run without a pause decides.
 * @param {string} [options.skillPath] - skill the step messages name; defaults to the apply skill.
 * @param {(task: import('./tasks.js').ApplyTask) => void} [options.onTask] - called as soon as a
 *   task's message leaves, before the run waits for its turn: the run's only outward signal
 *   between messages, which is where a run records the task it is on (4.3).
 * @param {(phase: 'task'|'boundary') => void} [options.onPhase] - called when the run enters
 *   the phase it is in (design D5 of the UI change): `boundary` while a finished group is
 *   being closed, `task` again once it is closed. Absent, nobody follows the phase.
 * @param {(sessionId: string) => void} [options.onSession] - called with the id of every
 *   session a group boundary moves the run into (design D7 of the UI change), once the first
 *   task of that group has been sent. The session the run started in is not reported — the
 *   caller opened nothing and already knows it.
 * @param {(progress: {complete: number, total: number}) => void} [options.onProgress] - called with
 *   the counts of every reading of the task file (design D7 of the UI change), so a reader can
 *   draw the run's progress without running the CLI itself. Not called when a reading carries no
 *   usable counts. Absent, nobody follows the progress.
 * @param {(context: GroupCompleteContext) => (void|{kind: string, commit: object}|Promise<void|{kind: string, commit: object}>)} [options.onGroupComplete] -
 *   called once the verified task left its group whole, before the next task is chosen (3.1):
 *   the run's hook for the review and commit that follow a group. It may answer
 *   `{kind: GROUP_END.commit, commit}` to stop the run at that boundary — a commit the
 *   tool refused (4.3, design D15) — or `{kind: GROUP_END.boundary}` to end it there and
 *   leave the next task for the following `/taskloop` (10.3, design D21). Absent, a
 *   completed group is announced to nobody and the run continues as before.
 * @param {(context: {change: string, previous: import('./tasks.js').ApplyTask, task: import('./tasks.js').ApplyTask}) => (object|Promise<object>)} [options.openSession] -
 *   opens the session a new group runs in (5.1) and returns its runner. Absent, a run that
 *   reaches a group boundary stops with a `TypeError` instead of silently continuing in the
 *   session it was leaving.
 * @param {(context: {change: string, agent: object, previous: string, task: import('./tasks.js').ApplyTask}) => Promise<import('./diverged.js').AdjudicationOutcome>} [options.adjudicate] -
 *   runs the one turn design D5 allows an uncertain divergence and reads its verdict off
 *   the row's checkbox (task 5.2). The loop hands it the recipient that received the task —
 *   a group boundary may have moved the run into another session — and the two wordings of
 *   that same row: the one that was sent, and the one the fresh reading holds. The seam
 *   itself is bound to the run's signal, so a stop ends the turn rather than waiting for it.
 *   Absent, a gray divergence has no verdict to read and the run stops instead of adopting or
 *   asking on a guess.
 * @param {(context: {change: string, previous: string, task: import('./tasks.js').ApplyTask}) => Promise<import('./diverged.js').ContinuationOutcome>} [options.confirmDiverged] -
 *   asks the user whether a task whose wording changed beyond recognition should still run
 *   (design D6 of the divergence change). The seam arrives bound to the run — its agent and
 *   its signal — so the loop never learns who answers; the divergence ladder (5.1–5.3) is its
 *   only caller, handing it the two wordings of the same row. Absent, a divergence cannot be
 *   resolved and the run stops with a reason instead of running a task no person vouched for.
 * @param {(agent: object, signal?: AbortSignal) => Promise<import('./compaction.js').CompactionOutcome>} [options.compact] -
 *   compacts the session the next task will run in, retries included (6.1). Called only when
 *   that task continues the current group, and before its message leaves. Absent, the run never
 *   compacts — a deployment without a compaction service, and every test that does not care
 *   about 6.1.
 * @param {'continue'|'break'} [options.onFailure] - what a compaction that spent its
 *   attempts means for the run (6.2): `break` stops before the task, `continue` sends it and
 *   records a warning. Defaults to `break`, the configuration's own default, because an
 *   unbounded context is worse than a stop the report explains.
 * @returns {Promise<LoopOutcome>} how the run ended and what it sent.
 * @throws {TypeError} when the agent has no `followup()` or `whenIdle()`, or when `onFailure`
 *   is not one of the two policies.
 * @throws {import('./tasks.js').ApplyError} when a reading of the task file is not usable.
 * @throws {import('./openspec.js').OpenSpecError} when the CLI cannot run.
 */
export async function runLoop({
  cli, cwd, change, agent, signal, waitWhilePaused, resumePending, skillPath, onTask, onPhase,
  onSession, onProgress, onGroupComplete, openSession, adjudicate, confirmDiverged, compact, onFailure,
}) {
  // Both channels are required before the first read: sending a task and then
  // discovering that nothing can wait for its turn would leave the run unable to
  // decide, with a message already in the session.
  if (typeof agent?.followup !== 'function' || typeof agent?.whenIdle !== 'function') {
    throw new TypeError('runLoop requires an agent that accepts followup() and reports whenIdle()')
  }
  // An unknown policy would otherwise fall through to one of the two branches by
  // accident; the loader validates the configuration, and a caller that bypasses it
  // is told here, before any message leaves.
  const policy = onFailure ?? ON_FAILURE.break
  if (policy !== ON_FAILURE.break && policy !== ON_FAILURE.continue) {
    throw new TypeError(`runLoop got an unknown compaction.onFailure policy: ${String(policy)}`)
  }

  /** @type {import('./tasks.js').ApplyInstructions|undefined} */
  let instructions
  /** @type {import('./tasks.js').ApplyTask[]} */
  const sent = []
  /** @type {import('./tasks.js').ApplyTask|undefined} */
  let previous
  /** @type {{sessionId: string, task: import('./tasks.js').ApplyTask}[]} */
  const sessions = []
  /** @type {{task: import('./tasks.js').ApplyTask, attempts: number, code?: string}[]} */
  const warnings = []
  /** The recipient of the next task: the invocation's agent until a boundary moves it. */
  let target = agent
  /** The phase the run is in (design D5 of the UI change); `boundary` only while a group is closing. */
  let phase = RUN_PHASE.task
  // The gate the run parks at (design D2/D3 of the UI change). Absent, the loop never
  // parks: a deployment that cannot pause, and every test that does not care about one.
  const waitPaused = typeof waitWhilePaused === 'function' ? waitWhilePaused : async () => {}
  // The one allowance a resume grants (design D6 of the UI change). Absent, no pause exists
  // to excuse an unchecked box, and every reading decides alone.
  const takeResumePending = typeof resumePending === 'function' ? resumePending : () => false

  /**
   * Move the run into a phase, telling the caller when it changes.
   *
   * The loop is the only thing that knows when a boundary begins and ends, so it is
   * what reports it; repeating the phase it is already in says nothing, because a
   * listener that records the value has nothing to record.
   *
   * @param {'task'|'boundary'} next - phase the run is entering.
   * @returns {void}
   */
  function enterPhase(next) {
    if (phase === next) return
    phase = next
    onPhase?.(next)
  }

  /**
   * The recipient of one task, opening a session when the group changes.
   *
   * Only a grouped transition can move the run: a flat list has no boundary on
   * purpose (design D5), and the first task has no group to leave. A failure to
   * open the session propagates — continuing here in the session the run was
   * leaving would report a boundary it did not honour.
   *
   * @param {import('./tasks.js').ApplyTask} task - task about to be sent.
   * @returns {Promise<object>} the agent or session runner to send to.
   * @throws {TypeError} when a boundary is reached and the loop has no `openSession()`.
   */
  async function targetFor(task) {
    if (previous === undefined) return target
    const transition = classifyTransition(describeGrouping(instructions.tasks), previous, task)
    if (transition !== TRANSITION.newGroup) return target

    if (typeof openSession !== 'function') {
      throw new TypeError('the run reached a group boundary but runLoop has no openSession()')
    }
    const runner = await openSession({ change, previous, task })
    // A stop that lands while the session is being created must not send the
    // first task into it: the run is over, and the new session stays unused.
    if (aborted(signal)) {
      throw new Error('the run was stopped while its next session was being created')
    }
    return runner
  }

  /**
   * Build one settled outcome from what the run knows right now.
   *
   * Every ending goes through here so none can forget a warning the run survived:
   * a run that skipped compaction under the `continue` policy must say so in its
   * report whichever state it finally stops in (6.2).
   *
   * @param {LoopOutcome['kind']} kind - how the run ended.
   * @param {object} [fields] - the readings that override what the run holds.
   * @returns {LoopOutcome} the outcome.
   */
  const settleNow = (kind, fields = {}) => settle(kind, {
    instructions,
    sent,
    task: previous,
    sessions,
    warnings,
    ...fields,
  })

  // A cancelled run reports the reading it last had, which may be none at all: a
  // stop that arrives before the first answer leaves the report to the listing's
  // counts instead of inventing a task file.
  const cancel = () => settleNow(LOOP_END.cancelled)

  /**
   * Compact before a task that continues the current group (6.1).
   *
   * Only a transition inside a group compacts: the first task has no history of
   * this run to shrink, and a boundary opens a session that is empty by
   * construction, so compacting the session being left would spend a summary
   * nobody inherits (design D7). A flat run has no boundaries and therefore
   * compacts on every transition (design D5).
   *
   * A transition whose attempts are spent is where the `onFailure` policy applies
   * (6.2): `break` hands the failure back so the run stops before the message,
   * `continue` records it as a warning and lets the task go out compacted only as
   * far as the backend managed.
   *
   * The recipient is the session the task will run in — before the step opens a
   * new one, which only happens at a boundary this function skips.
   *
   * @param {import('./tasks.js').ApplyTask} task - the task about to be sent.
   * @returns {Promise<import('./compaction.js').CompactionOutcome|undefined>} the failed or
   *   cancelled transition, or `undefined` when there was nothing to do, it succeeded, or the
   *   `continue` policy took the failure as a warning.
   */
  async function compactBefore(task) {
    if (previous === undefined || typeof compact !== 'function') return undefined
    const transition = classifyTransition(describeGrouping(instructions.tasks), previous, task)
    if (transition === TRANSITION.newGroup) return undefined

    const result = await compact(target, signal)
    // A stop that landed while the backend was compacting wins over the outcome:
    // the run is over either way, and no task may follow it (4.3).
    if (aborted(signal)) return { kind: COMPACTION_END.cancelled }
    if (result.kind === COMPACTION_END.compacted) return undefined
    if (result.kind === COMPACTION_END.cancelled) return result
    // The failure's message travels with the outcome: a code is a closed set of
    // categories, and "the compaction service is not composed" is not one of them —
    // without the message the report would say the compaction failed and leave the
    // reason in the session log.
    const reason = messageOf(result.error)
    if (policy === ON_FAILURE.continue) {
      warnings.push({ task, attempts: result.attempts, code: result.code, reason })
      return undefined
    }
    return { ...result, reason }
  }

  /**
   * Ask the user whether a reworded row the plugin may not adopt on its own still runs.
   *
   * This is the second of the two seams the ladder is given (design D6, D8), and the only
   * way a `major` drift or a `gray` one the model left alone can continue: the card shows
   * both wordings and offers `Продолжить`, which re-sends the task with the new wording. The
   * seam is bound to the run — its agent and its signal — so the loop never learns who
   * answers; it hands in the change and the two wordings and reads back one of three
   * answers.
   *
   * Every answer but `continue` is a stop, and the two ways of stopping are two decisions the
   * report names apart (task 5.3): a person who said no, and a deployment where nobody could
   * be asked. The seam being absent is the second of those rather than a reason to guess, and
   * an answer the ladder does not know is read the way the question itself reads an ambiguous
   * selection — as a refusal (4.2), because an answer nobody can interpret granted nothing.
   *
   * @param {import('./tasks.js').ApplyTask} task - row the fresh reading holds.
   * @returns {Promise<'continue'|'stop'|'unavailable'>} how the question was settled.
   */
  async function continueDiverged(task) {
    if (typeof confirmDiverged !== 'function') return DIVERGENCE_ANSWER.unavailable
    // The CLI's own name for the change, as the group hook uses: the run may have been
    // started with a name the CLI resolves differently, and the card belongs to the change
    // the reading describes. Both wordings are handed over as text — the card shows them
    // side by side — while the row itself travels as the task the fresh reading holds.
    const answer = await confirmDiverged({
      change: instructions.change !== '' ? instructions.change : change,
      previous: previous.description,
      task,
    })
    if (answer?.kind === DIVERGENCE_ANSWER.continue) return DIVERGENCE_ANSWER.continue
    if (answer?.kind === DIVERGENCE_ANSWER.unavailable) return DIVERGENCE_ANSWER.unavailable
    return DIVERGENCE_ANSWER.stop
  }

  for (;;) {
    // Checked before the read, because the read is the loop's only await between
    // the decision and the next message: a stop that landed while the previous
    // turn was finishing must not cost one more task.
    if (aborted(signal)) return cancel()

    if (instructions === undefined || previous !== undefined) {
      // The only moment the plugin reads the file is after the agent went quiet:
      // a reading taken during the turn would see the checkbox the model has not
      // ticked yet and stop a healthy run. A read cut short by a stop is that
      // stop, not a failure to report.
      try {
        instructions = await readApplyInstructions({ cli, cwd, change, signal })
      } catch (error) {
        if (aborted(signal)) return cancel()
        throw error
      }
    }

    // The counts travel with the reading that produced them (design D7 of the UI change): a
    // badge draws its bar from the last numbers it was told, and it must not run the CLI to
    // ask again. A reading the CLI could not count leaves the last known numbers alone
    // instead of redrawing a run as unmeasured.
    if (instructions.progress !== null) {
      onProgress?.({ complete: instructions.progress.complete, total: instructions.progress.total })
    }

    // The boundary the hook asked to stop at, when this reading closed a group
    // (10.3, design D21). The stop itself is settled after the selection, below.
    /** @type {{range?: {from: string, to: string}}|undefined} */
    let boundaryAt
    if (previous !== undefined) {
      // The verbatim triple is the fast path (design D1): while the row stands untouched
      // there is nothing to judge, so no other key is consulted.
      let refreshed = findListedTask(instructions, previous)
      // Whether this reading accepted a reworded row as the task that was sent (design D4).
      let accepted = false
      if (refreshed === undefined) {
        // A row the file lists without `N.M` has no second key at all (design D10): its wording
        // cannot be told from a replacement, so the run stops naming that impossibility instead
        // of reporting a removal. Checked before the search, because the search declines a flat
        // row on its own and the stop would then look like a deleted one (spec «Задача без
        // номера»).
        if (extractTaskNumber(previous.description) === null) {
          return settleNow(LOOP_END.unidentified, { reason: DIVERGENCE_REFUSAL.numberMissing })
        }
        // The second key is the number the row carries (design D2): a row whose line moved
        // or whose text was edited is still listed under the same `N.M` in the same file.
        const reworded = findTaskByNumber(instructions, previous)
        // Nothing under that number in the file it came from: the row was removed, or the
        // task was moved out of the list, and neither is something the run may guess about.
        // This stop has no wording to compare, so it is `gone` and not a divergence (design D7).
        if (reworded === undefined) {
          return settleNow(LOOP_END.gone)
        }
        // How far the wording drifted decides what the run may do with the row (design D3).
        const divergence = classifyDivergence(previous.description, reworded.description)
        if (divergence.kind === DIVERGENCE.minor) {
          // Design D4: the new wording is accepted, and it has to replace `previous`. Keeping
          // the sent text would make the next reading diverge from it again, and the run would
          // spend one turn per iteration rediscovering a row that is already the same task.
          refreshed = reworded
          previous = reworded
          accepted = true
        } else if (divergence.kind === DIVERGENCE.gray) {
          // Design D5: the uncertain band is worth exactly one turn, and only when there is
          // still work to do. A ticked row skips it — the task was performed, and a verdict
          // cannot be observed where the box already says done — so the question below is
          // asked straight away, which is the spec's "Задача уже отмечена" scenario.
          if (!reworded.done) {
            // No turn to ask and therefore no verdict to read: the run stops as a divergence
            // nobody could be asked about, rather than picking a band for the user (design D8).
            // It is `no-channel` for the same reason a deployment without a question service
            // is: the band needs an answer, and this deployment has no way to obtain one.
            if (typeof adjudicate !== 'function') {
              return settleNow(LOOP_END.diverged, {
                decision: DIVERGENCE_DECISION.noChannel,
                divergence: DIVERGENCE.gray,
              })
            }
            // The recipient travels with the call — a group boundary may have moved the run into
            // another session — and so does the change the reading named, which is what the turn
            // tells the model.
            const verdict = await adjudicate({
              change: instructions.change !== '' ? instructions.change : change,
              agent: target,
              previous: previous.description,
              task: reworded,
            })
            // A stop that ended the turn is the end of the run, and the row it may or may
            // not have ticked says nothing about a task nobody finished (spec "Остановка во
            // время адъюдикации").
            if (verdict?.kind === ADJUDICATION_END.cancelled) return cancel()
            if (verdict?.kind === ADJUDICATION_END.ticked) {
              // The model took the row as the same task and performed it, so the wording it
              // confirmed becomes the identity the run holds; the reading that follows sees
              // the box it ticked instead of the wording it was given. Re-reading rather than
              // trusting the verdict for the checkbox is what keeps `tasks.md` the authority
              // on whether a task is done (spec "Завершение задачи определяется по tasks.md").
              previous = reworded
              continue
            }
            // `untouched`: the same task is still unproven, and the plugin may not adopt a
            // wording the model declined to recognise (design D5).
          }
          // Either the model left the row alone or the box was already ticked. Both are
          // questions about a wording nobody has confirmed: the card of design D6 is the only
          // answer, and only `Продолжить` lets the task go ahead.
          const answer = await continueDiverged(reworded)
          // A stop that landed while the card was open ends the run as the stop it was, not as an
          // answer to the card (5.3): the question is asked with the run's signal, so a
          // `/taskloop stop` reaches this point as a dismissal, the same way it ends the
          // adjudication turn above — as `cancelled`, because nobody declined anything.
          if (aborted(signal)) return cancel()
          if (answer !== DIVERGENCE_ANSWER.continue) {
            // Refused, dismissed or unaskable: the two decisions design D7 names apart.
            return settleNow(LOOP_END.diverged, {
              decision: decisionOf(answer),
              divergence: DIVERGENCE.gray,
            })
          }
          refreshed = reworded
          previous = reworded
          accepted = true
        } else if (divergence.kind === DIVERGENCE.major) {
          // Design D6: a wording with almost nothing in common with the one that was sent is
          // nobody's call but the user's, and the model is not even asked — the turn of the
          // gray band exists to settle uncertainty, not to grant a rewrite.
          if (reworded.done) {
            // A ticked row under a replaced wording is not the task the run reported as done;
            // it stops the run instead of asking whether to run it, because nothing is left to
            // run (spec "Остановка при исчезнувшей или уже отмеченной задаче"). The decision
            // names which of the two facts this is: the work happened, under a wording nobody
            // recognises (design D7).
            return settleNow(LOOP_END.diverged, {
              decision: DIVERGENCE_DECISION.alreadyDone,
              divergence: DIVERGENCE.major,
            })
          }
          const answer = await continueDiverged(reworded)
          // The same stop as in the gray band: a card cut short by `/taskloop stop` ends the run,
          // and its dismissal is not a person refusing the wording.
          if (aborted(signal)) return cancel()
          if (answer !== DIVERGENCE_ANSWER.continue) {
            return settleNow(LOOP_END.diverged, {
              decision: decisionOf(answer),
              divergence: DIVERGENCE.major,
            })
          }
          refreshed = reworded
          previous = reworded
          accepted = true
        } else {
          // A pair the classifier refused although both rows carry the number it compares: a row
          // was left with nothing but that number, or blanked (task 5.4). Nothing was compared
          // and nobody was asked, so the stop names the refusal, not a band and not a decision.
          return settleNow(LOOP_END.unidentified, { reason: divergence.reason })
        }
      }
      // The first check after a resume spends its allowance (design D6 of the UI change):
      // the box the pause left unchecked belongs to a turn the user cancelled, not to a task
      // the model failed, so the same task goes out again. Taking it here — whatever the box
      // says — is what keeps the allowance from reaching a later task; and it is taken by the
      // check, so a task that stays unchecked after the re-send still ends the run.
      const resumed = takeResumePending()
      // An unchecked box ends the run — except the two cases where the box is not evidence
      // about a task that failed: a turn a pause cancelled, and a wording the file accepted
      // while its row stayed unchecked, which is sent again with that wording (design D4).
      if (!refreshed.done && !resumed && !accepted) {
        return settleNow(LOOP_END.unmarked)
      }

      // No group can be whole while this task is unchecked, so a task the resume re-sent
      // announces nothing. The reading that verifies a task is also the one that answers
      // whether its group is complete, and it answers before the next task is chosen: the
      // final group has no transition to hang a review on, only this moment (3.1).
      const closed = refreshed.done
        ? closedGroup(describeGrouping(instructions.tasks), instructions.tasks, refreshed)
        : undefined
      if (closed !== undefined) {
        const context = {
          change: instructions.change !== '' ? instructions.change : change,
          tasks: closed.tasks,
          agent: target,
        }
        if (closed.range !== undefined) context.range = closed.range
        // Closing a group is the boundary phase (design D5 of the UI change): a review
        // and a commit of work that is already ticked off may not be cut short, so a
        // pause that arrives now parks the run after this hook instead of cancelling
        // its turn. The phase goes back to `task` whatever the hook answered, because
        // the boundary ended either way.
        let stoppage
        if (typeof onGroupComplete === 'function') {
          enterPhase(RUN_PHASE.boundary)
          try {
            stoppage = await onGroupComplete(context)
          } finally {
            enterPhase(RUN_PHASE.task)
          }
        }
        // A stop that landed while the group was being reviewed ends the run here:
        // the review is over either way, and selecting a next task from what a
        // stopped review left behind would report a group the run did not close (3.3).
        if (aborted(signal)) return cancel()
        // A commit the tool refused ends the run at the same place (4.3, design D15):
        // the group is done and ticked off, and the next group must not start on top of
        // work that never reached the history.
        if (stoppage?.kind === GROUP_END.commit) {
          return settleNow(LOOP_END.commit, { commit: stoppage.commit })
        }
        // A boundary stop is only recorded here: whether it ends the run depends on there
        // being a task to leave for the next `/taskloop` (10.3, design D21).
        if (stoppage?.kind === GROUP_END.boundary) {
          boundaryAt = closed.range === undefined ? {} : { range: closed.range }
        }
      }
    }

    // The decision is taken here, not inside the step, because compaction has to
    // happen between them (6.1): the step receives the selection it must act on.
    const selection = selectNextTask(instructions)
    // A boundary stop needs a boundary with somewhere to go (10.3, design D21). The final
    // group of a change and a flat list leave nothing to run, so they fall through to the
    // ordinary step below and settle as complete, exactly as before the setting existed.
    if (boundaryAt !== undefined && selection.kind === NEXT_TASK.task) {
      return settleNow(LOOP_END.stoppedAtGroup, { boundary: { ...boundaryAt, next: selection.task } })
    }
    if (selection.kind === NEXT_TASK.task) {
      const stoppage = await compactBefore(selection.task)
      if (stoppage !== undefined) {
        if (stoppage.kind === COMPACTION_END.cancelled) return cancel()
        return settleNow(LOOP_END.compaction, {
          compaction: {
            attempts: stoppage.attempts,
            code: stoppage.code,
            reason: stoppage.reason,
            task: selection.task,
          },
        })
      }
      // The decision is made and the context is prepared, so this is the second parking
      // point (design D3 of the UI change): a pause that arrived during the reading, the
      // compaction or the boundary hook takes effect before the message leaves, and it
      // costs neither a task nor another CLI call. A gate that nothing will send behind —
      // a complete, blocked or idle reading — is not entered at all: parking there would
      // hold a run whose only remaining step is to end.
      await waitPaused(signal)
      // The wait ends for a stop as well; a stopped run sends nothing (design D2).
      if (aborted(signal)) return cancel()
      // A resume that released this wait cancelled no turn — the task had not left yet — so the
      // allowance it carries has nothing to excuse. Spending it here is what keeps a pause taken
      // during a reading from excusing the unchecked box of the turn that follows (design D6):
      // that box is the resumed run's own result, and it ends the run like any other failure.
      takeResumePending()
    }

    let step
    try {
      step = await runOneStep({
        cli,
        cwd,
        change,
        agent: target,
        agentFor: targetFor,
        signal,
        skillPath,
        instructions,
        selection,
      })
    } catch (error) {
      // The step can end without a message because the stop landed inside the
      // session handoff; that is the stop, not a failure of the run.
      if (aborted(signal)) return cancel()
      throw error
    }

    if (step.kind !== NEXT_TASK.task) {
      return settleNow(endOf(step.kind), {
        instructions: step.instructions,
        reason: step.reason,
      })
    }

    sent.push(step.task)
    previous = step.task
    onTask?.(step.task)

    // The step may have run in a session it just opened; the report names every
    // session the run moved to, with the task it took over at (5.1), and the caller
    // learns the same id as the place the run leads now (design D7 of the UI change).
    if (step.agent !== target) {
      sessions.push({ sessionId: step.agent.sessionId, task: step.task })
      target = step.agent
      onSession?.(step.agent.sessionId)
    }

    if (await waitForIdle(step.agent, signal) === 'cancelled') return cancel()
    // The turn is over, so this is the first moment a pause can take effect without
    // cutting anything short (design D3 of the UI change): waiting here is what keeps a
    // pause that arrived during the turn from paying for one more reading. A stop that
    // ends this wait is the aborted signal the next iteration checks before it reads.
    await waitPaused(signal)
  }
}

/**
 * The group a just-verified task closed, when this reading shows it whole (3.1).
 *
 * A grouped task closes its group once every task carrying its number is checked;
 * the task just verified is one of them, so a group that was already complete
 * before it is closed too. A flat list has no numbers: its unit is the whole
 * listed set, and it closes only when nothing is left unchecked (design D13).
 *
 * @param {{mode: string, groups: {group: number, tasks: import('./tasks.js').ApplyTask[]}[]}} grouping -
 *   grouping of the reading that verified the task.
 * @param {import('./tasks.js').ApplyTask[]} tasks - every listed task of that reading.
 * @param {import('./tasks.js').ApplyTask} previous - the task whose turn just ended.
 * @returns {{tasks: import('./tasks.js').ApplyTask[], range?: {from: string, to: string}}|undefined} the
 *   closed group, or `undefined` while one of its tasks is still unchecked.
 */
function closedGroup(grouping, tasks, previous) {
  if (grouping.mode === GROUPING.flat) {
    return tasks.every((task) => task.done) ? { tasks } : undefined
  }

  const number = extractTaskNumber(previous.description)
  if (number === null) return undefined
  const group = grouping.groups.find((entry) => entry.group === number.group)
  if (group === undefined || !group.tasks.every((task) => task.done)) return undefined

  // Both ends are numbered: a grouped run has every description prefixed, and this
  // group exists because one of its tasks carried the number.
  const from = extractTaskNumber(group.tasks[0].description)
  const to = extractTaskNumber(group.tasks[group.tasks.length - 1].description)
  return { tasks: group.tasks, range: { from: from.label, to: to.label } }
}

/**
 * Map a step's stop state onto the loop's vocabulary.
 *
 * `NEXT_TASK.done` becomes `completed` because by the time the loop sees it the
 * run either sent tasks and finished them or found the file already complete;
 * `blocked` and `idle` keep their names, which is what report code expects.
 *
 * @param {'done'|'blocked'|'idle'} kind - stopping step kind.
 * @returns {'completed'|'blocked'|'idle'} loop end kind.
 */
function endOf(kind) {
  if (kind === NEXT_TASK.done) return LOOP_END.completed
  if (kind === NEXT_TASK.blocked) return LOOP_END.blocked
  return LOOP_END.idle
}

/**
 * The decision a settled divergence question stands for (5.3).
 *
 * Only the stops reach this: `Продолжить` is not a decision at all, it is the run carrying
 * on with the wording the file holds. The two ways of stopping are kept apart because the
 * report names them apart (design D7) — a user who declined, and a deployment that had
 * nobody to ask. Anything that is not the explicit "nobody could ask" answer is read as a
 * refusal, which is how the question itself reads an answer it cannot interpret (4.2).
 *
 * @param {'continue'|'stop'|'unavailable'} answer - how the question was settled.
 * @returns {'declined'|'no-channel'} the decision the stop carries.
 */
function decisionOf(answer) {
  return answer === DIVERGENCE_ANSWER.unavailable
    ? DIVERGENCE_DECISION.noChannel
    : DIVERGENCE_DECISION.declined
}

/**
 * Build one settled outcome.
 *
 * @param {LoopOutcome['kind']} kind - how the run ended.
 * @param {object} fields
 * @param {import('./tasks.js').ApplyInstructions} [fields.instructions] - last reading; absent only
 *   when the run was cancelled before any read completed.
 * @param {import('./tasks.js').ApplyTask[]} fields.sent - tasks sent so far.
 * @param {import('./tasks.js').ApplyTask} [fields.task] - last task sent.
 * @param {{sessionId: string, task: import('./tasks.js').ApplyTask}[]} fields.sessions - sessions the
 *   run moved to at a group boundary.
 * @param {{attempts: number, code?: string, reason?: string, task: import('./tasks.js').ApplyTask}} [fields.compaction] -
 *   the compaction that stopped the run (6.1).
 * @param {{task: import('./tasks.js').ApplyTask, attempts: number, code?: string, reason?: string}[]} [fields.warnings] -
 *   compactions the run survived under the `continue` policy (6.2); absent means none.
 * @param {object} [fields.commit] - the commit that stopped the run (4.3), carried as the
 *   hook handed it over.
 * @param {{range?: {from: string, to: string}, next: import('./tasks.js').ApplyTask}} [fields.boundary] -
 *   the boundary a stopped run ended at (10.3): the closed group's range and the task
 *   left for the next `/taskloop`.
 * @param {string} [fields.decision] - how a `diverged` stop was settled (5.3).
 * @param {'gray'|'major'} [fields.divergence] - the band the wording of a `diverged` stop fell in.
 * @param {string} [fields.reason] - CLI account of a `blocked` or `idle` stop, or the refusal
 *   that leaves an `unidentified` task unrecognised (5.4).
 * @returns {LoopOutcome} the outcome.
 */
function settle(kind, { instructions, sent, task, sessions, warnings, compaction, commit, boundary, decision, divergence, reason }) {
  const outcome = { kind, instructions, sent, sessions, warnings: warnings ?? [] }
  if (task !== undefined) outcome.task = task
  if (compaction !== undefined) outcome.compaction = compaction
  if (commit !== undefined) outcome.commit = commit
  if (boundary !== undefined) outcome.boundary = boundary
  if (decision !== undefined) outcome.decision = decision
  if (divergence !== undefined) outcome.divergence = divergence
  if (reason !== undefined) outcome.reason = reason
  return outcome
}

/**
 * Message text of a thrown value, or `undefined` when there is nothing to say.
 *
 * The compaction outcome carries the original error; the report wants the sentence
 * the backend wrote, not the JS value. An absent error is `undefined` rather than
 * `'undefined'`, so a failure constructed by a test without an error adds no text.
 *
 * @param {unknown} value - thrown value carried by the compaction outcome.
 * @returns {string|undefined} the message, when the value has one.
 */
function messageOf(value) {
  if (value instanceof Error) return value.message
  if (typeof value === 'string' && value !== '') return value
  return undefined
}
