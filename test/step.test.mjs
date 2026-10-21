// Tests for the step message (task 4.1): the exact text, the one follow-up, and
// the address a reader can jump to.
//
// The wording is pinned literally because it is a behavioural contract, not
// prose: the model must learn the task number, the change, the row and that it
// owes a pause, and a reviewer must be able to see all four in one place.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { APPLY_SKILL_PATH, buildTaskPrompt, createTaskMessage, sendTaskStep, taskLabel } from '../lib/step.js'

const CHANGE = 'add-taskloop-plugin'
const SOURCE = 'C:\\work\\_dsh\\dsh-openspec-taskloop\\openspec\\changes\\add-taskloop-plugin\\tasks.md'

/** The task shape `openspec instructions apply --json` returns (task 2.3). */
const TASK = {
  id: '10',
  description: '4.1 Реализовать формирование сообщения задачи (номер, change, строка файла, навык, «далее — пауза») '
    + 'и отправку через `followup`; проверить тестом точный текст и отсутствие лишних сообщений',
  done: false,
  sourcePath: SOURCE,
  line: 23,
}

test('the step prompt names the number, the change, the file line, the skill and the pause', () => {
  assert.equal(buildTaskPrompt({ change: CHANGE, task: TASK }), [
    `Используя навык ${APPLY_SKILL_PATH} выполни task 4.1, далее - пауза.`,
    `Change: ${CHANGE}; файл: ${SOURCE}:23.`,
  ].join('\n'))
})

test('the number is read from the description, and a flat task falls back to its id', () => {
  assert.equal(taskLabel(TASK), '4.1')
  // A flat run (design D5) has no `N.M`; the CLI's id is the only identifier left.
  assert.equal(taskLabel({ ...TASK, id: '7', description: 'Обновить README' }), '7')

  const flat = buildTaskPrompt({ change: CHANGE, task: { ...TASK, id: '7', description: 'Обновить README' } })
  assert.ok(flat.startsWith(`Используя навык ${APPLY_SKILL_PATH} выполни task 7, далее - пауза.`))
  // The address line still pins the row, so the id cannot mislead the model.
  assert.ok(flat.includes(`Change: ${CHANGE}; файл: ${SOURCE}:23.`))
})

test('the message is one user-role text block with a fresh id per task', () => {
  const first = createTaskMessage({ change: CHANGE, task: TASK })
  const second = createTaskMessage({ change: CHANGE, task: TASK })

  assert.equal(first.role, 'user')
  assert.deepEqual(first.source, { kind: 'user' })
  assert.equal(first.content.length, 1)
  assert.equal(first.content[0].type, 'text')
  assert.equal(first.content[0].text, buildTaskPrompt({ change: CHANGE, task: TASK }))
  assert.equal(typeof first.id, 'string')
  assert.notEqual(first.id, second.id)
})

test('exactly one follow-up leaves the step, and it is the returned message', () => {
  const sent = []
  const agent = {
    id: 'agent-1',
    followup(message) {
      sent.push(message)
    },
  }

  const message = sendTaskStep({ agent, change: CHANGE, task: TASK })

  assert.equal(sent.length, 1)
  assert.equal(sent[0], message)
  assert.equal(message.content[0].text, buildTaskPrompt({ change: CHANGE, task: TASK }))
})

test('the skill path is a parameter, so a caller can point elsewhere', () => {
  const text = buildTaskPrompt({ change: CHANGE, task: TASK, skillPath: '.dsh/skills/other' })

  assert.ok(text.startsWith('Используя навык .dsh/skills/other выполни task 4.1, далее - пауза.'))
  assert.ok(!text.includes(APPLY_SKILL_PATH))
})

test('an agent that cannot accept a follow-up fails loudly instead of dropping the task', () => {
  assert.throws(() => sendTaskStep({ agent: undefined, change: CHANGE, task: TASK }), /accepts a follow-up/)
  assert.throws(() => sendTaskStep({ agent: {}, change: CHANGE, task: TASK }), TypeError)
})

test('a task or change without an address is refused, not sent half-addressed', () => {
  assert.throws(() => buildTaskPrompt({ change: '', task: TASK }), /change name/)
  assert.throws(() => buildTaskPrompt({ change: CHANGE, task: { ...TASK, sourcePath: '' } }), /sourcePath/)
  assert.throws(() => buildTaskPrompt({ change: CHANGE, task: { ...TASK, line: 0 } }), /line/)
  assert.throws(() => buildTaskPrompt({ change: CHANGE, task: { ...TASK, description: '' } }), /description/)
  assert.throws(() => buildTaskPrompt({ change: CHANGE, task: null }), /task object/)
})
