// dsh-openspec-taskloop — task numbers and groups (task 2.4).
//
// The CLI never says which group a task belongs to: `openspec instructions
// apply --json` returns a flat, file-ordered list, and design D5 fixes the
// leading `N.M` in `description` as the only signal — precisely because that is
// what the model sees when it reads `tasks.md`. Later tasks depend on this
// module twice: 6.1 compacts between tasks of one group, and 5.1 opens a new
// session when the group changes. Recovering groups from markdown headings was
// rejected in the design: the CLI does not return them.
//
// The run is flat when *any* listed task lacks the prefix (design D5, spec
// scenario "Задачи без нумерации"): sessions are not split, while compaction
// still happens on every transition. That decision is taken over the whole list
// the CLI returned, not over the uncompleted remainder. Otherwise a single
// unnumbered task would flip the mode mid-run — the moment it got checked — and
// the same run would split sessions at different points depending on when it
// was resumed. A flat run is the conservative answer: it never splits what might
// belong together.

/**
 * How a run treats groups.
 */
export const GROUPING = Object.freeze({
  /** Every listed task carries `N.M`; groups exist and bound sessions. */
  grouped: 'grouped',
  /** At least one listed task has no number; the run stays in one session. */
  flat: 'flat',
})

/**
 * What separates two consecutive tasks; callers switch on the value.
 */
export const TRANSITION = Object.freeze({
  /** Same group: compact in place, continue in the current session (6.1). */
  sameGroup: 'same-group',
  /** Other group: open a new session for this task (5.1). */
  newGroup: 'new-group',
  /** A flat run: no boundary anywhere, compaction on every transition. */
  flat: 'flat',
})

/**
 * Design D5: a task number is the prefix `N.M` of the description. Anchored, so
 * a number quoted deeper in the text cannot masquerade as the task's own.
 */
const TASK_NUMBER = /^(\d+)\.(\d+)/

/**
 * A task number read off a description.
 *
 * @typedef {object} TaskNumber
 * @property {string} major - leading digits exactly as written.
 * @property {string} minor - trailing digits exactly as written.
 * @property {string} label - `N.M` as written, i.e. what a message may name.
 * @property {number} group - major number as a number; identity of the group.
 */

/**
 * Read the `N.M` prefix of a task description.
 *
 * The label keeps the digits of the file (`02.1` stays `02.1`, `2.10` stays
 * `2.10`), while `group` is numeric, so differently padded spellings of the same
 * group are still one group. Both matter: the label goes into the message a
 * human reads, the group decides whether a session is split.
 *
 * @param {string} description - task text as written after the checkbox.
 * @returns {TaskNumber|null} the number, or `null` when the text does not start with one.
 */
export function extractTaskNumber(description) {
  if (typeof description !== 'string') {
    throw new TypeError('extractTaskNumber requires a task description string')
  }

  const match = TASK_NUMBER.exec(description)
  if (match === null) return null

  const [, major, minor] = match
  return { major, minor, label: `${major}.${minor}`, group: Number(major) }
}

/**
 * A group of tasks: one number and the tasks carrying it, in file order.
 *
 * @typedef {object} TaskGroup
 * @property {number} group - major number shared by the tasks.
 * @property {object[]} tasks - the tasks of this group, in file order.
 */

/**
 * Decide whether the run is grouped and, if so, which tasks belong together.
 *
 * Groups appear in first-appearance order rather than numerically sorted order:
 * the file is the run's order, and selection follows the file (task 2.3), so a
 * numbering that jumps back (`1.1`, `2.1`, `1.2`) must not be reordered here.
 *
 * @param {object[]} tasks - `tasks` array of parsed apply instructions, in file order.
 * @returns {{mode: string, groups: TaskGroup[]}} `groups` is empty for a flat run.
 */
export function describeGrouping(tasks) {
  if (!Array.isArray(tasks)) {
    throw new TypeError('describeGrouping requires the parsed task list')
  }

  const numbers = tasks.map((task) => extractTaskNumber(task.description))
  if (tasks.length === 0 || numbers.some((number) => number === null)) {
    return { mode: GROUPING.flat, groups: [] }
  }

  const groups = []
  const byNumber = new Map()
  for (const [index, task] of tasks.entries()) {
    const { group } = numbers[index]
    let entry = byNumber.get(group)
    if (entry === undefined) {
      entry = { group, tasks: [] }
      byNumber.set(group, entry)
      groups.push(entry)
    }
    entry.tasks.push(task)
  }
  return { mode: GROUPING.grouped, groups }
}

/**
 * Classify the step from one task to the next.
 *
 * Only a grouped run can have a boundary. In a flat run every transition is
 * `flat`, and so is a comparison the grouping cannot explain (a task without a
 * number in a run declared grouped, i.e. a list from somewhere else): taking a
 * new session on a guess is the one mistake this module exists to avoid, and the
 * spec's answer for unnumbered tasks is to keep working in one session.
 *
 * @param {{mode: string}} grouping - result of {@link describeGrouping}.
 * @param {object} previous - task that just completed.
 * @param {object} next - task about to run.
 * @returns {string} one of {@link TRANSITION}.
 */
export function classifyTransition(grouping, previous, next) {
  if (grouping.mode === GROUPING.flat) return TRANSITION.flat

  const from = extractTaskNumber(previous.description)
  const to = extractTaskNumber(next.description)
  if (from === null || to === null) return TRANSITION.flat

  return from.group === to.group ? TRANSITION.sameGroup : TRANSITION.newGroup
}
