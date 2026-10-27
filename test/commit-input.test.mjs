// Tests for the commit input of a run: its GitButler branch and its message (tasks 7.1, 7.3).
//
// The module turns `but status --json` into the branches a run may commit into, turns an
// answer back into the branch of D18, and asks both questions of the run — the message and
// the branch — as one card. Every direction changes what the run does — a wrong listing
// asks the wrong question, a wrong reader commits into the wrong branch or starts a run
// nobody answered, and a card split in two costs the user a second form — so the packet
// tests at the end pin the whole settlement: one card when both are needed, a second card
// only for the anchor, and the headless fallbacks that commit without a branch.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ANCHOR_QUESTION_ID,
  BRANCH_CHOICE,
  BRANCH_QUESTION_ID,
  CANCEL_STEP,
  buildAnchorQuestion,
  buildBranchQuestion,
  parseAppliedBranches,
  readAnchorChoice,
  readBranchChoice,
  requestCommitInput,
} from '../lib/commit-input.js'
import { COMMIT_MESSAGE_QUESTION_ID, COMMIT_TEXT } from '../lib/commit-text.js'

const CHANGE = 'add-taskloop-review-commit'
const BRANCHES = ['feature-a', 'feature-b']

/**
 * An answer holding one question, in the shape `ctx.userQuestions.ask` resolves.
 *
 * @param {string} id - question id the answer belongs to.
 * @param {object} [fields] - `selected` labels and/or `custom` text.
 * @returns {object} the answer.
 */
function answered(id, { selected = [], custom } = {}) {
  return { answers: [{ id, selected, ...(custom === undefined ? {} : { custom }) }] }
}

/**
 * A user-questions service that answers from a script and records what it was asked.
 *
 * One entry per `ask` call: an answer value, a factory of one, or an error to reject
 * with. The recorded requests are what makes "one card" observable.
 *
 * @param {...(object|Function|Error)} replies - one reply per question card.
 * @returns {{asked: object[], ask: Function}} the fake service.
 */
function fakeQuestions(...replies) {
  const asked = []
  const queue = [...replies]
  return {
    asked,
    async ask(request) {
      asked.push(request)
      const reply = queue.shift()
      if (reply instanceof Error) throw reply
      return typeof reply === 'function' ? reply(request) : reply
    },
  }
}

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

test('the listing yields the applied branches, in document order', () => {
  const stdout = JSON.stringify({
    stacks: [
      {
        id: 0,
        branches: [{ name: 'feature-a', cliId: 'b1' }, { name: 'feature-b', cliId: 'b2' }],
      },
      { id: 1, applied: false, branches: [{ name: 'parked', cliId: 'b3' }] },
    ],
  })

  assert.deepEqual(parseAppliedBranches(stdout), ['feature-a', 'feature-b'])
})

test('an unapplied or archived entry is not a branch the run may commit into', () => {
  const stdout = JSON.stringify({
    branches: [
      { name: 'feature-a' },
      { name: 'parked', applied: false },
      { name: 'old', archived: true },
      { name: 'feature-b', applied: true },
    ],
    stacks: [{ archived: true, branches: [{ name: 'gone' }] }],
  })

  assert.deepEqual(parseAppliedBranches(stdout), ['feature-a', 'feature-b'])
})

test('an entry without a name is offered by its cliId', () => {
  // `cliId` is the fallback argument of D18: an id is still something `but commit`
  // accepts, so dropping the entry would silently remove an option.
  const stdout = JSON.stringify({
    branches: [
      { cliId: 'b7' },
      { name: '  feature-a  ' },
      { cli_id: 'b8' },
      { name: '', cliId: 'b9' },
    ],
  })

  assert.deepEqual(parseAppliedBranches(stdout), ['b7', 'feature-a', 'b8', 'b9'])
})

test('a branch listed twice is offered once', () => {
  const stdout = JSON.stringify({
    branches: [{ name: 'feature-a' }],
    stacks: [{ branches: [{ name: 'feature-a' }, { name: 'feature-b' }] }],
  })

  assert.deepEqual(parseAppliedBranches(stdout), ['feature-a', 'feature-b'])
})

test('a document without branches, or with none at all, yields an empty list', () => {
  assert.deepEqual(parseAppliedBranches('{}'), [])
  assert.deepEqual(parseAppliedBranches('{"stacks":[]}'), [])
  assert.deepEqual(parseAppliedBranches('[]'), [])
  // Entries the walker cannot read are not branches and are not an error either.
  assert.deepEqual(parseAppliedBranches('{"stacks":[{"branches":[null,42,"main"]}]}'), [])
})

test('a stack is not a branch, however it is named', () => {
  // A stack carries branches of its own; committing into its name would target
  // something `but commit` does not accept.
  const stdout = JSON.stringify({
    stacks: [{ name: 'stack-1', branches: [{ name: 'feature-a' }] }],
  })

  assert.deepEqual(parseAppliedBranches(stdout), ['feature-a'])
})

