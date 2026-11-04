// Tests for divergence classification (tasks 1.1–1.4), the adjudication prompt
// (task 3.1) and the adjudication turn itself (task 3.2), the question a
// significant divergence asks the user (task 4.1) and the seam that asks it and
// reads the answer (task 4.2): the normalisation every later comparison is built
// on, the containment rule that decides the incident, the edit distance whose
// similarity places a drift in one of three bands, the classifier that orders those
// steps and refuses the pairs it cannot judge, the one turn a gray divergence is
// worth, the verdict that turn is read through, the card that puts a major
// divergence to the person, and the three answers that card can settle with.
//
// The 11.4 row is the one from docs/taskloop-missing-stop-2026-11-03.md. That
// report keeps the shape of the row rather than its exact words — the incident
// happened in another repository — so the two spellings below are a
// reconstruction of the facts it records: the model ticked 11.4, appended a note
// and fixed the typo `расрешiver` → `резолвер` inside it. Normalisation does not
// read the words, so any spelling of that shape exercises the same code, and the
// reconstruction keeps the test readable next to the report.
//
// The turn of task 3.2 is driven by fakes: an agent whose `followup()` edits a
// tracking file of the test's own, because the verdict is read from the checkbox
// and no test may tick a row of this repository's list.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ADJUDICATION_END,
  DIVERGENCE,
  DIVERGENCE_ANSWER,
  DIVERGENCE_LABEL,
  DIVERGENCE_QUESTION_ID,
  DIVERGENCE_REFUSAL,
  SIMILARITY_GRAY,
  SIMILARITY_MINOR,
  buildAdjudicationPrompt,
  buildDivergenceQuestion,
  classifyByContainment,
  classifyBySimilarity,
  classifyDivergence,
  levenshteinDistance,
  normalizeDescription,
  requestContinuation,
  runAdjudication,
  similarityRatio,
} from '../lib/diverged.js'
import { APPLY_SKILL_PATH } from '../lib/step.js'

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

const CHANGE = 'add-task-divergence-recovery'

/** Tracking file the sent row came from, as `openspec instructions apply` reports it. */
const SOURCE = 'C:\\work\\_dsh\\dsh-openspec-taskloop\\openspec\\changes\\add-task-divergence-recovery\\tasks.md'

/** The row a gray divergence would hand to one adjudication turn (tasks 3.1–3.2). */
const ADJUDICATION_TASK = {
  id: '7',
  description: INCIDENT_ROW_AFTER,
  done: false,
  sourcePath: SOURCE,
  line: 61,
}

/** The row a major divergence replaces the sent one with (design D6, task 4.2). */
const MAJOR_TASK = { ...ADJUDICATION_TASK, description: INCIDENT_ROW_REPLACEMENT }


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

test('the adjudication prompt names both wordings, the rule and the pause', () => {
  // Design D5 / task 3.1: the wording is a behavioural contract, so it is pinned
  // whole. The model has to see what it was given, what the row now says, what to
  // do in either case, and that the turn ends there.
  assert.equal(
    buildAdjudicationPrompt({ change: CHANGE, previous: INCIDENT_ROW_SENT, task: ADJUDICATION_TASK }),
    [
      `Используя навык ${APPLY_SKILL_PATH}, проверь, та же ли это задача, что была отправлена, далее - пауза.`,
      `Было: ${INCIDENT_ROW_SENT}`,
      `Стало: ${INCIDENT_ROW_AFTER}`,
      'Если это та же задача — выполни её и отметь чекбокс; если другая — не трогай строку.',
      `Change: ${CHANGE}; файл: ${SOURCE}:61.`,
    ].join('\n'),
  )
})

