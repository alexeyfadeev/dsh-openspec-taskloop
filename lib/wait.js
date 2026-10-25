// dsh-openspec-taskloop — the wait for a turn to go quiet, cut short by a stop
// (tasks 4.3, 3.2).
//
// `whenIdle()` is how both an agent and the session runner that speaks for an
// agent (`lib/session.js`) report that the turn a message started has finished.
// It cannot be cancelled: the turn runs to its end whatever happens to the run
// that started it. Two places wait for it — between the tasks of a group in the
// loop (4.2) and during the review that closes one (3.2, design D14) — and both
// obey the same rule: a stop wins the race, the wait is abandoned, and the caller
// reports `cancelled` instead of a turn that is still finishing.
//
// Losing the race leaves `whenIdle()` pending and unobserved; the run is over and
// nobody will read it again, so the abandonment must not turn into an unhandled
// rejection.
//
//     whenIdle() ─┐
//                 ├─▶ 'idle'      ──▶ the caller reads the next state
//     signal ─────┘─▶ 'cancelled' ──▶ the caller ends the run as stopped
//
// The helpers are shared rather than duplicated because the ordering they protect
// is subtle: waiting before the prompt was accepted would return at once, and
// watching the signal only after `whenIdle()` resolved would make `/taskloop stop`
// wait for a turn the user asked to leave.

/**
 * Whether the run has been cancelled.
 *
 * @param {AbortSignal} [signal] - cancellation of the whole run.
 * @returns {boolean} true when the caller stopped the run.
 */
export function aborted(signal) {
  return signal?.aborted === true
}

/**
 * Wait for the agent to go quiet, unless the run is cancelled first.
 *
 * The signal is watched only for this wait: the listener is removed whichever way
 * the race ends, so a long run does not accumulate one per turn. A signal that is
 * already aborted returns without touching `whenIdle()`.
 *
 * @param {object} agent - live agent or session runner; must expose `whenIdle()`.
 * @param {AbortSignal} [signal] - cancellation of the run.
 * @returns {Promise<'idle'|'cancelled'>} why the wait ended.
 * @throws {TypeError} when the agent cannot report idleness.
 */
export async function waitForIdle(agent, signal) {
  if (typeof agent?.whenIdle !== 'function') {
    throw new TypeError('waitForIdle requires an agent that reports whenIdle()')
  }
  if (signal === undefined || signal === null) {
    await agent.whenIdle()
    return 'idle'
  }
  if (aborted(signal)) return 'cancelled'

  /** @type {() => void} */
  let onAbort
  const cancelled = new Promise((resolve) => {
    onAbort = () => resolve('cancelled')
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([agent.whenIdle().then(() => 'idle'), cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
