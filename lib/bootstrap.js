// dsh-openspec-taskloop — the OpenSpec root check and initialisation (task 3.2).
//
// `/taskloop` may not start a single task before the directory is an OpenSpec
// root, and it may not create one on its own: `openspec init` writes `openspec/`
// and the OpenSpec skills into `.dsh/skills/`, so the plugin asks first and
// writes only on an explicit yes (spec "Проверка инициализации OpenSpec").
//
// The flow is the first half of decision D9:
//
//     openspec list --json ──root──▶ ready
//            │
//          root: null
//            │
//       ask the user ──not an explicit yes──▶ declined (nothing is written)
//            │
//          yes
//            │
//   openspec init --tools dsh ──▶ openspec list --json again ──▶ created
//
// Three decisions are embedded here:
//
//   - A nonzero exit from `list` is not a failure. On an uninitialized project
//     the CLI exits nonzero and still prints `"root": null`; that document is the
//     answer (see lib/openspec.js). Only text that cannot be parsed is an error.
//   - Consent must be explicit. Only the "Initialize" label counts; a dismissed
//     card, an "Other" answer, a missing answer and an aborted request are all
//     refusals. This is what makes "no files were created" true by construction
//     rather than by remembering to skip the call.
//   - Init success is verified rather than trusted. Exit code 0 does not prove a
//     root appeared in this directory (the CLI may find another root, or write
//     nothing), so the listing is read again; a still-missing root fails the
//     bootstrap instead of asking for a task description in a project that was
//     never created.
//
// The module is free of Cordis: the CLI wrapper, the confirmation channel and
// the project directory all arrive as arguments, so the confirmation and refusal
// scenarios run in tests without a UI and without `openspec` installed.

import { parseChangeListing } from './changes.js'

/** The read that answers "is this an OpenSpec project, and which changes does it have". */
export const LIST_ARGS = Object.freeze(['list', '--json'])

/** The one write this plugin ever performs, and only after an explicit yes. */
export const INIT_ARGS = Object.freeze(['init', '--tools', 'dsh'])

/** Outcomes of {@link ensureRoot}; callers switch on `kind`. */
export const BOOTSTRAP = Object.freeze({
  /** The directory already is an OpenSpec root; nothing was written. */
  ready: 'ready',
  /** The root was created by this call, after a confirmation. */
  created: 'created',
  /** The user refused; the directory is untouched. */
  declined: 'declined',
})

/** Failure kinds reported by {@link BootstrapError}. */
export const BOOTSTRAP_ERROR = Object.freeze({
  /** The project needs initialisation, but this session has nobody to ask. */
  noChannel: 'no-channel',
  /** `openspec init` ran and exited nonzero. */
  init: 'init',
  /** `openspec init` exited zero but no root appeared in the directory. */
  initRoot: 'init-root',
})

/** What the confirmation channel answers; `unavailable` is never consent. */
export const INIT_ANSWER = Object.freeze({
  initialize: 'initialize',
  cancel: 'cancel',
  unavailable: 'unavailable',
})

/** Stable question id, echoed back in the answer. */
export const INIT_QUESTION_ID = 'openspec-init'

/** Option labels; only {@link INIT_LABEL.initialize} counts as a yes. */
export const INIT_LABEL = Object.freeze({
  initialize: 'Initialize',
  cancel: 'Cancel',
})

/** Longest stretch of CLI diagnostics echoed into an error message. */
const MAX_DIAGNOSTIC_LENGTH = 300

/**
 * A bootstrap that cannot proceed. The command turns this into an error result;
 * a refusal is not an error and is returned as an outcome instead.
 */
export class BootstrapError extends Error {
  /**
   * @param {string} message - diagnostic naming the directory and the cause.
   * @param {object} details
   * @param {'no-channel'|'init'|'init-root'} details.code - failure kind.
   * @param {Error} [details.cause] - underlying failure, when any.
   */
  constructor(message, { code, cause }) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BootstrapError'
    this.code = code
  }
}

/**
 * A settled root check.
 *
 * @typedef {object} BootstrapOutcome
 * @property {'ready'|'created'|'declined'} kind - what the check found or did.
 * @property {{path: string, source: string|null}} [root] - resolved root; absent when declined.
 * @property {import('./changes.js').ChangeListing} [listing] - the listing read after the check.
 */

/**
 * Read `openspec list --json` and parse it.
 *
 * The exit code is deliberately ignored: `root: null` exits nonzero, and that
 * document is an answer. A CLI that cannot run at all still throws.
 *
 * @param {{run: Function}} cli - the `openspec` wrapper.
 * @param {object} options
 * @param {string} options.cwd - project directory.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<import('./changes.js').ChangeListing>} parsed listing.
 */
async function readListing(cli, { cwd, signal }) {
  const result = await cli.run(LIST_ARGS, { cwd, signal })
  return parseChangeListing(result.stdout)
}

/**
 * Settle whether the directory is an OpenSpec root, initialising it on request.
 *
 * @param {object} options
 * @param {{run: Function}} options.cli - the `openspec` wrapper.
 * @param {string} options.cwd - project directory the CLI runs in.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @param {(request: {cwd: string}) => Promise<'initialize'|'cancel'|'unavailable'>} options.confirm -
 *   asks the user; called only when the root is missing.
 * @returns {Promise<BootstrapOutcome>} the settled root check.
 * @throws {import('./changes.js').ListingError} when the listing cannot be parsed.
 * @throws {BootstrapError} when the project needs a root the plugin cannot create.
 * @throws {import('./openspec.js').OpenSpecError} when the CLI cannot run.
 */
