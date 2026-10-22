// Tests for the Cordis-facing seam (tasks 3.1–3.3, 5.1, 6.1, 6.3).
//
// The seam is small but decisive: which directory `openspec` runs in, which
// timeout the wrapper gets, whether the confirmation, the description question
// and the explore follow-up reach the session's services, which services open
// the session a run continues in at a group boundary, and what the two compaction
// calls send to the service. A fake context exposes exactly the services the seam
// reads, so a lookup of the wrong service fails here instead of in a mounted
// profile.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { INIT_ANSWER, INIT_LABEL, INIT_QUESTION_ID } from '../lib/bootstrap.js'
import { resolveConfig } from '../lib/config.js'
import { createEnvironment, resolveCwd } from '../lib/environment.js'
import {
  DESCRIPTION_QUESTION_ID,
  EXPLORE_ANSWER,
  EXPLORE_SKILL_PATH,
  buildExplorePrompt,
} from '../lib/explore.js'
import { OpenSpecCli } from '../lib/openspec.js'

/**
 * A context that hands back the composed services and nothing else.
 *
 * @param {object} services - service name to instance.
 * @returns {object} fake plugin context.
 */
function fakeCtx(services) {
  return {
    get: (name) => services[name],
    logger: { info() {} },
  }
}

/**
 * An agent whose session carries a header directory.
 *
 * @param {string} [cwd] - original project directory; omitted means "none recorded".
 * @returns {object} fake agent.
 */
const agentWith = (cwd) => ({ id: 'agent-1', session: { header: cwd === undefined ? {} : { cwd } } })

test('the session working directory comes from the working-directory service', () => {
  const ctx = fakeCtx({ workingDirectory: { get: () => '/work/project' } })
  const environment = createEnvironment(ctx, resolveConfig())

  assert.equal(environment.cwdOf({ agent: agentWith('/original/project') }), '/work/project')
  // The exported helper answers the same question for callers that already hold the agent.
  assert.equal(resolveCwd(ctx, agentWith('/original/project')), '/work/project')
})

test('the session header is the fallback when the service is absent', () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  assert.equal(environment.cwdOf({ agent: agentWith('C:\\projects\\demo') }), 'C:\\projects\\demo')
})

test('the host process directory is the last resort', () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  assert.equal(environment.cwdOf({ agent: agentWith() }), process.cwd())
  assert.equal(environment.cwdOf({ agent: undefined }), process.cwd())
})

test('the CLI wrapper is built with the configured timeout', () => {
  const subprocess = { resolveExecutable() {}, spawn() {} }
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig({ openspec: { timeoutMs: 9000 } }))

  const cli = environment.createCli()

  assert.ok(cli instanceof OpenSpecCli)
  assert.equal(cli.timeoutMs, 9000)
})

test('a missing subprocess service is reported when a run starts, not at mount', () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  assert.throws(() => environment.createCli(), /subprocess service is not composed/)
})

test('the confirmation goes to the session user-questions service', async () => {
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return { answers: [{ id: INIT_QUESTION_ID, selected: [INIT_LABEL.initialize] }] }
    },
  }
  const environment = createEnvironment(fakeCtx({ userQuestions: questions }), resolveConfig())
  const signal = new AbortController().signal
  const invocation = { agent: { id: 'agent-1' }, signal }

  const decision = await environment.askInit(invocation, '/work/demo')

  assert.equal(decision, INIT_ANSWER.initialize)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].agent, invocation.agent)
  assert.equal(asked[0].signal, signal)
  assert.match(asked[0].questions[0].question, /\/work\/demo/)
})

test('without a user-questions service the answer is unavailable, never consent', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  assert.equal(await environment.askInit({ agent: { id: 'agent-1' } }, '/work/demo'), INIT_ANSWER.unavailable)
})

