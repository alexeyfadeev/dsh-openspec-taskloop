// dsh-openspec-taskloop — the commit message text of one run (task 5.2).
//
// Design D16: the message is the user's own sentence about the work, so the plugin
// asks for it once per change and never invents one. This module owns the question
// itself and the way an answer is read; the stored value it is compared against lives
// in `lib/state.js`, and the decision to ask at all belongs to the seam that can reach
// both (`lib/environment.js`). Since design D18 the question no longer travels alone:
// it shares one card with the GitButler branch question, which is why the card is built
// and asked by `lib/commit-input.js` out of the builders below.
//
//     nothing stored for this change ──ask──▶ free text ──▶ the message
//            │
//        stored ──▶ nothing is asked; the sentence of the change is reused
//
// Three decisions shape the contract:
//
//   - The answer is free text, not a choice. The question carries no options, so a
//     capable UI renders its text field and the answer's `custom` text is the message.
//     Only its blankness is inspected: what the user wrote is what the commit will
//     carry, because normalising a sentence somebody owns would silently edit it.
//   - A blank answer is a refusal, not an empty message. The card that asks turns it
//     into `cancelled`, which stops the run before its first turn (spec "Отмена ввода").
//   - Nothing here asks, stores or decides anything. Whether the accepted text is kept,
//     and where, is the caller's business (D16: `lib/state.js` under
//     `profileContext.home`), so this module stays a pair of pure functions: the
//     question and the reading of its answer.

/** Stable question id, echoed back in the answer. */
export const COMMIT_MESSAGE_QUESTION_ID = 'openspec-commit-message'

/** Outcomes of the commit input of a run; callers switch on `kind`. */
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
