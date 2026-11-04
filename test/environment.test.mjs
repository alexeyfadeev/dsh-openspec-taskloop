// Tests for the Cordis-facing seam (tasks 3.1–3.3, 4.2, 5.1–5.3, 6.1, 6.3, 7.3).
//
// The seam is small but decisive: which directory `openspec` runs in, which
// timeout the wrapper gets, whether the confirmation, the description question
// and the explore follow-up reach the session's services, which services open
// the session a run continues in at a group boundary, what the two compaction
// calls send to the service, where the commit input comes from — the message text
// and, for GitButler, the branch of the run (design D16/D18) — how that input is
// kept and dropped again, and which argv the commit tool is started with (4.2). A
// fake context exposes exactly the services the seam reads, so a lookup of the
// wrong service fails here instead of in a mounted profile.
//
// The session controller ends a turn as well (5.1, design D4 of the UI change): a pause
// and a stop ask it to cancel the turn of the session the run leads. That call is
// best-effort, and both halves are pinned here — the request it receives, and the log
// line a refusal leaves behind, with the pause it did not undo.

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { INIT_ANSWER, INIT_LABEL, INIT_QUESTION_ID } from '../lib/bootstrap.js'
import { COMMIT_END, runCommit } from '../lib/commit.js'
import { ANCHOR_QUESTION_ID, BRANCH_QUESTION_ID } from '../lib/commit-input.js'
import { COMMIT_MESSAGE_QUESTION_ID, COMMIT_TEXT } from '../lib/commit-text.js'
import { resolveConfig } from '../lib/config.js'
import { DIVERGENCE_ANSWER, DIVERGENCE_LABEL, DIVERGENCE_QUESTION_ID } from '../lib/diverged.js'
import { createEnvironment, resolveCwd } from '../lib/environment.js'
import {
  DESCRIPTION_QUESTION_ID,
  EXPLORE_ANSWER,
  EXPLORE_MODE_PROMPT,
  EXPLORE_SKILL_PATH,
  buildExplorePrompt,
} from '../lib/explore.js'
import { OpenSpecCli } from '../lib/openspec.js'
import { createRuns } from '../lib/runs.js'
import { readCommitMessage, stateFileOf, writeCommitMessage } from '../lib/state.js'

/**
 * A context that hands back the composed services and nothing else.
 *
 * @param {object} services - service name to instance.
 * @param {string[]} [warnings] - collects the lines the seam writes to the logger.
 * @returns {object} fake plugin context.
 */
function fakeCtx(services, warnings) {
  return {
    get: (name) => services[name],
    logger: {
      info() {},
      warn(line) {
        warnings?.push(line)
      },
    },
  }
}

/**
 * An agent whose session carries a header directory.
 *
 * @param {string} [cwd] - original project directory; omitted means "none recorded".
 * @returns {object} fake agent.
 */
const agentWith = (cwd) => ({ id: 'agent-1', session: { header: cwd === undefined ? {} : { cwd } } })

/** A task row as a fresh reading reports it; the number lives in the description. */
const DIVERGED_TASK = {
  id: '11',
  description: '11.4 Переписать обработчик возврата',
  done: false,
  sourcePath: 'openspec/changes/demo/tasks.md',
  line: 24,
}

/** The wording the run sent for that row, before the file changed under it. */
const SENT_WORDING = '11.4 Починить обработчик возврата'

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

test('the divergence question goes to the session user-questions service', async () => {
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return { answers: [{ id: DIVERGENCE_QUESTION_ID, selected: [DIVERGENCE_LABEL.continue] }] }
    },
  }
  const environment = createEnvironment(fakeCtx({ userQuestions: questions }), resolveConfig())
  const signal = new AbortController().signal
  const invocation = { agent: { id: 'agent-1' }, signal }

  const outcome = await environment.confirmDiverged(invocation, {
    change: 'demo',
    previous: SENT_WORDING,
    task: DIVERGED_TASK,
  })

  assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.continue })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].agent, invocation.agent)
  assert.equal(asked[0].signal, signal)
  const [card] = asked[0].questions
  assert.match(card.question, /11\.4/)
  assert.deepEqual(
    card.options.map((option) => option.label),
    [DIVERGENCE_LABEL.continue, DIVERGENCE_LABEL.stop],
  )
  assert.match(card.detail, new RegExp(`Было: ${SENT_WORDING}`))
  assert.match(card.detail, /Стало: 11\.4 Переписать/)
})

test('the divergence card stops the run when the user chooses to stop', async () => {
  const questions = {
    async ask() {
      return { answers: [{ id: DIVERGENCE_QUESTION_ID, selected: [DIVERGENCE_LABEL.stop] }] }
    },
  }
  const environment = createEnvironment(fakeCtx({ userQuestions: questions }), resolveConfig())

  const outcome = await environment.confirmDiverged(
    { agent: { id: 'agent-1' } },
    { change: 'demo', previous: SENT_WORDING, task: DIVERGED_TASK },
  )

  assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.stop })
})

