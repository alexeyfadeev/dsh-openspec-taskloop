// Tests for divergence classification (tasks 1.1–1.4): the normalisation every
// later comparison is built on, the containment rule that decides the incident,
// the edit distance whose similarity places a drift in one of three bands, and
// the classifier that orders those steps and refuses the pairs it cannot judge.
//
// The 11.4 row is the one from docs/taskloop-missing-stop-2026-11-03.md. That
// report keeps the shape of the row rather than its exact words — the incident
// happened in another repository — so the two spellings below are a
// reconstruction of the facts it records: the model ticked 11.4, appended a note
// and fixed the typo `расрешiver` → `резолвер` inside it. Normalisation does not
// read the words, so any spelling of that shape exercises the same code, and the
// reconstruction keeps the test readable next to the report.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DIVERGENCE,
  DIVERGENCE_REFUSAL,
  SIMILARITY_GRAY,
  SIMILARITY_MINOR,
  classifyByContainment,
  classifyBySimilarity,
  classifyDivergence,
  levenshteinDistance,
  normalizeDescription,
  similarityRatio,
} from '../lib/diverged.js'

/** Row 11.4 as the model was given it, before the turn edited the text. */
const INCIDENT_ROW_SENT = '11.4 Реализовать резолвер корректировки доставки и отправку события в шину; '
  + 'проверить тестом повторную отправку при ретрае'

/** Row 11.4 after the model ticked it, appended a note and fixed the typo in it. */
const INCIDENT_ROW_AFTER = '11.4 Реализовать резолвер корректировки доставки и отправку события в шину; '
  + 'проверить тестом повторную отправку при ретрае (примечание: резолвер вынесен в отдельный модуль)'

const INCIDENT_BODY = 'реализовать резолвер корректировки доставки и отправку события в шину; '
  + 'проверить тестом повторную отправку при ретрае'

/** A note long enough to double the row, for the rule-versus-threshold case. */
const INCIDENT_NOTE_DOUBLE = ' (примечание: резолвер вынесен в отдельный модуль lib/delivery-correction.js, '
  + 'отправка события вынесена в шину, повторный ретрай покрыт отдельным тестом)'

/** Row 11.4 under the same number with the doubling note appended. */
const INCIDENT_ROW_DOUBLED = INCIDENT_ROW_SENT + INCIDENT_NOTE_DOUBLE

/** Row 11.4 with one letter fixed inside the wording: the spec's typo case. */
const INCIDENT_ROW_TYPO = INCIDENT_ROW_SENT.replace('корректировки', 'коректировки')

/** Row 11.4 with its opening rewritten and its tail kept: the uncertain band. */
const INCIDENT_ROW_REWRITTEN = '11.4 Переписать резолвер корректировки доставки на очередь и публикацию события; '
  + 'проверить тестом повторную отправку при ретрае'

/** Row 11.4 replaced by an unrelated task under the same number: the major band. */
const INCIDENT_ROW_REPLACEMENT = '11.4 Обновить README и раздел про настройки'


test('the incident row 11.4 loses its number and keeps its wording', () => {
  assert.equal(normalizeDescription(INCIDENT_ROW_SENT), INCIDENT_BODY)
})

test('the model-edited row 11.4 keeps the sent text as a prefix of its new form', () => {
  const before = normalizeDescription(INCIDENT_ROW_SENT)
  const after = normalizeDescription(INCIDENT_ROW_AFTER)

  // This is the property the substring rule of task 1.2 reads; the appended note
  // must survive normalisation so it can be recognised as an addition.
  assert.ok(after.startsWith(before), `expected ${JSON.stringify(after)} to start with ${JSON.stringify(before)}`)
  assert.ok(after.length > before.length)
})

test('only the prefix number is removed, not a number quoted in the text', () => {
  assert.equal(normalizeDescription('11.4 Сверить с 11.5'), 'сверить с 11.5')
  assert.equal(normalizeDescription('11.4'), '')
})

