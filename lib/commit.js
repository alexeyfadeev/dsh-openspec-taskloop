// dsh-openspec-taskloop — the commit that closes a task group (task 4.1).
//
// Design D15: the commit is the plugin's business, not the model's. The run knows
// which tasks it just finished and that the tree has to end up in the history, so
// it calls the configured tool itself. Letting the agent commit would make the one
// step that is easy to verify by machine — "the changes of this group are in the
// history" — depend on the model remembering to do it.
//
//     git status --porcelain ──▶ empty ──────────────▶ { kind: 'empty' }
//              │
//              └─ changes ──▶ git add -A ──▶ git commit -m <msg> ──▶ { kind: 'committed' }
//                             or  but commit -m <msg>
//
// Three properties shape the contract:
//
//   - Every argument is one argv element. There is no shell between the plugin and
//     the tool, so the commit message needs no escaping: quotes, spaces and line
//     breaks inside it stay a single argument, and a message the user typed can
//     never turn into a second command. The runner that resolves the executable and
//     spawns the process lives in `lib/environment.js` (task 4.2); this module only
//     builds the requests, which is why it is testable without a host.
//   - An exit code is data. A nonzero one does not throw: the command that failed,
//     its code and the tail of its stderr travel back in the outcome, so the run can
//     stop with a report that names the tool and the reason (design D17). Only a
//     request that cannot be made at all — a missing tool, a bad range — is an error.
//   - A stop is not a failure. A `/taskloop stop` that lands before or during the
//     commands ends the commit as `stopped`, and the run reports a stop rather than
//     an error the user did not cause. A commit that already went through stays
//     `committed` even when the stop lands while it finishes.
//
// The message is the user's text with the range of the group appended — `Добавить
// эндпоинт. Tasks 2.1 - 2.4` — because the text says what the work is for and the
// range says which part of it this commit is. A flat run has no task numbers to
// name (design D13), so its commit is the text alone; inventing a range for it
// would claim a structure the task list does not have.
//
// The tree is committed whole (`git add -A`, design D15): untracked files, a
// leftover edit of the user's, everything. That is the accepted trade-off — the
// alternative, snapshotting the tree at startup, is a much larger machine — and it
// is why an empty tree is not an error: the user may have committed by hand, and
// the run says so instead of committing an empty change set.

import { aborted } from './wait.js'

/**
 * Values of {@link CommitOutcome.kind}; callers switch on them.
 */
export const COMMIT_END = Object.freeze({
  /** The tool committed the tree; `output` is what it printed. */
  committed: 'committed',
  /** The tree had no changes; the tool was not asked to commit anything. */
  empty: 'empty',
  /** The tool ran and refused, or could not be run; `command` and `reason` say why. */
  failed: 'failed',
  /** The run was stopped before the commit went through; the next task must not start. */
  stopped: 'stopped',
})

/** The read-only check that decides whether there is anything to commit (design D15). */
export const STATUS_COMMAND = Object.freeze({
  executable: 'git',
  args: Object.freeze(['status', '--porcelain']),
})

/** Longest stderr tail kept in a failure reason, in characters. */
const REASON_MAX_CHARS = 2_000

/**
 * How one commit ended.
 *
 * `tool` is the configured tool (`git` or `gitbutler`), not the executable that
 * failed — a report says "the commit through git" and the user can then check the
 * setting. `message` is the message the commit would have had, so a failure can be
 * retried by hand without composing it again.
 *
 * On a failure, `command` names the request that failed (`git status`, `git add`,
 * `git commit`, `but commit`) and `reason` carries the tail of its stderr, the
 * message it printed to stdout when stderr was empty, or a sentence about the exit
 * code when it printed nothing at all. `exitCode` is absent only when the tool could
 * not be run — an executable that is not on PATH has no code to report.
 *
 * @typedef {object} CommitOutcome
 * @property {'committed'|'empty'|'failed'|'stopped'} kind - how the commit ended.
 * @property {'git'|'gitbutler'} tool - tool the configuration selected.
 * @property {string} message - message the commit carries (or would have carried).
 * @property {string} [output] - what the tool printed when it committed; the commit
 *   id is the part of it a report quotes.
 * @property {string} [command] - request that failed, e.g. `git commit`.
 * @property {number|null} [exitCode] - exit code of that request, `null` when a
 *   signal killed it; absent when it could not run.
 * @property {string} [reason] - why it failed: stderr tail, stdout tail or the code.
 */