test('without a user-questions service the divergence question is unavailable, never consent', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  const outcome = await environment.confirmDiverged(
    { agent: { id: 'agent-1' } },
    { change: 'demo', previous: SENT_WORDING, task: DIVERGED_TASK },
  )

  assert.deepEqual(outcome, { kind: DIVERGENCE_ANSWER.unavailable })
})

test('the run signal ends the divergence card, not the request one', async () => {
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return { answers: [] }
    },
  }
  const environment = createEnvironment(fakeCtx({ userQuestions: questions }), resolveConfig())
  const requestSignal = new AbortController().signal
  const runSignal = new AbortController().signal

  await environment.confirmDiverged(
    { agent: { id: 'agent-1' }, signal: requestSignal },
    { change: 'demo', previous: SENT_WORDING, task: DIVERGED_TASK, signal: runSignal },
  )

  assert.equal(asked.length, 1)
  assert.equal(asked[0].signal, runSignal)
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

test('the explore-mode follow-up goes to the invocation agent, once', () => {
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

  environment.followupExploreMode(invocation)

  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content[0].text, EXPLORE_MODE_PROMPT)
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

test('the turn of a session is cancelled through the session controller', async () => {
  const calls = []
  const environment = createEnvironment(fakeCtx({
    sessionController: {
      async cancel(request) {
        calls.push(request)
        return { cancelled: true }
      },
    },
  }), resolveConfig())

  assert.equal(await environment.cancelTurn('session-2'), true)
  // Addressed by session, not by agent: the same request the composer's stop button makes
  // (design D4), so a pause needs no live handle on the agent.
  assert.deepEqual(calls, [{ sessionId: 'session-2' }])
})

test('a refused cancellation is logged and leaves the pause in force', async () => {
  const warnings = []
  const runs = createRuns()
  const run = runs.start('add-a', { cwd: '/work/demo', sessionId: 'session-2' }).run
  const environment = createEnvironment(fakeCtx({
    sessionController: {
      async cancel() {
        throw new Error('session session-2 is not attached to a turn')
      },
    },
  }, warnings), resolveConfig())

  assert.equal(run.pause(), true)
  assert.equal(await environment.cancelTurn(run.sessionId), false)

  // Best-effort (design D4): what the service said changes nothing about the run. The
  // pause stands, the run was not stopped behind the user's back, and its own signal —
  // the only cancellation `/taskloop stop` uses — was not touched either.
  assert.equal(run.paused, true)
  assert.equal(run.stopped, false)
  assert.equal(run.signal.aborted, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /session session-2/u)
  assert.match(warnings[0], /is not attached to a turn/u)

  // Still releasable: `/taskloop resume` is what ends this pause, not the log line.
  assert.equal(run.resume(), true)
  assert.equal(run.paused, false)
})

test('a deployment without a session controller cannot cancel a turn, and says why', async () => {
  const warnings = []
  const environment = createEnvironment(fakeCtx({}, warnings), resolveConfig())

  assert.equal(await environment.cancelTurn('session-2'), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sessionController service is not composed/u)
})

test('a run that does not know its session asks the service for nothing', async () => {
  const calls = []
  const warnings = []
  const environment = createEnvironment(fakeCtx({
    sessionController: {
      async cancel(request) {
        calls.push(request)
      },
    },
  }, warnings), resolveConfig())

  assert.equal(await environment.cancelTurn(undefined), false)
  assert.equal(await environment.cancelTurn(''), false)
  assert.deepEqual(calls, [])
  // Nothing was asked, so there is nothing to report either.
  assert.deepEqual(warnings, [])
})

test('the review session denies approval prompts on its live agent', async () => {
  const calls = []
  const sessionAgent = { id: 'agent-2', async whenIdle() {} }
  const environment = createEnvironment(fakeCtx({
    approval: {
      setPolicy(target, policy) {
        calls.push({ target, policy })
      },
    },
    agents: { get: (id) => (id === 'session-2' ? sessionAgent : undefined) },
  }), resolveConfig())

  await environment.setApproval('session-2')

  // The policy goes on the agent of the review session, not on the invocation's:
  // that is the only session whose unattended turn needs it (task 3.2, design D14).
  assert.deepEqual(calls, [{ target: sessionAgent, policy: 'never' }])
})

test('without an approval service there is no one to ask, so nothing is switched', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  await environment.setApproval('session-2')
})

test('a review session without a live agent cannot deny approvals', async () => {
  const environment = createEnvironment(fakeCtx({
    approval: { setPolicy() {} },
  }), resolveConfig())

  await assert.rejects(() => environment.setApproval('session-2'), /has no live agent/u)
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

/** A reader whose whole retained text is `text`; the shape collect-mode stdio returns. */
const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })

/**
 * A handle the commit runner can settle.
 *
 * `hang` keeps `done` pending forever, which is how a command the stop cut short is
 * told apart from one the tool finished itself.
 *
 * @param {object} [options]
 * @param {number|null} [options.exitCode] - exit facts of a finished command.
 * @param {string} [options.stdout] - collected stdout.
 * @param {string} [options.stderr] - retained stderr.
 * @param {boolean} [options.hang] - never settle.
 * @returns {object} fake process handle.
 */
function handleOf({ exitCode = 0, stdout = '', stderr = '', hang = false } = {}) {
  const handle = {
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done: hang ? new Promise(() => {}) : Promise.resolve({ exitCode, signal: null }),
    terminated: 0,
    terminate() {
      handle.terminated += 1
    },
  }
  return handle
}

/**
 * A fake `ctx.subprocess` that records the executable lookups and the spawn specs.
 *
 * @param {object} [options]
 * @param {string|Error} [options.executable] - resolved path, or the lookup failure.
 * @param {(spec: object) => object} [options.spawn] - handle factory.
 * @returns {object} fake subprocess service.
 */
function fakeToolSubprocess({ executable = '/usr/local/bin/git', spawn = () => handleOf() } = {}) {
  const calls = { resolve: [], spawn: [] }
  return {
    calls,
    async resolveExecutable(command, env, signal) {
      calls.resolve.push({ command, env, signal })
      if (executable instanceof Error) throw executable
      return executable
    },
    spawn(spec) {
      calls.spawn.push(spec)
      return spawn(spec)
    },
  }
}

test('the commit tool is started with the message as one argv element', async () => {
  const message = 'Добавить эндпоинт. Tasks 2.1 - 2.4'
  const subprocess = fakeToolSubprocess({
    executable: 'C:\\Program Files\\Git\\cmd\\git.exe',
    spawn: () => handleOf({ stdout: '[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n 2 files changed\n' }),
  })
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  const result = await environment.runCommitCommand(
    { executable: 'git', args: ['commit', '-m', message] },
    { cwd: '/work/demo' },
  )

  assert.equal(subprocess.calls.resolve[0].command, 'git')
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /\[main 1a2b3c4\]/)
  assert.equal(result.stderr, '')

  const spec = subprocess.calls.spawn[0]
  assert.deepEqual(spec.argv, ['C:\\Program Files\\Git\\cmd\\git.exe', 'commit', '-m', message])
  assert.equal(spec.cwd, '/work/demo')
  assert.equal(spec.stdio.stdin, 'ignore')
  assert.ok(spec.graceMs > 0)
  // Argv only: no command line and no shell, so the host starts exactly these
  // elements and the message can never be re-split into further words (design D15).
  assert.equal('shell' in spec, false)
  assert.equal('command' in spec, false)
  assert.equal(spec.signal, undefined)
})

test('punctuation in the message reaches the tool as text', async () => {
  const message = 'fix: "quotes" & $(rm -rf /) ; echo hi'
  const subprocess = fakeToolSubprocess()
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  await environment.runCommitCommand({ executable: 'git', args: ['commit', '-m', message] }, { cwd: '/repo' })

  const spec = subprocess.calls.spawn[0]
  assert.deepEqual(spec.argv, ['/usr/local/bin/git', 'commit', '-m', message])
  assert.equal(spec.argv[3], message)
})

test('a tool that is not on PATH rejects with the command it could not run', async () => {
  const missing = Object.assign(new Error('spawn git ENOENT'), { name: 'SubprocessExecutableNotFoundError' })
  const subprocess = fakeToolSubprocess({ executable: missing })
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  await assert.rejects(
    () => environment.runCommitCommand({ executable: 'git', args: ['status', '--porcelain'] }, { cwd: '/repo' }),
    (error) => {
      assert.match(error.message, /git status cannot run/)
      assert.match(error.message, /git was not found/)
      assert.match(error.message, /ENOENT/)
      return true
    },
  )
  assert.equal(subprocess.calls.spawn.length, 0)
})

test('a spawn failure is reported with the command that could not start', async () => {
  const subprocess = fakeToolSubprocess({
    spawn() {
      throw new Error('EMFILE: too many open files')
    },
  })
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  await assert.rejects(
    () => environment.runCommitCommand({ executable: 'git', args: ['add', '-A'] }, { cwd: '/repo' }),
    /git add could not start: EMFILE/,
  )
})

test('the runner refuses a request that is not one command', async () => {
  const subprocess = fakeToolSubprocess()
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  await assert.rejects(
    () => environment.runCommitCommand({ executable: 'git', args: 'commit -m x' }, { cwd: '/repo' }),
    /requires a request with an executable and an args array/,
  )
  assert.equal(subprocess.calls.spawn.length, 0)
})