test('whitespace collapses and the ends are trimmed', () => {
  assert.equal(normalizeDescription('11.4\tРеализовать\n   резолвер  '), 'реализовать резолвер')
  assert.equal(normalizeDescription('11.4\u00a0Реализовать\u00a0резолвер'), 'реализовать резолвер')
})

test('case folds to lower, Cyrillic included', () => {
  assert.equal(normalizeDescription('11.4 РЕАЛИЗОВАТЬ Резолвер'), 'реализовать резолвер')
})

test('a flat description keeps all its text, with no prefix to strip', () => {
  assert.equal(normalizeDescription('Обновить README'), 'обновить readme')
})

test('normalisation is idempotent', () => {
  const once = normalizeDescription(INCIDENT_ROW_AFTER)
  assert.equal(normalizeDescription(once), once)
})

test('a non-string description is refused instead of compared as text', () => {
  for (const value of [42, null, undefined, {}, ['11.4']]) {
    assert.throws(() => normalizeDescription(value), TypeError)
  }
})

test('a note appended to the row keeps its wording, so the row is minor', () => {
  // The incident itself: the model ticked 11.4 and appended a note.
  assert.equal(classifyByContainment(INCIDENT_ROW_SENT, INCIDENT_ROW_AFTER), 'minor')
})

test('a note that doubles the row is minor by the rule, not by a threshold', () => {
  const before = normalizeDescription(INCIDENT_ROW_SENT)
  const after = normalizeDescription(INCIDENT_ROW_DOUBLED)

  // Precondition: the addition really doubles the row.
  assert.ok(after.length >= 2 * before.length, `expected ${after.length} to be at least twice ${before.length}`)

  // The old text is a prefix of the new one here, so the Levenshtein distance is
  // exactly the difference in length, and similarity is 1 - (new - old) / new,
  // at most 0.5 — under the gray floor. No threshold that still catches a
  // rewritten clause could reach `minor` for this row; only the rule can.
  assert.ok(1 - (after.length - before.length) / after.length < SIMILARITY_GRAY)

  assert.equal(classifyByContainment(INCIDENT_ROW_SENT, INCIDENT_ROW_DOUBLED), 'minor')
})

test('a note put before the task also leaves the row minor', () => {
  assert.equal(
    classifyByContainment('11.4 Реализовать резолвер', '11.4 (сверено с 11.5) Реализовать резолвер'),
    'minor',
  )
})

test('re-wrapping and re-capitalising a row change no wording and stay minor', () => {
  assert.equal(classifyByContainment('11.4 Реализовать резолвер', '11.4  реализовать\n\tРЕЗОЛВЕР'), 'minor')
})

test('a word inserted inside the wording is left to the similarity bands', () => {
  // Containment is not fuzzy: the rewrite that similarity exists for must reach
  // it, otherwise 1.3 could never see this pair.
  assert.equal(
    classifyByContainment('11.4 Реализовать резолвер доставки', '11.4 Реализовать новый резолвер доставки'),
    null,
  )
})

test('containment is directional: a row that lost text is not minor by this rule', () => {
  // The row shrank, so something was removed — that is the case the ladder is
  // meant to look at more closely, not to wave through.
  assert.equal(classifyByContainment(INCIDENT_ROW_AFTER, INCIDENT_ROW_SENT), null)
})

test('a row that kept only its number is not minor by this rule', () => {
  // The empty string is contained in everything; an unguarded rule would call
  // this minor.
  assert.equal(classifyByContainment('11.4 ', '11.4 Заменить резолвер на очередь'), null)
})

test('the containment rule is refused on a non-string description', () => {
  for (const value of [42, null, undefined, {}, ['11.4']]) {
    assert.throws(() => classifyByContainment('11.4 Реализовать резолвер', value), TypeError)
  }
})

