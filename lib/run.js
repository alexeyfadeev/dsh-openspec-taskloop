// dsh-openspec-taskloop — one step of an apply run (task 4.1).
//
// A step is the smallest unit of the loop: read `openspec instructions apply
// --json`, pick the first uncompleted task (2.3), and either send exactly that one
// task message (4.1) or settle on a state that sends none. The step owns no
// memory of its own: every entry re-reads `tasks.md` through the CLI, so the
// position of a run is always the file's position, never the plugin's (D4, D8).
//
//     read apply ──ready, task──▶ one followup ──▶ { kind: 'task' }
//          │
//          ├── all_done ──▶ { kind: 'done' }    (no message)
//          ├── blocked  ──▶ { kind: 'blocked' } (no message)
//          └── idle     ──▶ { kind: 'idle' }    (no message)
//
// Waiting for the turn to end and re-reading state afterwards is the loop's part
// (`lib/loop.js`, 4.2); this module is the single transition it repeats, kept
// separate so the message contract can be pinned without a driver and a clock.
//
// The recipient is the loop's choice, not this module's: on the step into another
// group the loop hands in a `agentFor()` that opens a session and returns its
// runner (5.1), so the message contract stays the same wherever the task runs.
// The decision itself can also be the caller's: the loop selects the next task,
// compacts the session it is going to use if the task continues the group (6.1),
// and passes that selection back in — one decision, acted upon twice.

import { NEXT_TASK, parseApplyInstructions, selectNextTask } from './tasks.js'
import { sendTaskStep } from './step.js'

/**
 * Arguments of the read that answers "which task is next".
 *
 * `--change` is always passed: the listing selected the change already, and
 * without the flag the CLI answers for whatever it considers current — which on a
 * project with several changes is not necessarily the one the user asked for.
 *
 * @param {string} change - change name to read.
 * @returns {string[]} arguments after the executable.
 */
export function applyArgs(change) {
  return ['instructions', 'apply', '--change', change, '--json']
}

/**
 * Read and parse the task file of one change.
 *
 * @param {object} options
 * @param {{run: Function}} options.cli - the `openspec` wrapper.
 * @param {string} options.cwd - project directory the CLI runs in.
 * @param {string} options.change - change to read.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<import('./tasks.js').ApplyInstructions>} state, tasks and progress.
 * @throws {import('./tasks.js').ApplyError} when the answer is not a usable document.
 * @throws {import('./openspec.js').OpenSpecError} when the CLI cannot run.
 */
export async function readApplyInstructions({ cli, cwd, change, signal }) {
  if (typeof change !== 'string' || change === '') {
    throw new TypeError('readApplyInstructions requires the change name')
  }
  const result = await cli.run(applyArgs(change), { cwd, signal })
  return parseApplyInstructions(result.stdout)
}

/**
 * What one step settled with.
 *
 * The `kind` values are {@link NEXT_TASK}'s: a step either sends a task or reports
 * the reason it sent none, and the caller renders that reason without inventing a
 * second vocabulary for the same four states.
 *
 * @typedef {object} StepOutcome
 * @property {'task'|'done'|'blocked'|'idle'} kind - what the step settled with.
 * @property {import('./tasks.js').ApplyInstructions} instructions - the reading the decision came from.
 * @property {import('./tasks.js').ApplyTask} [task] - task that was sent; present only when `kind` is `task`.
 * @property {object} [message] - the queued message; present only when `kind` is `task`.
 * @property {object} [agent] - the recipient the message went to; present only when `kind` is `task`.
 * @property {string} [reason] - why nothing was sent; present unless `kind` is `task`.
 */

/**
 * Run one step of the loop: read the task file, send at most one message.
 *
 * The message names the change as the CLI reported it, falling back to the name
 * the caller asked for; the two agree on a normal project, and the fallback keeps
 * a document that omits `changeName` from producing an unaddressed message.
 *
 * @param {object} options
 * @param {{run: Function}} options.cli - the `openspec` wrapper.
 * @param {string} options.cwd - project directory the CLI runs in.
 * @param {string} options.change - change to read.
 * @param {object} options.agent - live agent that receives the step message.
 * @param {(task: import('./tasks.js').ApplyTask) => (object|Promise<object>)} [options.agentFor] -
 *   chooses the recipient of a task; absent, every task goes to `agent`. The loop uses it to
 *   open a new session at a group boundary (5.1), and the returned object is reported back so
 *   the caller waits for the recipient it actually sent to.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @param {string} [options.skillPath] - skill the message names; defaults to the apply skill.
 * @param {import('./tasks.js').ApplyInstructions} [options.instructions] - a reading the caller
 *   already has; when present the step acts on it and makes no CLI call. The loop passes the
 *   reading it just verified so a transition costs one `instructions apply` call, not two.
 * @param {ReturnType<typeof selectNextTask>} [options.selection] - the decision the caller
 *   already took on that reading. The loop passes it after acting between the decision and the
 *   message — compaction inside a group (6.1) — so the step sends the task that was decided on
 *   and does not pick again.
 * @returns {Promise<StepOutcome>} the settled step.
 * @throws {import('./tasks.js').ApplyError} when the task file cannot be read.
 * @throws {TypeError} when the agent cannot accept a follow-up.
 */
export async function runOneStep({ cli, cwd, change, agent, agentFor, signal, skillPath, instructions, selection }) {
  const state = instructions ?? await readApplyInstructions({ cli, cwd, change, signal })
  const next = selection ?? selectNextTask(state)

  if (next.kind !== NEXT_TASK.task) {
    return { kind: next.kind, instructions: state, reason: next.reason }
  }

  const recipient = agentFor === undefined ? agent : await agentFor(next.task)
  const message = sendTaskStep({
    agent: recipient,
    change: state.change !== '' ? state.change : change,
    task: next.task,
    skillPath,
  })
  return { kind: NEXT_TASK.task, instructions: state, task: next.task, message, agent: recipient }
}
