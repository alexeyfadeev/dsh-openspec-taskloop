// Tests for task numbering and grouping (task 2.4).
//
// The numbering is not a CLI field: it is the `N.M` prefix of `description`
// (design D5). These tests pin the two decisions that later tasks lean on —
// which digits form a group, and when a run refuses to have groups at all — and
// the last test repeats both against the live `ready.json` capture so the
// fixture and the parser cannot drift apart.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { classifyTransition, describeGrouping, extractTaskNumber, GROUPING, TRANSITION } from '../lib/groups.js'
import { parseApplyInstructions } from '../lib/tasks.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apply')

/**
 * Build a task entry the way `parseApplyInstructions` returns it.
 *
 * @param {string} description - task text after the checkbox.
 * @param {object} [overrides] - fields to override.
 * @returns {{id: string, description: string, done: boolean, sourcePath: string, line: number}} task.
 */
const task = (description, overrides = {}) => ({
  id: '1',
  description,
  done: false,
  sourcePath: 'C:\\projects\\demo\\openspec\\changes\\demo\\tasks.md',
  line: 5,
  ...overrides,
})

/**
 * Descriptions of the tasks in one group.
 *
 * @param {{tasks: object[]}} group - group entry.
 * @returns {string[]} descriptions, file order preserved.
 */
const descriptionsOf = (group) => group.tasks.map((entry) => entry.description)

test('reads the N.M prefix and nothing else from a description', () => {
  assert.deepEqual(extractTaskNumber('2.4 Реализовать извлечение группы из описания'), {
    major: '2',
    minor: '4',
    label: '2.4',
    group: 2,
  })
})

test('keeps multi-digit minor numbers intact', () => {
  assert.deepEqual(extractTaskNumber('10.12 Последняя задача группы'), {
    major: '10',
    minor: '12',
    label: '10.12',
    group: 10,
  })
})

test('does not take a number that is not at the start', () => {
  // Anchoring is the point: a task may quote another number in its body.
  assert.equal(extractTaskNumber('Сделать 2.1 после 1.2'), null)
  assert.equal(extractTaskNumber('Обновить README'), null)
  assert.equal(extractTaskNumber(''), null)
})

test('treats differently padded digits as one group but keeps the written label', () => {
  // A file that writes `02.1` still means group 2: group identity is numeric so
  // a padded spelling cannot silently split the session.
  assert.deepEqual(extractTaskNumber('02.1 Первая задача'), { major: '02', minor: '1', label: '02.1', group: 2 })

  const grouping = describeGrouping([task('02.1 Первая'), task('2.2 Вторая', { id: '2', line: 6 })])
  assert.equal(grouping.mode, GROUPING.grouped)
  assert.equal(grouping.groups.length, 1)
  assert.equal(grouping.groups[0].group, 2)
})

test('groups adjacent tasks of one number and keeps file order', () => {
  const tasks = [task('1.1 Первая'), task('1.2 Вторая', { id: '2' }), task('2.1 Третья', { id: '3' })]
  const grouping = describeGrouping(tasks)

  assert.equal(grouping.mode, GROUPING.grouped)
  assert.deepEqual(grouping.groups.map((entry) => entry.group), [1, 2])
  assert.deepEqual(descriptionsOf(grouping.groups[0]), ['1.1 Первая', '1.2 Вторая'])
  assert.deepEqual(descriptionsOf(grouping.groups[1]), ['2.1 Третья'])
  // Grouping reports the same entries, it does not copy or reorder them.
  assert.equal(grouping.groups[0].tasks[0], tasks[0])
  assert.equal(grouping.groups[1].tasks[0], tasks[2])
})