test('the description question goes to the session user-questions service', async () => {
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return {
        answers: [{ id: DESCRIPTION_QUESTION_ID, selected: [], custom: 'Ship the export endpoint.' }],
      }
    },
  }
  const environment = createEnvironment(fakeCtx({ userQuestions: questions }), resolveConfig())
  const signal = new AbortController().signal
  const invocation = { agent: { id: 'agent-1' }, signal }

  const outcome = await environment.askDescription(invocation, '/work/demo')

  assert.deepEqual(outcome, {
    kind: EXPLORE_ANSWER.described,
    description: 'Ship the export endpoint.',
  })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].agent, invocation.agent)
  assert.equal(asked[0].signal, signal)
  assert.match(asked[0].questions[0].question, /\/work\/demo/)
})

test('the explore follow-up goes to the invocation agent, once', () => {
  const messages = []
  const environment = createEnvironment(fakeCtx({}), resolveConfig())
  const invocation = {
    agent: {
      id: 'agent-1',
      followup(message) {
        messages.push(message)
      },
    },
  }

  environment.followupExplore(invocation, 'Ship the export endpoint.')

  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content[0].text, buildExplorePrompt('Ship the export endpoint.', EXPLORE_SKILL_PATH))
})

test('the new session is created in the run workspace and driven through the controller', async () => {
  const created = []
  const paths = []
  const presets = []
  const prompts = []
  const idled = []
  const sessionAgent = {
    async whenIdle() {
      idled.push('session')
    },
  }
  const agent = { id: 'agent-1', ctx: { name: 'source' } }
  const controller = {
    async create(request) {
      created.push(request)
      return { sessionId: 'session-2' }
    },
    prompt(request, signal) {
      prompts.push({ request, signal })
      return Promise.resolve({ messageId: 'm-1' })
    },
  }
  const ctx = fakeCtx({
    sessionController: controller,
    workspaceRegistry: {
      async resolveByPath(path) {
        paths.push(path)
        return { id: 'ws-1' }
      },
    },
    agentPresets: {
      composedPreset(context) {
        presets.push(context)
        return 'default'
      },
    },
    agents: { get: (id) => (id === 'session-2' ? sessionAgent : undefined) },
  })
  const environment = createEnvironment(ctx, resolveConfig())
  const signal = new AbortController().signal
  const invocation = { agent, signal }

  const runner = await environment.openSession(invocation, {
    change: 'add-taskloop-plugin',
    cwd: '/work/demo',
  })

  assert.equal(runner.sessionId, 'session-2')
  // The workspace is preferred over the directory, and the preset is read from the
  // source session's own composition so the new session continues its protocol.
  assert.deepEqual(created, [{ workspaceId: 'ws-1', agentPreset: 'default' }])
  assert.deepEqual(paths, ['/work/demo'])
  assert.equal(presets[0], agent.ctx)

  runner.followup({ role: 'user', content: [{ type: 'text', text: 'task' }] })
  await runner.whenIdle()

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].request.sessionId, 'session-2')
  assert.equal(prompts[0].request.mode, 'queue')
  assert.equal(typeof prompts[0].request.requestId, 'string')
  assert.deepEqual(prompts[0].request.content, [{ type: 'text', text: 'task' }])
  // The invocation's own cancellation travels with the prompt; `/taskloop stop`
  // aborts the run's signal, not the command's, so a stopped run does not kill
  // the turn it started.
  assert.equal(prompts[0].signal, signal)
  assert.deepEqual(idled, ['session'])
})

test('a session opened at a boundary is driven with the run signal, not the request one', async () => {
  // The request's signal dies with the request; a session that continues the work
  // must not inherit that cancellation, or a reload would cancel the turn the new
  // group just started.
  const prompts = []
  const request = new AbortController().signal
  const run = new AbortController().signal
  const controller = {
    async create() {
      return { sessionId: 'session-2' }
    },
    prompt(request_, signal) {
      prompts.push({ request: request_, signal })
      return Promise.resolve({ messageId: 'm-1' })
    },
  }
  const environment = createEnvironment(
    fakeCtx({ sessionController: controller, agents: { get: () => ({ async whenIdle() {} }) } }),
    resolveConfig(),
  )

  const runner = await environment.openSession(
    { agent: agentWith(), signal: request },
    { change: 'add-taskloop-plugin', cwd: '/work/demo', signal: run },
  )
  runner.followup({ role: 'user', content: [{ type: 'text', text: 'task' }] })
  await runner.whenIdle()

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].signal, run)
})