test('the edit distance counts one changed character as one edit', () => {
  // Substitution, insertion and deletion each cost one; the same text costs none.
  assert.equal(levenshteinDistance('резолвер', 'резолвир'), 1)
  assert.equal(levenshteinDistance('резолвер', 'резолвера'), 1)
  assert.equal(levenshteinDistance('резолвер', 'резолве'), 1)
  assert.equal(levenshteinDistance(INCIDENT_BODY, INCIDENT_BODY), 0)
  assert.equal(levenshteinDistance('', ''), 0)
})

test('the edit distance is symmetric and bounded by the longer text', () => {
  const left = 'проверить тестом повторную отправку'
  const right = 'проверить тестом отправку при ретрае'

  assert.equal(levenshteinDistance(left, right), levenshteinDistance(right, left))
  assert.equal(levenshteinDistance(left, ''), left.length)
  assert.ok(levenshteinDistance(left, right) <= Math.max(left.length, right.length))
})

test('the edit distance counts a symbol outside the BMP as one character', () => {
  // A surrogate pair is one character to a reader. Counting code units would
  // charge two edits for a single emoji and understate the similarity.
  assert.equal(levenshteinDistance('👍', ''), 1)
  assert.equal(levenshteinDistance('задача 👍', 'задача 👎'), 1)
})

test('the edit distance is refused on a non-string', () => {
  for (const value of [42, null, undefined, {}, ['11.4']]) {
    assert.throws(() => levenshteinDistance(value, 'текст'), TypeError)
    assert.throws(() => levenshteinDistance('текст', value), TypeError)
  }
})

test('the same wording scores 1 and the ratio stays within 0 and 1', () => {
  // Normalisation runs first, so re-wrapping and re-capitalising change nothing.
  assert.equal(similarityRatio(INCIDENT_ROW_SENT, `${INCIDENT_ROW_SENT.toUpperCase()}\n`), 1)
  assert.equal(similarityRatio(INCIDENT_BODY, INCIDENT_BODY), 1)
  assert.equal(similarityRatio('', ''), 1)

  for (const task of [INCIDENT_ROW_SENT, INCIDENT_ROW_AFTER, INCIDENT_ROW_DOUBLED, '11.4 Обновить README']) {
    const ratio = similarityRatio(INCIDENT_ROW_SENT, task)
    assert.ok(ratio >= 0 && ratio <= 1, `expected ${ratio} within 0..1`)
    assert.equal(ratio, similarityRatio(task, INCIDENT_ROW_SENT))
  }
})

test('a fixed typo is minor although the substring rule declines', () => {
  // The spec's «Переписана опечатка» scenario: `корректировки` lost its `р`.

  // Containment cannot see this — one character changed inside the old text.
  assert.equal(classifyByContainment(INCIDENT_ROW_SENT, INCIDENT_ROW_TYPO), null)

  const ratio = similarityRatio(INCIDENT_ROW_SENT, INCIDENT_ROW_TYPO)
  assert.ok(ratio >= SIMILARITY_MINOR, `expected ${ratio} at or above ${SIMILARITY_MINOR}`)
  assert.equal(classifyBySimilarity(INCIDENT_ROW_SENT, INCIDENT_ROW_TYPO), 'minor')
})

test('a rewritten opening with a common tail is gray, not minor', () => {
  const ratio = similarityRatio(INCIDENT_ROW_SENT, INCIDENT_ROW_REWRITTEN)
  assert.ok(ratio >= SIMILARITY_GRAY && ratio < SIMILARITY_MINOR, `expected ${ratio} inside the gray band`)
  assert.equal(classifyBySimilarity(INCIDENT_ROW_SENT, INCIDENT_ROW_REWRITTEN), 'gray')
})