test('a refused commit comes back as data, with the tool and its exit code', async () => {
  // The seam's whole contract in one test: the status check says there is work,
  // `add` succeeds, `git commit` refuses — and that refusal is an outcome a report
  // can quote, not an exception that fails the run (design D15/D17).
  const subprocess = fakeToolSubprocess({
    spawn: (spec) => {
      if (spec.argv[1] === 'status') return handleOf({ stdout: ' M lib/loop.js\n' })
      if (spec.argv[1] === 'add') return handleOf()
      return handleOf({ exitCode: 128, stderr: 'fatal: not a git repository\n' })
    },
  })
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  const outcome = await runCommit({
    tool: 'git',
    text: 'Добавить эндпоинт',
    range: { from: '2.1', to: '2.4' },
    cwd: '/repo',
    run: environment.runCommitCommand,
  })

  assert.equal(outcome.kind, COMMIT_END.failed)
  assert.equal(outcome.tool, 'git')
  assert.equal(outcome.message, 'Добавить эндпоинт. Tasks 2.1 - 2.4')
  assert.equal(outcome.command, 'git commit')
  assert.equal(outcome.exitCode, 128)
  assert.match(outcome.reason, /fatal: not a git repository/)
})

test('a clean tree ends the commit before any command that changes it', async () => {
  const subprocess = fakeToolSubprocess({ spawn: () => handleOf({ stdout: '\n' }) })
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  const outcome = await runCommit({
    tool: 'git',
    text: 'Добавить эндпоинт',
    cwd: '/repo',
    run: environment.runCommitCommand,
  })

  assert.equal(outcome.kind, COMMIT_END.empty)
  assert.deepEqual(subprocess.calls.spawn.map((spec) => spec.argv.slice(1)), [['status', '--porcelain', '-z', '-uall']])
})

test('a stop terminates the tool and ends the commit as stopped, not as a refusal', async () => {
  const controller = new AbortController()
  let commitHandle
  const subprocess = fakeToolSubprocess({
    spawn: (spec) => {
      if (spec.argv[1] === 'status') return handleOf({ stdout: ' M lib/loop.js\n' })
      if (spec.argv[1] === 'add') return handleOf()
      commitHandle = handleOf({ hang: true })
      setTimeout(() => controller.abort(), 0)
      return commitHandle
    },
  })
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  const outcome = await runCommit({
    tool: 'git',
    text: 'Добавить эндпоинт',
    cwd: '/repo',
    signal: controller.signal,
    run: environment.runCommitCommand,
  })

  assert.equal(outcome.kind, COMMIT_END.stopped)
  // The abandoned wait is made real by terminating the managed process.
  assert.equal(commitHandle.terminated, 1)
})

test('a stop that landed before the commit starts runs nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  const subprocess = fakeToolSubprocess()
  const environment = createEnvironment(fakeCtx({ subprocess }), resolveConfig())

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: 'Добавить эндпоинт',
    cwd: '/repo',
    signal: controller.signal,
    run: environment.runCommitCommand,
  })

  assert.equal(outcome.kind, COMMIT_END.stopped)
  assert.equal(subprocess.calls.resolve.length, 0)
  assert.equal(subprocess.calls.spawn.length, 0)
})

test('a deployment without a subprocess service cannot commit', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  await assert.rejects(
    () => environment.runCommitCommand({ executable: 'git', args: ['commit', '-m', 'x'] }, { cwd: '/repo' }),
    /subprocess service is not composed/,
  )
})

/**
 * An empty directory to use as `profileContext.home`, removed when the test ends.
 *
 * @param {object} t - node:test context.
 * @returns {Promise<string>} path of the temporary harness home.
 */
async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'openspec-taskloop-env-'))
  t.after(async () => {
    await rm(home, { recursive: true, force: true })
  })
  return home
}

/**
 * The answer shape a question service returns for free text.
 *
 * @param {string} custom - text the user typed.
 * @returns {object} the `ctx.userQuestions` answer.
 */
const messageAnswer = (custom) => ({ answers: [{ id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom }] })

test('the stored message of a change is used and the question is not asked', async (t) => {
  const home = await temporaryHome(t)
  await writeCommitMessage({ home, cwd: '/repo', change: 'demo', message: 'Добавить эндпоинт' })
  const questions = {
    async ask() {
      throw new Error('the stored text must not be asked for again')
    },
  }
  const environment = createEnvironment(
    fakeCtx({ profileContext: { home }, userQuestions: questions }),
    resolveConfig(),
  )

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'git' },
  )

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' })
})

