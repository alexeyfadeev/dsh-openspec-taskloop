// Tests for the explore handoff (task 3.3): the description question, the single
// follow-up message, and the guarantee that a cancelled answer sends nothing.
//
// The module is driven with fakes for the question service and the agent. The
// assertions are about the two things the spec cares about — the message text
// carries the description verbatim and names the explore skill, and exactly one
// message ever leaves the plugin on this path — plus the refusal and
// unavailable paths, where the count must be zero.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DESCRIPTION_QUESTION_ID,
  EXPLORE_ANSWER,
  EXPLORE_SKILL_PATH,
  buildDescriptionQuestion,
  buildExplorePrompt,
  createExploreMessage,
  readDescription,
  requestDescription,
  sendExplorePrompt,
  startExplore,
} from '../lib/explore.js'

const CWD = 'C:\\projects\\demo'
const DESCRIPTION = 'Add an export endpoint.\n\nIt must stream CSV rows.'

/**
 * A question service that answers with a fixed value and records the requests.
 *
 * @param {object|Error} answer - answer document, or the error to reject with.
 * @returns {{ask: Function, requests: object[]}} the fake service.
 */
function fakeQuestions(answer) {
  const requests = []
  return {
    requests,
    async ask(request) {
      requests.push(request)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

/**
 * An agent whose `followup` records the messages it is handed.
 *
 * @param {Error} [failure] - error thrown instead of recording.
 * @returns {{agent: object, messages: object[]}} the agent and its sent messages.
 */
function fakeAgent(failure) {
  const messages = []
  return {
    messages,
    agent: {
      id: 'agent-1',
      followup(message) {
        if (failure !== undefined) throw failure
        messages.push(message)
      },
    },
  }
}

/**
 * A question failure carrying a stable code.
 *
 * @param {string} code - `ASK_CANCELLED`, `NO_PROVIDER`, ...
 * @returns {Error} the failure.
 */
const questionFailure = (code) => Object.assign(new Error(`question failed: ${code}`), { code })

test('the description question is free text and names the project and the skill', () => {
  const question = buildDescriptionQuestion(CWD)

  assert.equal(question.id, DESCRIPTION_QUESTION_ID)
  assert.equal(question.options, undefined, 'an option list would turn the task into a choice')
  assert.match(question.question, /C:\\projects\\demo/)
  assert.match(question.detail, /\.dsh\/skills\/openspec-explore/)
  assert.match(question.detail, /No task loop/)
})

test('the explore prompt names the skill and keeps the description verbatim', () => {
  const text = buildExplorePrompt(DESCRIPTION)

  assert.equal(text, [
    `Работай в режиме explore по навыку ${EXPLORE_SKILL_PATH}.`,
    '',
    'Описание задачи:',
    DESCRIPTION,
  ].join('\n'))
  // Multi-line text and blank lines survive: the user wrote them.
  assert.ok(text.includes('Add an export endpoint.\n\nIt must stream CSV rows.'))
})

test('the message is one user-role text block with a fresh id', () => {
  const first = createExploreMessage(DESCRIPTION)
  const second = createExploreMessage(DESCRIPTION)

  assert.equal(first.role, 'user')
  assert.deepEqual(first.source, { kind: 'user' })
  assert.equal(first.content.length, 1)
  assert.equal(first.content[0].type, 'text')
  assert.equal(first.content[0].text, buildExplorePrompt(DESCRIPTION))
  assert.equal(typeof first.id, 'string')
  assert.notEqual(first.id, second.id)
})

test('only custom text counts as a description; it is returned untrimmed', () => {
  const answer = (custom) => ({
    answers: [{ id: DESCRIPTION_QUESTION_ID, selected: [], ...custom === undefined ? {} : { custom } }],
  })

  assert.equal(readDescription(answer('  keep my spacing  ')), '  keep my spacing  ')
  assert.equal(readDescription(answer('   ')), null)
  assert.equal(readDescription(answer(undefined)), null)
  assert.equal(readDescription({ answers: [{ id: DESCRIPTION_QUESTION_ID, selected: ['somewhere'] }] }), null)
  assert.equal(readDescription({}), null)
  assert.equal(readDescription(undefined), null)
})

test('a described task is returned verbatim', async () => {
  const questions = fakeQuestions({
    answers: [{ id: DESCRIPTION_QUESTION_ID, selected: [], custom: DESCRIPTION }],
  })

  const outcome = await requestDescription({ questions, agent: { id: 'agent-1' }, cwd: CWD })

  assert.deepEqual(outcome, { kind: EXPLORE_ANSWER.described, description: DESCRIPTION })
  assert.equal(questions.requests.length, 1)
  assert.equal(questions.requests[0].agent.id, 'agent-1')
  assert.deepEqual(questions.requests[0].questions, [buildDescriptionQuestion(CWD)])
})

test('an empty or selected answer is a cancellation, not an empty task', async () => {
  const empty = await requestDescription({
    questions: fakeQuestions({ answers: [{ id: DESCRIPTION_QUESTION_ID, selected: [] }] }),
    cwd: CWD,
  })
  const selected = await requestDescription({
    questions: fakeQuestions({ answers: [{ id: DESCRIPTION_QUESTION_ID, selected: ['something'] }] }),
    cwd: CWD,
  })

  assert.deepEqual(empty, { kind: EXPLORE_ANSWER.cancelled })
  assert.deepEqual(selected, { kind: EXPLORE_ANSWER.cancelled })
})

test('a dismissed or aborted question is a cancellation', async () => {
  for (const code of ['ASK_CANCELLED', 'ASK_ABORTED']) {
    const outcome = await requestDescription({
      questions: fakeQuestions(questionFailure(code)),
      cwd: CWD,
    })
    assert.deepEqual(outcome, { kind: EXPLORE_ANSWER.cancelled }, `code ${code}`)
  }
})

test('a missing service and a missing answerer are both unavailable', async () => {
  const absent = await requestDescription({ questions: undefined, cwd: CWD })
  const noProvider = await requestDescription({
    questions: fakeQuestions(questionFailure('NO_PROVIDER')),
    cwd: CWD,
  })

  assert.deepEqual(absent, { kind: EXPLORE_ANSWER.unavailable })
  assert.deepEqual(noProvider, { kind: EXPLORE_ANSWER.unavailable })
})

test('an unexpected question failure is not swallowed', async () => {
  const failure = questionFailure('INTERNAL')

  await assert.rejects(
    requestDescription({ questions: fakeQuestions(failure), cwd: CWD }),
    (error) => error === failure,
  )
})

test('sending the prompt calls followup exactly once with one text message', () => {
  const { agent, messages } = fakeAgent()

  const message = sendExplorePrompt({ agent, description: DESCRIPTION })

  assert.equal(messages.length, 1)
  assert.equal(messages[0], message)
  assert.equal(messages[0].content.length, 1)
  assert.equal(messages[0].content[0].text, buildExplorePrompt(DESCRIPTION))
})

test('an agent that cannot take a follow-up fails before anything is recorded', () => {
  assert.throws(
    () => sendExplorePrompt({ agent: { id: 'agent-1' }, description: DESCRIPTION }),
    /agent that accepts a follow-up/,
  )
})

test('a described task produces exactly one message and no second one', async () => {
  const { agent, messages } = fakeAgent()
  const questions = fakeQuestions({
    answers: [{ id: DESCRIPTION_QUESTION_ID, selected: [], custom: DESCRIPTION }],
  })

  const outcome = await startExplore({ questions, agent, cwd: CWD })

  assert.equal(outcome.kind, EXPLORE_ANSWER.described)
  assert.equal(outcome.description, DESCRIPTION)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content[0].text, buildExplorePrompt(DESCRIPTION))
})

test('a cancelled description sends nothing', async () => {
  const { agent, messages } = fakeAgent()

  const outcome = await startExplore({
    questions: fakeQuestions({ answers: [{ id: DESCRIPTION_QUESTION_ID, selected: [] }] }),
    agent,
    cwd: CWD,
  })

  assert.equal(outcome.kind, EXPLORE_ANSWER.cancelled)
  assert.equal(messages.length, 0)
})

test('an unavailable channel sends nothing', async () => {
  const { agent, messages } = fakeAgent()

  const outcome = await startExplore({ questions: undefined, agent, cwd: CWD })

  assert.equal(outcome.kind, EXPLORE_ANSWER.unavailable)
  assert.equal(messages.length, 0)
})
