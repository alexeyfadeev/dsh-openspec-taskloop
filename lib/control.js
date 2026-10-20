// dsh-openspec-taskloop — the actions behind `/taskloop` (tasks 3.1–3.2).
//
// `run` is the entry point of a run. Today it resolves the working directory,
// settles the OpenSpec root (asking for `openspec init` when there is none) and
// decides which change the run is about; the explore handoff for a project
// without changes (3.3) and the task loop itself (4.1) plug in here next. Until
// they exist the command says what it found and states plainly that no task was
// started, instead of implying a run that is not happening.
//
// The module is a plain function of its dependencies — the CLI wrapper, the
// confirmation channel and the session directory all arrive from
// `lib/environment.js` — so everything `/taskloop` does before the first model
// turn is testable with fakes.

import { BOOTSTRAP, ensureRoot } from './bootstrap.js'
import { SELECTION, selectChange } from './changes.js'

/** Every command result starts with this, so a session log line is attributable. */
const PREFIX = 'taskloop: '

// Task 3.3 replaces the first sentence, task 4.1 the second. Saying "not wired
// up in this build" is deliberate: the alternative is a command that reports a
// run it did not start.
const EXPLORE_NOT_WIRED =
  'There are no changes yet, and asking for a task description is not wired up in this build; nothing was started.'
const LOOP_NOT_WIRED = 'The task loop is not wired up in this build, so no task was started.'

/**
 * Build the three actions the command dispatches to.
 *
 * @param {object} deps
 * @param {import('./config.js').Config} deps.config - resolved plugin configuration.
 * @param {() => {run: Function}} deps.createCli - builds the `openspec` wrapper for one run.
 * @param {(invocation: object) => string} deps.cwdOf - project directory of the invocation.
 * @param {(invocation: object, cwd: string) => Promise<'initialize'|'cancel'|'unavailable'>} deps.askInit -
 *   asks the user about initialising the project.
 * @returns {{run: Function, stop: Function, status: Function}} command actions.
 */
export function createControl({ config, createCli, cwdOf, askInit }) {
  // No run registry exists yet (4.3 adds it); until then the only truthful
  // answer to both subcommands is that nothing is active.
  const noActiveRun = () => ({ kind: 'success', text: `${PREFIX}no run is active.` })
  return {
    run: (invocation, action) => startRun({ config, createCli, cwdOf, askInit }, invocation, action ?? {}),
    stop: noActiveRun,
    status: noActiveRun,
  }
}

/**
 * Resolve the project, the root and the change, then report where the run would go.
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {object} invocation - command invocation: `agent`, `signal`, `rawInput`.
 * @param {{change?: string|null}} action - change named on the command line, `null` when absent.
 * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
 */
async function startRun(deps, invocation, { change }) {
  try {
    const cwd = deps.cwdOf(invocation)
    const outcome = await ensureRoot({
      cli: deps.createCli(),
      cwd,
      signal: invocation.signal,
      confirm: (request) => deps.askInit(invocation, request.cwd),
    })
    return describeOutcome(outcome, { cwd, requested: change ?? deps.config.change })
  } catch (error) {
    // A failure the user can act on belongs in the command result, not in a
    // thrown handler: the registry would log it as a command/done error and the
    // explanation would lose the `taskloop:` attribution.
    return { kind: 'error', text: `${PREFIX}${messageOf(error)}` }
  }
}

/**
 * Render the settled root check as a command result.
 *
 * @param {import('./bootstrap.js').BootstrapOutcome} outcome - settled root check.
 * @param {object} context
 * @param {string} context.cwd - project directory the check ran in.
 * @param {string|undefined} context.requested - change from the command line or configuration.
 * @returns {{kind: 'success'|'error', text: string}} command result.
 */
function describeOutcome(outcome, { cwd, requested }) {
  if (outcome.kind === BOOTSTRAP.declined) {
    return {
      kind: 'success',
      text: `${PREFIX}initialization cancelled; ${cwd} was left unchanged and no files were created.`,
    }
  }

  // After an init the root path is the fact worth reporting, not the directory
  // the CLI happened to run in: the two can differ by symlink resolution.
  const head = outcome.kind === BOOTSTRAP.created
    ? `initialized OpenSpec; the root is ${outcome.root.path}.`
    : `OpenSpec root: ${outcome.root.path}.`
  const selection = selectChange(outcome.listing, requested)

  // An unknown name is a typo, not an invitation to explore: answering with the
  // available names lets the user correct it, and starting the explore flow
  // would silently run a workflow they did not ask for.
  if (selection.kind === SELECTION.unknown) {
    return {
      kind: 'error',
      text: `${PREFIX}no change named "${selection.name}". Available changes: ${selection.available.join(', ')}.`,
    }
  }
  if (selection.kind === SELECTION.empty) {
    return { kind: 'success', text: `${PREFIX}${head} ${EXPLORE_NOT_WIRED}` }
  }
  return {
    kind: 'success',
    text: `${PREFIX}${head} Change "${selection.change.name}"${progressOf(selection.change)}. ${LOOP_NOT_WIRED}`,
  }
}

/**
 * `(7/20 tasks done)` for a change whose counts the CLI reported, or `''`.
 *
 * @param {import('./changes.js').ChangeEntry} change - selected change.
 * @returns {string} the parenthesised progress or an empty string.
 */
function progressOf(change) {
  const { completedTasks, totalTasks } = change
  if (!Number.isSafeInteger(completedTasks) || !Number.isSafeInteger(totalTasks)) return ''
  return ` (${completedTasks}/${totalTasks} tasks done)`
}

/**
 * Message text for an unknown thrown value.
 *
 * @param {unknown} value - thrown value.
 * @returns {string} a message safe to embed.
 */
function messageOf(value) {
  return value instanceof Error ? value.message : String(value)
}
