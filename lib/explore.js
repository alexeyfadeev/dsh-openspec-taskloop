// dsh-openspec-taskloop — collecting a task description and entering explore (task 3.3).
//
// `/taskloop` in a project that is initialised but has no changes yet cannot run a
// task: there is no change and no task list. Design D9 gives this one case one
// job — ask the user what they want to work on, then hand that text to the model
// as a single message asking it to work in explore mode. This module owns that
// step; the task loop is deliberately not reachable from here.
//
//     openspec list --json ──root, no changes──▶ ask for a description
//                                                        │
//                                   blank / dismissed ──▶ cancelled (nothing is sent)
//                                                        │
//                                                 description
//                                                        │
//                                  one followup: explore via the skill
//
// Three decisions are embedded here:
//
//   - The description is free text, not a choice. The question carries no
//     options, so a capable UI renders its text field; the answer's `custom` text
//     is the description. A selection without that text is a refusal, because
//     there is nothing to hand to the model — a unit test pins that no message is
//     sent in that case.
//   - The description travels verbatim. Only its blankness is inspected
//     (`trim()`); the text itself is inserted unchanged, so what the user wrote is
//     what the model reads. Normalising it here would silently edit an
//     instruction the user owns.
//   - Exactly one message is sent, and only after the answer settles. The model
//     owns the dialogue from there and the plugin does not watch it (D9); a
//     second message, a status poll or a task turn here would be the loop the
//     spec says must not start.
//
// The module is free of Cordis, like the rest of the bootstrap: the question
// channel and the agent arrive as arguments, so the described, cancelled and
// unavailable paths run in tests without a host and without a UI.

import { createUserTextMessage } from './message.js'

/** Skill the explore message points the model at. */
export const EXPLORE_SKILL_PATH = '.dsh/skills/openspec-explore'

/** Stable question id, echoed back in the answer. */
export const DESCRIPTION_QUESTION_ID = 'openspec-task-description'

/** Outcomes of {@link requestDescription}; callers switch on `kind`. */
export const EXPLORE_ANSWER = Object.freeze({
  /** The user supplied a description; the result carries it as `description`. */
  described: 'described',
  /** The user dismissed the question or submitted nothing usable. */
  cancelled: 'cancelled',
  /** The project needs a description, but this session has nobody to ask. */
  unavailable: 'unavailable',
})

/**
 * A settled ask for a task description.
 *
 * @typedef {object} DescriptionOutcome
 * @property {'described'|'cancelled'|'unavailable'} kind - what the question settled with.
 * @property {string} [description] - the user's text, verbatim; present only when described.
 */

/**
 * Build the one question the explore bootstrap asks.
 *
 * No `options`: the description is free text, and an option list would turn a
 * task statement into a multiple-choice answer. The detail names the skill and
 * says that no task loop starts, so the user knows what the message will do.
 *
 * @param {string} cwd - project directory the description is about.
 * @returns {object} a `ctx.userQuestions` question.
 */
export function buildDescriptionQuestion(cwd) {
  return {
    id: DESCRIPTION_QUESTION_ID,
    header: 'OpenSpec',
    question: `No OpenSpec change exists in ${cwd} yet. What task should the model explore with you?`,
    detail: 'The description is sent to the model as one message asking it to work in explore mode '
      + `with ${EXPLORE_SKILL_PATH}. No task loop is started from here.`,
  }
}

/**
 * Read the description out of a `ctx.userQuestions` answer.
 *
 * Only `custom` text counts. The question offers no options, so a non-blank
 * `custom` value with no selection is the normal answer; a selection alone
 * carries no description and is treated as a refusal rather than as an empty
 * task statement.
 *
 * @param {unknown} answer - `{answers: [{id, selected, custom?}]}` shape.
 * @returns {string|null} the description verbatim, or `null` when none was given.
 */
export function readDescription(answer) {
  const answers = Array.isArray(answer?.answers) ? answer.answers : []
  const item = answers.find((entry) => entry?.id === DESCRIPTION_QUESTION_ID)
  const custom = typeof item?.custom === 'string' ? item.custom : ''
  return custom.trim() === '' ? null : custom
}

