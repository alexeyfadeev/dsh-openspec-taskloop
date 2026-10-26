// dsh-openspec-taskloop — invocation of the `openspec` CLI (task 2.1).
//
// Every read the plugin makes goes through this one wrapper — `list --json`,
// `instructions apply --json`, and later `init` — so the executable lookup, the
// deadline, the output caps and the failure vocabulary are defined once.
//
// Two facts shape the contract:
//
//   - A nonzero exit is DATA, not an exception. `openspec list --json` exits
//     nonzero on an uninitialized project and still prints `"root": null`, and
//     `instructions apply --json` exits nonzero on a blocked change; the caller
//     reads the answer from stdout and decides. Only a failure to RUN the CLI
//     (missing executable, spawn error, timeout, cancellation) throws.
//   - A hung CLI must not wedge a run. The call is bounded by
//     `openspec.timeoutMs` (design D11) *and* by the caller's own signal, and
//     the managed process range is terminated on either, rather than waiting
//     for a provider to notice.
//
// The service is reached through `ctx.subprocess`; the class takes the service
// as a constructor argument so tests can drive it with a fake and so the plugin
// entry point stays the only place that knows about Cordis.
//
// The third fact is a version gate (task 9.1, design D20): every read above is a
// document a *recent* CLI defines, so `openspec --version` is asked once per run,
// before the first of them, and a CLI below the floor — or one that will not say
// which version it is — stops the run with advice instead of failing in the middle
// of it, after some tasks were already done.

/** Executable the subprocess provider resolves; the plugin never guesses a path. */
export const OPENSPEC_COMMAND = 'openspec'

/**
 * Oldest `openspec` this plugin's reads are written against (task 9.1, design D20).
 *
 * The plugin lives on JSON documents the CLI defines — `list --json` with `root`,
 * `instructions apply --json` with the task list — and an older CLI answers a different
 * shape. A constant, not a configuration value: a setting could only lower the floor, and
 * an old CLI does not become newer for it.
 */
export const MIN_OPENSPEC_VERSION = '0.14.0'

/**
 * Failure kinds reported by {@link OpenSpecError}. Callers switch on the code
 * instead of matching message text.
 */
export const OPENSPEC_ERROR = Object.freeze({
  /** The provider could not resolve `openspec` on PATH. */
  missing: 'missing',
  /** The call outlived `openspec.timeoutMs` and was terminated. */
  timeout: 'timeout',
  /** The caller's own signal fired before the call finished. */
  aborted: 'aborted',
  /** The provider failed to start or run the process. */
  spawn: 'spawn',
  /** The installed CLI is older than {@link MIN_OPENSPEC_VERSION}. */
  outdated: 'outdated',
  /** `openspec --version` failed or answered without a version this plugin can read. */
  unrecognized: 'unrecognized',
})

/** Milliseconds the CLI gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000

/** In-memory stdout cap; `instructions apply --json` is the largest answer read. */
const STDOUT_MAX_BYTES = 8 * 1024 * 1024

/** Retained stderr tail for diagnostics. */
const STDERR_MAX_BYTES = 16 * 1024

/**
 * A call that could not be completed. A nonzero exit is not represented here:
 * see the module comment.
 */
export class OpenSpecError extends Error {
  /**
   * @param {string} message - diagnostic naming the command and the cause.
   * @param {object} details
   * @param {'missing'|'timeout'|'aborted'|'spawn'|'outdated'|'unrecognized'} details.code - failure kind.
   * @param {readonly string[]} [details.args] - arguments handed to the CLI.
   * @param {Error} [details.cause] - underlying provider or process error.
   * @param {number} [details.timeoutMs] - configured deadline of this call.
   */
  constructor(message, { code, args = [], cause, timeoutMs }) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'OpenSpecError'
    this.code = code
    this.args = args
    this.timeoutMs = timeoutMs
  }
}

/**
 * Settled command facts; mirrors the shape of the harness' own CLI runners.
 *
 * @typedef {object} OpenSpecResult
 * @property {number|null} exitCode - exit code, `null` when a signal killed it.
 * @property {string} stdout - collected stdout, decoded as UTF-8.
 * @property {string} stderr - retained stderr tail.
 * @property {boolean} truncated - true when stdout overflowed its cap and lost its head.
 */

/**
 * The argument that asks the CLI which version it is (task 9.1, design D20).
 *
 * One element in an argv array, like every other call: the plugin never composes a
 * command line and never lets a shell see what it runs.
 */
const VERSION_ARGS = Object.freeze(['--version'])