test('both formulations reach the model verbatim, not normalised', () => {
  // The normalisation of task 1.1 exists for the plugin's own comparison; showing
  // the model a folded text instead of the row would leave it comparing nothing it
  // recognises. The pause is part of the instruction, so it must be present even
  // though the run is what continues afterwards.
  const text = buildAdjudicationPrompt({ change: CHANGE, previous: INCIDENT_ROW_SENT, task: ADJUDICATION_TASK })

  assert.ok(text.includes(`Было: ${INCIDENT_ROW_SENT}`))
  assert.ok(text.includes(`Стало: ${INCIDENT_ROW_AFTER}`))
  assert.ok(text.includes('далее - пауза'), 'the turn must end where the task ends')
})

test('the skill path is a parameter, so a caller can point the turn elsewhere', () => {
  const text = buildAdjudicationPrompt({
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: ADJUDICATION_TASK,
    skillPath: '.dsh/skills/other',
  })

  assert.ok(text.includes('Используя навык .dsh/skills/other,'))
  assert.ok(!text.includes(APPLY_SKILL_PATH))
})

test('an adjudication prompt without a change, an old wording or an address is refused', () => {
  // A half-addressed turn would ask the model to compare nothing or tick a row it
  // cannot find, which is worse than not asking at all.
  const previous = INCIDENT_ROW_SENT

  assert.throws(() => buildAdjudicationPrompt({ change: '', previous, task: ADJUDICATION_TASK }), /change name/)
  assert.throws(() => buildAdjudicationPrompt({ change: CHANGE, previous: '', task: ADJUDICATION_TASK }), /previous/)
  assert.throws(() => buildAdjudicationPrompt({ change: CHANGE, previous: 42, task: ADJUDICATION_TASK }), /previous/)
  assert.throws(() => buildAdjudicationPrompt({ change: CHANGE, previous, task: null }), /task object/)

  for (const task of [
    { ...ADJUDICATION_TASK, description: '' },
    { ...ADJUDICATION_TASK, sourcePath: '' },
    { ...ADJUDICATION_TASK, line: 0 },
  ]) {
    assert.throws(() => buildAdjudicationPrompt({ change: CHANGE, previous, task }), TypeError)
  }
})

/** The fake tracking file around row 11.4, as the adjudication turn found it. */
const ROWS_BEFORE = [
  '# Tasks',
  '',
  '## 11. Гарантия отправки события корректировки',
  `- [ ] ${INCIDENT_ROW_SENT}`,
  '- [ ] 11.5 Прогнать полный набор тестов',
]

/** The same file after the turn did the task and ticked its row. */
const ROWS_AFTER = [
  '# Tasks',
  '',
  '## 11. Гарантия отправки события корректировки',
  `- [x] ${INCIDENT_ROW_AFTER}`,
  '- [ ] 11.5 Прогнать полный набор тестов',
]

/**
 * A tracking file of the test's own, holding these rows.
 *
 * A fake file rather than this repository's `tasks.md`: the verdict is read from the
 * checkbox, so the row the turn is asked about is the row a test would have to tick,
 * and no test may tick a real one.
 *
 * @param {object} t - test context, which owns the cleanup.
 * @param {string[]} rows - lines of the fake tracking file.
 * @returns {Promise<string>} absolute path of the file.
 */
