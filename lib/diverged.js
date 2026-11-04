// dsh-openspec-taskloop — how far a task's wording drifted (task 1.1).
//
// A task is recognised between turns by three fields — `sourcePath`, `line` and
// the verbatim `description` (`lib/tasks.js:206`). Verbatim is enough until the
// model edits the very row it was given: in session-0b8f1713 the model ticked
// task 11.4, appended a note and fixed a typo inside that note, and the run
// stopped as `missing` even though the task was done
// (docs/taskloop-missing-stop-2026-11-03.md).
//
// This module is the pure part of the recovery designed in `design.md` (D3, D8):
// it normalises a description (task 1.1), decides the first rung of the ladder —
// the old wording surviving intact inside the new one (task 1.2) — and measures
// how alike two wordings are, placing the result in one of the three bands
// (task 1.3). `classifyDivergence` is the classifier the loop calls: it puts the
// rungs in design D3's order and refuses the pairs that must not be classified at
// all (task 1.4). The one turn of design D5 lives here as well: its text (task
// 3.1), and the turn itself — one message, one wait, and a verdict read from the
// row's checkbox (task 3.2). The question to the user is task 4.1.
//
// It is Cordis-free on purpose, like `lib/step.js` and `lib/review.js`: anything
// that needs a host — a turn, a question — is passed in by the run loop, so every
// comparison here stays a plain function of its arguments and keeps no state. The
// turn needs no host beyond the agent it is given, the same shape `lib/review.js`
// has; the verdict needs the tracking file, which the task's own address carries.
//
// The thresholds are exported constants rather than settings (design D9): a
// threshold is a property of the algorithm, not of the environment, and it cannot
// be configured meaningfully without a corpus of real reformulations. The page of
// settings in the spec therefore stays at eleven values.

import { readFile } from 'node:fs/promises'

import { extractTaskNumber } from './groups.js'
import { createUserTextMessage } from './message.js'
import { APPLY_SKILL_PATH } from './step.js'
import { aborted, waitForIdle } from './wait.js'

/**
 * Similarity at or above which a drifted wording counts as `minor` (design D3).
 *
 * Similarity is the character-level Levenshtein ratio
 * `1 - distance / length of the longer string`. 0.90 leaves room for a typo or
 * two in a task of a hundred-plus characters — one wrong character in 150 is
 * ≈0.99 — while a rewritten clause or a reordered opening drops below it.
 *
 * The commonest drift never consults this number: an appended note keeps the old
 * text as a substring and is `minor` by the substring rule (task 1.2). The two
 * spellings of the incident's row 11.4 are exactly that case.
 */
export const SIMILARITY_MINOR = 0.90

/**
 * Lower bound of the uncertain band (design D3): from here up to
 * {@link SIMILARITY_MINOR} the plugin asks the model, and below it the user.
 *
 * 0.60 is where two formulations still share most of a sentence — a rewritten
 * opening with a common tail sits here — while unrelated text drops well under
 * it. The band is deliberately narrow: every task inside it costs one extra turn.
 */
export const SIMILARITY_GRAY = 0.60

/**
 * Reduce a description to the text the comparison looks at.
 *
 * Three changes, each with a reason:
 *
 *  - the `N.M` prefix goes first, because the number has already been matched on
 *    its own (task 2.1): leaving it in would give every pair the same opening
 *    characters and flatter the similarity of unrelated tasks under one number;
 *  - runs of whitespace collapse to a single space and both ends are trimmed,
 *    because re-wrapping a row is not a reformulation;
 *  - case folds to lower, because a capitalised first word is an artefact of the
 *    row, not part of the task.
 *
 * Punctuation and wording stay: dropping them would hide exactly the edits the
 * classification exists to notice.
 *
 * @param {string} description - task text as written after the checkbox.
 * @returns {string} the normalised text; empty when nothing was left.
 * @throws {TypeError} when the value is not a description string.
 */