/**
 * The message a commit carries: the user's text plus the range of the group.
 *
 * Surrounding whitespace is dropped because the text is stored between runs and a
 * trailing newline would otherwise end up before the appended range. Inner line
 * breaks are kept: the message is a single argv element, so a multi-line body is
 * one argument the way a one-line message is.
 *
 * The range is added as a new sentence, and the sentence break is not doubled when
 * the user's text already ends with one: `Добавить эндпоинт` becomes
 * `Добавить эндпоинт. Tasks 2.1 - 2.4`, while a text typed as
 * `Change add-fallback-status-badge.` becomes `Change add-fallback-status-badge.
 * Tasks 2.1 - 2.7` — the same words the user wrote, with no `..` the tool would
 * carry into the history. A text that ends with `!` or `?` is a finished sentence
 * too, so it gets the same treatment.
 *
 * @param {object} options
 * @param {string} options.text - message text the user typed for this change (5.2).
 * @param {{from: string, to: string}} [options.range] - first and last task of the
 *   group, as written in `tasks.md`; absent for a flat run, whose commit carries the
 *   text alone.
 * @returns {string} the commit message.
 * @throws {TypeError} when the text is empty, or a range is given but is not a pair
 *   of non-empty labels.
 */
export function buildCommitMessage({ text, range }) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') {
    throw new TypeError('buildCommitMessage requires a non-empty message text')
  }
  if (range === undefined) return body
  if (typeof range?.from !== 'string' || range.from === '') {
    throw new TypeError('buildCommitMessage requires range.from when a range is given')
  }
  if (typeof range?.to !== 'string' || range.to === '') {
    throw new TypeError('buildCommitMessage requires range.to when a range is given')
  }
  // A sentence the user already ended stays one sentence: the range is appended as
  // a separate sentence rather than as a second full stop.
  const separator = /[.!?]$/u.test(body) ? ' ' : '. '
  return `${body}${separator}Tasks ${range.from} - ${range.to}`
}

/**
 * The commit id a tool printed, when its output names one.
 *
 * `git commit` answers with `[<branch> <hash>] <subject>` (and `[<branch>
 * (root-commit) <hash>] …` for the first commit of a repository), while `but
 * commit` prints `Committed as <hash>`. The id is taken from those two shapes only:
 * an arbitrary hex-looking word elsewhere in the output — a branch name, a path, a
 * word of the subject — must never be reported as the commit.
 *
 * @param {unknown} output - what the commit tool printed.
 * @returns {string|undefined} the abbreviated id, or `undefined` when the output
 *   names none.
 */
export function commitIdOf(output) {
  if (typeof output !== 'string') return undefined
  // The hash is the last token inside the brackets; a greedy prefix keeps a branch
  // name that happens to look hexadecimal from winning.
  const bracketed = /\[[^\]\n]*\b([0-9a-f]{7,40})\]/u.exec(output)
  if (bracketed !== null) return bracketed[1]
  const committed = /\bCommitted as\s+([0-9a-f]{7,40})\b/u.exec(output)
  if (committed !== null) return committed[1]
  return undefined
}

/**
 * The requests that perform one commit, in order, with the message already in place.
 *
 * `git` needs the tree staged first, so it takes two requests; GitButler's `but`
 * commits on its own and takes one. The message is the last element of the argv
 * rather than something interpolated into a command line: the tool receives it
 * byte for byte, whatever punctuation it holds.
 *
 * @param {object} options
 * @param {'git'|'gitbutler'} options.tool - configured commit tool (design D12).
 * @param {string} options.message - commit message, as {@link buildCommitMessage} built it.
 * @returns {{executable: string, args: readonly string[]}[]} the requests, in order.
 * @throws {TypeError} when the tool is unknown or the message is empty.
 */