test('output that is not JSON, or not there at all, is an error rather than an empty list', () => {
  // An empty list means "no applied branch"; a failed reading must not be mistaken
  // for it, because D18 refuses to start the run only on a failed reading.
  assert.throws(() => parseAppliedBranches('not json'), /did not print JSON/u)
  assert.throws(() => parseAppliedBranches(''), /printed nothing/u)
  assert.throws(() => parseAppliedBranches(undefined), /printed nothing/u)
  assert.throws(() => parseAppliedBranches('   '), /printed nothing/u)
})

test('the branch question offers every applied branch and the free-text field', () => {
  const question = buildBranchQuestion({ change: CHANGE, branches: BRANCHES })

  assert.equal(question.id, BRANCH_QUESTION_ID)
  assert.equal(question.header, 'OpenSpec')
  assert.match(question.question, /add-taskloop-review-commit/u)
  assert.deepEqual(question.options.map((option) => option.label), BRANCHES)
  // The typed name is the other half of the answer: an option list alone cannot
  // express a branch that does not exist yet.
  assert.match(question.detail, /type the name of a new one/u)
  // The branch is created at the first commit, not when the question is answered.
  assert.match(question.detail, /first commit/u)
  // A dismissal has a consequence the user must know before answering.
  assert.match(question.detail, /Cancelling starts no run/u)
})

test('with no applied branch the question asks only for a name', () => {
  const question = buildBranchQuestion({ change: CHANGE, branches: [] })

  assert.equal(question.options, undefined)
  assert.match(question.detail, /No applied branch was found/u)
  assert.match(question.detail, /type the name of the branch to create/u)
  // The first branch of a project cannot be stacked, so no anchor is mentioned as
  // something that would be asked.
  assert.match(question.detail, /has no anchor/u)
})

test('a selected option is the branch, and it is trimmed like every other answer', () => {
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { selected: ['feature-b'] }), BRANCHES),
    { kind: BRANCH_CHOICE.branch, branch: 'feature-b' },
  )
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { selected: [' feature-a '] }), BRANCHES),
    { kind: BRANCH_CHOICE.branch, branch: 'feature-a' },
  )
})

test('a typed name that is not an applied branch is a branch to create', () => {
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { custom: 'feature-c' }), BRANCHES),
    { kind: BRANCH_CHOICE.create, name: 'feature-c' },
  )
  // The name is an argv element of `but branch new`, not a sentence to rewrite.
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { custom: '  release/2.0  ' }), BRANCHES),
    { kind: BRANCH_CHOICE.create, name: 'release/2.0' },
  )
})

test('a typed name that matches an applied branch selects it instead of creating it', () => {
  // The spec's "Имя совпало с существующей веткой": the same name must not turn into
  // a second branch that `but branch new` would refuse.
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { custom: 'feature-a' }), BRANCHES),
    { kind: BRANCH_CHOICE.branch, branch: 'feature-a' },
  )
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { custom: 'feature-b' }), BRANCHES),
    { kind: BRANCH_CHOICE.branch, branch: 'feature-b' },
  )
})

test('free text wins over a highlighted option, because typing is deliberate', () => {
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { selected: ['feature-a'], custom: 'feature-c' }), BRANCHES),
    { kind: BRANCH_CHOICE.create, name: 'feature-c' },
  )
})

test('with no applied branch a typed name is the only way to answer', () => {
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { custom: 'first' }), []),
    { kind: BRANCH_CHOICE.create, name: 'first' },
  )
})

test('an answer without a branch is a refusal', () => {
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, {}), BRANCHES),
    { kind: BRANCH_CHOICE.cancelled },
  )
  assert.deepEqual(
    readBranchChoice(answered(BRANCH_QUESTION_ID, { custom: '   ' }), BRANCHES),
    { kind: BRANCH_CHOICE.cancelled },
  )
  assert.deepEqual(readBranchChoice({}, BRANCHES), { kind: BRANCH_CHOICE.cancelled })
  assert.deepEqual(readBranchChoice(undefined, BRANCHES), { kind: BRANCH_CHOICE.cancelled })
  // An answer to some other question is not an answer to this one.
  assert.deepEqual(
    readBranchChoice(answered('another-question', { custom: 'feature-c' }), BRANCHES),
    { kind: BRANCH_CHOICE.cancelled },
  )
})