export function normalizeDescription(description) {
  if (typeof description !== 'string') {
    throw new TypeError('normalizeDescription requires a task description string')
  }

  // The prefix is read by the same anchored pattern groups use, so a number
  // quoted deeper in the text is never mistaken for the task's own (task 2.4).
  const number = extractTaskNumber(description)
  const body = number === null ? description : description.slice(number.label.length)

  return body.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Classify a divergence whose old wording survives intact inside the new one.
 *
 * This is the first rule of the ladder (design D3) and the one that decides the
 * incident: the model ticked 11.4, appended a note and fixed a typo inside it, so
 * the text it was given is still there, character for character. The rule is not
 * a convenience around the threshold — it is the opposite. A note may double the
 * row, and then the two spellings are at most half alike (see the test for 1.2):
 * no value of {@link SIMILARITY_MINOR} that still catches a rewritten clause can
 * call that `minor`. The commonest drift therefore must not be judged by a number
 * calibrated for the rare one.
 *
 * Containment is directional: text that disappeared is exactly what the ladder
 * should look at more closely, so a shrinking row falls through to the similarity
 * bands. It is checked anywhere in the new text, not only at its start, because a
 * note is as likely to be put before the task as after it. And it survives
 * re-wrapping, because normalisation folds whitespace and case (task 1.1) — but
 * not a reworded clause, which is the case similarity exists for (task 1.3).
 *
 * @param {string} previous - description as it was sent to the model.
 * @param {string} task - description as the fresh reading has it.
 * @returns {'minor'|null} `minor` when the old text is preserved; `null` when the
 *   rule does not apply, and the caller must fall through to similarity.
 * @throws {TypeError} when either value is not a description string.
 */
export function classifyByContainment(previous, task) {
  const before = normalizeDescription(previous)
  const after = normalizeDescription(task)

  // An empty old text is contained in every string, so an unguarded rule would
  // call a row that kept only its number `minor`. The plain refusal belongs to
  // the composite classifier (task 1.4); the rule simply declines here.
  if (before === '') return null

  return after.includes(before) ? 'minor' : null
}

/**
 * Reject a value that is not text, before it reaches the comparison.
 *
 * @param {unknown} value - candidate.
 * @param {string} caller - function name, for the message.
 * @returns {void}
 * @throws {TypeError} when the value is not a string.
 */
function requireText(value, caller) {
  if (typeof value !== 'string') {
    throw new TypeError(`${caller} requires a task description string`)
  }
}

/**
 * Split text into characters the way a reader counts them.
 *
 * `Array.from` iterates code points, so a surrogate pair — an emoji in a task —
 * is one character and not two. Indexing UTF-16 code units instead would count a
 * single such symbol as two edits, understating the similarity of two rows that
 * differ by one emoji.
 *
 * @param {string} text - any string.
 * @returns {string[]} its characters.
 */
function characters(text) {
  return Array.from(text)
}

/**
 * Edit distance between two strings, at character level (design D3).
 *
 * The classic two-row Levenshtein program: insertion, deletion and substitution
 * each cost one, so the result is the fewest single-character edits that turn one
 * text into the other. It is written out here rather than taken from a dependency
 * because task descriptions are tens to a hundred characters long — the quadratic
 * table is trivial — and because the comparison must stay a plain function
 * (`lib/diverged.js` is Cordis-free, like `lib/step.js`).
 *
 * The function is symmetric and does not normalise: it measures exactly the two
 * strings it is given. {@link similarityRatio} and {@link classifyBySimilarity}
 * are the entry points that compare descriptions.
 *
 * @param {string} left - first text.
 * @param {string} right - second text.
 * @returns {number} count of single-character edits turning `left` into `right`.
 * @throws {TypeError} when either value is not a string.
 */
export function levenshteinDistance(left, right) {
  requireText(left, 'levenshteinDistance')
  requireText(right, 'levenshteinDistance')

  const source = characters(left)
  const target = characters(right)

  // An empty side costs one edit per character of the other. This is also the
  // first row of the program below, so returning early only skips the loop.
  if (source.length === 0) return target.length
  if (target.length === 0) return source.length

  // `above` holds the row already computed; `current` is filled from it. Keeping
  // two rows instead of the whole table is what makes this cheap on long rows.
  let above = Array.from({ length: target.length + 1 }, (_, column) => column)

  for (let row = 1; row <= source.length; row += 1) {
    const current = [row]

    for (let column = 1; column <= target.length; column += 1) {
      const kept = source[row - 1] === target[column - 1] ? 0 : 1

      current[column] = Math.min(
        above[column] + 1, // the character was deleted from `source`
        current[column - 1] + 1, // it was inserted into `target`
        above[column - 1] + kept, // it was substituted, or it matched
      )
    }

    above = current
  }

  return above[target.length]
}

/**
 * Similarity of two texts as a fraction: `1 - distance / length of the longer`.
 *
 * Takes already-normalised texts. Two empty texts are identical rather than
 * undefined; the callers that must not classify an empty description guard
 * before asking (task 1.4), because division would otherwise be by zero.
 *
 * @param {string} before - normalised old text.
 * @param {string} after - normalised new text.
 * @returns {number} 1 for identical texts, less as they diverge, 0 at worst.
 */
function ratioOf(before, after) {
  const longer = Math.max(characters(before).length, characters(after).length)

  if (longer === 0) return 1

  return 1 - levenshteinDistance(before, after) / longer
}

/**
 * Measure how far one description is from another, between 0 and 1.
 *
 * The number is the character-level Levenshtein ratio of the two *normalised*
 * descriptions (tasks 1.1, 1.3): a typo in one character of a hundred-plus keeps
 * it near 0.99, a rewritten opening with a common tail lands in the sixties and
 * seventies, and unrelated text falls well below.
 *
 * @param {string} previous - description as it was sent to the model.
 * @param {string} task - description as the fresh reading has it.
 * @returns {number} similarity, 1 for the same wording and 0 for no overlap.
 * @throws {TypeError} when either value is not a description string.
 */
export function similarityRatio(previous, task) {
  return ratioOf(normalizeDescription(previous), normalizeDescription(task))
}

/**
 * Place a similarity ratio in its band (design D3).
 *
 * The edges are inclusive at the bottom: exactly 0.90 is still `minor`, exactly
 * 0.60 is already `gray`. Both are pinned by tests, so a silent retune fails.
 *
 * @param {number} ratio - similarity from {@link ratioOf}.
 * @returns {'minor'|'gray'|'major'} the band.
 */
function bandForRatio(ratio) {
  if (ratio >= SIMILARITY_MINOR) return 'minor'
  if (ratio >= SIMILARITY_GRAY) return 'gray'
  return 'major'
}

/**
 * Classify a divergence by how alike the two wordings are (design D3, rule 2).
 *
 * This is the second rung of the ladder: it runs when the old text did not
 * survive intact (task 1.2 declined), and it is what catches a fixed typo, a
 * rewritten clause and a row replaced by a different task. Three bands, two
 * thresholds: at or above {@link SIMILARITY_MINOR} the wording is the same task
 * with a correction, below {@link SIMILARITY_GRAY} the two texts share too little
 * to be one task, and in between the answer is not safe to guess — the model is
 * asked first and the user second (task 5.2).
 *
 * @param {string} previous - description as it was sent to the model.
 * @param {string} task - description as the fresh reading has it.
 * @returns {'minor'|'gray'|'major'|null} the band; `null` when a description is
 *   empty, which is unclassifiable and is refused by the composite (task 1.4).
 * @throws {TypeError} when either value is not a description string.
 */
export function classifyBySimilarity(previous, task) {
  const before = normalizeDescription(previous)
  const after = normalizeDescription(task)

  // A row that kept only its number, or one that was blanked, says nothing about
  // which task it is; the refusal is the composite classifier's (task 1.4).
  if (before === '' || after === '') return null

  return bandForRatio(ratioOf(before, after))
}

/**
 * What a comparison of two wordings concluded (task 1.4); callers switch on it.
 *
 * The three band values are the strings the rungs already return, gathered here
 * so the loop compares against a name instead of a literal. The fourth value is
 * the refusal: the pair must not be classified, and `reason` says which
 * precondition for a comparison is missing.
 */
export const DIVERGENCE = Object.freeze({
  /** The same task, wording preserved or corrected (design D4). */
  minor: 'minor',
  /** Too close to call: one adjudication turn, then the user (design D5). */
  gray: 'gray',
  /** Not the same task underneath: the user decides (design D6). */
  major: 'major',
  /** Unclassifiable; the report names the reason (task 6.1). */
  refused: 'refused',
})

/**
 * Why two wordings were refused instead of classified (task 1.4).
 *
 * Three different facts, so three values rather than one: the report turns each
 * into its own sentence, and the flat list of design D10 is stopped for a
 * different reason than a row whose number was rewritten.
 */
export const DIVERGENCE_REFUSAL = Object.freeze({
  /** One of the rows carries no `N.M`, so there is no second key (design D10). */
  numberMissing: 'number-missing',
  /** Both carry `N.M` and the numbers differ: the row belongs to another task. */
  numberChanged: 'number-changed',
  /** A row kept only its number, or was blanked: nothing is left to compare. */
  emptyText: 'empty-text',
})

/**
 * A conclusion about how far a rewritten row drifted from the one that was sent.
 *
 * @typedef {object} Divergence
 * @property {'minor'|'gray'|'major'|'refused'} kind - the band, or the refusal.
 * @property {'number-missing'|'number-changed'|'empty-text'} [reason] - present
 *   only when `kind` is `refused`.
 */

/**
 * Decide what a rewritten row is, in the order design D3 fixes — or refuse to.
 *
 * The classifier the run loop calls (tasks 5.1–5.3). The two rungs above are its
 * steps, not alternatives, and their order is the point: a note appended to a row
 * is `minor` by the substring rule even when it doubles the text and the
 * similarity of the two spellings falls to 0.43 (task 1.2), so the threshold must
 * never get to overrule the rule.
 *
 * Three pairs are refused rather than classified. The reason travels with the
 * refusal because the report names it (task 6.1):
 *
 *  - a row without `N.M` on either side: the number is the second identity key
 *    (design D1, D2), and without it a rewrite cannot be told from a replacement
 *    — the flat list of design D10;
 *  - numbers that differ: identity comes before content, and the guard has to run
 *    here, ahead of the rungs, because normalisation strips the prefix (task
 *    1.1). `11.4 Реализовать резолвер` and `11.5 Реализовать резолвер` normalise
 *    to the same text and similarity would call them identical, while the spec's
 *    «Правка затрагивает номер задачи» says a rewritten number is not a minor
 *    divergence at all;
 *  - an empty text on either side: a row reduced to its number, or blanked, says
 *    nothing about which task it is.
 *
 * The number is compared numerically, not by its label: `02.1` and `2.1` are one
 * position in the list written two ways, while `2.10` and `2.1` are two. Padding
 * is formatting, like the whitespace and case normalisation folds.
 *
 * @param {string} previous - description as it was sent to the model.
 * @param {string} task - description as the fresh reading has it.
 * @returns {Divergence} the band, or `refused` together with its reason.
 * @throws {TypeError} when either value is not a description string.
 */
export function classifyDivergence(previous, task) {
  requireText(previous, 'classifyDivergence')
  requireText(task, 'classifyDivergence')

  const before = extractTaskNumber(previous)
  const after = extractTaskNumber(task)

  // A flat row has no key to compare, and one row keeping its number while the
  // other lost it is the same impossibility from the other side.
  if (before === null || after === null) {
    return { kind: DIVERGENCE.refused, reason: DIVERGENCE_REFUSAL.numberMissing }
  }

  const sameNumber = namesSamePosition(before, after)

  if (!sameNumber) {
    return { kind: DIVERGENCE.refused, reason: DIVERGENCE_REFUSAL.numberChanged }
  }

  // Checked here rather than left to the rungs, because a refusal is not the same
  // answer as "this rung does not apply": the loop has to stop on the first and
  // fall through on the second.
  if (normalizeDescription(previous) === '' || normalizeDescription(task) === '') {
    return { kind: DIVERGENCE.refused, reason: DIVERGENCE_REFUSAL.emptyText }
  }

  const byRule = classifyByContainment(previous, task)
  if (byRule !== null) return { kind: byRule }

  // Neither rung can decline any more: both texts are typed and non-empty, which
  // is exactly the precondition the similarity rung guards for itself.
  return { kind: classifyBySimilarity(previous, task) }
}

/**
 * Text of the adjudication turn: both wordings and the rule that settles them.
 *
 * This is the one turn design D5 allows the uncertain band. The model is shown
 * the wording it was given and the wording the file now holds, because the
 * comparison it has to make is the one the plugin could not make safely; the rule
 * says what to do with either answer — perform the task and tick its checkbox if
 * it is the same one, leave the row alone if it is not. Naming the checkbox
 * rather than a reply is not shorthand: the verdict is read from `tasks.md`
 * afterwards, not from the model's answer, because `followup()` returns no text
 * (task 3.2, design D5).
 *
 * The pause belongs to the instruction for the same reason it does in the step
 * message (`lib/step.js`): the run, not the model, decides what follows a task,
 * so the turn must end when the task does — whichever branch the model took.
 * The address line pins the row for the same reason as well, so the checkbox the
 * model ticks is the one the loop re-reads.
 *
 * Both formulations go in verbatim, not normalised: the model is meant to see the
 * wording as it was sent and as it now stands, and the normalisation of
 * {@link normalizeDescription} exists for the plugin's own comparison only.
 *
 * @param {object} options
 * @param {string} options.change - change the task belongs to.
 * @param {string} options.previous - description as it was sent to the model.
 * @param {import('./tasks.js').ApplyTask} options.task - description as the fresh
 *   reading has it.
 * @param {string} [options.skillPath] - skill the instruction names; defaults to
 *   {@link APPLY_SKILL_PATH}.
 * @returns {string} the complete message text.
 * @throws {TypeError} when the change, the old wording or the task cannot be named.
 */
export function buildAdjudicationPrompt({ change, previous, task, skillPath = APPLY_SKILL_PATH }) {
  if (typeof change !== 'string' || change === '') {
    throw new TypeError('buildAdjudicationPrompt requires the change name')
  }
  // An empty old wording would leave the model comparing nothing; the classifier
  // refuses such a pair before the ladder reaches this turn (task 1.4), so a call
  // like that is a caller's bug rather than a question to ask.
  if (typeof previous !== 'string' || previous === '') {
    throw new TypeError('buildAdjudicationPrompt requires the previous description')
  }
  assertAdjudicationTask(task)

  return [
    `Используя навык ${skillPath}, проверь, та же ли это задача, что была отправлена, далее - пауза.`,
    `Было: ${previous}`,
    `Стало: ${task.description}`,
    'Если это та же задача — выполни её и отметь чекбокс; если другая — не трогай строку.',
    `Change: ${change}; файл: ${task.sourcePath}:${task.line}.`,
  ].join('\n')
}

/**
 * Refuse a task the adjudication turn could not point at.
 *
 * Same contract as the step message's guard (`lib/step.js`): without a
 * description there is nothing to compare, and without a file and a line the
 * model would not know which checkbox to tick or leave alone. The parser already
 * requires all three, so this catches direct callers instead of trusting them.
 *
 * @param {unknown} task - task the fresh reading reported.
 * @throws {TypeError} when the task lacks a description, a source path or a line.
 */
function assertAdjudicationTask(task) {
  if (typeof task !== 'object' || task === null) {
    throw new TypeError('buildAdjudicationPrompt requires a task object')
  }
  if (typeof task.description !== 'string' || task.description === '') {
    throw new TypeError('buildAdjudicationPrompt requires the task description')
  }
  if (typeof task.sourcePath !== 'string' || task.sourcePath === '') {
    throw new TypeError('buildAdjudicationPrompt requires the task sourcePath')
  }
  if (!Number.isSafeInteger(task.line) || task.line < 1) {
    throw new TypeError('buildAdjudicationPrompt requires the task line')
  }
}

/**
 * Values of {@link AdjudicationOutcome.kind}; the loop switches on them (task 5.2).
 *
 * Three answers, because the two ways a turn can end without a ticked row lead to
 * different places: a run that was stopped ends there, while a row the model left
 * alone hands the question to the user (design D5, D6). Collapsing them would make
 * `/taskloop stop` look like a model that disagreed.
 */
export const ADJUDICATION_END = Object.freeze({
  /** The row is ticked: the model took it as the same task and performed it. */
  ticked: 'ticked',
  /** The row is still unticked: the same task is unproven, so the user decides. */
  untouched: 'untouched',
  /** The run was stopped before or during the turn; nothing may follow it. */
  cancelled: 'cancelled',
})

/**
 * How one adjudication turn ended.
 *
 * @typedef {object} AdjudicationOutcome
 * @property {'ticked'|'untouched'|'cancelled'} kind - what the row's checkbox says,
 *   or that the run was stopped before the verdict could be read.
 */

/**
 * Run the one turn design D5 allows an uncertain divergence, and read its verdict.
 *
 * The order is the contract, and it is the review's order (`lib/review.js`): the
 * message is built before anything leaves, so a caller that cannot name the change,
 * the old wording or the row puts no question into the session; a stop that arrived
 * before the turn sends nothing; exactly one message goes out; and the wait is the
 * stop-aware one from `lib/wait.js`, so `/taskloop stop` ends it as `cancelled`
 * instead of waiting for a turn nobody asked to finish.
 *
 * The verdict is read from the file, not from the model's answer (design D5):
 * `followup()` returns no text and the plugin does not read the transcript, so the
 * checkbox is the only channel there is — and it is the one the message names
 * (`buildAdjudicationPrompt`). Two safe answers follow from it: a ticked row means
 * the run continues with the task as performed, an unticked one means the task is
 * unproven and the user is asked (task 5.2). A model that could not do the task and
 * a model that judged it another task look the same here, and both are safe.
 *
 * @param {object} options
 * @param {object} options.agent - recipient that received the task and drives the
 *   turn; must expose `followup()` and `whenIdle()`.
 * @param {string} options.change - change the task belongs to.
 * @param {string} options.previous - description as it was sent to the model.
 * @param {import('./tasks.js').ApplyTask} options.task - description as the fresh
 *   reading has it, i.e. the row the turn is asked about.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<AdjudicationOutcome>} the verdict, or that the run was stopped.
 * @throws {TypeError} when the agent cannot drive a turn, or the question cannot be
 *   built.
 * @throws {Error} when the turn fails to start — a stop is not such a failure.
 */
export async function runAdjudication({ agent, change, previous, task, signal }) {
  if (typeof agent?.followup !== 'function' || typeof agent?.whenIdle !== 'function') {
    throw new TypeError('runAdjudication requires an agent that accepts followup() and reports whenIdle()')
  }
  const message = createUserTextMessage(buildAdjudicationPrompt({ change, previous, task }))

  // Every await below can outlive the run: a stop that arrived before the turn began
  // must send nothing, and one that arrives later must not wait for the turn to end.
  if (aborted(signal)) return { kind: ADJUDICATION_END.cancelled }

  agent.followup(message)
  try {
    if (await waitForIdle(agent, signal) === 'cancelled') return { kind: ADJUDICATION_END.cancelled }
  } catch (error) {
    // A turn the stop cut short rejects with the abort; that is the stop the caller
    // asked for, not a turn that failed to start.
    if (aborted(signal)) return { kind: ADJUDICATION_END.cancelled }
    throw error
  }

  return { kind: await verdictOf(task) }
}

/**
 * The row a tracking file writes a task on: a list item, then the checkbox.
 *
 * Anchored at the bullet rather than at the text, so a checkbox quoted inside a
 * task's own wording — a task about checkboxes, say — is not taken for a row.
 */
const CHECKBOX_ROW = /^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/u

/**
 * The checkbox rows of a tracking file, in file order.
 *
 * Only the shape `openspec` itself writes is read. The plugin is looking for one bit
 * — whether the row it asked about is ticked — and `openspec instructions apply`
 * stays the authority on what a task is; parsing no more than the checkbox is what
 * keeps that authority in one place.
 *
 * @param {string} path - tracking file the sent row lives in.
 * @returns {Promise<{line: number, done: boolean, description: string}[]|undefined>} the
 *   rows, or `undefined` when the file cannot be read.
 */
async function readCheckboxRows(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // Gone, unreadable, or a directory: the caller treats that as "no proof", not
    // as an error, because an unobserved checkbox must never continue a run.
    return undefined
  }

  const rows = []
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const match = CHECKBOX_ROW.exec(lines[index])
    if (match === null) continue
    rows.push({ line: index + 1, done: match[1] !== ' ', description: match[2].trim() })
  }
  return rows
}

