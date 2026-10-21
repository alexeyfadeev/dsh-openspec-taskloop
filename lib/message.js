// dsh-openspec-taskloop — the one user-message shape the plugin sends.
//
// Both messages the plugin puts into a session — the explore hand-off (3.3) and
// the step that drives one task (4.1) — are user-role messages with a single text
// block and a producer source. The shape mirrors `createUserMessage` from
// `@deepseek-ai/dsh-llm`; it is built here rather than imported so this package
// keeps its single runtime dependency and its tests run under plain Node.
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
