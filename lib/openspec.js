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

/** Executable the subprocess provider resolves; the plugin never guesses a path. */
export const OPENSPEC_COMMAND = 'openspec'

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
   * @param {'missing'|'timeout'|'aborted'|'spawn'} details.code - failure kind.
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