test('the anchor question offers the applied branches a new branch can stack on', () => {
  const question = buildAnchorQuestion({ change: CHANGE, name: 'feature-c', branches: BRANCHES })

  assert.equal(question.id, ANCHOR_QUESTION_ID)
  assert.equal(question.header, 'OpenSpec')
  assert.match(question.question, /feature-c/u)
  assert.deepEqual(question.options.map((option) => option.label), BRANCHES)
  // What the answer creates is the pair name + anchor, at the first commit.
  assert.match(question.detail, /but branch new feature-c -A <anchor>/u)
  assert.match(question.detail, /first commit/u)
  assert.match(question.detail, /Cancelling starts no run/u)
})

test('only an applied branch is an anchor; anything else is a refusal', () => {
  assert.equal(readAnchorChoice(answered(ANCHOR_QUESTION_ID, { selected: ['feature-a'] }), BRANCHES), 'feature-a')
  // A typed value is an anchor when it names an applied branch, and a refusal when it
  // does not: an unknown anchor would fail the first commit after the work is done.
  assert.equal(readAnchorChoice(answered(ANCHOR_QUESTION_ID, { custom: 'feature-b' }), BRANCHES), 'feature-b')
  assert.equal(readAnchorChoice(answered(ANCHOR_QUESTION_ID, { custom: 'gone' }), BRANCHES), null)
  assert.equal(readAnchorChoice(answered(ANCHOR_QUESTION_ID, { selected: ['parked'] }), BRANCHES), null)
  assert.equal(readAnchorChoice(answered(ANCHOR_QUESTION_ID, {}), BRANCHES), null)
  assert.equal(readAnchorChoice(undefined, BRANCHES), null)
})

test('the message and the branch are asked as one card', async () => {
  const questions = fakeQuestions({
    answers: [
      { id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom: 'Добавить эндпоинт' },
      { id: BRANCH_QUESTION_ID, selected: ['feature-a'] },
    ],
  })
  const agent = { id: 'agent-1' }
  const signal = new AbortController().signal

  const outcome = await requestCommitInput({
    questions, agent, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES, signal,
  })

  // One card, the message first (D18): two forms in a row for two facts of the same run
  // is exactly what the single packet removes.
  assert.equal(questions.asked.length, 1)
  assert.deepEqual(
    questions.asked[0].questions.map((question) => question.id),
    [COMMIT_MESSAGE_QUESTION_ID, BRANCH_QUESTION_ID],
  )
  assert.equal(questions.asked[0].agent, agent)
  assert.equal(questions.asked[0].signal, signal)
  assert.deepEqual(outcome, {
    kind: COMMIT_TEXT.text,
    text: 'Добавить эндпоинт',
    branch: { name: 'feature-a', exists: true },
  })
})

test('a stored message is not asked again, and the card holds only the branch', async () => {
  const questions = fakeQuestions(answered(BRANCH_QUESTION_ID, { selected: ['feature-b'] }))

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'gitbutler', stored: 'Сохранённый текст', branches: BRANCHES,
  })

  assert.equal(questions.asked.length, 1)
  assert.deepEqual(questions.asked[0].questions.map((question) => question.id), [BRANCH_QUESTION_ID])
  assert.deepEqual(outcome, {
    kind: COMMIT_TEXT.text,
    text: 'Сохранённый текст',
    branch: { name: 'feature-b', exists: true },
  })
})

test('a new name asks for its anchor in a second card', async () => {
  const questions = fakeQuestions(
    {
      answers: [
        { id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom: 'Добавить эндпоинт' },
        { id: BRANCH_QUESTION_ID, selected: [], custom: 'feature-c' },
      ],
    },
    answered(ANCHOR_QUESTION_ID, { selected: ['feature-a'] }),
  )

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES,
  })

  assert.equal(questions.asked.length, 2)
  assert.deepEqual(questions.asked[1].questions.map((question) => question.id), [ANCHOR_QUESTION_ID])
  assert.match(questions.asked[1].questions[0].question, /feature-c/u)
  // The plan is incomplete until the branch exists: `but branch new` runs at the first
  // commit that has something in it (D18).
  assert.deepEqual(outcome, {
    kind: COMMIT_TEXT.text,
    text: 'Добавить эндпоинт',
    branch: { name: 'feature-c', anchor: 'feature-a', exists: false },
  })
})

test('the first branch of a project is created without an anchor question', async () => {
  const questions = fakeQuestions({
    answers: [
      { id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom: 'Добавить эндпоинт' },
      { id: BRANCH_QUESTION_ID, selected: [], custom: 'first' },
    ],
  })

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: [],
  })

  // Nothing to stack on, so nothing to ask: `but branch new first` without `-a`.
  assert.equal(questions.asked.length, 1)
  assert.deepEqual(outcome.branch, { name: 'first', exists: false })
})

test('a typed applied name selects that branch instead of creating a second one', async () => {
  const questions = fakeQuestions({
    answers: [
      { id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom: 'Добавить эндпоинт' },
      { id: BRANCH_QUESTION_ID, selected: [], custom: ' feature-b ' },
    ],
  })

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES,
  })

  assert.equal(questions.asked.length, 1, 'a matching name is an answer, not a second question')
  assert.deepEqual(outcome.branch, { name: 'feature-b', exists: true })
})