/** The first `X.Y.Z` anywhere in an answer; pre-release and build metadata are not part of it. */
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/u

/**
 * Read the version out of an `openspec --version` answer (task 9.1).
 *
 * The answer is treated as data rather than as a format: the first `X.Y.Z` anywhere in it
 * is the version, and anything without one is `undefined`. Pre-release and build metadata
 * are dropped on purpose (design D20) — the gate exists to exclude an old contract, not to
 * honour semantic-version ordering, so `0.14.0-beta` counts as `0.14.0`.
 *
 * @param {unknown} answer - printed stdout of `openspec --version`.
 * @returns {{major: number, minor: number, patch: number}|undefined} numeric components, or
 *   `undefined` when the answer holds no version at all.
 */
export function parseOpenSpecVersion(answer) {
  if (typeof answer !== 'string') return undefined
  const match = VERSION_PATTERN.exec(answer)
  if (match === null) return undefined
  const [major, minor, patch] = match.slice(1).map((part) => Number(part))
  // A component that is not a safe integer cannot be compared, so it is not a version.
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return undefined
  return { major, minor, patch }
}

/**
 * Compare two parsed versions component by component (task 9.1).
 *
 * Deliberately not a string comparison: `'0.9.0' > '0.14.0'` as text, because `'9' > '1'`,
 * while 0.9.0 is the older release. The components are compared as numbers, major first.
 *
 * @param {{major: number, minor: number, patch: number}} left - parsed version.
 * @param {{major: number, minor: number, patch: number}} right - parsed version to compare against.
 * @returns {number} negative when `left` is older, zero when the two are equal, positive when newer.
 * @throws {TypeError} when either side is not a parsed version.
 */
export function compareOpenSpecVersions(left, right) {
  for (const side of [left, right]) {
    if (!Number.isSafeInteger(side?.major) || !Number.isSafeInteger(side?.minor) || !Number.isSafeInteger(side?.patch)) {
      throw new TypeError('compareOpenSpecVersions requires two parsed versions')
    }
  }
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1
  }
  return 0
}

/**
 * Render a parsed version the way the CLI printed it.
 *
 * @param {{major: number, minor: number, patch: number}} version - parsed version.
 * @returns {string} `X.Y.Z`.
 */