async function trackingFile(t, rows) {
  const directory = await mkdtemp(join(tmpdir(), 'openspec-taskloop-diverged-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'tasks.md')
  await writeFile(path, `${rows.join('\n')}\n`, 'utf8')
  return path
}

/**
 * Row 11.4 of a fake tracking file, as the fresh reading would report it.
 *
 * @param {string} sourcePath - the fake file the row lives in.
 * @param {number} [line] - the line the row was on in that reading.
 * @returns {import('../lib/tasks.js').ApplyTask} the task a gray divergence hands to
 *   the adjudication turn.
 */
function grayTask(sourcePath, line = 4) {
  return { ...ADJUDICATION_TASK, sourcePath, line }
}

/**
 * Let every already-resolved promise run before the test looks at the fakes.
 *
 * @returns {Promise<void>} resolves after the next macrotask.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a turn that ticks the row reports the task as taken', async (t) => {
  const path = await trackingFile(t, ROWS_BEFORE)
  const task = grayTask(path)
  const sent = []
  const agent = {
    followup(message) {
      sent.push(message)
      // What the message asks for: perform the task, then tick its row. The note and
      // the fixed typo are the model's; the checkbox is the verdict.
      writeFileSync(path, `${ROWS_AFTER.join('\n')}\n`, 'utf8')
    },
    async whenIdle() {},
  }

  const outcome = await runAdjudication({ agent, change: CHANGE, previous: INCIDENT_ROW_SENT, task })

  assert.deepEqual(outcome, { kind: ADJUDICATION_END.ticked })
  // Exactly one turn (design D5), and it is the plain user message of task 3.1: the
  // session log is where the user reads what the model was asked.
  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'user')
  assert.equal(sent[0].source.kind, 'user')
  assert.equal(
    sent[0].content[0].text,
    buildAdjudicationPrompt({ change: CHANGE, previous: INCIDENT_ROW_SENT, task }),
  )
})

test('a turn that leaves the row alone reports the task as unproven', async (t) => {
  const path = await trackingFile(t, ROWS_BEFORE)
  const sent = []
  const agent = {
    followup(message) {
      sent.push(message)
    },
    async whenIdle() {},
  }

  const outcome = await runAdjudication({ agent, change: CHANGE, previous: INCIDENT_ROW_SENT, task: grayTask(path) })

  // Design D5: the model's answer is never read, so "could not do it" and "it is
  // another task" are one verdict — and both hand the decision to the user.
  assert.deepEqual(outcome, { kind: ADJUDICATION_END.untouched })
  assert.equal(sent.length, 1)
})

test('the verdict follows the row number, not the line the turn was told to tick', async (t) => {
  // The model inserted a line above the row while it worked, so row 11.4 is no longer
  // at the line the message named — and that line now holds another task, unticked.
  // Reading the address would report the sent task as unproven; reading the number
  // finds the row the model actually ticked.
  const path = await trackingFile(t, [
    '# Tasks',
    '',
    `- [ ] 11.3 ${INCIDENT_ROW_SENT}`,
    'Заметка, которую модель дописала по ходу работы.',
    `- [x] ${INCIDENT_ROW_AFTER}`,
    '- [ ] 11.5 Прогнать полный набор тестов',
  ])
  const agent = { followup() {}, async whenIdle() {} }

  const outcome = await runAdjudication({
    agent,
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: grayTask(path, 3),
  })

  assert.deepEqual(outcome, { kind: ADJUDICATION_END.ticked })
})

test('a ticked neighbour at the addressed line is not the verdict', async (t) => {
  // The mirror case, and the unsafe one: another task's ticked box sits at the line
  // the message named, while row 11.4 moved down untouched. Reading the address
  // would continue a run on the strength of someone else's checkbox.
  const path = await trackingFile(t, [
    '# Tasks',
    '',
    'Заметка, которую модель дописала выше строки.',
    `- [x] 11.3 ${INCIDENT_ROW_SENT}`,
    `- [ ] ${INCIDENT_ROW_AFTER}`,
    '- [ ] 11.5 Прогнать полный набор тестов',
  ])
  const agent = { followup() {}, async whenIdle() {} }

  const outcome = await runAdjudication({
    agent,
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: grayTask(path, 4),
  })

  assert.deepEqual(outcome, { kind: ADJUDICATION_END.untouched })
})

test('a stop during the adjudication ends it as cancelled, not as a lost turn', async () => {
  const controller = new AbortController()
  let sent = 0
  const agent = {
    followup() {
      sent += 1
    },
    // The turn never finishes: only the stop can end the wait.
    whenIdle: () => new Promise(() => {}),
  }

  const pending = runAdjudication({
    agent,
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: ADJUDICATION_TASK,
    signal: controller.signal,
  })

  await settle()
  // The message is the turn being interrupted, not one that never started.
  assert.equal(sent, 1)
  controller.abort()

  assert.deepEqual(await pending, { kind: ADJUDICATION_END.cancelled })
})

test('a run stopped before the adjudication sends no turn and reads no verdict', async () => {
  const controller = new AbortController()
  controller.abort()
  let sent = 0
  const agent = {
    followup() {
      sent += 1
    },
    async whenIdle() {},
  }

  const outcome = await runAdjudication({
    agent,
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: ADJUDICATION_TASK,
    signal: controller.signal,
  })

  assert.equal(sent, 0)
  assert.deepEqual(outcome, { kind: ADJUDICATION_END.cancelled })
})

test('a verdict that cannot be read leaves the task unproven', async (t) => {
  const path = await trackingFile(t, ROWS_AFTER)
  // The row was there a moment ago; a file that went away still proves nothing.
  await rm(path)
  const agent = { followup() {}, async whenIdle() {} }

  const outcome = await runAdjudication({ agent, change: CHANGE, previous: INCIDENT_ROW_SENT, task: grayTask(path) })

  assert.deepEqual(outcome, { kind: ADJUDICATION_END.untouched })
})

test('an adjudication needs a turn-capable agent and a complete question', async () => {
  const sent = []
  const agent = {
    followup(message) {
      sent.push(message)
    },
    async whenIdle() {},
  }

  // Neither half of the turn is optional: one message, then one wait.
  await assert.rejects(
    () => runAdjudication({ change: CHANGE, previous: INCIDENT_ROW_SENT, task: ADJUDICATION_TASK }),
    /requires an agent/u,
  )
  await assert.rejects(
    () => runAdjudication({ agent: { followup() {} }, change: CHANGE, previous: INCIDENT_ROW_SENT, task: ADJUDICATION_TASK }),
    /requires an agent/u,
  )

  // A question that cannot name both wordings or the row is a caller's bug, and it
  // must not reach a session.
  await assert.rejects(
    () => runAdjudication({ agent, change: '', previous: INCIDENT_ROW_SENT, task: ADJUDICATION_TASK }),
    /change name/u,
  )
  await assert.rejects(
    () => runAdjudication({ agent, change: CHANGE, previous: '', task: ADJUDICATION_TASK }),
    /previous/u,
  )

  assert.equal(sent.length, 0)
})

test('a turn that fails to start is an error, not a stop', async (t) => {
  const path = await trackingFile(t, ROWS_BEFORE)
  const agent = {
    followup() {},
    whenIdle: () => Promise.reject(new Error('the agent is gone')),
  }

  await assert.rejects(
    () => runAdjudication({ agent, change: CHANGE, previous: INCIDENT_ROW_SENT, task: grayTask(path) }),
    /the agent is gone/u,
  )
})

test('the divergence question shows both wordings and offers continue or stop', () => {
  // Design D6 / task 4.1: the card is what the human decides from, so the whole
  // question is pinned — the number it names, what was sent, what the file now
  // says, and the two ways out. The labels are also the answer the run reads back
  // (task 4.2), which is why they are asserted by name and not only by the
  // deep-equal above.
  const card = buildDivergenceQuestion({
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: { ...ADJUDICATION_TASK, description: INCIDENT_ROW_REPLACEMENT },
  })

  assert.deepEqual(card, {
    id: DIVERGENCE_QUESTION_ID,
    header: 'OpenSpec',
    question: 'Формулировка задачи `11.4` изменилась. Продолжить выполнение этой задачи?',
    detail: `Было: ${INCIDENT_ROW_SENT}\nСтало: ${INCIDENT_ROW_REPLACEMENT}`,
    options: [{ label: 'Продолжить' }, { label: 'Остановить taskloop' }],
  })

  const labels = card.options.map((option) => option.label)
  assert.ok(labels.includes('Продолжить'), 'the way to continue is offered')
  assert.ok(labels.includes('Остановить taskloop'), 'the way to stop is offered')
})

test('the question names the number the fresh row carries, not the sent one', () => {
  // The number is the second identity key (design D1): it is read off the row the
  // file holds now, so a padded spelling stays exactly as the file writes it.
  const card = buildDivergenceQuestion({
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: { ...ADJUDICATION_TASK, description: '02.1 Обновить README' },
  })

  assert.ok(card.question.includes('`02.1`'))
  assert.ok(!card.question.includes('11.4'))
})

test('a divergence question without an old wording or a numbered row is refused', () => {
  // A card that shows one wording, or cannot name the task it is about, would ask
  // the user to decide on nothing; that is a caller's bug, not a question.
  const previous = INCIDENT_ROW_SENT

  assert.throws(() => buildDivergenceQuestion({ change: CHANGE, previous: '', task: ADJUDICATION_TASK }), /previous/u)
  assert.throws(() => buildDivergenceQuestion({ change: CHANGE, previous: 42, task: ADJUDICATION_TASK }), /previous/u)
  assert.throws(() => buildDivergenceQuestion({ change: CHANGE, previous, task: null }), /task object/u)
  assert.throws(
    () => buildDivergenceQuestion({ change: CHANGE, previous, task: { ...ADJUDICATION_TASK, description: '' } }),
    /task description/u,
  )
  assert.throws(
    () => buildDivergenceQuestion({ change: CHANGE, previous, task: { ...ADJUDICATION_TASK, description: 'Прогнать тесты' } }),
    /task number/u,
  )
})

/**
 * A `ctx.userQuestions` stand-in that answers the divergence card with one selection.
 *
 * The service reports a selection by the labels it showed (it is how the bootstrap
 * reads its consent), so a label list is the whole answer — and an empty list is the
 * shape a card closed without a choice leaves behind.
 *
 * @param {string[]} selected - labels the fake person picked.
 * @returns {{ask: (request: object) => Promise<object>}} the stand-in service.
 */
function selecting(selected) {
  return {
    async ask() {
      return { answers: [{ id: DIVERGENCE_QUESTION_ID, selected }] }
    },
  }
}

test('the continue label sends the task again with the wording the file holds', async () => {
  // Design D6: this answer is the only way a major divergence goes ahead, so the
  // seam must show the card of task 4.1 and nothing else — one question, whose id
  // and two wordings are what the answer is read against.
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return { answers: [{ id: DIVERGENCE_QUESTION_ID, selected: [DIVERGENCE_LABEL.continue] }] }
    },
  }

  const outcome = await requestContinuation({
    questions,
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: MAJOR_TASK,
  })

  assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.continue })
  assert.equal(asked.length, 1, 'the card is shown once')
  assert.deepEqual(
    asked[0].questions,
    [buildDivergenceQuestion({ change: CHANGE, previous: INCIDENT_ROW_SENT, task: MAJOR_TASK })],
  )
})

