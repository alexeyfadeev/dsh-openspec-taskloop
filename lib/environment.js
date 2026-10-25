// dsh-openspec-taskloop — the Cordis-facing seam (tasks 3.1–3.3, 4.2, 5.1–5.3, 6.1, 6.3).
//
// Everything the plugin takes from the host is resolved here: the `openspec`
// wrapper and — in the other direction, since a run also writes to the history —
// the commit tool (both through `ctx.subprocess`), the session working directory
// (through `ctx.workingDirectory`, falling back to the session header and then to
// the host process), the confirmation and description channels (through
// `ctx.userQuestions`), the follow-up channel (through `agent.followup`), the
// compaction calls (through `ctx.compaction`), the approval policy of the session a
// review runs in (through `ctx.approval`), the commit message text of a change
// (asked through `ctx.userQuestions`, kept between runs by `lib/state.js` under
// `ctx.get('profileContext').home` until the change is finished, when it is dropped
// again), and — for a run that crosses a group boundary —
// the session the next group runs in (through `ctx.sessionController`,
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
//
// The commit tool (design D15) is the one host-facing call that is not a read. It is
// spawned from an argv array rather than a command line, so the message the user
// typed stays one argument and can never be split by a shell — see
// runCommitCommand(). Its exit code is data that `lib/commit.js` classifies; only a
// command that cannot run at all rejects here.

import { requestInitialization } from './bootstrap.js'
import { COMMIT_TEXT, requestCommitMessage } from './commit-text.js'
import { requestDescription, sendExplorePrompt } from './explore.js'
import { createNoticeMessage } from './message.js'
import { OpenSpecCli } from './openspec.js'
import { openSession } from './session.js'
import { deleteCommitMessage, readCommitMessage, writeCommitMessage } from './state.js'
import { aborted } from './wait.js'

/**
 * Build the host-bound dependencies of the command actions.
 *
 * @param {object} ctx - plugin context; `ctx.get(name)` reads a composed service.
 * @param {import('./config.js').Config} config - resolved plugin configuration.
 * @returns {{createCli: Function, cwdOf: Function, askInit: Function, askDescription: Function, followupExplore: Function, compactNow: Function, compactIfNeeded: Function, openSession: Function, setApproval: Function, commitText: Function, forgetCommitText: Function, appendNotice: Function, runCommitCommand: Function, logger: object}} dependencies.
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
    openSession: (invocation, { cwd, adoptAgent, signal }) => openGroupSession(ctx, invocation, { cwd, adoptAgent, signal }),
    setApproval: (sessionId) => denyApprovals(ctx, sessionId),
    commitText: (invocation, context) => resolveCommitText(ctx, invocation, context),
    forgetCommitText: (context) => forgetStoredCommitText(ctx, context),
    appendNotice: (recipient, text) => appendSessionNotice(ctx, recipient, text),
    runCommitCommand: (request, options) => runCommitCommand(ctx, request, options),
    logger: ctx.logger,
  }
}

/**
 * Deny approval prompts in the session the review runs in (task 3.2, design D14).
 *
 * The review turn is unattended: nobody is looking at that session, so a request
 * for confirmation would wait for an answer that never comes. `setPolicy(agent,
 * 'never')` makes every such request resolve `'rejected'` deterministically, and
 * the prompt tells the model so. It is set before the review message, on a session
 * that has not started a turn yet, which is why the policy event is the first
 * thing its log holds rather than a change to something already visible.
 *
 * A deployment without an approval service composes nothing that could ask, so
 * there is nothing to deny and this is a no-op. The agent is required: without a
 * live one the switch could not reach the session, and a review that might hang is
 * worse than one that stops with an explanation. It is looked up the same way
 * `whenIdle()` finds it, so a session the controller has only just created is
 * found through the controller's own resolver.
 *
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - session the review runs in.
 * @returns {Promise<void>} resolves once the policy is in place, or immediately without a service.
 * @throws {Error} when the review session has no live agent to carry the policy.
 */
