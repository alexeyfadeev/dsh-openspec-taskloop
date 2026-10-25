// dsh-openspec-taskloop — the code review that closes a task group (task 3.2).
//
// Design D14: when the last task of a group is verified, the run does not carry
// on in the session that drove it. A session of its own receives exactly one
// instruction to review the uncommitted changes, and the run waits for that turn
// before the next group starts or the commit runs.
//
//     openSession({change, range}) ──▶ session id
//                                        │
//                 setApproval(sessionId)─▶ approval 'never'
//                                        │
//          followup(review message) ──────▶ whenIdle()
//
// Two properties of the turn are fixed here rather than left to the model:
//
//   - it is unattended. Nobody is watching that session, so the prompt forbids
//     questions and the session's approval policy is `'never'` before the first
//     turn: a request for confirmation would wait for an answer that never comes,
//     and the run would hang on it. With `'never'` an escalation is rejected
//     deterministically instead, and the review either fixes a defect or reports
//     what it could not do.
//   - it is one turn. The message says `далее - пауза`, and the module sends it
//     once: what follows the turn — the commit, then the next group — is decided
//     by the run (`lib/loop.js`, `lib/control.js`), not by the reviewer.
//
// The prompt names the change and the range of the group (`Tasks 2.1 - 2.4` in a
// commit message uses the same pair), allows fixing only unambiguous significant
// defects, and asks for a list of what was checked when the changes are clean.
// A flat run has no task numbers, so its instruction names the whole list instead
// of a range (design D13).
//
// Everything the module needs comes from its caller: the session opener, the
// approval switch and the run's signal. That keeps it a plain function of its
// dependencies, testable without a host, and keeps `lib/environment.js` the only
// place that knows service names — the same split `lib/session.js` follows.

import { createUserTextMessage } from './message.js'
import { aborted, waitForIdle } from './wait.js'

/**
 * Values of {@link ReviewOutcome.kind}; callers switch on them.
 */
export const REVIEW_END = Object.freeze({
  /** The review turn ran to its end; the group may be committed. */
  reviewed: 'reviewed',
  /** The run was stopped before or during the review; no commit may follow. */
  cancelled: 'cancelled',
})

/**
 * How one review ended.
 *
 * `sessionId` is the session the review ran (or was about to run) in, so the
 * report can name it (design D17). A run stopped before the session was opened has
 * no session to name and carries no `sessionId`.
 *
 * @typedef {object} ReviewOutcome
 * @property {'reviewed'|'cancelled'} kind - whether the turn ran to its end.
 * @property {string} [sessionId] - session of the review, when one was opened.
 */

/**
 * Text of the review instruction: the scope, the autonomy, the rules of a fix.
 *
 * Kept as one exported function so the wording is pinned in one place, the way the
 * step message is (`lib/step.js`). The first line is the whole scope — change and
 * task range — because the reviewer starts in an empty session and has no other
 * pointer to what it is reviewing. The second line is what makes the turn safe to
 * leave unattended. The third is the only kind of change the reviewer may make:
 * a defect it can fix one way without guessing, in the same uncommitted tree the
 * commit will pick up.
 *
 * @param {object} options
 * @param {string} options.change - change whose uncommitted changes are reviewed.
 * @param {{from: string, to: string}} [options.range] - first and last task of the group;
 *   absent for a flat run, whose review covers the whole list.
 * @returns {string} the complete message text.
 * @throws {TypeError} when the change is missing or the range is not a pair of labels.
 */
export function buildReviewPrompt({ change, range }) {
  if (typeof change !== 'string' || change === '') {
    throw new TypeError('buildReviewPrompt requires the change name')
  }
  return [
    `Проведи код-ревью незакоммиченных изменений по change "${change}" (${scopeOf(range)}), далее - пауза.`,
    'Работай автономно: не задавай вопросов пользователю и не жди подтверждений — всё, что требует эскалации, будет отклонено автоматически.',
    'Исправляй только однозначные значимые дефекты — в этом же turn и теми же незакоммиченными изменениями; если дефектов нет, перечисли, что проверил.',
  ].join('\n')
}

/**
 * Build the identified user message that opens the review turn.
 *
 * A plain user message, like the step message: the review is a turn the plugin
 * starts, and the session log is where the user can read exactly what it was asked
 * to do.
 *
 * @param {object} options - see {@link buildReviewPrompt}.
 * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: {kind: 'user'}}} the message.
 * @throws {TypeError} when the change is missing or the range is not a pair of labels.
 */