test('the stop label stops the run and sanctions nothing', async () => {
  // The other half of design D6: the person looked at the two wordings and said no,
  // so the task is not sent and the run ends with the reason the report names.
  const outcome = await requestContinuation({
    questions: selecting([DIVERGENCE_LABEL.stop]),
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: MAJOR_TASK,
  })

  assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.stop })
})

test('a closed card and a broken-off question are stops, not consents', async () => {
  // The spec's "Вопрос закрыт без ответа" scenario. A dismissal is a request that
  // ended, and an aborted one cannot be answered at all; neither may be read as
  // permission to run a task nobody agreed to.
  const rejecting = (code) => ({
    ask: async () => {
      const error = new Error(code)
      error.code = code
      throw error
    },
  })

  for (const code of ['ASK_CANCELLED', 'ASK_ABORTED']) {
    const outcome = await requestContinuation({
      questions: rejecting(code),
      change: CHANGE,
      previous: INCIDENT_ROW_SENT,
      task: MAJOR_TASK,
    })

    assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.stop }, `${code} stops the run`)
  }
})

test('an answer that does not pick the continue label alone is a stop', async () => {
  // Consent is one label on its own (task 4.2). A card that came back with no
  // selection, with free text instead of a choice, with both labels, with an extra
  // label it never offered, or with an entry for another question granted nothing, and
  // continuing on any of them would send a task whose wording no person endorsed.
  const answers = {
    'no selection': selecting([]),
    'free text': {
      async ask() {
        return { answers: [{ id: DIVERGENCE_QUESTION_ID, selected: [], custom: 'да, давай' }] }
      },
    },
    'both labels': selecting([DIVERGENCE_LABEL.continue, DIVERGENCE_LABEL.stop]),
    'continue and an unknown label': selecting([DIVERGENCE_LABEL.continue, 'Пропустить']),
    'another question': {
      async ask() {
        return { answers: [{ id: 'some-other-card', selected: [DIVERGENCE_LABEL.continue] }] }
      },
    },
  }

  for (const [name, questions] of Object.entries(answers)) {
    const outcome = await requestContinuation({
      questions,
      change: CHANGE,
      previous: INCIDENT_ROW_SENT,
      task: MAJOR_TASK,
    })

    assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.stop }, name)
  }
})