export function buildCommitCommands({ tool, message }) {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new TypeError('buildCommitCommands requires a non-empty commit message')
  }
  const commit = Object.freeze(['commit', '-m', message])
  switch (tool) {
    case 'git':
      return [
        Object.freeze({ executable: 'git', args: Object.freeze(['add', '-A']) }),
        Object.freeze({ executable: 'git', args: commit }),
      ]
    case 'gitbutler':
      return [Object.freeze({ executable: 'but', args: commit })]
    default:
      // The schema rejects this before a run starts; the check is repeated here
      // because a caller that bypasses the loader must not reach a silent no-op.
      throw new TypeError(`buildCommitCommands got an unknown commit tool: ${String(tool)}`)
  }
}

/**
 * Commit the tree of one finished group through the configured tool.
 *
 * The status check comes first because "nothing to commit" is a normal answer, not
 * a failure: `git add -A` on an empty tree would succeed and `git commit` would
 * fail on it, turning the user's own commit — or a group whose changes were already
 * in the history — into an error. A tree that does have changes is committed whole.
 *
 * A stop is honoured before each request and after every request but the last: a
 * stop that lands while the tree is being staged must not be followed by a commit,
 * while one that lands while the commit itself runs has already committed, and the
 * outcome says so.
 *
 * @param {object} options
 * @param {'git'|'gitbutler'} options.tool - configured commit tool, read at the
 *   moment of the commit so a change in Settings applies to the next group (D12).
 * @param {string} options.text - message text the user entered for this change.
 * @param {{from: string, to: string}} [options.range] - group the commit closes;
 *   absent for a flat run.
 * @param {string} options.cwd - project directory the tool runs in.
 * @param {(request: {executable: string, args: readonly string[]}, options: {cwd: string, signal?: AbortSignal}) => Promise<{exitCode: number|null, stdout: string, stderr: string}>} options.run -
 *   executes one request without a shell. A request that cannot run at all must
 *   reject; an exit code comes back in the result (task 4.2).
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<CommitOutcome>} how the commit ended and what it carried.
 * @throws {TypeError} when the runner is missing, or the text, the range or the tool
 *   cannot be turned into a request.
 */
export async function runCommit({ tool, text, range, cwd, run, signal }) {
  if (typeof run !== 'function') {
    throw new TypeError('runCommit requires a run() that executes one commit request')
  }
  // Built before anything runs: a message that cannot be composed is a caller's
  // bug, and a tree staged by a half-run commit would be left that way.
  const message = buildCommitMessage({ text, range })
  const commands = buildCommitCommands({ tool, message })

  /** Fields every ending of this commit carries. */
  const outcome = (kind) => ({ kind, tool, message })
  const stopped = () => outcome(COMMIT_END.stopped)
  /**
   * @param {string} command - request that failed.
   * @param {number|null} [exitCode] - its exit code, when it ran.
   * @param {string} [reason] - its account of the failure.
   * @returns {CommitOutcome} the failed outcome.
   */
  const failed = (command, exitCode, reason) => {
    const result = { ...outcome(COMMIT_END.failed), command }
    if (exitCode !== undefined) result.exitCode = exitCode
    if (reason !== undefined) result.reason = reason
    return result
  }

  if (aborted(signal)) return stopped()

  const status = await attempt(run, STATUS_COMMAND, cwd, signal)
  if (aborted(signal)) return stopped()
  if (status.error !== undefined) {
    return failed(commandName(STATUS_COMMAND), undefined, describe(status.error))
  }
  if (status.result.exitCode !== 0) {
    return failed(commandName(STATUS_COMMAND), status.result.exitCode, reasonOf(status.result))
  }
  if (!hasChanges(status.result)) return outcome(COMMIT_END.empty)

  /** @type {{exitCode: number|null, stdout: string, stderr: string}|undefined} */
  let last
  for (const [index, command] of commands.entries()) {
    if (aborted(signal)) return stopped()

    const result = await attempt(run, command, cwd, signal)
    // A stop that cut the request short is the stop, not a tool that failed.
    if (aborted(signal) && (result.error !== undefined || result.result.exitCode !== 0)) {
      return stopped()
    }
    if (result.error !== undefined) {
      return failed(commandName(command), undefined, describe(result.error))
    }
    if (result.result.exitCode !== 0) {
      return failed(commandName(command), result.result.exitCode, reasonOf(result.result))
    }
    // The commit is the last request: once it went through the tree is committed,
    // and a stop arriving while it finished must not pretend otherwise.
    if (index < commands.length - 1 && aborted(signal)) return stopped()
    last = result.result
  }

  const output = last === undefined ? undefined : tailOf(last.stdout)
  return output === undefined ? outcome(COMMIT_END.committed) : { ...outcome(COMMIT_END.committed), output }
}

