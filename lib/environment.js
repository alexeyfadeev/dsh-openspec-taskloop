// dsh-openspec-taskloop — the Cordis-facing seam (tasks 3.1–3.2).
//
// Everything the plugin takes from the host is resolved here: the `openspec`
// wrapper (through `ctx.subprocess`), the session working directory (through
// `ctx.workingDirectory`, falling back to the session header and then to the
// host process), and the confirmation channel (through `ctx.userQuestions`).
// `lib/index.js` stays a manifest and `lib/control.js` stays a plain function of
// these three, so both are testable without a host.
//
// Services are looked up per invocation rather than at mount time on purpose:
// the plugin mounts with only `commands` injected, and a deployment without
// `userQuestions` (a headless run) must still mount — there the missing channel
// becomes a command result ("cannot ask for confirmation"), not a failed mount.

import { requestInitialization } from './bootstrap.js'
import { OpenSpecCli } from './openspec.js'

/**
 * Build the host-bound dependencies of the command actions.
 *
 * @param {object} ctx - plugin context; `ctx.get(name)` reads a composed service.
 * @param {import('./config.js').Config} config - resolved plugin configuration.
 * @returns {{createCli: Function, cwdOf: Function, askInit: Function}} dependencies.
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
  }
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