test('a change without a stored message is asked once and the answer is kept', async (t) => {
  const home = await temporaryHome(t)
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return messageAnswer('  Добавить эндпоинт  ')
    },
  }
  const environment = createEnvironment(
    fakeCtx({ profileContext: { home }, userQuestions: questions }),
    resolveConfig(),
  )
  const invocation = { agent: { id: 'agent-1' }, signal: new AbortController().signal }

  const outcome = await environment.commitInput(invocation, { change: 'demo', cwd: '/repo', tool: 'git' })

  // Trimmed once, so the run commits with the same string the next run reads back.
  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].agent, invocation.agent)
  assert.equal(asked[0].signal, invocation.signal)
  assert.equal(asked[0].questions[0].id, COMMIT_MESSAGE_QUESTION_ID)
  // Stored straight away: a run stopped after this point must not ask again (design D16).
  assert.equal(await readCommitMessage({ home, cwd: '/repo', change: 'demo' }), 'Добавить эндпоинт')

  // The next run of the same change reads it back instead of asking again.
  const second = createEnvironment(
    fakeCtx({
      profileContext: { home },
      userQuestions: {
        async ask() {
          throw new Error('the second run asked again')
        },
      },
    }),
    resolveConfig(),
  )
  assert.deepEqual(
    await second.commitInput(invocation, { change: 'demo', cwd: '/repo', tool: 'git' }),
    { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' },
  )
})

test('a dismissed question is a refusal and stores nothing', async (t) => {
  const home = await temporaryHome(t)
  const questions = {
    async ask() {
      const error = new Error('dismissed')
      error.code = 'ASK_CANCELLED'
      throw error
    },
  }
  const environment = createEnvironment(
    fakeCtx({ profileContext: { home }, userQuestions: questions }),
    resolveConfig(),
  )

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'git' },
  )

  // The refusal names the question it was: a dismissed message is not a dismissed branch.
  assert.deepEqual(outcome, { kind: COMMIT_TEXT.cancelled, step: 'message' })
  // Nothing is kept: the run that would have used the text never started (5.2).
  assert.equal(await readCommitMessage({ home, cwd: '/repo', change: 'demo' }), undefined)
  await assert.rejects(() => access(stateFileOf(home)), /ENOENT/)
})

test('a session with no question channel has no message and writes no state', async (t) => {
  const home = await temporaryHome(t)
  const environment = createEnvironment(fakeCtx({ profileContext: { home } }), resolveConfig())

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'git' },
  )

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.unavailable })
  await assert.rejects(() => access(stateFileOf(home)), /ENOENT/)
})

test('a host without a profile home still asks and uses the answer for the run', async () => {
  const questions = { async ask() { return messageAnswer('Добавить эндпоинт') } }
  const environment = createEnvironment(fakeCtx({ userQuestions: questions }), resolveConfig())

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' } },
    { change: 'demo', cwd: '/repo', tool: 'git' },
  )

  // Nowhere documented to keep the text: the run commits with the answer, and the next
  // one asks again — better than refusing to commit in a host that has no harness home.
  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' })
})

test('a state file that cannot be read is reported before the question is asked', async (t) => {
  const home = await temporaryHome(t)
  // A directory where the file belongs: reading it fails with EISDIR, which is not
  // "nothing stored" and must not be answered with a question.
  await mkdir(stateFileOf(home), { recursive: true })
  const asked = []
  const questions = {
    async ask() {
      asked.push('text')
      return messageAnswer('Добавить эндпоинт')
    },
  }
  const environment = createEnvironment(
    fakeCtx({ profileContext: { home }, userQuestions: questions }),
    resolveConfig(),
  )

  await assert.rejects(
    () => environment.commitInput(
      { agent: { id: 'agent-1' }, signal: new AbortController().signal },
      { change: 'demo', cwd: '/repo', tool: 'git' },
    ),
    (error) => error.code === 'EISDIR',
  )
  assert.deepEqual(asked, [])
})

test('a finished change drops its text, so the next run asks again', async (t) => {
  const home = await temporaryHome(t)
  const asked = []
  const questions = {
    async ask() {
      asked.push('text')
      return messageAnswer('Добавить эндпоинт')
    },
  }
  const environment = createEnvironment(
    fakeCtx({ profileContext: { home }, userQuestions: questions }),
    resolveConfig(),
  )
  const invocation = { agent: { id: 'agent-1' }, signal: new AbortController().signal }

  assert.deepEqual(
    await environment.commitInput(invocation, { change: 'demo', cwd: '/repo', tool: 'git' }),
    { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' },
  )
  // A second change of the same project keeps its own record across the deletion.
  await writeCommitMessage({ home, cwd: '/repo', change: 'other', message: 'Починить вход' })

  await environment.forgetCommitText({ change: 'demo', cwd: '/repo' })

  assert.equal(await readCommitMessage({ home, cwd: '/repo', change: 'demo' }), undefined)
  assert.equal(await readCommitMessage({ home, cwd: '/repo', change: 'other' }), 'Починить вход')

  // The point of dropping it (5.3): the next run of the finished change asks again.
  const questionsAgain = {
    async ask() {
      asked.push('text')
      return messageAnswer('Следующая задача')
    },
  }
  const next = createEnvironment(
    fakeCtx({ profileContext: { home }, userQuestions: questionsAgain }),
    resolveConfig(),
  )
  assert.deepEqual(
    await next.commitInput(invocation, { change: 'demo', cwd: '/repo', tool: 'git' }),
    { kind: COMMIT_TEXT.text, text: 'Следующая задача' },
  )
  assert.equal(asked.length, 2)
})

test('dropping the text of a change that has none writes nothing', async (t) => {
  const home = await temporaryHome(t)
  const environment = createEnvironment(fakeCtx({ profileContext: { home } }), resolveConfig())

  await environment.forgetCommitText({ change: 'demo', cwd: '/repo' })

  // Cleaning up is not a reason to create the state file (5.3).
  await assert.rejects(() => access(stateFileOf(home)), /ENOENT/)
})

test('a host without a profile home has no stored text to drop', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  // Nowhere documented to keep it, so nothing to remove and nothing to fail on.
  await environment.forgetCommitText({ change: 'demo', cwd: '/repo' })
})

