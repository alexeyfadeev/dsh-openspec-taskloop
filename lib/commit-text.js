// dsh-openspec-taskloop — the commit message text of one run (task 5.2).
//
// Design D16: the message is the user's own sentence about the work, so the plugin
// asks for it once per change and never invents one. This module owns that question;
// the stored value it is compared against lives in `lib/state.js`, and the decision to
// ask at all belongs to the seam that can reach both (`lib/environment.js`).
//
//     stored for this change ──yes──▶ use it, ask nothing
//            │
//           no
//            │
//     ask for the text ──answer──▶ { kind: 'text' }
//            │
//        dismissed ──▶ { kind: 'cancelled' }        the run must not start
//            │
//      nobody to ask ──▶ { kind: 'unavailable' }     the run goes on without commits
//
// Three decisions shape the contract:
//
//   - The answer is free text, not a choice. The question carries no options, so a
//     capable UI renders its text field and the answer's `custom` text is the message.
//     Only its blankness is inspected: what the user wrote is what the commit will
//     carry, because normalising a sentence somebody owns would silently edit it.
//   - A dismissal is a refusal, not an empty message. `cancelled` is what stops the run
//     before its first turn (spec "Отмена ввода"), while `unavailable` — a deployment
//     with no question channel at all, such as a headless run — is not: there nobody
//     refused, and skipping the commits with a reason in the report (design D17) is
//     better than refusing to work at all.
//   - Nothing here writes anything. Whether the accepted text is kept, and where, is
//     the caller's business (D16: `lib/state.js` under `profileContext.home`), so this
//     module stays a plain function of the question channel and its arguments.
//
// Like `lib/explore.js` it is free of Cordis: `questions` arrives as an argument, so the
// answered, dismissed and unavailable paths run in tests without a host and without a UI.

/** Stable question id, echoed back in the answer. */
export const COMMIT_MESSAGE_QUESTION_ID = 'openspec-commit-message'

/** Outcomes of {@link requestCommitMessage}; callers switch on `kind`. */
export const COMMIT_TEXT = Object.freeze({
  /** The user supplied the text; the result carries it as `text`. */
  text: 'text',
  /** The user dismissed the question; the run must not start. */
  cancelled: 'cancelled',
  /** There is no stored text and nobody to ask; the run goes on without commits. */
  unavailable: 'unavailable',
})

/**
 * A settled ask for a commit message text.
 *
 * @typedef {object} CommitTextOutcome
 * @property {'text'|'cancelled'|'unavailable'} kind - what the question settled with.
 * @property {string} [text] - the user's text, verbatim; present only when `text`.
 */

/**
 * Build the one question that asks for this change's commit message.
 *
 * No `options`: the message is free text, and an option list could not hold a sentence
 * the user owns anyway. The detail names the appended range, because that is the part a
 * person cannot predict from the question alone, and says that a dismissal starts no
 * run — the answer decides whether any work happens at all.
 *
 * @param {object} options
 * @param {string} options.change - OpenSpec change the message is for.
 * @param {string} options.cwd - project directory the message is stored for.
 * @returns {object} a `ctx.userQuestions` question.
 */
export function buildMessageQuestion({ change, cwd } = {}) {
  return {
    id: COMMIT_MESSAGE_QUESTION_ID,
    header: 'OpenSpec',
    question: `What message should the commits of change "${change}" carry?`,
    detail: 'Every commit of this run uses this text with the range of its task group appended, '
      + 'for example "Add the export endpoint. Tasks 2.1 - 2.4". The text is kept for this change '
      + `in ${cwd} and is not asked for again, even after a stop. Cancelling starts no run.`,
  }
}

/**
 * Read the message text out of a `ctx.userQuestions` answer.
 *
 * Only `custom` text counts. The question offers no options, so a non-blank `custom`
 * value with no selection is the normal answer; a selection alone carries no text and
 * is a refusal rather than an empty commit message.
 *
 * @param {unknown} answer - `{answers: [{id, selected, custom?}]}` shape.
 * @returns {string|null} the text verbatim, or `null` when none was given.
 */
export function readCommitText(answer) {
  const answers = Array.isArray(answer?.answers) ? answer.answers : []
  const item = answers.find((entry) => entry?.id === COMMIT_MESSAGE_QUESTION_ID)
  const custom = typeof item?.custom === 'string' ? item.custom : ''
  return custom.trim() === '' ? null : custom
}

/**
 * Ask the session's human for the message this change's commits should carry.
 *
 * `questions` is `ctx.userQuestions`, or `undefined` when the deployment has no such
 * service. A live service with no answerer rejects with `NO_PROVIDER`; both answer
 * `unavailable`, because there is nobody to ask and nobody refused. Dismissal and an
 * aborted request are refusals, so they answer `cancelled` and must stop the run.
 *
 * @param {object} request
 * @param {object} [request.questions] - the user-questions service.
 * @param {object} [request.agent] - live root agent the question belongs to.
 * @param {string} request.change - OpenSpec change named in the question.
 * @param {string} request.cwd - project directory the message is stored for.
 * @param {AbortSignal} [request.signal] - cancellation of the request that started the run.
 * @returns {Promise<CommitTextOutcome>} the settled text, refusal or missing channel.
 * @throws {Error} when the question fails for a reason other than dismissal.
 */
export async function requestCommitMessage({ questions, agent, change, cwd, signal }) {
  if (questions === undefined || questions === null) return { kind: COMMIT_TEXT.unavailable }

  let answer
  try {
    answer = await questions.ask({
      questions: [buildMessageQuestion({ change, cwd })],
      agent,
      signal,
    })
  } catch (error) {
    const code = errorCode(error)
    // A dismissed card asks nothing further and an aborted request cannot be answered;
    // both are refusals. Neither may be read as a message with no words in it.
    if (code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') return { kind: COMMIT_TEXT.cancelled }
    if (code === 'NO_PROVIDER') return { kind: COMMIT_TEXT.unavailable }
    throw error
  }

  const text = readCommitText(answer)
  return text === null ? { kind: COMMIT_TEXT.cancelled } : { kind: COMMIT_TEXT.text, text }
}

/**
 * Machine-readable code of a failed question, when it has one.
 *
 * @param {unknown} error - thrown value from the question service.
 * @returns {string|undefined} the code.
 */
function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : undefined
}
