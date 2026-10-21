// dsh-openspec-taskloop — compaction between tasks of one group (task 6.1).
//
// Between two tasks of the same group the run stays in one session, so the context
// of the tasks already done is still there when the next one starts.
// `compaction.compactNow()` is what bounds it: design D7 has the plugin call it on
// every transition inside a group, and only there — a group boundary opens a fresh
// session (5.1), whose context is empty by construction, so compacting the session
// the run is leaving would pay for work nobody needs.
//
// Manual compaction does not always succeed on the first call. Three codes are
// transient: `busy` means another turn already holds the session, `summary` means
// the summarization request failed, and `persistence` means the checkpoint could
// not be written — each of those may succeed a moment later. Three codes are
// terminal instead: `changed` means the selected span moved under the backend,
// `commit` that the replacement was already being applied, and `cancelled` that
// somebody aborted the request. A retry there re-enters a transaction that must not
// be re-entered; `commit` in particular would risk applying half of a mutation
// twice. Design D11 makes the transient set configurable and freezes the terminal
// three, which is why {@link TERMINAL_CODES} below is never read from
// configuration: no setting may make them retryable (design D7).
//
//     compactNow ──ok──────────────────▶ compacted
//          │
//          ├──terminal or unlisted code─▶ failed   (no retry)
//          ├──transient, budget left────▶ wait(delayMs·factor^n) ──▶ compactNow
//          └──budget exhausted──────────▶ failed
//
// The delay before the first retry is `delayMs`; every further retry multiplies it
// by `factor`, never above `maxDelayMs` (design D11). `sleep` is injected so the
// backoff is observable in tests without spending wall-clock time, and the default
// wait ends early when the run is cancelled, so `/taskloop stop` is not held up by
// a pending backoff.
//
// What happens after `failed` is the caller's decision, not this module's: `failed`
// says the attempts are over, and the run turns that into the configured
// `compaction.onFailure` outcome (6.2). {@link ON_FAILURE} names the two policies;
// the split is deliberate — retries belong here, and what a spent budget means for
// the run belongs to the loop that owns the run's progress. This module only
// guarantees that an attempt budget is respected and that no code is retried that
// must not be.

/**
 * Values of {@link CompactionOutcome.kind}; callers switch on them.
 */
export const COMPACTION_END = Object.freeze({
  /** The history was compacted, or the backend found nothing worth compacting. */
  compacted: 'compacted',
  /** Compaction did not succeed and no attempt is left. */
  failed: 'failed',
  /** The run was cancelled before or during an attempt; nothing failed. */
  cancelled: 'cancelled',
})

/**
 * Codes that are never retried, whatever `compaction.retry.codes` says (design D7).
 *
 * Exported so tests can pin the closed set and so a caller can explain the policy
 * without repeating the list.
 */
export const TERMINAL_CODES = Object.freeze(['changed', 'commit', 'cancelled'])

/**
 * What a transition does when its attempts are spent (design D7).
 *
 * `break` stops the run: continuing without compaction grows the context with no
 * bound, and a stop the report explains is better than a run that quietly
 * accumulates history. `continue` sends the task uncompacted and records a
 * warning, for projects that would rather make progress than lose a run to a
 * backend that is momentarily unavailable.
 *
 * Exported because two modules meet on these values: the run applies the policy
 * (6.2) and the configuration validates it, so the vocabulary lives in one place.
 */
export const ON_FAILURE = Object.freeze({
  /** Stop the run before the task the transition was preparing for. */
  break: 'break',
  /** Send the task without compacting and let the report carry a warning. */
  continue: 'continue',
})

/**
 * How one transition's compaction ended.
 *
 * `attempts` counts calls to `compactNow`, the first one included, and `delays`
 * records every backoff taken between them, in order — that is what makes the
 * retry policy observable from a test without a clock.
 *
 * @typedef {object} CompactionOutcome
 * @property {'compacted'|'failed'|'cancelled'} kind - how the transition ended.
 * @property {number} attempts - calls to `compactNow` made for this transition.
 * @property {number[]} delays - backoffs waited between those calls, in milliseconds.
 * @property {string} [code] - the last failure's `code`, when it carried one.
 * @property {Error|unknown} [error] - the last failure, unchanged.
 */

/**
 * Run `compactNow` for one transition, retrying transient codes with backoff.
 *
 * A successful call returns `compacted` — including the `null` a backend uses for
 * "nothing worth compacting", which is a success, not a missing answer. A failure
 * is retried only when its `code` is both listed in `retry.codes` and absent from
 * {@link TERMINAL_CODES}, and only while calls remain in `retry.attempts`. Running
 * out of attempts, or failing with any other code, settles as `failed`; the
 * configured {@link ON_FAILURE} policy decides what the run does with that (6.2).
 *
 * A cancelled run never became a compaction failure: the check happens before the
 * first call, after every failure, and after every backoff, so a stop ends the
 * transition as `cancelled` regardless of what the backend was doing.
 *
 * @param {object} options
 * @param {(agent: object, signal?: AbortSignal) => Promise<unknown>} options.compactNow -
 *   one attempt; the environment owns resolving the recipient to a compactable agent (6.1).
 * @param {object} options.agent - recipient of the task the transition leads to.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @param {object} options.retry - resolved `compaction.retry` configuration.
 * @param {number} options.retry.attempts - calls allowed, the first included.
 * @param {number} options.retry.delayMs - delay before the first retry.
 * @param {number} options.retry.factor - multiplier for each further delay.
 * @param {number} options.retry.maxDelayMs - ceiling for a delay.
 * @param {string[]} options.retry.codes - transient codes that may be retried.
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep] -
 *   waits between attempts; defaults to {@link waitFor}, which ends early on abort.
 * @returns {Promise<CompactionOutcome>} how the transition ended.
 * @throws {TypeError} when the compactor or the retry configuration is not usable.
 */