async function denyApprovals(ctx, sessionId) {
  const approval = ctx.get('approval')
  if (typeof approval?.setPolicy !== 'function') return

  const agent = await resolveSessionAgent(ctx, sessionId)
  if (agent === undefined || agent === null) {
    throw new Error(`the review session ${sessionId} has no live agent to deny approvals on`)
  }
  approval.setPolicy(agent, 'never')
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
 * @param {AbortSignal} [context.signal] - cancellation of the *run*, when the caller has
 *   one: the request's own signal ends with the request, and an opened session must
 *   not inherit a cancellation that has nothing to do with the work it continues.
 * @param {(agent: object) => void} [context.adoptAgent] - registers the run's protocol section on the
 *   new session's agent (5.2).
 * @returns {Promise<{sessionId: string, followup: Function, whenIdle: Function}>} runner of the new session.
 * @throws {Error} when the deployment composes no session controller.
 */
async function openGroupSession(ctx, invocation, { cwd, adoptAgent, signal }) {
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
    signal: signal ?? invocation.signal,
    resolveAgent: (sessionId) => resolveSessionAgent(ctx, sessionId),
    adoptAgent,
  })
}

/**
 * Append one line to the session a finished group ran in (4.3, design D17).
 *
 * The run names the recipient that drove the group: an agent when the group ran in
 * the invocation's session, a runner when the run had already moved at an earlier
 * boundary. Only the runner needs tracing back — it speaks the loop's vocabulary and
 * carries a session id, not a session. The lookup is the one `whenIdle()` and
 * `setApproval()` use, so a session opened a moment ago is found the same way.
 *
 * A session with no `append()` is not an error: the line is a courtesy of the
 * transcript, and the report of the run still carries the same commit. The caller
 * treats a rejection as the same lost line, so this seam returns `false` rather than
 * throwing — a run whose tasks are done must not fail on a log write.
 *
 * @param {object} ctx - plugin context.
 * @param {object} recipient - agent or session runner the finished group ran in.
 * @param {string} text - the line to append.
 * @returns {Promise<boolean>} whether the session took the line.
 */
async function appendSessionNotice(ctx, recipient, text) {
  const agent = await noticeAgent(ctx, recipient)
  const session = agent?.session
  if (session === undefined || session === null || typeof session.append !== 'function') {
    return false
  }
  session.append('user/message', createNoticeMessage(text), { surfaceOp: 'append' })
  return true
}

/**
 * The agent whose session owns a recipient's transcript.
 *
 * An agent is recognised by the session it carries, a runner by its id (the same
 * distinction `compactableAgent()` makes for the other direction). A value that is
 * neither is handed back unchanged, so the caller can see it has no session.
 *
 * @param {object} ctx - plugin context.
 * @param {object} recipient - agent or session runner.
 * @returns {Promise<object|undefined>} the agent, when it can be found.
 */
