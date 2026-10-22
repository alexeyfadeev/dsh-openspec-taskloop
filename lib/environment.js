// dsh-openspec-taskloop — the Cordis-facing seam (tasks 3.1–3.3, 5.1–5.2, 6.1, 6.3).
//
// Everything the plugin takes from the host is resolved here: the `openspec`
// wrapper (through `ctx.subprocess`), the session working directory (through
// `ctx.workingDirectory`, falling back to the session header and then to the
// host process), the confirmation and description channels (through
// `ctx.userQuestions`), the follow-up channel (through `agent.followup`), the
// compaction calls (through `ctx.compaction`), and — for a run that crosses a group
// boundary — the session the next group runs in (through `ctx.sessionController`,
// `ctx.workspaceRegistry`, `ctx.agentPresets` and `ctx.agents`). `lib/index.js`
// stays a manifest and `lib/control.js` stays a plain function of these, so both
// are testable without a host.
//
// Services are looked up per invocation rather than at mount time on purpose:
// the plugin mounts with only `commands` injected, and a deployment without
// `userQuestions` (a headless run) must still mount — there the missing channel
// becomes a command result ("cannot ask for confirmation"), not a failed mount.
// The same holds for the session services: a run without a boundary never needs
// them, so only a run that actually changes session meets their absence. The
// compaction service is required for every grouped run, so its absence is met as
// soon as a run reaches a transition inside a group (6.1); a step-boundary
// compaction (6.3) is optional and its absence becomes a warning of the run, not a
// failed start. On a preset-isolated profile — the shipped
// `@deepseek-ai/dsh-web-app` is one — the host-plane compaction row is disabled and
// each preset mounts its own inside its group, so the service is also looked up
// through the preset registry (see compactionServiceFor()).

import { requestInitialization } from './bootstrap.js'
import { requestDescription, sendExplorePrompt } from './explore.js'
import { OpenSpecCli } from './openspec.js'
import { openSession } from './session.js'

/**
 * Build the host-bound dependencies of the command actions.
 *
 * @param {object} ctx - plugin context; `ctx.get(name)` reads a composed service.
 * @param {import('./config.js').Config} config - resolved plugin configuration.
 * @returns {{createCli: Function, cwdOf: Function, askInit: Function, askDescription: Function, followupExplore: Function, compactNow: Function, compactIfNeeded: Function, openSession: Function, logger: object}} dependencies.
 */
export function createEnvironment(ctx, config) {
  return {
    createCli: () => createCli(ctx, config),
    cwdOf: (invocation) => resolveCwd(ctx, invocation.agent),
    askInit: (invocation, cwd) => requestInitialization({
      questions: ctx.get('userQuestions'),
      agent: invocation.agent,
      cwd,
      signal: invocation.signal,
    }),
    askDescription: (invocation, cwd) => requestDescription({
      questions: ctx.get('userQuestions'),
      agent: invocation.agent,
      cwd,
      signal: invocation.signal,
    }),
    followupExplore: (invocation, description) => sendExplorePrompt({
      agent: invocation.agent,
      description,
    }),
    compactNow: (agent, signal) => compactAgent(ctx, agent, signal),
    compactIfNeeded: (agent, signal) => compactStep(ctx, agent, signal),
    openSession: (invocation, { cwd, adoptAgent }) => openGroupSession(ctx, invocation, { cwd, adoptAgent }),
    logger: ctx.logger,
  }
}

/**
 * Open the session the next group of a run works in.
 *
 * The controller is required — a boundary is the one moment the plugin cannot
 * improvise, because continuing in the session it was leaving would contradict
 * the report — while the workspace, the preset and the agent lookups degrade:
 * a session without a workspace is created by `cwd` (design D6), a preset that
 * cannot be resolved leaves the default in place, and a session whose agent is
 * not live yet is resolved lazily in `whenIdle()`.
 *
 * @param {object} ctx - plugin context.
 * @param {object} invocation - command invocation: `agent`, `signal`, `rawInput`.
 * @param {object} context
 * @param {string} context.cwd - project directory the new session should work in.
 * @param {(agent: object) => void} [context.adoptAgent] - registers the run's protocol section on the
 *   new session's agent (5.2).
 * @returns {Promise<{sessionId: string, followup: Function, whenIdle: Function}>} runner of the new session.
 * @throws {Error} when the deployment composes no session controller.
 */
async function openGroupSession(ctx, invocation, { cwd, adoptAgent }) {
  const controller = ctx.get('sessionController')
  if (
    controller === undefined || controller === null
    || typeof controller.create !== 'function' || typeof controller.prompt !== 'function'
  ) {
    throw new Error('a new session cannot be opened because the sessionController service is not composed')
  }
  return openSession({
    controller,
    cwd,
    workspaceOf: (path) => resolveWorkspaceId(ctx, path),
    presetOf: () => resolvePreset(ctx, invocation.agent),
    signal: invocation.signal,
    resolveAgent: (sessionId) => resolveSessionAgent(ctx, sessionId),
    adoptAgent,
  })
}

