// dsh-openspec-taskloop — the task loop (tasks 4.2–4.3, 5.1).
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
//                                              └─ gone      ──▶ { kind: 'missing' }
//
// Two consequences of waiting for the whole agent, not for one turn (D1): a user
// message that arrives mid-step is waited for as well, and the run stops if such
// a turn leaves the task unchecked; and a turn that ends in an abort or an error
// lands in the same `unmarked` stop instead of being retried — the cause itself
// stays in the session log, where the user already sees it.
//
// Cancellation (4.3) is the one thing the loop obeys between messages. It is
// checked in three places, because the run can be ended at three different
// moments: before a read, while a read is in flight, and while waiting for
// quiescence. Any of them ends the run as `cancelled`, and none of them sends
// another message — that is what makes `/taskloop stop` a stop rather than a
// request the next iteration may ignore.
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

import { COMPACTION_END, ON_FAILURE } from './compaction.js'
import { TRANSITION, classifyTransition, describeGrouping } from './groups.js'
import { NEXT_TASK, findListedTask, selectNextTask } from './tasks.js'
import { readApplyInstructions, runOneStep } from './run.js'

/**
 * Values of {@link LoopOutcome.kind}; callers switch on them.
 */
export const LOOP_END = Object.freeze({
  /** Every tracked task is checked; the run is complete. */
  completed: 'completed',
  /** The task that was just sent is still unchecked; the run stopped. */
  unmarked: 'unmarked',
  /** The task that was just sent is no longer listed; the run stopped. */
  missing: 'missing',
  /** The CLI blocked the change; `reason` says why. */
  blocked: 'blocked',
  /** Ready, yet nothing to run; `reason` says what was observed. */
  idle: 'idle',
  /** The run's signal aborted while waiting; no further task was sent. */
  cancelled: 'cancelled',
  /** Compaction before the next task failed; `compaction` says where and why. */
  compaction: 'compaction',
})

/**
 * How one run of the loop ended.
 *
 * `sent` is the run's audit trail: the tasks whose messages left this call, in
 * order. `task` is the last of them, and is the task a stop report is about; a
 * stop that sent nothing has no `task`.
 *
 * @typedef {object} LoopOutcome
 * @property {'completed'|'unmarked'|'missing'|'blocked'|'idle'|'cancelled'|'compaction'} kind - how the run ended.
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
 * @property {string} [reason] - the CLI's account of a `blocked` or `idle` stop.
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
 * @param {string} [options.skillPath] - skill the step messages name; defaults to the apply skill.
 * @param {(task: import('./tasks.js').ApplyTask) => void} [options.onTask] - called as soon as a
 *   task's message leaves, before the run waits for its turn: the run's only outward signal
 *   between messages, which is where a run records the task it is on (4.3).
 * @param {(context: {change: string, previous: import('./tasks.js').ApplyTask, task: import('./tasks.js').ApplyTask}) => (object|Promise<object>)} [options.openSession] -
 *   opens the session a new group runs in (5.1) and returns its runner. Absent, a run that
 *   reaches a group boundary stops with a `TypeError` instead of silently continuing in the
 *   session it was leaving.
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
  cli, cwd, change, agent, signal, skillPath, onTask, openSession, compact, onFailure,
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

    if (previous !== undefined) {
      const refreshed = findListedTask(instructions, previous)
      if (refreshed === undefined) {
        return settleNow(LOOP_END.missing)
      }
      if (!refreshed.done) {
        return settleNow(LOOP_END.unmarked)
      }
    }

    // The decision is taken here, not inside the step, because compaction has to
    // happen between them (6.1): the step receives the selection it must act on.
    const selection = selectNextTask(instructions)
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
    // session the run moved to, with the task it took over at (5.1).
    if (step.agent !== target) {
      sessions.push({ sessionId: step.agent.sessionId, task: step.task })
      target = step.agent
    }

    if (await waitForIdle(step.agent, signal) === 'cancelled') return cancel()
  }
}

/**
 * Whether the run has been cancelled.
 *
 * @param {AbortSignal} [signal] - cancellation of the whole run.
 * @returns {boolean} true when the caller stopped the run.
 */
function aborted(signal) {
  return signal?.aborted === true
}

/**
 * Wait for the agent to go quiet, unless the run is cancelled first.
 *
 * `whenIdle()` cannot be cancelled itself, so the wait races it against the run's
 * signal: a cancelled command must stop sending messages even though the turn it
 * started is still finishing. Losing the race leaves the `whenIdle()` promise
 * pending; it is not observed again, and the run is over.
 *
 * @param {object} agent - live agent.
 * @param {AbortSignal} [signal] - cancellation of the run.
 * @returns {Promise<'idle'|'cancelled'>} why the wait ended.
 */
async function waitForIdle(agent, signal) {
  if (signal === undefined || signal === null) {
    await agent.whenIdle()
    return 'idle'
  }
  if (aborted(signal)) return 'cancelled'

  /** @type {() => void} */
  let onAbort
  const cancelled = new Promise((resolve) => {
    onAbort = () => resolve('cancelled')
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([agent.whenIdle().then(() => 'idle'), cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
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
 * @param {string} [fields.reason] - CLI account of a `blocked` or `idle` stop.
 * @returns {LoopOutcome} the outcome.
 */
function settle(kind, { instructions, sent, task, sessions, warnings, compaction, reason }) {
  const outcome = { kind, instructions, sent, sessions, warnings: warnings ?? [] }
  if (task !== undefined) outcome.task = task
  if (compaction !== undefined) outcome.compaction = compaction
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