test('the session opened at a boundary hands its agent to the run', async () => {
  const sessionAgent = { async whenIdle() {} }
  const adopted = []
  const ctx = fakeCtx({
    sessionController: {
      async create() {
        return { sessionId: 'session-2' }
      },
      prompt() {
        return Promise.resolve({ messageId: 'm-1' })
      },
    },
    agents: { get: (id) => (id === 'session-2' ? sessionAgent : undefined) },
  })
  const environment = createEnvironment(ctx, resolveConfig())

  const runner = await environment.openSession(
    { agent: agentWith(), signal: undefined },
    {
      change: 'add-taskloop-plugin',
      cwd: '/work/demo',
      adoptAgent: (agent) => adopted.push(agent),
    },
  )

  // The protocol section (5.2) belongs to the agent that drives the new group,
  // so the seam passes that agent — not the invocation's — to the run.
  assert.equal(runner.sessionId, 'session-2')
  assert.deepEqual(adopted, [sessionAgent])
})

test('a deployment without a session controller cannot open a session', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  await assert.rejects(
    () => environment.openSession({ agent: agentWith(), signal: undefined }, { change: 'add-taskloop-plugin', cwd: '/work/demo' }),
    /sessionController service is not composed/,
  )
})

test('without a workspace the new session is created by the run directory', async () => {
  const created = []
  const ctx = fakeCtx({
    sessionController: {
      async create(request) {
        created.push(request)
        return { session: { id: 'session-3' } }
      },
      prompt() {
        return Promise.resolve({ messageId: 'm-1' })
      },
    },
    // A directory no workspace owns is a normal answer; the run still opens a
    // session, just not one the sidebar tracks (design D6).
    workspaceRegistry: {
      async resolveByPath() {
        throw new Error('not inside a workspace')
      },
    },
  })
  const environment = createEnvironment(ctx, resolveConfig())

  const runner = await environment.openSession(
    { agent: agentWith(), signal: undefined },
    { change: 'add-taskloop-plugin', cwd: '/work/demo' },
  )

  assert.equal(runner.sessionId, 'session-3')
  assert.deepEqual(created, [{ cwd: '/work/demo' }])
})

test('compaction goes to the service with the invocation agent and the run signal', async () => {
  const calls = []
  const agent = { id: 'agent-1', runMaintenance() {} }
  const compaction = {
    async compactNow(target, signal) {
      calls.push({ target, signal })
      return null
    },
  }
  const environment = createEnvironment(fakeCtx({ compaction }), resolveConfig())
  const signal = new AbortController().signal

  const result = await environment.compactNow(agent, signal)

  assert.equal(result, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, agent)
  assert.equal(calls[0].signal, signal)
})

test('a session runner is traced back to its live agent before compacting', async () => {
  // A run that crossed a boundary holds a runner, not an agent (5.1); the
  // compaction service only accepts the agent that carries `runMaintenance()`.
  const live = { id: 'agent-2', runMaintenance() {} }
  const calls = []
  const compaction = {
    async compactNow(target) {
      calls.push(target)
      return null
    },
  }
  const ctx = fakeCtx({
    compaction,
    agents: { get: (id) => (id === 'session-2' ? live : undefined) },
  })
  const environment = createEnvironment(ctx, resolveConfig())

  await environment.compactNow({ sessionId: 'session-2', followup() {}, whenIdle() {} }, undefined)

  assert.deepEqual(calls, [live])
})

