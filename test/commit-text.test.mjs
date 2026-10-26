// Tests for the commit message question (task 5.2).
//
// The module decides two things, and each one changes what the command does: what the
// user is shown, and which answers count as a message. Both are pinned here. The card
// that asks it — together with the GitButler branch question of design D18 — belongs to
// `lib/commit-input.js`, whose tests cover the asking; these ones cover the question and
// the reading of its answer, which that card composes unchanged.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMIT_MESSAGE_QUESTION_ID,
  buildMessageQuestion,
  readCommitText,
} from '../lib/commit-text.js'

/**
 * An answer holding the message text as free text.
 *
 * @param {string} custom - the text the user typed.
 * @returns {object} the `ctx.userQuestions` answer shape.
 */
const answered = (custom) => ({ answers: [{ id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom }] })

test('the question names the change and the range that will be appended', () => {
  const question = buildMessageQuestion({ change: 'add-taskloop-review-commit', cwd: 'C:\\repo' })

  assert.equal(question.id, COMMIT_MESSAGE_QUESTION_ID)
  assert.equal(question.header, 'OpenSpec')
  assert.match(question.question, /add-taskloop-review-commit/u)
  // The appended range is the part a user cannot predict, so the card says it.
  assert.match(question.detail, /Tasks 2\.1 - 2\.4/u)
  assert.match(question.detail, /C:\\repo/u)
  // A dismissal has a consequence the user must know before answering.
  assert.match(question.detail, /Cancelling starts no run/u)
  // Free text: an option list could not hold a sentence the user owns.
  assert.equal(question.options, undefined)
})

test('the answer is read verbatim from the custom text', () => {
  assert.equal(readCommitText(answered('Добавить эндпоинт')), 'Добавить эндпоинт')
  // Inner line breaks are part of the message: it travels as one argument.
  assert.equal(readCommitText(answered('Add the endpoint\n\nand its test')), 'Add the endpoint\n\nand its test')
  // Surrounding space is not text: the seam trims it before committing.
  assert.equal(readCommitText(answered('  Add the endpoint  ')), '  Add the endpoint  ')
})

test('an answer without text is no message at all', () => {
  assert.equal(readCommitText(answered('')), null)
  assert.equal(readCommitText(answered('   \n  ')), null)
  assert.equal(readCommitText({ answers: [{ id: COMMIT_MESSAGE_QUESTION_ID, selected: ['Something'] }] }), null)
  assert.equal(readCommitText({ answers: [{ id: 'other-question', custom: 'Add the endpoint' }] }), null)
  assert.equal(readCommitText({}), null)
  assert.equal(readCommitText(undefined), null)
})
