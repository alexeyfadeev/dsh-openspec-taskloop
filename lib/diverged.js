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
// all (task 1.4). The adjudication turn and the question to the user are the
// tasks after it (3.1–3.2, 4.1).
//
// It is Cordis-free on purpose, like `lib/step.js` and `lib/review.js`: anything
// that needs a host — a turn, a question — is passed in by the run loop, so every
// comparison here stays a plain function of its arguments and keeps no state.
//
// The thresholds are exported constants rather than settings (design D9): a
// threshold is a property of the algorithm, not of the environment, and it cannot
// be configured meaningfully without a corpus of real reformulations. The page of
// settings in the spec therefore stays at eleven values.

import { extractTaskNumber } from './groups.js'

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

  const sameNumber = Number(before.major) === Number(after.major)
    && Number(before.minor) === Number(after.minor)

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
