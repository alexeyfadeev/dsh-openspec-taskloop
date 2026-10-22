// dsh-openspec-taskloop — the messages the plugin puts into a session.
//
// Two kinds travel through this module. The first is the model-facing text the
// plugin sends as a turn: the explore hand-off (3.3) and the step that drives one
// task (4.1). Both are user-role messages with a single text block and a producer
// source. The second is the report of a run whose request went away: it is not a
// turn but a `runtime-context` notice appended to the session log, so the user can
// read how the run ended and no model turn is started for it.
//
// The shape mirrors `createUserMessage` from `@deepseek-ai/dsh-llm`; it is built
// here rather than imported so this package keeps its single runtime dependency and
// its tests run under plain Node.
//
// The id is fresh per message: `followup` queues a message and the session log
// identifies it by id, so two step messages that happen to carry the same text
// (a resumed run re-sending a task, say) must not collapse into one.

import { randomUUID } from 'node:crypto'

/**
 * Build a user-role message carrying one text block.
 *
 * @param {string} text - complete model-facing text.
 * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: {kind: 'user'}}} the message.
 * @throws {TypeError} when the text is not a string.
 */
export function createUserTextMessage(text) {
  if (typeof text !== 'string') {
    throw new TypeError('createUserTextMessage requires the message text string')
  }
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Build a context notice carrying one text block.
 *
 * The notice is how a settled run speaks to a session nobody is requesting
 * anything from: `runtime-context` with `form: 'notice'` is the source the host
 * renders as a context block rather than as something the user typed, so the
 * report cannot be mistaken for an instruction the user gave or the model wrote.
 * The summary is the first line, which is what a collapsed block shows.
 *
 * @param {string} text - complete report text.
 * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: {kind: 'runtime-context', form: 'notice', summary: string}}} the message.
 * @throws {TypeError} when the text is not a string.
 */
export function createNoticeMessage(text) {
  if (typeof text !== 'string') {
    throw new TypeError('createNoticeMessage requires the message text string')
  }
  const summary = text.split('\n', 1)[0]
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'runtime-context', form: 'notice', summary },
  }
}