/** A `but status --json` document listing two applied branches (D18). */
const BUT_STATUS_JSON = JSON.stringify({
  stacks: [
    { id: 0, branches: [{ name: 'feature-a', cliId: 'b1' }, { name: 'feature-b', cliId: 'b2' }] },
  ],
})

/**
 * A spawn factory for a GitButler run: answers `but --version` with a supported version
 * (task 3.2) and the branch listing for every other read.
 *
 * The version gate sits at the top of the card, so a GitButler test that wants to reach
 * the branch question first has to get past it. Tests that assert a *refused* version
 * build their own spawn instead and never reach `status`.
 *
 * @param {object} [statusHandle] - handle the `but status --json` read settles with.
 * @returns {(spec: object) => object} the spawn factory.
 */
const butSpawn = (statusHandle = handleOf({ stdout: BUT_STATUS_JSON })) => (spec) => (
  spec.argv[1] === '--version' ? handleOf({ stdout: 'but 0.22.3\n' }) : statusHandle
)

/**
 * An answer to the one card of a GitButler run: the message and the branch.
 *
 * @param {string} [text] - message text the user typed.
 * @param {object} [branch] - `selected` labels and/or `custom` text for the branch question.
 * @returns {object} the `ctx.userQuestions` answer.
 */
const inputAnswer = (text = 'Добавить эндпоинт', branch = { selected: ['feature-a'] }) => ({
  answers: [
    { id: COMMIT_MESSAGE_QUESTION_ID, selected: [], custom: text },
    { id: BRANCH_QUESTION_ID, selected: branch.selected ?? [], ...(branch.custom === undefined ? {} : { custom: branch.custom }) },
  ],
})

test('a GitButler run reads the branches and asks for both halves in one card', async () => {
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: butSpawn(),
  })
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return inputAnswer('Добавить эндпоинт', { selected: ['feature-b'] })
    },
  }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())
  const signal = new AbortController().signal

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal },
    { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
  )

  // One card for the message and the branch, and one read of the listing behind it.
  assert.equal(asked.length, 1)
  assert.deepEqual(
    asked[0].questions.map((question) => question.id),
    [COMMIT_MESSAGE_QUESTION_ID, BRANCH_QUESTION_ID],
  )
  assert.deepEqual(asked[0].questions[1].options.map((option) => option.label), ['feature-a', 'feature-b'])
  // The listing is an argv request without a shell, in the project directory.
  assert.equal(subprocess.calls.resolve[0].command, 'but')
  // The version gate answered first (`--version`), then the branch listing.
  assert.deepEqual(
    subprocess.calls.spawn.map((spec) => spec.argv.slice(1)),
    [['--version'], ['status', '--json']],
  )
  assert.equal(subprocess.calls.spawn[1].cwd, '/repo')
  assert.equal(subprocess.calls.spawn[1].signal, signal)
  assert.deepEqual(outcome, {
    kind: COMMIT_TEXT.text,
    text: 'Добавить эндпоинт',
    branch: { name: 'feature-b', exists: true },
  })
})

test('a new branch name asks for its anchor and comes back as a plan to create', async () => {
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: butSpawn(),
  })
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      if (asked.length === 1) return inputAnswer('Добавить эндпоинт', { custom: 'feature-c' })
      return { answers: [{ id: ANCHOR_QUESTION_ID, selected: ['feature-a'] }] }
    },
  }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
  )

  assert.equal(asked.length, 2)
  assert.deepEqual(asked[1].questions.map((question) => question.id), [ANCHOR_QUESTION_ID])
  // `exists: false` is what makes `but branch new` run at the first non-empty commit.
  assert.deepEqual(outcome.branch, { name: 'feature-c', anchor: 'feature-a', exists: false })
})

