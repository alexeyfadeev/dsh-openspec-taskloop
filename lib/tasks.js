// dsh-openspec-taskloop — reading `openspec instructions apply --json` (task 2.3).
//
// This document is the plugin's only source of truth about where a run stands:
// the CLI re-reads `tasks.md` on every call, so the parser never caches a
// position and a resumed run sees exactly what the file says. Like the listing
// parser, this module is pure — stdout text in, data out. The call itself is
// `OpenSpecCli.run(['instructions', 'apply', '--json'])` (task 2.1).
//
// Document shape, captured from openspec 1.14.1 (see test/fixtures/apply):
//
//   {
//     "changeName", "changeDir", "schemaName", "contextFiles",
//     "progress": { "total", "complete", "remaining" },
//     "tasks": [ { "id", "description", "done", "sourcePath", "line" } ],
//     "taskTrackingConfigured", "state", "instruction",
//     "missingArtifacts"?, "missingPrerequisites"?, "warnings"?, ...
//   }
//
// Facts the plugin depends on:
//
//   - `state` is `ready`, `blocked` or `all_done`. `blocked` and `all_done` end a
//     run without sending a task, and the reason to report is `instruction`:
//     the CLI puts the whole explanation there, including which artifacts are
//     missing.
//   - `id` is a sequential string over the *listed* tasks, not the `N.M` number.
//     The number exists only inside `description` (task 2.4 extracts it).
//   - `line` and `sourcePath` locate the checkbox in the tracking file. The
//     plugin re-reads the task after every turn and trusts the checkbox, never
//     its own memory (design D4), so those two fields plus the description are
//     the identity of a task across reads.
//   - `progress` counts every checkbox in the file, while `tasks` omits
//     checkboxes that carry no text. The two can therefore disagree by
//     construction, which is why `progress` is kept separate rather than
//     derived from `tasks.length`.
//
// Identity across reads (design D4) is the triple `sourcePath` + `line` +
// `description`, which `findListedTask` compares verbatim. When that misses —
// the model edited the very row it was given — `findTaskByNumber` falls back to
// the `N.M` number inside the same file, and the divergence ladder in
// `lib/diverged.js` decides whether the row is the same task.

import { extractTaskNumber } from './groups.js'

/**
 * Failure kinds reported by {@link ApplyError}. Callers switch on the code
 * instead of matching message text.
 */
export const APPLY_ERROR = Object.freeze({
  /** stdout was not a JSON document of the documented shape. */
  malformed: 'malformed',
})

/**
 * Values of the document's `state` that the plugin acts on.
 */
export const RUN_STATE = Object.freeze({
  /** Work can continue; there is at least one uncompleted task. */
  ready: 'ready',
  /** The CLI refuses to apply; `instruction` says why. */
  blocked: 'blocked',
  /** Every tracked task is checked. */
  allDone: 'all_done',
})

/**
 * Outcomes of {@link selectNextTask}; callers switch on `kind`.
 */
export const NEXT_TASK = Object.freeze({
  /** A task to send to the model; the result carries it as `task`. */
  task: 'task',
  /** All tracked tasks are complete; nothing to send. */
  done: 'done',
  /** The CLI blocked the change; `reason` comes from its `instruction`. */
  blocked: 'blocked',
  /** Ready, yet nothing to run; `reason` says what was observed. */
  idle: 'idle',
})

/**
 * One entry of the `tasks` array, normalised for the plugin.
 *
 * @typedef {object} ApplyTask
 * @property {string} id - sequential id over the listed tasks; not the `N.M` number.
 * @property {string} description - task text as written after the checkbox.
 * @property {boolean} done - whether the checkbox in the tracking file is ticked.
 * @property {string} sourcePath - tracking file that holds the checkbox.
 * @property {number} line - 1-based line of the checkbox in `sourcePath`.
 */

/**
 * A parsed `openspec instructions apply --json` document.
 *
 * @typedef {object} ApplyInstructions
 * @property {string} change - change the CLI answered for.
 * @property {string|null} schema - workflow schema in use, e.g. `spec-driven`.
 * @property {string} state - raw `state` value; selection treats anything but `ready` and `all_done` as blocking.
 * @property {string} instruction - the CLI's prose for this state; empty when it sent none.
 * @property {{total: number, complete: number, remaining: number}|null} progress - counts over every checkbox, or `null` when unusable.
 * @property {ApplyTask[]} tasks - listed tasks in file order.
 * @property {string[]} missingArtifacts - required artifacts the CLI reports as absent.
 */

/**
 * A document that is not a usable set of apply instructions.
 *
 * A well-formed document in any of the three states is an answer, not an error:
 * `blocked` and `all_done` are returned as data for selection to act on.
 */