test('a dismissed branch question starts no run, and names the question it was', async () => {
  const questions = fakeQuestions({
    answers: [
      { id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom: 'Добавить эндпоинт' },
      { id: BRANCH_QUESTION_ID, selected: [] },
    ],
  })

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES,
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.branch })
})

test('dismissing the single branch card is a refusal of the branch, not of a message', async () => {
  const questions = fakeQuestions(coded('ASK_CANCELLED'))

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'gitbutler', stored: 'Сохранённый текст', branches: BRANCHES,
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.branch })
})

test('a blank message is a refusal of the message question', async () => {
  const questions = fakeQuestions({
    answers: [
      { id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom: '   ' },
      { id: BRANCH_QUESTION_ID, selected: ['feature-a'] },
    ],
  })

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES,
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.message })
})

test('a new branch without an anchor is a refusal', async () => {
  /**
   * A first card that answers with a name to create.
   *
   * @returns {object} the answer shape of the card.
   */
  const named = () => ({
    answers: [
      { id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom: 'Добавить эндпоинт' },
      { id: BRANCH_QUESTION_ID, custom: 'feature-c' },
    ],
  })

  const dismissed = fakeQuestions(named(), coded('ASK_CANCELLED'))
  assert.deepEqual(
    await requestCommitInput({ questions: dismissed, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES }),
    { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.anchor },
  )

  // An anchor that is not an applied branch is no anchor: `but branch new -a gone`
  // would fail at the first commit, after the group's work is done.
  const unknown = fakeQuestions(named(), answered(ANCHOR_QUESTION_ID, { selected: ['parked'] }))
  assert.deepEqual(
    await requestCommitInput({ questions: unknown, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES }),
    { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.anchor },
  )

  // A channel that vanished between the two cards is the same refusal: no anchor means
  // no stacked branch, and the run must not start on an unstacked guess.
  const gone = fakeQuestions(named(), coded('NO_PROVIDER'))
  assert.deepEqual(
    await requestCommitInput({ questions: gone, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES }),
    { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.anchor },
  )
})

test('a git run asks only for the message and carries no branch', async () => {
  const questions = fakeQuestions(answered(COMMIT_MESSAGE_QUESTION_ID, { custom: 'Добавить эндпоинт' }))

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'git', branches: BRANCHES,
  })

  assert.equal(questions.asked.length, 1)
  assert.deepEqual(questions.asked[0].questions.map((question) => question.id), [COMMIT_MESSAGE_QUESTION_ID])
  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' })
  assert.equal('branch' in outcome, false)
})

test('a stored message with nothing to ask settles without a card', async () => {
  const questions = fakeQuestions()

  const outcome = await requestCommitInput({
    questions, change: CHANGE, cwd: '/repo', tool: 'git', stored: 'Сохранённый текст',
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Сохранённый текст' })
  assert.equal(questions.asked.length, 0)
})

test('without a question channel a stored sentence still commits, and no branch is named', async () => {
  // The headless fallback of D18: nobody to ask, so `but commit -m` without the branch
  // argument, and the report of that commit is what says so.
  const outcome = await requestCommitInput({
    questions: undefined, change: CHANGE, cwd: '/repo', tool: 'gitbutler', stored: 'Сохранённый текст', branches: BRANCHES,
  })

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Сохранённый текст' })
})

test('without a question channel and without a message there is nothing to commit', async () => {
  assert.deepEqual(
    await requestCommitInput({ questions: undefined, change: CHANGE, cwd: '/repo', tool: 'git' }),
    { kind: COMMIT_TEXT.unavailable },
  )
})

test('a channel with nobody behind it answers like a missing one', async () => {
  const withStored = fakeQuestions(coded('NO_PROVIDER'))
  assert.deepEqual(
    await requestCommitInput({
      questions: withStored, change: CHANGE, cwd: '/repo', tool: 'gitbutler', stored: 'Сохранённый текст', branches: BRANCHES,
    }),
    { kind: COMMIT_TEXT.text, text: 'Сохранённый текст' },
  )

  const withoutStored = fakeQuestions(coded('NO_PROVIDER'))
  assert.deepEqual(
    await requestCommitInput({ questions: withoutStored, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES }),
    { kind: COMMIT_TEXT.unavailable },
  )
})

test('a question that failed for another reason is not read as an answer', async () => {
  const questions = fakeQuestions(new Error('the answerer crashed'))

  await assert.rejects(
    () => requestCommitInput({ questions, change: CHANGE, cwd: '/repo', tool: 'gitbutler', branches: BRANCHES }),
    /the answerer crashed/u,
  )
})