export async function compactBetweenTasks({ compactNow, agent, signal, retry, sleep = waitFor }) {
  if (typeof compactNow !== 'function') {
    throw new TypeError('compactBetweenTasks requires a compactNow() function')
  }
  if (typeof retry !== 'object' || retry === null) {
    throw new TypeError('compactBetweenTasks requires the resolved retry configuration')
  }

  const budget = Math.max(1, Math.trunc(retry.attempts))
  /** @type {number[]} */
  const delays = []
  let attempts = 0

  for (;;) {
    if (aborted(signal)) return settled(COMPACTION_END.cancelled, { attempts, delays })
    attempts += 1

    try {
      await compactNow(agent, signal)
      return settled(COMPACTION_END.compacted, { attempts, delays })
    } catch (error) {
      const code = codeOf(error)
      // A stop that landed while the backend was working is the stop, not a
      // compaction failure, and it must not cost another attempt.
      if (aborted(signal)) return settled(COMPACTION_END.cancelled, { attempts, delays, code, error })
      if (!isRetryable(code, retry.codes) || attempts >= budget) {
        return settled(COMPACTION_END.failed, { attempts, delays, code, error })
      }

      const delay = delayBefore(retry, attempts)
      delays.push(delay)
      await sleep(delay, signal)
    }
  }
}

/**
 * Whether a failure code may be retried.
 *
 * A missing code cannot be classified and is not retried: guessing that an
 * unknown failure is transient is exactly the mistake the terminal set exists to
 * prevent.
 *
 * @param {string|undefined} code - failure code.
 * @param {string[]|undefined} codes - configured transient codes.
 * @returns {boolean} true when the code is transient and configured.
 */
export function isRetryable(code, codes) {
  if (code === undefined) return false
  if (TERMINAL_CODES.includes(code)) return false
  return Array.isArray(codes) && codes.includes(code)
}

/**
 * The backoff before a retry.
 *
 * `attempt` is the number of the call that just failed, so the first retry waits
 * `delayMs`, the second `delayMs * factor`, and so on up to `maxDelayMs`
 * (design D11's semantics).
 *
 * @param {object} retry - resolved `compaction.retry` configuration.
 * @param {number} attempt - 1-based number of the failed call.
 * @returns {number} milliseconds to wait.
 */
function delayBefore(retry, attempt) {
  const grown = retry.delayMs * retry.factor ** (attempt - 1)
  return Math.min(grown, retry.maxDelayMs)
}

/**
 * Wait between attempts, ending early when the run is cancelled.
 *
 * The wait resolves rather than rejects on abort so the caller can read the signal
 * once, at the top of the loop, and report the stop as `cancelled` — the same
 * answer it gives for a stop that arrives between attempts.
 *
 * @param {number} ms - milliseconds to wait.
 * @param {AbortSignal} [signal] - cancellation of the whole run.
 * @returns {Promise<void>} resolves after the wait or on abort.
 */
export function waitFor(ms, signal) {
  if (aborted(signal) || !(ms > 0)) return Promise.resolve()

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

/**
 * Whether the run has been cancelled.
 *
 * @param {AbortSignal} [signal] - cancellation of the whole run.
 * @returns {boolean} true when the caller stopped the run.
 */
function aborted(signal) {
  return signal?.aborted === true
}

/**
 * The `code` a compaction failure carries, when it has a usable one.
 *
 * The compaction service reports expected failures as `ManualCompactionError`;
 * this module reads the field instead of importing the class, so it does not force
 * a host dependency into a module that is tested without a host. Exported because
 * the step-boundary gate (`lib/midtask.js`) reads the same field of the same error
 * and must classify it the same way (6.3).
 *
 * @param {unknown} error - thrown value.
 * @returns {string|undefined} the code, or `undefined` when the value cannot be classified.
 */
export function codeOf(error) {
  const code = error?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/**
 * Build one outcome, omitting the fields the transition never had.
 *
 * @param {CompactionOutcome['kind']} kind - how the transition ended.
 * @param {object} fields
 * @param {number} fields.attempts - calls made.
 * @param {number[]} fields.delays - backoffs waited.
 * @param {string} [fields.code] - last failure code.
 * @param {unknown} [fields.error] - last failure.
 * @returns {CompactionOutcome} the outcome.
 */
function settled(kind, { attempts, delays, code, error }) {
  const outcome = { kind, attempts, delays }
  if (code !== undefined) outcome.code = code
  if (error !== undefined) outcome.error = error
  return outcome
}
