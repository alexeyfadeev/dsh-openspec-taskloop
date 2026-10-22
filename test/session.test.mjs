// Tests for the session handoff (task 5.1): a run that crosses a group boundary
// opens its next session through `sessionController.create` and drives the first
// task of the new group there through `sessionController.prompt`.
//
// The controller is a fake that records the requests it receives, which is what
// the task asks for: the request shapes, the workspace-or-directory choice and the
// inherited preset are pinned here, before 7.1/7.2 exercise them against the real
// service. The runner is driven through the same `sendTaskStep()` the loop uses,
// so the message a new session receives is provably the message an in-place step
// would have received.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createSessionRunner,
  openSession,
  promptRequest,
  sessionRequest,
} from '../lib/session.js'
import { sendTaskStep } from '../lib/step.js'

const CWD = 'C:\\projects\\demo'
const CHANGE = 'add-taskloop-plugin'

/** The task the run enters a new group with: 3.1, the first row of group 3. */
const TASK = {
  id: '7',
  description: '3.1 Зарегистрировать команду `/taskloop` с разбором аргументов',
  sourcePath: 'C:\\projects\\demo\\openspec\\changes\\add-taskloop-plugin\\tasks.md',
  line: 17,
  done: false,
}

/**
 * A controller that records every request and answers create() with one value.
 *
 * @param {object} [options]
 * @param {unknown} [options.createValue] - value returned by `create()`.
 * @param {(request: object) => (unknown|Promise<unknown>)} [options.prompt] - answer to `prompt()`;
 *   defaults to a settled receipt.
 * @returns {{creates: object[], prompts: object[], create: Function, prompt: Function}} the fake.
 */
function fakeController({ createValue = { sessionId: 'session-2' }, prompt } = {}) {
  const creates = []
  const prompts = []
  return {
    creates,
    prompts,
    async create(request) {
      creates.push(request)
      return createValue
    },
    prompt(request, signal) {
      prompts.push({ request, signal })
      return prompt === undefined ? Promise.resolve({ messageId: 'm-1' }) : prompt(request)
    },
  }
}

test('the new session is created in the workspace of the source session, with its preset', async () => {
  const controller = fakeController()
  const paths = []

  const runner = await openSession({
    controller,
    cwd: CWD,
    workspaceOf: async (path) => {
      paths.push(path)
      return 'ws-1'
    },
    presetOf: () => 'default',
  })

  assert.equal(runner.sessionId, 'session-2')
  // The workspace, not the directory: only a workspace-bound session appears in
  // the sidebar (design D6), and the workspace can be a parent of the directory.
  assert.deepEqual(controller.creates, [{ workspaceId: 'ws-1', agentPreset: 'default' }])
  assert.deepEqual(paths, [CWD])
})

test('without a workspace the session is created by its directory', async () => {
  const controller = fakeController({ createValue: { session: { id: 'session-3' } } })

  const runner = await openSession({
    controller,
    cwd: CWD,
    workspaceOf: async () => undefined,
  })

  assert.equal(runner.sessionId, 'session-3')
  // No preset is sent as `undefined`: the field is omitted so the controller sees
  // a request it can validate.
  assert.deepEqual(controller.creates, [{ cwd: CWD }])
})

test('a session request needs a workspace or a directory', () => {
  assert.deepEqual(sessionRequest({ cwd: CWD, workspaceId: 'ws-1' }), { workspaceId: 'ws-1' })
  assert.deepEqual(sessionRequest({ cwd: CWD }), { cwd: CWD })
  assert.throws(() => sessionRequest({}), /requires a workspaceId or a cwd/)
})