export function createReviewMessage({ change, range }) {
  return createUserTextMessage(buildReviewPrompt({ change, range }))
}

/**
 * Run the review of one finished group.
 *
 * The order is the contract (design D14): the session is opened first, its
 * approval policy is narrowed to `'never'` before anything is sent into it, and
 * only then does the single review message leave. The wait afterwards is the
 * stop-aware one from `lib/wait.js`, so a `/taskloop stop` that lands during the
 * review ends it as `cancelled` rather than waiting for a turn nobody asked to
 * finish — and a caller that sees `cancelled` knows not to commit.
 *
 * A stop that lands while the session is being opened or the approval is being set
 * leaves the review unsent: the session may exist, but no instruction enters it.
 *
 * A review that cannot start is an error, not a stop: the session opener and the
 * approval switch propagate their failures, and so does `whenIdle()`. The run
 * reports them as a failed review, which is different from a stop the user asked
 * for.
 *
 * @param {object} options
 * @param {string} options.change - change whose uncommitted changes are reviewed.
 * @param {{from: string, to: string}} [options.range] - group the review closes;
 *   absent for a flat run.
 * @param {(context: {change: string, range?: {from: string, to: string}}) => (object|Promise<object>)} options.openSession -
 *   opens the review session and returns its runner (`followup()` and `whenIdle()`).
 * @param {(sessionId: string) => (void|Promise<void>)} [options.setApproval] - narrows the review
 *   session's approval policy to `'never'`; absent in a deployment without an approval
 *   service, where no prompt could be asked anyway.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<ReviewOutcome>} how the review ended and in which session.
 * @throws {TypeError} when the session opener is missing or the message cannot be built.
 * @throws {Error} when the session cannot be opened, the approval cannot be set, or the
 *   review turn fails to start.
 */
export async function runReview({ change, range, openSession, setApproval, signal }) {
  if (typeof openSession !== 'function') {
    throw new TypeError('runReview requires an openSession() that opens the review session')
  }
  if (setApproval !== undefined && typeof setApproval !== 'function') {
    throw new TypeError('runReview requires setApproval() to be a function when it is given')
  }
  // Built before the session exists: a change or range the message cannot name is
  // a caller's bug, and it must not leave an empty session behind.
  const prompt = buildReviewPrompt({ change, range })

  // Every await below can outlive the run: a stop that arrived before the review
  // began must open nothing, and one that arrives later must not send the message
  // into a session the run has already left.
  if (aborted(signal)) return { kind: REVIEW_END.cancelled }

  const runner = await openSession(range === undefined ? { change } : { change, range })
  const sessionId = typeof runner?.sessionId === 'string' && runner.sessionId !== ''
    ? runner.sessionId
    : undefined
  const outcome = (kind) => (sessionId === undefined ? { kind } : { kind, sessionId })

  if (aborted(signal)) return outcome(REVIEW_END.cancelled)

  await setApproval?.(sessionId)
  if (aborted(signal)) return outcome(REVIEW_END.cancelled)

  runner.followup(createUserTextMessage(prompt))
  try {
    if (await waitForIdle(runner, signal) === 'cancelled') return outcome(REVIEW_END.cancelled)
  } catch (error) {
    // A prompt the stop cut short rejects with the abort; that is the stop the
    // caller asked for, not a review that failed to start.
    if (aborted(signal)) return outcome(REVIEW_END.cancelled)
    throw error
  }
  return outcome(REVIEW_END.reviewed)
}

/**
 * `задачи 2.1 - 2.4` / `весь список задач` for the instruction's scope clause.
 *
 * A flat run has no numbers to name; saying so is more useful than an empty
 * parenthesis, and it is the same distinction the loop makes when it announces a
 * completed group (design D13).
 *
 * @param {{from: string, to: string}} [range] - group the review closes.
 * @returns {string} the scope clause, without the parentheses.
 * @throws {TypeError} when a range is given but is not a pair of non-empty labels.
 */
function scopeOf(range) {
  if (range === undefined) return 'весь список задач'
  if (typeof range.from !== 'string' || range.from === '') {
    throw new TypeError('buildReviewPrompt requires range.from when a range is given')
  }
  if (typeof range.to !== 'string' || range.to === '') {
    throw new TypeError('buildReviewPrompt requires range.to when a range is given')
  }
  return `задачи ${range.from} - ${range.to}`
}
