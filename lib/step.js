// dsh-openspec-taskloop — the one message that drives a single task (task 4.1).
//
// Design D2 fixes the wording and the reason it travels as a message instead of a
// system-prompt section: the task number changes on every step, and a prefix that
// changes between tasks would invalidate the prompt cache on each one. A message
// is also visible in the session log, which is what makes the conductor
// debuggable — the user can see exactly which task the model was handed.
//
//     Используя навык .dsh/skills/openspec-apply-change выполни task 4.1, далее - пауза.
//     Change: add-taskloop-plugin; файл: …\tasks.md:23.
//
// The first line is the instruction the model acts on *and* the pause it owes:
// the plugin, not the model, decides whether the run continues (D1), so a turn
// that kept going would spend context the compaction policy never sees. The
// second line is the address — change, tracking file and the exact line the
// checkbox lives on — so the model does not have to search for the task and the
// supervisor can point at the same row when it re-reads state afterwards (D4).
//
// The module is pure and Cordis-free: it builds the message and calls `followup`
// exactly once, which is all a step needs. Waiting for the turn to end and
// re-reading `tasks.md` belong to the run loop (4.2), not to the message.

import { extractTaskNumber } from './groups.js'
import { createUserTextMessage } from './message.js'

/** Skill every step message points the model at. */
export const APPLY_SKILL_PATH = '.dsh/skills/openspec-apply-change'

/**
 * How the message names the task.
 *
 * The `N.M` label is preferred because it is what the model sees in `tasks.md`
 * and what the user reads in the report (design D5). A flat run has tasks
 * without that prefix, and then the CLI's sequential id is the only identifier
 * the plugin has; the address line still pins the exact row, so naming the id
 * cannot point the model at the wrong task.
 *
 * @param {import('./tasks.js').ApplyTask} task - task about to run.
 * @returns {string} the label used in the message.
 */
export function taskLabel(task) {
  const number = extractTaskNumber(task.description)
  if (number !== null) return number.label
  return task.id !== '' ? task.id : `line ${task.line}`
}

/**
 * Text of the step message: the instruction with the pause, then the address.
 *
 * Kept as one exported function so the exact wording is pinned in one place,
 * including the trailing address line a reader can jump to.
 *
 * @param {object} options
 * @param {string} options.change - change the task belongs to.
 * @param {import('./tasks.js').ApplyTask} options.task - task about to run.
 * @param {string} [options.skillPath] - skill the instruction names.
 * @returns {string} the complete message text.
 * @throws {TypeError} when the change or the task cannot be addressed.
 */
export function buildTaskPrompt({ change, task, skillPath = APPLY_SKILL_PATH }) {
  if (typeof change !== 'string' || change === '') {
    throw new TypeError('buildTaskPrompt requires the change name')
  }
  assertAddressable(task)

  return [
    `Используя навык ${skillPath} выполни task ${taskLabel(task)}, далее - пауза.`,
    `Change: ${change}; файл: ${task.sourcePath}:${task.line}.`,
  ].join('\n')
}

/**
 * Build the identified user message for one task.
 *
 * @param {object} options - see {@link buildTaskPrompt}.
 * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: {kind: 'user'}}} the message.
 * @throws {TypeError} when the change or the task cannot be addressed.
 */
export function createTaskMessage({ change, task, skillPath = APPLY_SKILL_PATH }) {
  return createUserTextMessage(buildTaskPrompt({ change, task, skillPath }))
}

/**
 * Send the step message to the agent as its next turn.
 *
 * `followup` is called once, synchronously: the harness queues the message and
 * wakes the driver. The plugin does not await the turn here — that is the loop's
 * next step (4.2) — so this function never sends a second message.
 *
 * @param {object} options
 * @param {object} options.agent - live agent that receives the message; must expose `followup`.
 * @param {string} options.change - change the task belongs to.
 * @param {import('./tasks.js').ApplyTask} options.task - task about to run.
 * @param {string} [options.skillPath] - skill the instruction names.
 * @returns {object} the queued user message.
 * @throws {TypeError} when the agent cannot accept a follow-up, or the task cannot be addressed.
 */
export function sendTaskStep({ agent, change, task, skillPath = APPLY_SKILL_PATH }) {
  if (typeof agent?.followup !== 'function') {
    throw new TypeError('the task step needs an agent that accepts a follow-up')
  }
  const message = createTaskMessage({ change, task, skillPath })
  agent.followup(message)
  return message
}

/**
 * Refuse a task the message could not point at.
 *
 * The address is the whole value of a step message: without a tracking file and a
 * line the model would have to guess which task it was given, and the supervisor
 * would have no row to re-read afterwards. The parser (2.3) already requires
 * both, so this guards the direct callers instead of trusting them.
 *
 * @param {unknown} task - task about to run.
 * @throws {TypeError} when the task lacks a description, a source path or a line.
 */
function assertAddressable(task) {
  if (typeof task !== 'object' || task === null) {
    throw new TypeError('buildTaskPrompt requires a task object')
  }
  if (typeof task.description !== 'string' || task.description === '') {
    throw new TypeError('buildTaskPrompt requires a task description')
  }
  if (typeof task.sourcePath !== 'string' || task.sourcePath === '') {
    throw new TypeError('buildTaskPrompt requires the task sourcePath')
  }
  if (!Number.isSafeInteger(task.line) || task.line < 1) {
    throw new TypeError('buildTaskPrompt requires the task line')
  }
}