test('orders groups by first appearance, not by number', () => {
  // The file is the run's order (selection follows it), so a numbering that
  // jumps back must not be re-sorted here.
  const tasks = [task('1.1'), task('2.1', { id: '2' }), task('1.2', { id: '3' }), task('3.1', { id: '4' })]
  const grouping = describeGrouping(tasks)

  assert.deepEqual(grouping.groups.map((entry) => entry.group), [1, 2, 3])
  assert.deepEqual(descriptionsOf(grouping.groups[0]), ['1.1', '1.2'])
  assert.deepEqual(descriptionsOf(grouping.groups[1]), ['2.1'])
})

test('makes the whole run flat when one listed task has no number', () => {
  // A mixed list: the numbered tasks cannot be trusted to bound sessions when a
  // sibling is unnumbered, so nothing is split (spec: "Задачи без нумерации").
  const grouping = describeGrouping([
    task('1.1 Первая'),
    task('Обновить README', { id: '2', line: 6 }),
    task('1.2 Третья', { id: '3', line: 7 }),
  ])

  assert.equal(grouping.mode, GROUPING.flat)
  assert.deepEqual(grouping.groups, [])
})

test('makes a wholly unnumbered list flat', () => {
  const grouping = describeGrouping([task('Первая задача'), task('Вторая задача', { id: '2', line: 6 })])

  assert.equal(grouping.mode, GROUPING.flat)
  assert.deepEqual(grouping.groups, [])
})

test('makes an empty list flat rather than grouped with no groups', () => {
  assert.deepEqual(describeGrouping([]), { mode: GROUPING.flat, groups: [] })
})

test('classifies a step inside one group and across groups', () => {
  const grouping = describeGrouping([task('2.3 Третья'), task('2.4 Четвёртая', { id: '2' }), task('3.1 Пятая', { id: '3' })])

  assert.equal(classifyTransition(grouping, grouping.groups[0].tasks[0], grouping.groups[0].tasks[1]), TRANSITION.sameGroup)
  assert.equal(classifyTransition(grouping, grouping.groups[0].tasks[1], grouping.groups[1].tasks[0]), TRANSITION.newGroup)
})

test('classifies every step of a flat run as flat', () => {
  const grouping = describeGrouping([task('Первая задача'), task('Вторая задача', { id: '2' })])

  // Even tasks that happen to be numbered stay in one session: the run, not the
  // pair, decides whether groups exist.
  assert.equal(classifyTransition(grouping, task('1.1'), task('1.2', { id: '2' })), TRANSITION.flat)
})

test('refuses a boundary it cannot justify', () => {
  // A list declared grouped but holding an unnumbered task is not this list;
  // treating the step as a boundary would split a session on a guess.
  const grouping = { mode: GROUPING.grouped }

  assert.equal(classifyTransition(grouping, task('1.1'), task('Без номера', { id: '2' })), TRANSITION.flat)
})

test('rejects arguments that are not a task list', () => {
  assert.throws(() => extractTaskNumber(42), TypeError)
  assert.throws(() => describeGrouping('1.1 Первая'), TypeError)
})

test('separates this change into its seven written groups', () => {
  const instructions = parseApplyInstructions(readFileSync(join(fixturesDir, 'ready.json'), 'utf8'))
  const grouping = describeGrouping(instructions.tasks)

  assert.equal(grouping.mode, GROUPING.grouped)
  assert.deepEqual(
    grouping.groups.map((entry) => entry.group),
    [1, 2, 3, 4, 5, 6, 7],
  )
  assert.deepEqual(
    grouping.groups.map((entry) => entry.tasks.length),
    [2, 4, 3, 3, 2, 3, 3],
  )
  assert.deepEqual(
    grouping.groups[1].tasks.map((entry) => extractTaskNumber(entry.description).label),
    ['2.1', '2.2', '2.3', '2.4'],
  )

  // The transitions this change will actually make: 2.3 → 2.4 stays inside the
  // group and compacts; 2.4 → 3.1 opens a new session.
  assert.equal(classifyTransition(grouping, instructions.tasks[4], instructions.tasks[5]), TRANSITION.sameGroup)
  assert.equal(classifyTransition(grouping, instructions.tasks[5], instructions.tasks[6]), TRANSITION.newGroup)
})