test('the first task of the new group is sent through prompt, and idleness waits for it', async () => {
  const events = []
  const agent = { async whenIdle() { events.push('idle') } }
  let releasePrompt
  const controller = fakeController({
    prompt: () => new Promise((resolve) => {
      releasePrompt = resolve
    }),
  })
  const runner = await openSession({
    controller,
    cwd: CWD,
    resolveAgent: () => agent,
  })

  const message = sendTaskStep({ agent: runner, change: CHANGE, task: TASK })
  events.push('prompt')

  // The turn is not waited for before the prompt was accepted: a `whenIdle()`
  // that ran first would resolve at once and let the loop read a turn that has
  // not started.
  let idled = false
  const idle = runner.whenIdle().then(() => {
    idled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(idled, false)
  assert.deepEqual(events, ['prompt'])

  releasePrompt({ messageId: 'm-1' })
  await idle

  assert.deepEqual(events, ['prompt', 'idle'])
  assert.equal(controller.prompts.length, 1)
  const request = controller.prompts[0].request
  // The controller's envelope, not bare content: admission id, queue mode, content.
  assert.equal(request.sessionId, 'session-2')
  assert.equal(request.mode, 'queue')
  assert.equal(typeof request.requestId, 'string')
  assert.notEqual(request.requestId, '')
  assert.deepEqual(request.content, message.content)
  // The message is the one the step would have sent in place: the address line
  // still names the change and the exact row the model must tick.
  assert.match(message.content[0].text, /выполни task 3\.1, далее - пауза\./u)
  assert.match(message.content[0].text, /Change: add-taskloop-plugin; файл: .*tasks\.md:17\./u)
})

test('every prompt carries its own admission id', async () => {
  const controller = fakeController()
  const runner = createSessionRunner({
    controller,
    sessionId: 'session-2',
    resolveAgent: () => ({ async whenIdle() {} }),
  })
  const message = { role: 'user', content: [{ type: 'text', text: 'task' }] }

  // Two task messages that happen to carry the same text are two admissions, not
  // one retried request: reusing the id would let the controller deduplicate the
  // second task away.
  runner.followup(message)
  await runner.whenIdle()
  runner.followup(message)
  await runner.whenIdle()

  const ids = controller.prompts.map(({ request }) => request.requestId)
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, 2)
})

test('a prompt the controller rejects is reported as a failed turn', async () => {
  const controller = fakeController({
    prompt: () => Promise.reject(new Error('the session was closed')),
  })
  const runner = createSessionRunner({
    controller,
    sessionId: 'session-2',
    resolveAgent: () => ({ async whenIdle() {} }),
  })

  runner.followup({ role: 'user', content: [{ type: 'text', text: 'task' }] })

  await assert.rejects(
    () => runner.whenIdle(),
    /session session-2 could not start the turn: the session was closed/,
  )
})

test('a session value without an id is refused instead of guessed', async () => {
  const controller = fakeController({ createValue: { session: { title: 'untitled' } } })

  await assert.rejects(
    () => openSession({ controller, cwd: CWD }),
    /the session controller returned no session id/,
  )
})

test('a session without a live agent cannot be waited on', async () => {
  const runner = createSessionRunner({
    controller: fakeController(),
    sessionId: 'session-2',
    resolveAgent: () => undefined,
  })

  runner.followup({ role: 'user', content: [{ type: 'text', text: 'task' }] })

  await assert.rejects(() => runner.whenIdle(), /has no live agent that reports whenIdle/)
})

test('the new session hands its agent to the run before the first task', async () => {
  const adopted = []
  const agent = { async whenIdle() {} }
  const runner = await openSession({
    controller: fakeController(),
    cwd: CWD,
    resolveAgent: () => agent,
    adoptAgent: (value) => adopted.push(value),
  })

  // The protocol section (5.2) must be in place when the first task starts, not
  // after its turn, so the session adopts the agent while it is still opening.
  assert.deepEqual(adopted, [agent])

  runner.followup({ role: 'user', content: [{ type: 'text', text: 'task' }] })
  await runner.whenIdle()

  // The same agent met twice is still adopted once.
  assert.deepEqual(adopted, [agent])
})

test('an agent that is not live yet is adopted when the turn is awaited', async () => {
  const adopted = []
  let live
  const agent = { async whenIdle() {} }
  const runner = await openSession({
    controller: fakeController(),
    cwd: CWD,
    resolveAgent: () => live,
    adoptAgent: (value) => adopted.push(value),
  })

  assert.deepEqual(adopted, [])

  live = agent
  runner.followup({ role: 'user', content: [{ type: 'text', text: 'task' }] })
  await runner.whenIdle()

  assert.deepEqual(adopted, [agent])
})

test('a lookup that fails while the session opens does not stop the handoff', async () => {
  let calls = 0
  const agent = { async whenIdle() {} }
  const runner = await openSession({
    controller: fakeController(),
    cwd: CWD,
    resolveAgent: () => {
      calls += 1
      if (calls === 1) throw new Error('the session is not live yet')
      return agent
    },
    adoptAgent: () => {},
  })

  assert.equal(runner.sessionId, 'session-2')

  runner.followup({ role: 'user', content: [{ type: 'text', text: 'task' }] })
  await runner.whenIdle()

  assert.equal(calls, 2)
})

test('a controller without create() or prompt() is refused', async () => {
  await assert.rejects(() => openSession({ controller: { create: async () => ({}) }, cwd: CWD }), /create\(\) and prompt\(\)/)
  assert.throws(() => promptRequest('', { content: [] }), /requires the session id/)
})