test('a deployment with no question channel stops instead of continuing', async () => {
  // The spec's "Спросить некого" scenario, and design D6's headless answer: the run
  // stops with a reason instead of running a task no person vouched for.
  for (const questions of [undefined, null, {}]) {
    const outcome = await requestContinuation({
      questions,
      change: CHANGE,
      previous: INCIDENT_ROW_SENT,
      task: MAJOR_TASK,
    })

    assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.unavailable })
  }
})

test('a channel with nobody behind it is unavailability, not a refusal', async () => {
  // `NO_PROVIDER` is the service saying it has no answerer, which is the same
  // headless deployment as an absent service — not a person saying no.
  const questions = {
    ask: async () => {
      const error = new Error('no provider')
      error.code = 'NO_PROVIDER'
      throw error
    },
  }

  const outcome = await requestContinuation({
    questions,
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: MAJOR_TASK,
  })

  assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.unavailable })
})

test('a question that fails for another reason is an error, not an answer', async () => {
  // A broken service is neither consent nor refusal: reporting it as a stop would
  // end a healthy run on a bug, and reporting it as a continuation would send a task
  // nobody was asked about.
  const questions = {
    ask: async () => {
      throw new Error('the question service is gone')
    },
  }

  await assert.rejects(
    () => requestContinuation({ questions, change: CHANGE, previous: INCIDENT_ROW_SENT, task: MAJOR_TASK }),
    /the question service is gone/u,
  )
})

test('a run stopped before the question asks nobody anything', async () => {
  const controller = new AbortController()
  controller.abort()
  let asked = 0
  const questions = {
    async ask() {
      asked += 1
      return { answers: [{ id: DIVERGENCE_QUESTION_ID, selected: [DIVERGENCE_LABEL.continue] }] }
    },
  }

  const outcome = await requestContinuation({
    questions,
    change: CHANGE,
    previous: INCIDENT_ROW_SENT,
    task: MAJOR_TASK,
    signal: controller.signal,
  })

  assert.equal(asked, 0, 'nothing is shown for a run that already ended')
  assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.stop })
})

test('a question that cannot name the task is refused even with no channel', async () => {
  // The card is built before the channel is looked at: an unnameable question is a
  // caller's bug in every deployment, and reporting it as "no channel" would hide it
  // in exactly the deployments that never see a card.
  await assert.rejects(
    () => requestContinuation({ change: CHANGE, previous: '', task: MAJOR_TASK }),
    /previous/u,
  )
  await assert.rejects(
    () => requestContinuation({ change: CHANGE, previous: INCIDENT_ROW_SENT, task: { ...MAJOR_TASK, description: 'Прогнать тесты' } }),
    /task number/u,
  )
})
