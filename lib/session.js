// dsh-openspec-taskloop — a session opened at a group boundary (task 5.1).
//
// A run starts in the session the user typed `/taskloop` in, and stays there
// while tasks share a group. On the step into another group the run does not
// carry on in that session: design D6 has it ask `sessionController.create` for a
// fresh session in the same workspace — or in the same directory when the session
// belongs to none — and drive the first task of the new group there with
// `sessionController.prompt`. The invoking session keeps only the final report.
//
//     create({workspaceId|cwd, agentPreset}) ──▶ session id ──▶ runner
//                                                                 │
//                            followup(message) ──▶ prompt(request)
//                            whenIdle()        ──▶ prompt settled, then the agent's idle
//
// The controller is used instead of `agents.create` because it also binds the
// session to a workspace; a session created by other means would not appear in
// the sidebar, and doing the binding by hand would duplicate the controller's own
// logic. The preset is inherited from the source session when it is known, so the
// new session runs the same protocol as the one it continues.
//
// The runner speaks the same two methods as an agent — `followup()` and
// `whenIdle()` — so the step (`lib/step.js`) and the loop (`lib/loop.js`) do not
// learn a second way of sending a task or of waiting for its turn.
//
// A run that carries the optional protocol section (5.2) hands the session an
// `adoptAgent(agent)` callback: the new agent is the one that must receive the
// section, and the session is the only place that meets that agent. The callback
// runs as soon as the agent is resolved — before the first task where possible,
// from `whenIdle()` otherwise — and `lib/protocol.js` owns the section itself.
//
// Everything here is a plain function of its dependencies, so the whole handoff
// is testable with a fake controller and no host: that is what task 5.1 asks for,
// and it is how the request shapes below were pinned down before 7.1/7.2 exercise
// them against the real service.

import { randomUUID } from 'node:crypto'

/**
 * The request `sessionController.create` receives.
 *
 * `workspaceId` wins when the session belongs to a workspace, because only that
 * shape puts the session in the sidebar; `cwd` is the documented fallback for a
 * session without one (design D6, risk "Сессия без workspace"). The preset is
 * omitted rather than sent as `undefined`, so a deployment whose controller
 * validates the field sees a request it can accept.
 *
 * @param {object} options
 * @param {string} options.cwd - project directory the new session should work in.
 * @param {string} [options.workspaceId] - workspace of the source session, when it has one.
 * @param {string} [options.agentPreset] - preset inherited from the source session, when known.
 * @returns {{workspaceId?: string, cwd?: string, agentPreset?: string}} the create request.
 * @throws {TypeError} when neither a workspace nor a directory can address the session.
 */
export function sessionRequest({ cwd, workspaceId, agentPreset }) {
  /** @type {{workspaceId?: string, cwd?: string, agentPreset?: string}} */
  const request = {}
  if (typeof workspaceId === 'string' && workspaceId !== '') {
    request.workspaceId = workspaceId
  } else if (typeof cwd === 'string' && cwd !== '') {
    request.cwd = cwd
  } else {
    throw new TypeError('sessionRequest requires a workspaceId or a cwd')
  }
  if (typeof agentPreset === 'string' && agentPreset !== '') {
    request.agentPreset = agentPreset
  }
  return request
}

/**
 * The request `sessionController.prompt` receives for one task message.
 *
 * The controller's contract (`SessionPromptRequest`) is a request envelope, not
 * just content: `requestId` makes the admission idempotent on the session's side,
 * `mode` says whether the prompt queues behind the current turn or steers it, and
 * only then follows the content. Every task message the run sends through the
 * controller is a one-shot request, so it gets its own id and `'queue'` — a step
 * is never a steering instruction, and a fresh session has no turn to steer.
 *
 * The content blocks are the ones the step built, so the session log of a handoff
 * reads exactly like a task sent in place.
 *
 * @param {string} sessionId - session the task runs in.
 * @param {object} message - user message built by the step.
 * @param {string} [requestId] - admission id; a fresh one per call by default.
 * @returns {{requestId: string, sessionId: string, mode: 'queue', content: object[]}} the prompt request.
 * @throws {TypeError} when the session or the message content is not usable.
 */
