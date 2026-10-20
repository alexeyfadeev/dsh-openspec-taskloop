// Tests for the Cordis-facing seam (tasks 3.1–3.2).
//
// The seam is small but decisive: which directory `openspec` runs in, which
// timeout the wrapper gets, and whether the confirmation reaches the session's
// question service. A fake context exposes exactly the services the seam reads,
// so a lookup of the wrong service fails here instead of in a mounted profile.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { INIT_ANSWER, INIT_LABEL, INIT_QUESTION_ID } from '../lib/bootstrap.js'
import { resolveConfig } from '../lib/config.js'
import { createEnvironment, resolveCwd } from '../lib/environment.js'
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