test('unrelated text under the same number is major', () => {
  assert.ok(similarityRatio(INCIDENT_ROW_SENT, INCIDENT_ROW_REPLACEMENT) < SIMILARITY_GRAY)
  assert.equal(classifyBySimilarity(INCIDENT_ROW_SENT, INCIDENT_ROW_REPLACEMENT), 'major')
})

test('the doubled row is major by similarity, so only the rule can call it same', () => {
  // This is the tie between 1.2 and 1.3: the incident's own drift, measured.
  assert.ok(similarityRatio(INCIDENT_ROW_SENT, INCIDENT_ROW_DOUBLED) < SIMILARITY_GRAY)
  assert.equal(classifyBySimilarity(INCIDENT_ROW_SENT, INCIDENT_ROW_DOUBLED), 'major')

  // The ladder is ordered, so the rule has already answered this pair; the band
  // is what an unguarded threshold would have said instead.
  assert.equal(classifyByContainment(INCIDENT_ROW_SENT, INCIDENT_ROW_DOUBLED), 'minor')
})

test('the band edges are inclusive at the bottom and exclusive at the top', () => {
  // Ten-character texts make the ratios exact: one edit is 0.9, four are 0.6,
  // five are 0.5. The band names below are design D3's, not roundings of it.
  assert.equal(similarityRatio('abcdefghij', 'abcdefghix'), 0.9)
  assert.equal(classifyBySimilarity('abcdefghij', 'abcdefghix'), 'minor')

  assert.equal(similarityRatio('abcdefghij', 'abcdxxxxij'), 0.6)
  assert.equal(classifyBySimilarity('abcdefghij', 'abcdxxxxij'), 'gray')

  assert.equal(similarityRatio('abcdefghij', 'abcdxxxxxj'), 0.5)
  assert.equal(classifyBySimilarity('abcdefghij', 'abcdxxxxxj'), 'major')
})

test('a row that kept only its number is left to the composite classifier', () => {
  // Similarity of nothing to something is the refusal case of task 1.4, not a band.
  assert.equal(classifyBySimilarity('11.4 ', '11.4 Заменить резолвер на очередь'), null)
  assert.equal(classifyBySimilarity('11.4 Заменить резолвер на очередь', '11.4 '), null)
})

test('classification by similarity is refused on a non-string description', () => {
  for (const value of [42, null, undefined, {}, ['11.4']]) {
    assert.throws(() => classifyBySimilarity('11.4 Реализовать резолвер', value), TypeError)
    assert.throws(() => similarityRatio('11.4 Реализовать резолвер', value), TypeError)
  }
})

test('the classifier answers with the band the ladder reaches, for every degree', () => {
  const cases = [
    [INCIDENT_ROW_SENT, INCIDENT_ROW_AFTER, DIVERGENCE.minor, 'a note appended'],
    [INCIDENT_ROW_SENT, INCIDENT_ROW_SENT, DIVERGENCE.minor, 'the same row again'],
    [INCIDENT_ROW_SENT, INCIDENT_ROW_TYPO, DIVERGENCE.minor, 'a fixed typo'],
    [INCIDENT_ROW_SENT, INCIDENT_ROW_REWRITTEN, DIVERGENCE.gray, 'a rewritten opening'],
    [INCIDENT_ROW_SENT, INCIDENT_ROW_REPLACEMENT, DIVERGENCE.major, 'another task'],
    [INCIDENT_ROW_SENT, INCIDENT_ROW_DOUBLED, DIVERGENCE.minor, 'a note that doubles the row'],
  ]

  for (const [previous, task, band, what] of cases) {
    assert.deepEqual(classifyDivergence(previous, task), { kind: band }, what)
  }
})