/**
 * Run one request and keep a rejection as a value.
 *
 * Both ways a request can fail end in the same report — the tool's own refusal and
 * the runner's inability to start it — so they meet here rather than at every call
 * site. The rejection is returned, not swallowed: the caller turns it into the
 * `reason` of a failed commit.
 *
 * @param {Function} run - runner handed in by the caller.
 * @param {{executable: string, args: readonly string[]}} command - request to run.
 * @param {string} cwd - project directory.
 * @param {AbortSignal} [signal] - cancellation of the whole run.
 * @returns {Promise<{result: object}|{error: unknown}>} the result or the rejection.
 */
async function attempt(run, command, cwd, signal) {
  try {
    const result = await run(
      { executable: command.executable, args: [...command.args] },
      { cwd, signal },
    )
    return { result }
  } catch (error) {
    return { error }
  }
}

/**
 * Whether `git status --porcelain` reported at least one change.
 *
 * Porcelain output is one line per change and nothing else, so a blank answer — the
 * empty string, or a provider that appended a newline to it — is the empty tree.
 *
 * @param {{stdout?: string}} result - settled status request.
 * @returns {boolean} whether the tree has anything to commit.
 */
function hasChanges(result) {
  return typeof result.stdout === 'string' && result.stdout.trim() !== ''
}

/**
 * Why a request that ran failed, as the report should quote it.
 *
 * stderr is the tool's own explanation and wins; GitButler prints some refusals to
 * stdout, so that is the second source; a silent refusal still gets a sentence, so
 * the report never shows a failure with no reason at all.
 *
 * @param {{exitCode: number|null, stdout?: string, stderr?: string}} result - settled
 *   request whose exit code was not zero.
 * @returns {string} the reason to report.
 */
function reasonOf(result) {
  const said = tailOf(result.stderr) ?? tailOf(result.stdout)
  if (said !== undefined) return said
  if (result.exitCode === null) return 'the command was terminated by a signal before it exited'
  return `the command exited with code ${String(result.exitCode)}`
}

/**
 * The last `REASON_MAX_CHARS` characters of a tool's output, or `undefined` when it
 * said nothing.
 *
 * A tool can print a whole diff or a page of hints; the report wants the sentence at
 * the end of it. The text is trimmed but not otherwise rewritten: what the tool said
 * is what the user gets.
 *
 * @param {unknown} value - output captured from the tool.
 * @returns {string|undefined} the tail, when there is one.
 */
function tailOf(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length <= REASON_MAX_CHARS ? text : text.slice(-REASON_MAX_CHARS)
}

/**
 * How a request is named in a report: `git commit`, `git add`, `git status`, `but commit`.
 *
 * The message is left out on purpose — it is already the outcome's `message`, and a
 * failure report should not quote it twice.
 *
 * @param {{executable: string, args: readonly string[]}} command - request.
 * @returns {string} executable and subcommand.
 */
function commandName(command) {
  return [command.executable, command.args[0]].filter((part) => typeof part === 'string' && part !== '').join(' ')
}

/**
 * Message text of an unknown thrown value.
 *
 * @param {unknown} value - thrown value from the runner.
 * @returns {string} a message safe to embed.
 */
function describe(value) {
  return value instanceof Error ? value.message : String(value)
}