test('a refused branch question starts nothing and stores nothing', async (t) => {
  const home = await temporaryHome(t)
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: butSpawn(),
  })
  const questions = {
    async ask() {
      return inputAnswer('Добавить эндпоинт', { selected: [] })
    },
  }
  const environment = createEnvironment(
    fakeCtx({ profileContext: { home }, subprocess, userQuestions: questions }),
    resolveConfig(),
  )

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
  )

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.cancelled, step: 'branch' })
  // The text that came with the refused card is not kept: no run will use it.
  await assert.rejects(() => access(stateFileOf(home)), /ENOENT/)
})

test('a failing but status stops the command before the first task and carries the hint', async () => {
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: butSpawn(handleOf({ exitCode: 1, stderr: 'fatal: this directory is not a GitButler project\n' })),
  })
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return inputAnswer()
    },
  }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  await assert.rejects(
    () => environment.commitInput(
      { agent: { id: 'agent-1' }, signal: new AbortController().signal },
      { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
    ),
    (error) => {
      assert.match(error.message, /but status --json failed with exit code 1/u)
      assert.match(error.message, /not a GitButler project/u)
      assert.match(error.message, /but setup/u)
      return true
    },
  )
  // The user is not asked anything they could not answer: the run stops here (D18).
  assert.deepEqual(asked, [])
})

test('a but status that prints no JSON is a failure, not a project without branches', async () => {
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: butSpawn(handleOf({ stdout: 'Logging in…\n' })),
  })
  // A question channel, because a listing nobody could be asked about is not read (D18).
  const questions = { async ask() { return inputAnswer() } }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  await assert.rejects(
    () => environment.commitInput(
      { agent: { id: 'agent-1' }, signal: new AbortController().signal },
      { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
    ),
    (error) => {
      // An empty list would mean "create the first branch", which is a very different
      // thing to do with a project GitButler does not know.
      assert.match(error.message, /did not print JSON/u)
      assert.match(error.message, /but setup/u)
      return true
    },
  )
})

test('a git run reads no branch listing and asks for the message alone', async () => {
  const subprocess = fakeToolSubprocess()
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return messageAnswer('Добавить эндпоинт')
    },
  }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'git' },
  )

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' })
  assert.deepEqual(asked[0].questions.map((question) => question.id), [COMMIT_MESSAGE_QUESTION_ID])
  // `git` has no branches to choose, so the tool is not started at all before the run.
  assert.equal(subprocess.calls.spawn.length, 0)
})

test('a GitButler run with a current version passes the gate and reads the listing', async () => {
  // The gate's happy path (spec "Версия актуальна"): `0.22.0` itself, the floor, is enough.
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: (spec) => (
      spec.argv[1] === '--version' ? handleOf({ stdout: 'but 0.22.0\n' }) : handleOf({ stdout: BUT_STATUS_JSON })
    ),
  })
  const questions = { async ask() { return inputAnswer() } }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
  )

  assert.deepEqual(outcome, {
    kind: COMMIT_TEXT.text,
    text: 'Добавить эндпоинт',
    branch: { name: 'feature-a', exists: true },
  })
  // The version is read once, before the listing.
  assert.deepEqual(
    subprocess.calls.spawn.map((spec) => spec.argv.slice(1)),
    [['--version'], ['status', '--json']],
  )
})

test('a GitButler version below the minimum stops the run with the update advice', async () => {
  // Spec "Версия ниже минимальной": the command names `0.22.0` and asks to update.
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: (spec) => (
      spec.argv[1] === '--version' ? handleOf({ stdout: 'but 0.21.0\n' }) : handleOf({ stdout: BUT_STATUS_JSON })
    ),
  })
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return inputAnswer()
    },
  }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  await assert.rejects(
    () => environment.commitInput(
      { agent: { id: 'agent-1' }, signal: new AbortController().signal },
      { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
    ),
    (error) => {
      assert.match(error.message, /0\.21\.0/u)
      assert.match(error.message, /0\.22\.0/u)
      assert.match(error.message, /update GitButler/u)
      return true
    },
  )
  // Nothing was asked and no listing was read: the gate stopped before the card.
  assert.deepEqual(asked, [])
  assert.deepEqual(subprocess.calls.spawn.map((spec) => spec.argv.slice(1)), [['--version']])
})

test('a but --version that answers no version stops the run unrecognized', async () => {
  // Spec "Версия не распознана": output without an X.Y.Z stops the run.
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: (spec) => (
      spec.argv[1] === '--version' ? handleOf({ stdout: 'but: unknown version\n' }) : handleOf({ stdout: BUT_STATUS_JSON })
    ),
  })
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return inputAnswer()
    },
  }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  await assert.rejects(
    () => environment.commitInput(
      { agent: { id: 'agent-1' }, signal: new AbortController().signal },
      { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
    ),
    (error) => {
      assert.match(error.message, /no X\.Y\.Z version/u)
      assert.match(error.message, /0\.22\.0/u)
      assert.match(error.message, /update GitButler/u)
      return true
    },
  )
  assert.deepEqual(asked, [])
  assert.deepEqual(subprocess.calls.spawn.map((spec) => spec.argv.slice(1)), [['--version']])
})