test('a preset-isolated profile compacts through the preset registry', async () => {
  // The shipped `dsh-web-app` profile disables the host-plane compaction row and
  // mounts a private one inside each preset's group. The host-plane lookup answers
  // nothing there, and the registry is the public route to the instance the agent
  // actually runs with (6.1).
  const calls = []
  const resolved = []
  const agent = { id: 'agent-1', ctx: { name: 'agent' }, runMaintenance() {} }
  const compaction = {
    async compactNow(target, signal) {
      calls.push({ target, signal })
      return null
    },
  }
  const ctx = fakeCtx({
    agentPresets: {
      serviceFor(target, name) {
        resolved.push({ target, name })
        return compaction
      },
    },
  })
  const environment = createEnvironment(ctx, resolveConfig())
  const signal = new AbortController().signal

  const result = await environment.compactNow(agent, signal)

  assert.equal(result, null)
  assert.deepEqual(resolved, [{ target: agent, name: 'compaction' }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, agent)
  assert.equal(calls[0].signal, signal)
})

test('a host-plane compaction wins over the preset one', async () => {
  const hostCalls = []
  const host = {
    async compactNow() {
      hostCalls.push('host')
      return null
    },
  }
  const agent = { id: 'agent-1', ctx: {}, runMaintenance() {} }
  const ctx = fakeCtx({
    compaction: host,
    agentPresets: {
      serviceFor() {
        throw new Error('the preset service must not be asked when the host plane has one')
      },
    },
  })
  const environment = createEnvironment(ctx, resolveConfig())

  await environment.compactNow(agent, undefined)

  assert.deepEqual(hostCalls, ['host'])
})

test('a step compaction falls back to the preset service as well', async () => {
  const calls = []
  const agent = { id: 'agent-1', ctx: {} }
  const compaction = {
    async compactIfNeeded(target, trigger, signal) {
      calls.push({ target, trigger, signal })
      return null
    },
  }
  const ctx = fakeCtx({ agentPresets: { serviceFor: () => compaction } })
  const environment = createEnvironment(ctx, resolveConfig())
  const signal = new AbortController().signal

  const result = await environment.compactIfNeeded(agent, signal)

  assert.equal(result, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, agent)
  assert.equal(calls[0].trigger, 'pressure')
  assert.equal(calls[0].signal, signal)
})

test('a registry without serviceFor is the same as no service at all', async () => {
  const environment = createEnvironment(
    fakeCtx({ agentPresets: { composedPreset: () => 'cordis' } }),
    resolveConfig(),
  )

  await assert.rejects(
    () => environment.compactNow({ id: 'agent-1', runMaintenance() {} }, undefined),
    /compaction service is not composed/,
  )
})

test('a deployment without a compaction service cannot compact', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  await assert.rejects(
    () => environment.compactNow({ id: 'agent-1', runMaintenance() {} }, undefined),
    /compaction service is not composed/,
  )
})

test('a runner without a live agent is reported, not compacted by guess', async () => {
  const compaction = {
    async compactNow() {
      throw new Error('the service must not be called for a missing agent')
    },
  }
  const environment = createEnvironment(fakeCtx({ compaction }), resolveConfig())

  await assert.rejects(
    () => environment.compactNow({ sessionId: 'session-9', followup() {}, whenIdle() {} }, undefined),
    /session has no live agent/,
  )
})

test('a step compaction asks the service for pressure with the agent and the turn signal', async () => {
  const calls = []
  const agent = { id: 'agent-1' }
  const compaction = {
    async compactIfNeeded(target, trigger, signal) {
      calls.push({ target, trigger, signal })
      return null
    },
  }
  const environment = createEnvironment(fakeCtx({ compaction }), resolveConfig())
  const signal = new AbortController().signal

  const result = await environment.compactIfNeeded(agent, signal)

  // The threshold is the service's, so the seam passes the trigger and nothing
  // else: `null` ("not worth compacting") is a normal answer (design D7).
  assert.equal(result, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, agent)
  assert.equal(calls[0].trigger, 'pressure')
  assert.equal(calls[0].signal, signal)
})

test('a deployment without a compaction service cannot compact a step', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  await assert.rejects(
    () => environment.compactIfNeeded({ id: 'agent-1' }, undefined),
    /compaction service is not composed/,
  )
})