export class ApplyError extends Error {
  /**
   * @param {string} message - diagnostic naming the offending part.
   * @param {object} [details]
   * @param {Error} [details.cause] - underlying `JSON.parse` error, when any.
   */
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ApplyError'
    this.code = APPLY_ERROR.malformed
  }
}

/**
 * Parse the stdout of `openspec instructions apply --json`.
 *
 * @param {string} stdout - collected stdout of the call.
 * @returns {ApplyInstructions} state, tasks and progress.
 * @throws {ApplyError} when the text is not a document of the documented shape.
 */
export function parseApplyInstructions(stdout) {
  if (typeof stdout !== 'string') {
    throw new TypeError('parseApplyInstructions requires the stdout string of the CLI call')
  }

  let document
  try {
    document = JSON.parse(stdout)
  } catch (cause) {
    throw new ApplyError(`openspec instructions apply --json did not return JSON: ${describe(cause)}`, { cause })
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new ApplyError('openspec instructions apply --json did not return a JSON object')
  }
  if (typeof document.state !== 'string' || document.state === '') {
    throw new ApplyError('openspec instructions apply --json returned a document without a state')
  }
  if (!Array.isArray(document.tasks)) {
    throw new ApplyError('openspec instructions apply --json returned a document without a task list')
  }

  return {
    change: typeof document.changeName === 'string' ? document.changeName : '',
    schema: typeof document.schemaName === 'string' ? document.schemaName : null,
    state: document.state,
    instruction: typeof document.instruction === 'string' ? document.instruction : '',
    progress: parseProgress(document.progress),
    tasks: document.tasks.map((task, index) => parseTask(task, index)),
    missingArtifacts: parseNames(document.missingArtifacts),
  }
}

/**
 * Decide what the run does next, from one reading of the task file.
 *
 * The order of the checks is the contract: a blocked change never runs a task
 * even if its list happens to contain an uncompleted one, and `all_done` is
 * reported as completion rather than as "no task found".
 *
 * @param {ApplyInstructions} instructions - parsed document.
 * @returns {{kind: 'task', task: ApplyTask}|{kind: 'done'}|{kind: 'blocked', reason: string}|{kind: 'idle', reason: string}} next step.
 */
export function selectNextTask(instructions) {
  if (instructions.state === RUN_STATE.allDone) return { kind: NEXT_TASK.done }

  if (instructions.state !== RUN_STATE.ready) {
    // `blocked` and any state this plugin does not know both stop the run. The
    // CLI's instruction is preferred because it names the missing artifacts;
    // the fallback exists for a document that carries none.
    const reason = instructions.instruction !== '' ? instructions.instruction : `openspec reported state "${instructions.state}"`
    return { kind: NEXT_TASK.blocked, reason }
  }

  // First uncompleted task in file order: for the `N.M` numbering the CLI keeps
  // the file's order, so this is also the lowest number left.
  const task = instructions.tasks.find((candidate) => !candidate.done)
  if (task !== undefined) return { kind: NEXT_TASK.task, task }

  // Reachable when the only unchecked boxes are ones with no text: they count
  // in `progress` but are not listed. Sending nothing is the honest answer.
  const remaining = instructions.progress?.remaining ?? 0
  return {
    kind: NEXT_TASK.idle,
    reason:
      remaining > 0
        ? `openspec reports ${remaining} incomplete task(s) but lists none to run`
        : `openspec reported state "${instructions.state}" but lists no task to run`,
  }
}

/**
 * Find the same task in a later reading of the task file.
 *
 * A task is identified by the three fields the CLI reports for it: the file that
 * holds the checkbox, the line of that checkbox, and the task text (design D4).
 * The `done` flag is deliberately not part of the identity — it is the answer the
 * caller is looking for, not a way to recognise the task. A missing result means
 * the file changed under the run (a row was removed or the text was rewritten),
 * which is a stop condition rather than a reason to guess.
 *
 * @param {ApplyInstructions} instructions - a fresh reading of the task file.
 * @param {ApplyTask} task - task a caller sent, as it was read before the turn.
 * @returns {ApplyTask|undefined} the same task in the fresh reading, or `undefined`.
 */
export function findListedTask(instructions, task) {
  return instructions.tasks.find((candidate) =>
    candidate.sourcePath === task.sourcePath
    && candidate.line === task.line
    && candidate.description === task.description)
}