/**
 * Read the verdict of an adjudication turn from the row's checkbox (design D5).
 *
 * The row is found by its number — the second identity key (design D1, D2) — and
 * not by the line the message named, because the model may have inserted a line
 * above the row while it worked; among several rows carrying the number the nearest
 * one wins, exactly as in the search that led here. A task without a number has only
 * its address, so there the named line is where the answer has to appear.
 *
 * A file that cannot be read answers `untouched`: an unobserved checkbox proves
 * nothing, and the branch that continues is the one that must not be taken without
 * proof.
 *
 * @param {import('./tasks.js').ApplyTask} task - the row the turn was asked about.
 * @returns {Promise<'ticked'|'untouched'>} what the checkbox says.
 * @throws {TypeError} when the task has no description to read a number from.
 */
async function verdictOf(task) {
  const rows = await readCheckboxRows(task.sourcePath)
  if (rows === undefined) return ADJUDICATION_END.untouched

  const number = extractTaskNumber(task.description)
  /** @type {{line: number, done: boolean, description: string}|undefined} */
  let nearest
  let nearestDistance = Infinity

  for (const row of rows) {
    if (number === null) {
      if (row.line !== task.line) continue
    } else {
      const rowNumber = extractTaskNumber(row.description)
      if (rowNumber === null || !namesSamePosition(rowNumber, number)) continue
    }

    const distance = Math.abs(row.line - task.line)
    if (distance < nearestDistance || (distance === nearestDistance && row.line < nearest.line)) {
      nearest = row
      nearestDistance = distance
    }
  }

  return nearest?.done === true ? ADJUDICATION_END.ticked : ADJUDICATION_END.untouched
}

/**
 * Whether two numbers read off descriptions name the same position.
 *
 * Numeric, not textual — `02.1` and `2.1` are one task, `2.10` and `2.1` are two —
 * the same rule the search by number applies (`lib/tasks.js`).
 *
 * @param {import('./groups.js').TaskNumber} left - one number.
 * @param {import('./groups.js').TaskNumber} right - the other.
 * @returns {boolean} whether both name the same position in the list.
 */
function namesSamePosition(left, right) {
  return Number(left.major) === Number(right.major) && Number(left.minor) === Number(right.minor)
}
