// Tests for the commit message question (task 5.2).
//
// The module decides three things, and each one changes what the command does: what the
// user is asked, which answers count as a message, and which answers are refusals. All
// three are pinned here with a fake question channel, because the seam around them
// (`lib/environment.js`) can only be as honest as these outcomes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMIT_MESSAGE_QUESTION_ID,
  COMMIT_TEXT,
  buildMessageQuestion,
  readCommitText,
  requestCommitMessage,
} from '../lib/commit-text.js'

/**
 * A user-questions service that records what it was asked and answers with `answer`.
 *
 * @param {object|Error} [answer] - answer value, or an error to reject with.
 * @returns {{asked: object[], ask: Function}} the fake service.
 */
function fakeQuestions(answer) {
  const asked = []
  return {
    asked,
    async ask(request) {
      asked.push(request)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

/**
 * An answer holding the message text as free text.
 *
 * @param {string} custom - the text the user typed.
 * @returns {object} the `ctx.userQuestions` answer shape.
 */
const answered = (custom) => ({ answers: [{ id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom }] })

/**
 * A failure with a machine-readable code, as the question service raises them.
 *
 * @param {string} code - e.g. `ASK_CANCELLED`.
 * @returns {Error} the coded error.
 */
function coded(code) {
  const error = new Error(code)
  error.code = code
  return error
}

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

test('an answered question settles with the text and the request details', async () => {
  const questions = fakeQuestions(answered('Добавить эндпоинт'))
  const agent = { id: 'agent-1' }
  const signal = new AbortController().signal

  const outcome = await requestCommitMessage({
    questions,
    agent,
    change: 'add-taskloop-review-commit',
    cwd: 'C:\\repo',
    signal,
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' })
  assert.equal(questions.asked.length, 1)
  assert.equal(questions.asked[0].agent, agent)
  assert.equal(questions.asked[0].signal, signal)
  assert.equal(questions.asked[0].questions.length, 1)
  assert.equal(questions.asked[0].questions[0].id, COMMIT_MESSAGE_QUESTION_ID)
})

test('a dismissed question is a refusal, never an empty message', async () => {
  const questions = fakeQuestions(coded('ASK_CANCELLED'))

  const outcome = await requestCommitMessage({
    questions,
    agent: { id: 'agent-1' },
    change: 'add-taskloop-review-commit',
    cwd: 'C:\\repo',
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.cancelled })
})

test('a request that ended before it was answered is a refusal too', async () => {
  const questions = fakeQuestions(coded('ASK_ABORTED'))

  const outcome = await requestCommitMessage({
    questions,
    agent: { id: 'agent-1' },
    change: 'add-taskloop-review-commit',
    cwd: 'C:\\repo',
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.cancelled })
})

test('an answered card with nothing typed is a refusal', async () => {
  const questions = fakeQuestions(answered('   '))

  const outcome = await requestCommitMessage({
    questions,
    agent: { id: 'agent-1' },
    change: 'add-taskloop-review-commit',
    cwd: 'C:\\repo',
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.cancelled })
})

test('a session with nobody to ask reports the missing channel instead of refusing', async () => {
  const questions = fakeQuestions(coded('NO_PROVIDER'))

  assert.deepEqual(
    await requestCommitMessage({
      questions,
      agent: { id: 'agent-1' },
      change: 'add-taskloop-review-commit',
      cwd: 'C:\\repo',
    }),
    { kind: COMMIT_TEXT.unavailable },
  )
})

test('a deployment without a question service never asks anything', async () => {
  const questions = fakeQuestions(answered('Добавить эндпоинт'))

  assert.deepEqual(
    await requestCommitMessage({
      questions: undefined,
      agent: { id: 'agent-1' },
      change: 'add-taskloop-review-commit',
      cwd: 'C:\\repo',
    }),
    { kind: COMMIT_TEXT.unavailable },
  )
  assert.equal(questions.asked.length, 0)
})

test('a question that failed for another reason is not read as an answer', async () => {
  const questions = fakeQuestions(new Error('the answerer crashed'))

  await assert.rejects(
    requestCommitMessage({
      questions,
      agent: { id: 'agent-1' },
      change: 'add-taskloop-review-commit',
      cwd: 'C:\\repo',
    }),
    /the answerer crashed/u,
  )
})