/**
 * Find the sent task again by its number, when the verbatim triple missed.
 *
 * This is the second identity key of design D1 and the first step of the
 * divergence ladder: `findListedTask` answers "unchanged", and only when it
 * declines does the plugin look for the same `N.M` in the same tracking file
 * (design D2). A hit here means the row is still the task the model was given —
 * its line moved, or its text was edited — so the caller can classify the
 * divergence instead of declaring the task gone.
 *
 * Three rules keep the search honest:
 *
 *  - candidates come only from the sent task's `sourcePath`: moving a task to
 *    another file is not a reformulation, and a same-numbered row elsewhere
 *    belongs to another change's list;
 *  - the number is compared numerically, like {@link classifyDivergence} does:
 *    `02.1` and `2.1` are one position written two ways, while `2.10` and `2.1`
 *    are two — padding is formatting, not identity;
 *  - among several matches the nearest `line` wins, because a reformulation is
 *    an edit in place, not a move a hundred lines down. Equal distances resolve
 *    to the smaller line, so the answer does not depend on the array's order.
 *
 * A row without `N.M` has no second key (design D10), so the search simply
 * finds nothing; the caller reports the flat-list reason rather than guessing.
 *
 * @param {ApplyInstructions} instructions - a fresh reading of the task file.
 * @param {ApplyTask} task - task a caller sent, as it was read before the turn.
 * @returns {ApplyTask|undefined} the same-numbered row in the same file, nearest
 *   to the sent line, or `undefined` when the file no longer lists it.
 */
export function findTaskByNumber(instructions, task) {
  const number = extractTaskNumber(task.description)
  if (number === null) return undefined

  let nearest
  let nearestDistance = Infinity

  for (const candidate of instructions.tasks) {
    if (candidate.sourcePath !== task.sourcePath) continue

    const candidateNumber = extractTaskNumber(candidate.description)
    if (candidateNumber === null || !hasSameNumber(number, candidateNumber)) continue

    const distance = Math.abs(candidate.line - task.line)
    if (distance < nearestDistance || (distance === nearestDistance && candidate.line < nearest.line)) {
      nearest = candidate
      nearestDistance = distance
    }
  }

  return nearest
}

/**
 * Compare two numbers read off descriptions.
 *
 * Numeric, not textual: the same position can be written `02.1` and `2.1`, and
 * only the digits' value decides which task a row is. `2.10` and `2.1` stay
 * different, which is why both parts are compared as numbers rather than by
 * dropping leading zeros from the label.
 *
 * @param {import('./groups.js').TaskNumber} left - one number.
 * @param {import('./groups.js').TaskNumber} right - the other.
 * @returns {boolean} whether both name the same position in the list.
 */
function hasSameNumber(left, right) {
  return Number(left.major) === Number(right.major) && Number(left.minor) === Number(right.minor)
}

/**
 * Normalise the document's `progress` block.
 *
 * @param {unknown} value - raw `progress` value.
 * @returns {{total: number, complete: number, remaining: number}|null} counts, or `null` when unusable.
 */
function parseProgress(value) {
  if (typeof value !== 'object' || value === null) return null
  const { total, complete, remaining } = value
  const counts = [total, complete, remaining]
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return null
  return { total, complete, remaining }
}

/**
 * Normalise one task entry.
 *
 * Strict on the fields a run depends on: the description is what the model is
 * asked to do, and `sourcePath`/`line` are how the same task is found again
 * after the turn. A document that cannot supply them cannot be verified.
 *
 * @param {unknown} entry - raw entry.
 * @param {number} index - position in the array, for diagnostics.
 * @returns {ApplyTask} parsed entry.
 * @throws {ApplyError} when the entry is not a locatable task.
 */
function parseTask(entry, index) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ApplyError(`openspec instructions apply --json returned tasks[${index}] that is not an object`)
  }
  if (typeof entry.description !== 'string' || entry.description === '') {
    throw new ApplyError(`openspec instructions apply --json returned tasks[${index}] without a description`)
  }
  if (typeof entry.sourcePath !== 'string' || entry.sourcePath === '') {
    throw new ApplyError(`openspec instructions apply --json returned tasks[${index}] without a sourcePath`)
  }
  if (!Number.isSafeInteger(entry.line) || entry.line < 1) {
    throw new ApplyError(`openspec instructions apply --json returned tasks[${index}] without a usable line`)
  }
  if (typeof entry.done !== 'boolean') {
    throw new ApplyError(`openspec instructions apply --json returned tasks[${index}] without a boolean done flag`)
  }
  return {
    // The CLI emits the id as a string; a number is accepted so a future
    // encoding change costs nothing, but the plugin only ever compares it.
    id: entry.id === undefined || entry.id === null ? '' : String(entry.id),
    description: entry.description,
    done: entry.done,
    sourcePath: entry.sourcePath,
    line: entry.line,
  }
}

/**
 * Normalise an array of artifact names.
 *
 * @param {unknown} value - raw `missingArtifacts` value.
 * @returns {string[]} names, empty when the field is absent or unusable.
 */
function parseNames(value) {
  if (!Array.isArray(value)) return []
  return value.filter((name) => typeof name === 'string' && name !== '')
}

/**
 * Message text for an unknown thrown value.
 *
 * @param {unknown} value - thrown value.
 * @returns {string} a message safe to embed.
 */
function describe(value) {
  return value instanceof Error ? value.message : String(value)
}