/**
 * The workspace the directory belongs to, when the deployment tracks workspaces.
 *
 * The workspace id is preferred over the directory because only a session bound
 * to a workspace appears in the sidebar, and the two can differ: a session opened
 * in a subdirectory of a workspace belongs to that workspace. A registry that
 * cannot answer is not a reason to stop the run — the documented `cwd` fallback
 * still opens a working session.
 *
 * @param {object} ctx - plugin context.
 * @param {string} cwd - project directory the run works in.
 * @returns {Promise<string|undefined>} workspace id, or `undefined`.
 */
async function resolveWorkspaceId(ctx, cwd) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry === null || typeof registry.resolveByPath !== 'function') {
    return undefined
  }
  try {
    const workspace = await registry.resolveByPath(cwd)
    return typeof workspace?.id === 'string' && workspace.id !== '' ? workspace.id : undefined
  } catch {
    // A directory outside every workspace is a normal answer for `resolveByPath`,
    // and a registry that fails answers the same question: no workspace.
    return undefined
  }
}

/**
 * The preset the source session runs, so the new session continues its protocol.
 *
 * `composedPreset` reads the composition of the agent's own context, which is the
 * preset the user selected for that session; with no preset (a default session)
 * the field is omitted and the new session keeps the default. Both a missing
 * service and a session without a preset mean "nothing to inherit", not an error.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [agent] - the invocation's agent.
 * @returns {string|undefined} preset id, or `undefined`.
 */
function resolvePreset(ctx, agent) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined || presets === null || typeof presets.composedPreset !== 'function') {
    return undefined
  }
  if (agent?.ctx === undefined || agent.ctx === null) return undefined
  try {
    const preset = presets.composedPreset(agent.ctx)
    return typeof preset === 'string' && preset !== '' ? preset : undefined
  } catch {
    return undefined
  }
}

/**
 * The live agent of a session, for waiting on its turn.
 *
 * `agents.get` is the direct route and is checked first; a session created a
 * moment ago can still be missing there, so the controller's own resolver is the
 * fallback. Either answer is handed to the runner unchanged — it rejects a value
 * that cannot report idleness rather than waiting on the wrong object.
 *
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - session whose agent is needed.
 * @returns {Promise<object|undefined>} the agent, when it can be found.
 */
async function resolveSessionAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (typeof agents?.get === 'function') {
    const live = agents.get(sessionId)
    if (live !== undefined && live !== null) return live
  }

  const controller = ctx.get('sessionController')
  if (typeof controller?.resolveAgent !== 'function') return undefined
  const resolved = await controller.resolveAgent(sessionId)
  if (resolved === undefined || resolved === null) return undefined
  return resolved.agent ?? resolved.session?.agent ?? resolved
}

/**
 * Compact the history of the session a task is about to run in (task 6.1).
 *
 * The loop hands in the recipient of the next task, which is an agent in the
 * session the command came from and a runner in a session opened at a group
 * boundary (5.1). Only the runner needs tracing back: it speaks the loop's
 * vocabulary, not the compaction service's, so its live agent is looked up the
 * same way `whenIdle()` finds it. The service is required rather than optional: a
 * run that cannot bound its context must say so instead of quietly leaving the
 * group uncompacted (design D7). Which service that is depends on the composition —
 * the host plane or the agent's preset (see {@link compactionServiceFor}) — and the
 * lookup happens after the agent is known, because the preset registry resolves by
 * agent.
 *
 * @param {object} ctx - plugin context.
 * @param {object} recipient - agent or session runner the next task goes to.
 * @param {AbortSignal} [signal] - cancellation of the whole run.
 * @returns {Promise<object|null>} the compaction service's result.
 * @throws {Error} when the deployment composes no compaction service, or the
 *   recipient's session has no live agent that can be compacted.
 */
async function compactAgent(ctx, recipient, signal) {
  const agent = await compactableAgent(ctx, recipient)
  if (agent === undefined || agent === null) {
    throw new Error('the run cannot compact its context because the session has no live agent')
  }
  const compaction = compactionServiceFor(ctx, agent, 'compactNow')
  if (compaction === undefined) {
    throw new Error('the run cannot compact its context because the compaction service is not composed')
  }
  return compaction.compactNow(agent, signal)
}