export function promptRequest(sessionId, message, requestId = randomUUID()) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('promptRequest requires the session id')
  }
  if (!Array.isArray(message?.content) || message.content.length === 0) {
    throw new TypeError('promptRequest requires the message content')
  }
  return { requestId, sessionId, mode: 'queue', content: message.content }
}

/**
 * The id of the session `create` answered with.
 *
 * `SessionCreateValue` is a Remote value type the plugin cannot enumerate at
 * build time; the shapes below are the plausible carriers of the id, and a value
 * without one is refused instead of being guessed at — continuing in the wrong
 * session would be worse than stopping with an explanation.
 *
 * @param {unknown} value - value returned by `sessionController.create`.
 * @returns {string} the new session id.
 * @throws {Error} when the value carries no session id.
 */
export function sessionIdOf(value) {
  const candidates = [
    value?.sessionId,
    value?.session?.id,
    value?.session?.sessionId,
    value?.id,
  ]
  const id = candidates.find((candidate) => typeof candidate === 'string' && candidate !== '')
  if (id === undefined) throw new Error('the session controller returned no session id')
  return id
}

/**
 * A session that accepts task messages through the controller.
 *
 * The runner is the loop's counterpart of an agent: `followup()` hands the
 * message to `sessionController.prompt` and `whenIdle()` resolves once the
 * prompt was accepted *and* the session's agent went quiet — the order matters,
 * because waiting for idleness before the prompt is queued would return at once
 * and let the loop read `tasks.md` in the middle of the turn.
 *
 * The prompt's outcome is captured rather than left pending: `whenIdle()` may be
 * abandoned when a stop wins the race in `lib/loop.js`, and a rejection nobody
 * observes must not take the process down. The failure resurfaces from
 * `whenIdle()` when the loop is still waiting.
 *
 * @param {object} options
 * @param {{prompt: Function}} options.controller - the session controller.
 * @param {string} options.sessionId - session the messages go to.
 * @param {AbortSignal} [options.signal] - cancellation of the invocation that opened the session.
 * @param {(sessionId: string) => (object|Promise<object|undefined>)} [options.resolveAgent] - looks up
 *   the live agent of the session; when absent the runner only waits for the prompt.
 * @param {(agent: object) => void} [options.adoptAgent] - called once the session's agent is known,
 *   so a run can register its protocol section on that agent (5.2).
 * @param {object} [options.knownAgent] - agent the caller already resolved; adopted at construction.
 * @returns {{sessionId: string, followup: Function, whenIdle: Function}} the runner.
 * @throws {TypeError} when the controller or the session id is not usable.
 */
export function createSessionRunner({ controller, sessionId, signal, resolveAgent, adoptAgent, knownAgent }) {
  if (typeof controller?.prompt !== 'function') {
    throw new TypeError('createSessionRunner requires a session controller with prompt()')
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('createSessionRunner requires the session id')
  }

  /** @type {Promise<{ok: true, value: unknown}|{ok: false, error: unknown}>|undefined} */
  let turn
  /** The agent already handed to the run; see {@link adoptAgent}. */
  let adopted

  /**
   * Hand the resolved agent to the run that opened the session, once per agent.
   *
   * The same agent is met twice — when the session is opened and when its turn
   * is awaited — and the run's tracker is idempotent per scope, but a distinct
   * agent must still be adopted: it is the one whose turn will be waited for.
   *
   * @param {object} agent - the session's live agent.
   * @returns {void}
   */
  const adopt = (agent) => {
    if (typeof adoptAgent !== 'function' || agent === adopted) return
    adopted = agent
    adoptAgent(agent)
  }

  if (knownAgent !== undefined && knownAgent !== null) adopt(knownAgent)

  return {
    sessionId,

    /**
     * Send one task message to the session.
     *
     * Called synchronously by the step, so the call itself is not awaited: the
     * turn is started here and its outcome is settled in `whenIdle()`.
     *
     * @param {object} message - user message built by the step.
     * @returns {object} the message, as `followup()` would.
     */
    followup(message) {
      const request = promptRequest(sessionId, message)
      turn = controller.prompt(request, signal).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
      return message
    },

    /**
     * Wait for the turn the last message started.
     *
     * @returns {Promise<void>} resolves once the session is quiet.
     * @throws {Error} when the prompt could not be started or no agent can report idleness.
     */
    async whenIdle() {
      const started = turn
      turn = undefined
      if (started !== undefined) {
        const receipt = await started
        if (!receipt.ok) {
          throw new Error(`session ${sessionId} could not start the turn: ${describe(receipt.error)}`)
        }
      }
      if (typeof resolveAgent !== 'function') return

      const agent = await resolveAgent(sessionId)
      if (agent === undefined || agent === null || typeof agent.whenIdle !== 'function') {
        throw new Error(`session ${sessionId} has no live agent that reports whenIdle()`)
      }
      // The protocol section must be on the agent before its turn is waited for;
      // the run's tracker ignores a second sighting of the same agent (5.2).
      adopt(agent)
      await agent.whenIdle()
    },
  }
}