test('a row whose number changed is refused, not measured', () => {
  // The number is the identity key (design D1, D2), and the guard has to run
  // before the rungs: normalisation strips the prefix, so both spellings below
  // look identical to a comparison of texts alone.
  const renumbered = INCIDENT_ROW_SENT.replace('11.4', '11.5')

  assert.equal(similarityRatio(INCIDENT_ROW_SENT, renumbered), 1)
  assert.equal(classifyBySimilarity(INCIDENT_ROW_SENT, renumbered), 'minor')
  assert.equal(classifyByContainment(INCIDENT_ROW_SENT, renumbered), 'minor')

  // The spec's «Правка затрагивает номер задачи»: a rewritten number is not a
  // minor divergence, whatever the text underneath still says.
  assert.deepEqual(classifyDivergence(INCIDENT_ROW_SENT, renumbered), {
    kind: DIVERGENCE.refused,
    reason: DIVERGENCE_REFUSAL.numberChanged,
  })
})

test('a differently padded number is the same position in the list', () => {
  // `02.1` and `2.1` name one place; how the digits are padded is formatting, like
  // the whitespace and case normalisation folds.
  assert.deepEqual(
    classifyDivergence('2.01 Обновить README', '2.1 Обновить README и настройки'),
    { kind: DIVERGENCE.minor },
  )

  // `2.10` is its own position, not another spelling of `2.1`.
  assert.deepEqual(classifyDivergence('2.1 Обновить README', '2.10 Обновить README'), {
    kind: DIVERGENCE.refused,
    reason: DIVERGENCE_REFUSAL.numberChanged,
  })
})

test('a row without a number offers no key to compare, so it is refused', () => {
  // Design D10 and the spec's «Задача без номера»: the second key is missing, so
  // even a textually obvious addition is not classified — the run stops instead.
  const refused = { kind: DIVERGENCE.refused, reason: DIVERGENCE_REFUSAL.numberMissing }

  assert.deepEqual(classifyDivergence('Обновить README', 'Обновить README и настройки'), refused)
  assert.deepEqual(classifyDivergence(INCIDENT_ROW_SENT, 'Обновить README'), refused)
  assert.deepEqual(classifyDivergence('Обновить README', INCIDENT_ROW_SENT), refused)
})

test('a row that kept only its number is refused as empty', () => {
  const refused = { kind: DIVERGENCE.refused, reason: DIVERGENCE_REFUSAL.emptyText }

  assert.deepEqual(classifyDivergence('11.4 ', '11.4 Заменить резолвер на очередь'), refused)
  assert.deepEqual(classifyDivergence('11.4 Заменить резолвер на очередь', '11.4 '), refused)
  assert.deepEqual(classifyDivergence('11.4', '11.4'), refused)
})

test('the classifier is refused on a non-string description', () => {
  for (const value of [42, null, undefined, {}, ['11.4']]) {
    assert.throws(() => classifyDivergence('11.4 Реализовать резолвер', value), TypeError)
    assert.throws(() => classifyDivergence(value, '11.4 Реализовать резолвер'), TypeError)
  }
})

test('the band tags are the strings the rungs already return', () => {
  // The classifier gathers the three bands under one name; a rename here would
  // silently break the loop's switch (tasks 5.1–5.3).
  assert.equal(DIVERGENCE.minor, classifyByContainment(INCIDENT_ROW_SENT, INCIDENT_ROW_AFTER))
  assert.equal(DIVERGENCE.gray, classifyBySimilarity(INCIDENT_ROW_SENT, INCIDENT_ROW_REWRITTEN))
  assert.equal(DIVERGENCE.major, classifyBySimilarity(INCIDENT_ROW_SENT, INCIDENT_ROW_REPLACEMENT))
  assert.equal(DIVERGENCE.refused, 'refused')
})

test('the bands are pinned to the thresholds the design fixes', () => {
  // Design D3 / tasks 1.2–1.3: the numbers are part of the behaviour, so they are
  // asserted rather than only referenced — a silent retune must fail a test.
  assert.equal(SIMILARITY_MINOR, 0.90)
  assert.equal(SIMILARITY_GRAY, 0.60)
  assert.ok(SIMILARITY_GRAY < SIMILARITY_MINOR)
})