async function noticeAgent(ctx, recipient) {
  if (recipient?.session !== undefined && recipient?.session !== null) return recipient
  if (typeof recipient?.sessionId === 'string' && recipient.sessionId !== '') {
    return await resolveSessionAgent(ctx, recipient.sessionId)
  }
  return recipient
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
 * The message text this change's commits carry: the stored one, or the user's answer (task 5.2).
 *
 * The text belongs to a change of a project (design D16), so it is looked up under
 * `<home>/storages/openspec-taskloop.json` with the `<cwd>#<change>` key, and only a value
 * that is not there is asked for. The answer is written straight away rather than at the
 * end of the run: the point of keeping it is that the next `/taskloop` after a stop does
 * not ask again, and a run that is stopped never reaches an "end".
 *
 * `profileContext.home` is the only place the harness home is read from. A deployment
 * without that service has nowhere documented to keep the text; it still gets asked and
 * its commits are still composed from the answer, the run simply cannot promise the next
 * one will not ask — which is better than refusing to commit in a host that has no home.
 *
 * A dismissal is returned as a refusal and stores nothing: the run that would have used
 * the text has not started, so there is nothing to keep it for. Read and write failures
 * are not caught either — a state file that cannot be reached is reported before the first
 * turn, instead of surfacing halfway through a run it was meant to survive.
 *
 * @param {object} ctx - plugin context.
 * @param {object} invocation - command invocation: `agent` and `signal` of the request.
 * @param {{change: string, cwd: string}} context - change and project directory the text belongs to.
 * @returns {Promise<import('./commit-text.js').CommitTextOutcome>} the settled text.
 * @throws {Error} when the question fails, or the state file cannot be read or written.
 */
async function resolveCommitText(ctx, invocation, { change, cwd }) {
  const home = resolveHome(ctx)
  const stored = home === undefined ? undefined : await readCommitMessage({ home, cwd, change })
  if (stored !== undefined) return { kind: COMMIT_TEXT.text, text: stored }

  const asked = await requestCommitMessage({
    questions: ctx.get('userQuestions'),
    agent: invocation.agent,
    change,
    cwd,
    signal: invocation.signal,
  })
  if (asked.kind !== COMMIT_TEXT.text) return { kind: asked.kind }

  // Trimmed once, here, so the text the run commits with and the text the next run reads
  // back are the same string; `lib/state.js` trims again because it is the store's own
  // contract, not because the two disagree.
  const text = asked.text.trim()
  if (home !== undefined) await writeCommitMessage({ home, cwd, change, message: text })
  return { kind: COMMIT_TEXT.text, text }
}

/**
 * Drop the text kept for a change that is finished (task 5.3).
 *
 * The record exists to spare the user from typing the same sentence on every `/taskloop`
 * after an interruption (design D16); it is not a milestone of the project, and a change
 * whose every task is done has no next group to commit. Keeping it would be worse than
 * useless: a later change with the same name would silently inherit a sentence written
 * about other work. So `all_done` deletes the record and the next run asks again.
 *
 * A deployment without a harness home has no record to drop and nothing happens: there is
 * no state file, which is exactly the "already gone" the caller wants. Read and write
 * failures are not caught here — the caller decides what a run that already finished says
 * about them, and this seam only reports what happened.
 *
 * @param {object} ctx - plugin context.
 * @param {{change: string, cwd: string}} context - change and project directory the text belonged to.
 * @returns {Promise<void>} resolves once the record is gone (or was never there).
 * @throws {Error} when the state file cannot be read or written.
 */
async function forgetStoredCommitText(ctx, { change, cwd }) {
  const home = resolveHome(ctx)
  if (home === undefined) return
  await deleteCommitMessage({ home, cwd, change })
}

/**
 * The harness home a profile-level state file lives in (design D16).
 *
 * `profileContext` is provided by a profile launched by `dsh` and absent in a bare host;
 * a value that is not a non-empty string is treated the same way, because a state file
 * cannot be placed under something that is not a directory path.
 *
 * @param {object} ctx - plugin context.
 * @returns {string|undefined} the home directory, when the deployment has one.
 */
function resolveHome(ctx) {
  const home = ctx.get('profileContext')?.home
  return typeof home === 'string' && home !== '' ? home : undefined
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

/** Milliseconds a commit tool gets to exit after termination starts. */
const COMMIT_GRACE_MS = 2_000

/** In-memory stdout cap of one commit request; even a verbose `git commit` is small. */
const COMMIT_STDOUT_MAX_BYTES = 1024 * 1024

/** Retained stderr tail of one commit request. */
const COMMIT_STDERR_MAX_BYTES = 16 * 1024

/**
 * Run one commit request through the host's subprocess service (task 4.2, design D15).
 *
 * `lib/commit.js` composes the request — executable, argument list, message — and
 * decides what an exit code means; this function only starts the process. There is
 * no shell anywhere in between: the host receives `argv` and starts exactly those
 * elements, which is why the commit message travels as one array element and a
 * message holding quotes, semicolons or `$(...)` reaches the tool as text rather
 * than as something to interpret.
 *
 * A settled process is a result, nonzero exit included: `runCommit()` names the tool
 * and the code in its report, and a refusal must not be thrown as if the run itself
 * broke. Rejection is for a request that could not be made at all — no subprocess
 * service, an executable missing from PATH, a spawn failure, or a stop that cut the
 * command short — and every such message names the command (`git commit`,
 * `but commit`), so the report still says which step failed when there is no exit
 * code to quote.
 *
 * A stop is not a failure either: the rejection is only how the wait is abandoned,
 * and `runCommit()` sees the aborted signal and reports a stop rather than an error.
 *
 * @param {object} ctx - plugin context.
 * @param {{executable: string, args: readonly string[]}} request - one command, never
 *   a command line.
 * @param {object} [options]
 * @param {string} options.cwd - project directory the tool runs in.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string}>} exit
 *   facts and collected output of the tool.
 * @throws {TypeError} when the request is not one command.
 * @throws {Error} when the tool cannot be run, or the stop ended the wait.
 */
async function runCommitCommand(ctx, request, { cwd, signal } = {}) {
  if (typeof request?.executable !== 'string' || request.executable === '' || !Array.isArray(request.args)) {
    throw new TypeError('runCommitCommand requires a request with an executable and an args array')
  }
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined || subprocess === null) {
    throw new Error('the commit cannot run because the subprocess service is not composed')
  }
  // The executable and the subcommand are what a report shows; the message is left
  // out because the commit outcome already carries it in full.
  const command = [request.executable, request.args[0]]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ')
  const stopped = () => new Error(`${command} was stopped before it exited`)

  if (aborted(signal)) throw new Error(`${command} was stopped before it ran`)

  let executable
  try {
    executable = await subprocess.resolveExecutable(request.executable, undefined, signal)
  } catch (cause) {
    // A lookup the stop cut short is the stop, not a tool that is absent.
    if (aborted(signal)) throw stopped()
    throw new Error(`${command} cannot run because ${request.executable} was not found: ${describe(cause)}`)
  }

  let handle
  try {
    handle = subprocess.spawn({
      argv: [executable, ...request.args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: COMMIT_STDOUT_MAX_BYTES },
        stderr: { maxBytes: COMMIT_STDERR_MAX_BYTES },
      },
      graceMs: COMMIT_GRACE_MS,
      signal,
    })
  } catch (cause) {
    if (aborted(signal)) throw stopped()
    throw new Error(`${command} could not start: ${describe(cause)}`)
  }

  const outcome = await settleCommitTool(handle, command, signal)
  // Collect-mode stdio always yields both readers; the optional access keeps a
  // provider that omits one from turning a result into a crash.
  const stdout = handle.collected?.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
  return { exitCode: outcome.exitCode, stdout, stderr }
}

/**
 * Wait for a commit command to exit, but stop waiting when the run is stopped.
 *
 * The provider terminates the managed process when the signal fires; `terminate()`
 * is called here as well because it is idempotent and makes the stop hold even for
 * a provider that stops observing the child.
 *
 * @param {object} handle - live process handle returned by the provider.
 * @param {string} command - name of the request, for the stop message.
 * @param {AbortSignal} [signal] - cancellation of the whole run.
 * @returns {Promise<{exitCode: number|null, signal: string|null}>} exit facts.
 * @throws {Error} when the stop cut the wait short, or the process itself failed.
 */
function settleCommitTool(handle, command, signal) {
  return new Promise((resolve, reject) => {
    if (signal === undefined || signal === null) {
      handle.done.then(resolve, reject)
      return
    }
    const onAbort = () => {
      handle.terminate()
      reject(new Error(`${command} was stopped before it exited`))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    handle.done.then(
      (outcome) => {
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
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

/**
 * Message text for an unknown thrown value.
 *
 * @param {unknown} value - thrown value from the provider.
 * @returns {string} a message safe to embed.
 */
function describe(value) {
  return value instanceof Error ? value.message : String(value)
}