export async function ensureRoot({ cli, cwd, signal, confirm }) {
  const before = await readListing(cli, { cwd, signal })
  if (before.root !== null) {
    return { kind: BOOTSTRAP.ready, root: before.root, listing: before }
  }

  const decision = await confirm({ cwd })
  if (decision === INIT_ANSWER.unavailable) {
    throw new BootstrapError(
      `OpenSpec is not initialized in ${cwd}, and this session cannot ask for confirmation. `
        + 'Run `openspec init --tools dsh` there, then repeat the command.',
      { code: BOOTSTRAP_ERROR.noChannel },
    )
  }
  // Anything short of the explicit Initialize label is a refusal; the question
  // is the only gate in front of the one write this plugin performs.
  if (decision !== INIT_ANSWER.initialize) return { kind: BOOTSTRAP.declined }

  const init = await cli.run(INIT_ARGS, { cwd, signal })
  if (init.exitCode !== 0) {
    throw new BootstrapError(
      `openspec init --tools dsh failed with exit code ${String(init.exitCode)}${failureSuffix(init)}`,
      { code: BOOTSTRAP_ERROR.init },
    )
  }

  const after = await readListing(cli, { cwd, signal })
  if (after.root === null) {
    throw new BootstrapError(
      `openspec init --tools dsh reported success, but ${cwd} is still not an OpenSpec root`,
      { code: BOOTSTRAP_ERROR.initRoot },
    )
  }
  return { kind: BOOTSTRAP.created, root: after.root, listing: after }
}

/**
 * Ask the session's human whether to initialise the project.
 *
 * `questions` is `ctx.userQuestions`, or `undefined` when the deployment has no
 * such service. A live service with no answerer rejects with `NO_PROVIDER`;
 * both cases answer `unavailable`, because there is nobody to ask — which the
 * caller reports as a failure, never as consent.
 *
 * @param {object} request
 * @param {object} [request.questions] - the user-questions service.
 * @param {object} [request.agent] - live root agent the question belongs to.
 * @param {string} request.cwd - project directory named in the question.
 * @param {AbortSignal} [request.signal] - cancellation of the whole run.
 * @returns {Promise<'initialize'|'cancel'|'unavailable'>} the user's decision.
 * @throws {Error} when the question fails for a reason other than dismissal.
 */
export async function requestInitialization({ questions, agent, cwd, signal }) {
  if (questions === undefined || questions === null) return INIT_ANSWER.unavailable

  let answer
  try {
    answer = await questions.ask({
      questions: [buildInitQuestion(cwd)],
      agent,
      signal,
    })
  } catch (error) {
    const code = errorCode(error)
    // A dismissed card asks nothing further and an aborted request cannot be
    // confirmed; both are refusals. Neither may be read as consent.
    if (code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') return INIT_ANSWER.cancel
    if (code === 'NO_PROVIDER') return INIT_ANSWER.unavailable
    throw error
  }

  return readInitAnswer(answer)
}

/**
 * Build the one question the bootstrap asks.
 *
 * @param {string} cwd - project directory the initialisation would run in.
 * @returns {object} a `ctx.userQuestions` question.
 */
export function buildInitQuestion(cwd) {
  return {
    id: INIT_QUESTION_ID,
    header: 'OpenSpec',
    question: `No OpenSpec project was found in ${cwd}. Initialize it now?`,
    detail: 'Initialization runs `openspec init --tools dsh` in the session working directory: '
      + 'it creates `openspec/` and adds the OpenSpec skills under `.dsh/skills/`.',
    options: [
      {
        label: INIT_LABEL.initialize,
        description: 'Create the OpenSpec root; the command continues once it exists.',
      },
      {
        label: INIT_LABEL.cancel,
        description: 'Leave the directory untouched; no files are created.',
      },
    ],
  }
}

/**
 * Read the decision out of a `ctx.userQuestions` answer.
 *
 * Only one selected option equal to the Initialize label is consent. Custom
 * text is not: the user may have typed anything, and the question is the gate in
 * front of a write.
 *
 * @param {unknown} answer - `{answers: [{id, selected, custom?}]}` shape.
 * @returns {'initialize'|'cancel'} the decision.
 */
export function readInitAnswer(answer) {
  const answers = Array.isArray(answer?.answers) ? answer.answers : []
  const item = answers.find((entry) => entry?.id === INIT_QUESTION_ID)
  const selected = Array.isArray(item?.selected) ? item.selected : []
  return selected.length === 1 && selected[0] === INIT_LABEL.initialize
    ? INIT_ANSWER.initialize
    : INIT_ANSWER.cancel
}

/**
 * Machine-readable code of a failed question, when it has one.
 *
 * @param {unknown} error - thrown value from the question service.
 * @returns {string|undefined} the code.
 */
function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : undefined
}

/**
 * `: <last stderr line>` for an init failure, or `''` when the CLI said nothing.
 *
 * @param {{stdout: string, stderr: string}} result - settled CLI facts.
 * @returns {string} the suffix of the error message.
 */
function failureSuffix({ stdout, stderr }) {
  const line = lastLine(stderr) || lastLine(stdout)
  return line === '' ? '' : `: ${line}`
}

/**
 * Last non-empty line of a CLI output, capped so one pathological line cannot
 * dominate a command result.
 *
 * @param {unknown} text - captured output.
 * @returns {string} the line, or `''`.
 */
function lastLine(text) {
  if (typeof text !== 'string') return ''
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return ''
  const line = lines[lines.length - 1]
  return line.length > MAX_DIAGNOSTIC_LENGTH ? `${line.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : line
}