/**
 * Open a session for the group the run is entering.
 *
 * The three lookups the controller needs — the workspace, the inherited preset
 * and later the live agent — arrive as callbacks, so this module stays free of
 * Cordis and the environment (`lib/environment.js`) stays the only place that
 * knows the service names.
 *
 * @param {object} options
 * @param {{create: Function, prompt: Function}} options.controller - the session controller.
 * @param {string} options.cwd - project directory the new session should work in.
 * @param {(cwd: string) => (string|undefined|Promise<string|undefined>)} [options.workspaceOf] -
 *   resolves the workspace id of that directory, when it has one.
 * @param {() => (string|undefined)} [options.presetOf] - preset inherited from the source session.
 * @param {AbortSignal} [options.signal] - cancellation of the invocation that opened the session.
 * @param {(sessionId: string) => (object|Promise<object|undefined>)} [options.resolveAgent] - looks up
 *   the live agent of the session, see {@link createSessionRunner}.
 * @param {(agent: object) => void} [options.adoptAgent] - registers the run's protocol section on the
 *   new session's agent (5.2), see {@link createSessionRunner}.
 * @returns {Promise<{sessionId: string, followup: Function, whenIdle: Function}>} the runner of the new session.
 * @throws {TypeError} when the controller cannot create or prompt.
 * @throws {Error} when the controller returns no session id.
 */
export async function openSession({ controller, cwd, workspaceOf, presetOf, signal, resolveAgent, adoptAgent }) {
  if (typeof controller?.create !== 'function' || typeof controller?.prompt !== 'function') {
    throw new TypeError('openSession requires a session controller with create() and prompt()')
  }

  const workspaceId = workspaceOf === undefined ? undefined : await workspaceOf(cwd)
  const agentPreset = presetOf === undefined ? undefined : presetOf()
  const value = await controller.create(sessionRequest({ cwd, workspaceId, agentPreset }))
  const sessionId = sessionIdOf(value)

  // The section should already be in place when the new group's first task
  // starts, and only the agent resolution stands in its way: do it now rather
  // than after the prompt is accepted. The attempt is best-effort — an agent that
  // is not live yet is adopted from `whenIdle()`, and a lookup that fails must
  // not cost the task, which would otherwise still be sendable.
  /** @type {object|undefined} */
  let knownAgent
  if (typeof adoptAgent === 'function' && typeof resolveAgent === 'function') {
    try {
      knownAgent = (await resolveAgent(sessionId)) ?? undefined
    } catch {
      // `whenIdle()` reports the session that still cannot be waited on.
    }
  }

  return createSessionRunner({
    controller,
    sessionId,
    signal,
    resolveAgent,
    adoptAgent,
    knownAgent,
  })
}

/**
 * Text of a rejection the runner could not use.
 *
 * @param {unknown} value - rejection or thrown value.
 * @returns {string} a message safe to embed in the run report.
 */
function describe(value) {
  return value instanceof Error ? value.message : String(value)
}