/**
 * Ask the session's human for the task description.
 *
 * `questions` is `ctx.userQuestions`, or `undefined` when the deployment has no
 * such service. A live service with no answerer rejects with `NO_PROVIDER`;
 * both cases answer `unavailable`, because there is nobody to ask. Dismissal is
 * a refusal, so it is reported as `cancelled` and produces no message.
 *
 * @param {object} request
 * @param {object} [request.questions] - the user-questions service.
 * @param {object} [request.agent] - live root agent the question belongs to.
 * @param {string} request.cwd - project directory named in the question.
 * @param {AbortSignal} [request.signal] - cancellation of the whole run.
 * @returns {Promise<DescriptionOutcome>} the settled description.
 * @throws {Error} when the question fails for a reason other than dismissal.
 */
export async function requestDescription({ questions, agent, cwd, signal }) {
  if (questions === undefined || questions === null) return { kind: EXPLORE_ANSWER.unavailable }

  let answer
  try {
    answer = await questions.ask({
      questions: [buildDescriptionQuestion(cwd)],
      agent,
      signal,
    })
  } catch (error) {
    const code = errorCode(error)
    // A dismissed card asks nothing further and an aborted request cannot be
    // answered; both are refusals. Neither may be read as a description.
    if (code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') return { kind: EXPLORE_ANSWER.cancelled }
    if (code === 'NO_PROVIDER') return { kind: EXPLORE_ANSWER.unavailable }
    throw error
  }

  const description = readDescription(answer)
  return description === null
    ? { kind: EXPLORE_ANSWER.cancelled }
    : { kind: EXPLORE_ANSWER.described, description }
}

/**
 * Ask for a description, then send the single explore message when one was given.
 *
 * The message is sent only for the `described` outcome; the other two outcomes
 * are returned untouched, so the caller can report them without guessing whether
 * anything reached the model.
 *
 * @param {object} options - see {@link requestDescription}, plus the live agent.
 * @param {object} options.agent - live root agent that receives the message.
 * @returns {Promise<DescriptionOutcome & {message?: object}>} the settled outcome.
 * @throws {Error} when the question fails, or when the agent cannot accept a message.
 */
export async function startExplore({ questions, agent, cwd, signal }) {
  const decision = await requestDescription({ questions, agent, cwd, signal })
  if (decision.kind !== EXPLORE_ANSWER.described) return decision
  const message = sendExplorePrompt({ agent, description: decision.description })
  return { kind: EXPLORE_ANSWER.described, description: decision.description, message }
}

/**
 * Send the explore message to the agent as its next turn.
 *
 * `followup` is called once, synchronously: the harness queues the message and
 * wakes the driver, and the plugin does not wait for the resulting turn (D9).
 *
 * @param {object} options
 * @param {object} options.agent - live root agent; must expose `followup`.
 * @param {string} options.description - task description, inserted verbatim.
 * @param {string} [options.skillPath] - skill the message names; defaults to {@link EXPLORE_SKILL_PATH}.
 * @returns {object} the queued user message.
 * @throws {TypeError} when the agent cannot accept a follow-up.
 */
export function sendExplorePrompt({ agent, description, skillPath = EXPLORE_SKILL_PATH }) {
  if (typeof agent?.followup !== 'function') {
    throw new TypeError('the explore message needs an agent that accepts a follow-up')
  }
  const message = createExploreMessage(description, skillPath)
  agent.followup(message)
  return message
}

/**
 * Build the identified user message that starts explore mode.
 *
 * @param {string} description - task description, inserted verbatim.
 * @param {string} [skillPath] - skill named in the message.
 * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: {kind: 'user'}}} the message.
 */
export function createExploreMessage(description, skillPath = EXPLORE_SKILL_PATH) {
  return createUserTextMessage(buildExplorePrompt(description, skillPath))
}

/**
 * Text of the explore message: the instruction, then the description verbatim.
 *
 * @param {string} description - task description as the user wrote it.
 * @param {string} [skillPath] - skill the instruction names.
 * @returns {string} the complete message text.
 * @throws {TypeError} when the description is not a string.
 */
export function buildExplorePrompt(description, skillPath = EXPLORE_SKILL_PATH) {
  if (typeof description !== 'string') {
    throw new TypeError('buildExplorePrompt requires the description string')
  }
  return [
    `Работай в режиме explore по навыку ${skillPath}.`,
    '',
    'Описание задачи:',
    description,
  ].join('\n')
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