test('a failing but --version stops the run unrecognized with the tool output', async () => {
  // Spec "Версия не распознана": a command that failed has not confirmed the version (fail-closed).
  const subprocess = fakeToolSubprocess({
    executable: '/usr/local/bin/but',
    spawn: (spec) => (
      spec.argv[1] === '--version'
        ? handleOf({ exitCode: 1, stderr: 'but: not found in this shell\n' })
        : handleOf({ stdout: BUT_STATUS_JSON })
    ),
  })
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return inputAnswer()
    },
  }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  await assert.rejects(
    () => environment.commitInput(
      { agent: { id: 'agent-1' }, signal: new AbortController().signal },
      { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
    ),
    (error) => {
      assert.match(error.message, /but --version failed with exit code 1/u)
      assert.match(error.message, /not found in this shell/u)
      assert.match(error.message, /update GitButler/u)
      return true
    },
  )
  assert.deepEqual(asked, [])
})

test('a git run never reads the GitButler version', async () => {
  // Spec "Проверка не нужна для git": a git commit touches `but` at no point, so the
  // gate is not even asked. A `but --version` that answers nothing would fail a run
  // that calls it; here the subprocess is empty and the run is unaffected.
  const subprocess = fakeToolSubprocess()
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return messageAnswer('Добавить эндпоинт')
    },
  }
  const environment = createEnvironment(fakeCtx({ subprocess, userQuestions: questions }), resolveConfig())

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'git' },
  )

  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' })
  assert.equal(asked.length, 1)
  // No `but --version`, no `but status`: the tool is never started.
  assert.equal(subprocess.calls.spawn.length, 0)
})

test('a stored message with no question channel reads no listing and names no branch', async (t) => {
  const home = await temporaryHome(t)
  await writeCommitMessage({ home, cwd: '/repo', change: 'demo', message: 'Добавить эндпоинт' })
  const subprocess = fakeToolSubprocess({ spawn: butSpawn() })
  const environment = createEnvironment(fakeCtx({ profileContext: { home }, subprocess }), resolveConfig())

  const outcome = await environment.commitInput(
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
    { change: 'demo', cwd: '/repo', tool: 'gitbutler' },
  )

  // The headless fallback of D18: no branch question, so no `but status` to ask from.
  // The version gate still runs first (task 3.2) — a run that will commit with `but`
  // must confirm the tool it is about to use, even with nobody to ask a question.
  assert.deepEqual(outcome, { kind: COMMIT_TEXT.text, text: 'Добавить эндпоинт' })
  assert.deepEqual(subprocess.calls.spawn.map((spec) => spec.argv.slice(1)), [['--version']])
})

test('a commit line is appended to the session that drove the finished group', async () => {
  const appended = []
  const agent = {
    id: 'agent-1',
    session: {
      append(type, message, options) {
        appended.push({ type, message, options })
      },
    },
  }
  const environment = createEnvironment(fakeCtx({}), resolveConfig())
  const text = 'taskloop: commit 1a2b3c4 for tasks 2.1 - 2.4 (git).'

  assert.equal(await environment.appendNotice(agent, text), true)
  assert.equal(appended.length, 1)
  // A notice, not a turn: the same shape the report of a run outlived by its request
  // uses, so the transcript shows it and no model turn is started for it.
  assert.equal(appended[0].type, 'user/message')
  assert.deepEqual(appended[0].options, { surfaceOp: 'append' })
  assert.equal(appended[0].message.source.kind, 'runtime-context')
  assert.equal(appended[0].message.source.form, 'notice')
  assert.equal(appended[0].message.content[0].text, text)
})

test('a session runner is traced back to the agent that owns its transcript', async () => {
  const appended = []
  const agent = { id: 'session-2-agent', session: { append: (...args) => appended.push(args) } }
  const environment = createEnvironment(
    fakeCtx({ agents: { get: (id) => (id === 'session-2' ? agent : undefined) } }),
    resolveConfig(),
  )

  assert.equal(await environment.appendNotice({ sessionId: 'session-2' }, 'taskloop: commit 1a2b3c4.'), true)
  assert.equal(appended.length, 1)
  assert.equal(appended[0][1].content[0].text, 'taskloop: commit 1a2b3c4.')
})

test('a session that cannot take a line answers false instead of failing the run', async () => {
  const environment = createEnvironment(fakeCtx({}), resolveConfig())

  // A runner whose session cannot be resolved, and an agent with no session at all.
  assert.equal(await environment.appendNotice({ sessionId: 'gone' }, 'taskloop: commit 1a2b3c4.'), false)
  assert.equal(await environment.appendNotice({ id: 'agent-without-session' }, 'x'), false)
})