/**
 * Consider a pressure compaction at a step boundary (task 6.3).
 *
 * The gate (`lib/midtask.js`) calls this before each step of a task, and the
 * service decides whether the context is under enough pressure to act: `'pressure'`
 * is the only trigger a step boundary can observe, and the threshold behind it is
 * `compaction-basic`'s own configuration (design D7). The service is optional here
 * in the way it is not for a transition: the gate turns this rejection into a
 * warning of the run, so a deployment without the service still runs its tasks.
 *
 * @param {object} ctx - plugin context.
 * @param {object} agent - live agent whose step is being proposed.
 * @param {AbortSignal} [signal] - cancellation of the current turn.
 * @returns {Promise<object|null>} the compaction service's result; `null` means no
 *   compaction was needed.
 * @throws {Error} when the deployment composes no compaction service.
 */
async function compactStep(ctx, agent, signal) {
  const compaction = compactionServiceFor(ctx, agent, 'compactIfNeeded')
  if (compaction === undefined) {
    throw new Error('the task cannot compact a step because the compaction service is not composed')
  }
  return compaction.compactIfNeeded(agent, 'pressure', signal)
}

/**
 * The compaction service `agent` actually runs with.
 *
 * Two compositions exist. A simple profile mounts `compaction-basic` on the host
 * plane, and `ctx.get('compaction')` is that instance. A preset-isolated profile —
 * the shipped `@deepseek-ai/dsh-web-app` is one — disables that host-plane row and
 * mounts a private compaction inside each preset's group instead, so the host-plane
 * lookup answers `undefined` while the agent has a perfectly good service one scope
 * away. The preset registry is the public route to it: `serviceFor(agent, name)`
 * resolves the service of the composition the agent itself runs.
 *
 * The host-plane instance wins when both exist, because it is the one the profile
 * configured; the preset lookup is the fallback, not an override. A registry that
 * cannot answer — a harness without `serviceFor()`, an agent without a context — is
 * the same "nothing to compact with" as an absent service, and the caller reports
 * it. The method is checked on the instance rather than assumed: a service that
 * cannot make the requested call is not a usable answer.
 *
 * @param {object} ctx - plugin context.
 * @param {object} agent - live agent whose history the call is for.
 * @param {'compactNow'|'compactIfNeeded'} method - the call the caller needs.
 * @returns {object|undefined} the service, or `undefined` when none can serve the call.
 */
function compactionServiceFor(ctx, agent, method) {
  const host = ctx.get('compaction')
  if (typeof host?.[method] === 'function') return host

  const presets = ctx.get('agentPresets')
  if (presets === undefined || presets === null || typeof presets.serviceFor !== 'function') {
    return undefined
  }
  let scoped
  try {
    scoped = presets.serviceFor(agent, 'compaction')
  } catch {
    // A registry that rejects the agent answers the same question as one that
    // returns nothing: this agent has no compaction this seam can call.
    return undefined
  }
  return typeof scoped?.[method] === 'function' ? scoped : undefined
}

/**
 * The agent whose history `compactNow()` can reduce.
 *
 * `runMaintenance()` is what tells a compactable agent from the loop's session
 * runner; the session id is how a runner is traced back to its agent. A value that
 * is neither is handed back unchanged, so the service — not this seam — reports
 * the unusable recipient.
 *
 * @param {object} ctx - plugin context.
 * @param {object} recipient - agent or session runner.
 * @returns {Promise<object|undefined>} the agent to compact.
 */
async function compactableAgent(ctx, recipient) {
  if (typeof recipient?.runMaintenance === 'function') return recipient
  if (typeof recipient?.sessionId === 'string' && recipient.sessionId !== '') {
    return await resolveSessionAgent(ctx, recipient.sessionId)
  }
  return recipient
}

/**
 * Resolve the `openspec` executable and bind the configured deadline.
 *
 * Built per run rather than at mount so a missing `subprocess` service is one
 * failed command instead of a plugin that never mounts.
 *
 * @param {object} ctx - plugin context.
 * @param {import('./config.js').Config} config - resolved plugin configuration.
 * @returns {OpenSpecCli} the wrapper for one run.
 * @throws {Error} when the deployment composes no subprocess service.
 */
function createCli(ctx, config) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined || subprocess === null) {
    throw new Error('the openspec CLI cannot run because the subprocess service is not composed')
  }
  return new OpenSpecCli(subprocess, { timeoutMs: config.openspec.timeoutMs })
}

/**
 * The directory `openspec` should run in for one invocation.
 *
 * `workingDirectory` is authoritative because it follows an explicit `cd`; the
 * session header is the project the session was created in, and `process.cwd()`
 * is the last resort for a session that carries neither.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [agent] - live agent of the invocation.
 * @returns {string} absolute project directory.
 */
export function resolveCwd(ctx, agent) {
  const session = agent?.session
  const service = ctx.get('workingDirectory')
  if (session !== undefined && service !== undefined && typeof service.get === 'function') {
    const directory = service.get(session)
    if (typeof directory === 'string' && directory !== '') return directory
  }
  const header = session?.header?.cwd
  if (typeof header === 'string' && header !== '') return header
  return process.cwd()
}