function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`
}

/**
 * The tool's own last word, as a clause of a version refusal.
 *
 * @param {string} stderr - retained stderr of the call.
 * @returns {string} `: <tail>`, or an empty string when the tool said nothing.
 */
function stderrClause(stderr) {
  const said = typeof stderr === 'string' ? stderr.trim() : ''
  if (said === '') return ''
  const tail = said.split(/\r?\n/u).at(-1) ?? ''
  return `: ${tail.length > 160 ? `${tail.slice(0, 160)}…` : tail}`
}

/**
 * Runs `openspec` through a subprocess provider.
 *
 * One instance is bound to one `openspec.timeoutMs`, because the timeout is a
 * property of the configuration rather than of a single call.
 */
export class OpenSpecCli {
  /** @type {object} The `ctx.subprocess` service; only `resolveExecutable` and `spawn` are used. */
  #subprocess

  /** @type {number} */
  #timeoutMs

  /** @type {Promise<{major: number, minor: number, patch: number}>|undefined} */
  #version

  /**
   * @param {object} subprocess - `ctx.subprocess`.
   * @param {object} options
   * @param {number} options.timeoutMs - deadline of one call in milliseconds; positive integer.
   */
  constructor(subprocess, { timeoutMs }) {
    if (subprocess === undefined || subprocess === null) {
      throw new TypeError('OpenSpecCli requires the subprocess service')
    }
    // The schema bounds this for a mounted plugin; the class is also built
    // directly, so it keeps the same invariant instead of trusting the caller.
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new TypeError(`OpenSpecCli requires a positive integer timeoutMs, got ${String(timeoutMs)}`)
    }
    this.#subprocess = subprocess
    this.#timeoutMs = timeoutMs
  }

  /** Configured deadline of one call, in milliseconds. */
  get timeoutMs() {
    return this.#timeoutMs
  }

  /**
   * Settle the installed version, or refuse to go on with it (task 9.1, design D20).
   *
   * Every read the plugin makes leans on a JSON document this CLI defines, so the version
   * is asked once, before the first of them (`lib/control.js` calls this right after the
   * wrapper is built and before the project is read). A version below
   * {@link MIN_OPENSPEC_VERSION} and an answer that names no version both stop the run:
   * the second case means the contract cannot be confirmed, and guessing is worse than
   * saying so. A version at or above the floor returns quietly; the caller has nothing to
   * report, because a supported CLI is not news.
   *
   * The verdict is remembered on the wrapper, which lives for one run (design D20): the
   * steps of that run ask again only to get the same answer, never to start a second
   * `--version` process. A missing executable, a timeout and a stop are not versions at
   * all and are reported as what they are — those messages already say what failed.
   *
   * @param {object} [options]
   * @param {string} [options.cwd] - project directory the CLI runs in.
   * @param {AbortSignal} [options.signal] - cancellation of the whole run.
   * @returns {Promise<{major: number, minor: number, patch: number}>} the installed version.
   * @throws {OpenSpecError} `outdated` for a CLI below the floor, `unrecognized` for an
   *   answer without a version, and the invocation kinds for a call that could not run.
   */
  async ensureSupportedVersion({ cwd, signal } = {}) {
    this.#version ??= this.#settleVersion({ cwd, signal })
    return await this.#version
  }

  /**
   * Ask the CLI once and turn its answer into a version or a refusal.
   *
   * A nonzero exit is asked about before stdout is parsed, because a `--version` that
   * failed has not confirmed anything even if it happened to print a number (design D20:
   * the gate is fail-closed).
   *
   * @param {object} options
   * @param {string} [options.cwd] - project directory the CLI runs in.
   * @param {AbortSignal} [options.signal] - cancellation of the whole run.
   * @returns {Promise<{major: number, minor: number, patch: number}>} the installed version.
   * @throws {OpenSpecError} `unrecognized` or `outdated`.
   */
  async #settleVersion({ cwd, signal }) {
    const result = await this.run(VERSION_ARGS, { cwd, signal })
    const command = `${OPENSPEC_COMMAND} ${VERSION_ARGS.join(' ')}`
    const minimum = parseOpenSpecVersion(MIN_OPENSPEC_VERSION)
    if (minimum === undefined) {
      // A malformed floor is a bug in this module, not a verdict about the CLI.
      throw new TypeError(`MIN_OPENSPEC_VERSION is not a version: ${MIN_OPENSPEC_VERSION}`)
    }

    if (result.exitCode !== 0) {
      const how = result.exitCode === null
        ? `${command} was killed before it printed a version`
        : `${command} exited with code ${String(result.exitCode)}`
      throw new OpenSpecError(
        `the ${OPENSPEC_COMMAND} version could not be determined: ${how}${stderrClause(result.stderr)}; `
        + `OpenSpec ${MIN_OPENSPEC_VERSION} or newer is required, so update OpenSpec and run /taskloop again`,
        { code: OPENSPEC_ERROR.unrecognized, args: VERSION_ARGS },
      )
    }

    const version = parseOpenSpecVersion(result.stdout)
    if (version === undefined) {
      throw new OpenSpecError(
        `the ${OPENSPEC_COMMAND} version could not be determined: ${command} printed no X.Y.Z version; `
        + `OpenSpec ${MIN_OPENSPEC_VERSION} or newer is required, so update OpenSpec and run /taskloop again`,
        { code: OPENSPEC_ERROR.unrecognized, args: VERSION_ARGS },
      )
    }

    if (compareOpenSpecVersions(version, minimum) < 0) {
      throw new OpenSpecError(
        `${OPENSPEC_COMMAND} ${formatVersion(version)} is older than the minimum ${MIN_OPENSPEC_VERSION}; `
        + `update OpenSpec to ${MIN_OPENSPEC_VERSION} or newer and run /taskloop again`,
        { code: OPENSPEC_ERROR.outdated, args: VERSION_ARGS },
      )
    }

    return version
  }

  /**
   * Run one `openspec` command to completion.
   *
   * Resolves for any exit code, including a nonzero one; rejects only when the
   * CLI could not run or the call was cut short.
   *
   * @param {readonly string[]} args - arguments after the executable; never shell-interpreted.
   * @param {object} options
   * @param {string} options.cwd - project directory the CLI runs in.
   * @param {AbortSignal} [options.signal] - cancellation of the whole run.
   * @returns {Promise<OpenSpecResult>} exit facts and collected output.
   * @throws {OpenSpecError} with `code` naming the failure kind.
   */
  async run(args, { cwd, signal } = {}) {
    // One deadline per call: `AbortSignal.timeout` starts its timer here, and
    // `AbortSignal.any` lets either the caller or the deadline stop the child.
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const command = `${OPENSPEC_COMMAND} ${args.join(' ')}`

    // Classifies an abort into the two ways it happens. Returns undefined when
    // neither fired, which is how callers tell "aborted" from "failed to start".
    const abortFailure = () => {
      if (timeout.aborted) {
        return new OpenSpecError(`${command} timed out after ${this.#timeoutMs}ms`, {
          code: OPENSPEC_ERROR.timeout,
          args,
          timeoutMs: this.#timeoutMs,
        })
      }
      if (bound.aborted) {
        return new OpenSpecError(`${command} was aborted`, { code: OPENSPEC_ERROR.aborted, args })
      }
      return undefined
    }

    const executable = await this.#resolve(args, bound, abortFailure)

    // A deadline can expire while the executable is being looked up.
    const stale = abortFailure()
    if (stale !== undefined) throw stale

    const handle = this.#spawn(args, executable, cwd, bound, abortFailure)

    let outcome
    try {
      outcome = await this.#settle(handle, bound, abortFailure)
    } catch (error) {
      if (error instanceof OpenSpecError) throw error
      throw new OpenSpecError(`${command} failed to run: ${describe(error)}`, {
        code: OPENSPEC_ERROR.spawn,
        args,
        cause: error instanceof Error ? error : undefined,
      })
    }

    // Collect-mode stdio always yields both readers; the fallbacks keep a
    // provider that omits one from turning a result into a crash.
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }

  /**
   * Resolve the executable in the provider's execution world.
   *
   * @param {readonly string[]} args - arguments, for the failure message.
   * @param {AbortSignal} bound - cancellation carrying both the deadline and the caller.
   * @param {() => OpenSpecError|undefined} abortFailure - abort classifier.
   * @returns {Promise<string>} canonical executable path.
   * @throws {OpenSpecError} `missing`, or the abort cause when the lookup was cut short.
   */
  async #resolve(args, bound, abortFailure) {
    try {
      return await this.#subprocess.resolveExecutable(OPENSPEC_COMMAND, undefined, bound)
    } catch (cause) {
      const aborted = abortFailure()
      if (aborted !== undefined) throw aborted
      // The provider reports a lookup miss with its own error type; the plugin
      // does not depend on that type, only on the lookup having failed.
      throw new OpenSpecError(`${OPENSPEC_COMMAND} CLI is not available: ${describe(cause)}`, {
        code: OPENSPEC_ERROR.missing,
        args,
        cause: cause instanceof Error ? cause : undefined,
      })
    }
  }

  /**
   * Start the child with the fully specified request the seam requires.
   *
   * @param {readonly string[]} args - arguments after the executable.
   * @param {string} executable - resolved path.
   * @param {string} cwd - project directory.
   * @param {AbortSignal} bound - cancellation signal handed to the provider.
   * @param {() => OpenSpecError|undefined} abortFailure - abort classifier.
   * @returns {object} the live process handle returned by the provider.
   * @throws {OpenSpecError} `spawn`, or the abort cause when the request was pre-aborted.
   */
  #spawn(args, executable, cwd, bound, abortFailure) {
    try {
      return this.#subprocess.spawn({
        argv: [executable, ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STDOUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal: bound,
      })
    } catch (cause) {
      const aborted = abortFailure()
      if (aborted !== undefined) throw aborted
      throw new OpenSpecError(`${OPENSPEC_COMMAND} ${args.join(' ')} could not start: ${describe(cause)}`, {
        code: OPENSPEC_ERROR.spawn,
        args,
        cause: cause instanceof Error ? cause : undefined,
      })
    }
  }

  /**
   * Wait for the direct command's exit facts, but never past the bound.
   *
   * The provider terminates the range when the signal fires; `terminate()` is
   * called again here because it is idempotent and makes the deadline hold even
   * for a provider that stops observing the child.
   *
   * @param {object} handle - live process handle returned by the provider.
   * @param {AbortSignal} bound - cancellation carrying both the deadline and the caller.
   * @param {() => OpenSpecError|undefined} abortFailure - abort classifier; never undefined inside the listener.
   * @returns {Promise<{exitCode: number|null, signal: string|null}>} exit facts.
   * @throws {OpenSpecError} timeout or abort, classified by the caller's cause.
   */
  #settle(handle, bound, abortFailure) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        handle.terminate()
        // The listener only runs because the bound aborted, so this is an
        // error; the fallback cannot be reached but keeps the type honest.
        reject(abortFailure() ?? new OpenSpecError(`${OPENSPEC_COMMAND} call was aborted`, { code: OPENSPEC_ERROR.aborted }))
      }
      bound.addEventListener('abort', onAbort, { once: true })
      handle.done.then(
        (outcome) => {
          bound.removeEventListener('abort', onAbort)
          resolve(outcome)
        },
        (error) => {
          bound.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }
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
