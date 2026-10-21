// dsh-openspec-taskloop — compaction by context pressure between steps of a task (task 6.3).
//
// Between tasks the run compacts the session explicitly (`lib/compaction.js`), yet a
// single task can outgrow the context on its own: a long exploration, a large tool
// output, a summary that arrives late. That a task fits one turn is a bet on the
// task, not a guarantee, so design D7 gives the plugin a second seam for it — the
// `agent/pre-step` waterfall, where the request for the next step is derived and a
// compaction taken there costs no extra turn.
//
// The mechanism is deliberately thin. The threshold, the retained tail and the
// summarization itself belong to the `compaction` service: the gate asks for a
// `'pressure'` compaction and lets `compactIfNeeded()` decide whether anything is
// worth compacting (design D7 — a second threshold here would drift from the one the
// service enforces). A `null` answer is the ordinary "nothing to do", not a failure.
//
// The gate is installed for the agents of one run only, on their own contexts: a
// listener on an agent's context sees that agent's steps and no other session's,
// which is what the spec's "only the sessions the plugin drives" asks for. `close()`
// removes every listener when the run settles, so a later turn in the same session —
// the user typing after the run stopped — is not gated by a run that is over.
//
// A failure here is not a run failure: the step continues either way and the failure
// is recorded as a warning for the report. That is the deliberate difference from the
// transition compaction of 6.1/6.2 — that one bounds what the next task inherits, so
// a spent budget needs a policy; this one is opportunistic (design D7), so the worst
// case is the context the run already had.
//
// It is off by default (`compaction.midTask`, D11) and is meant to be switched on
// together with `protocol.systemSection`: the section is what survives the summary
// this gate may take (5.2, design D3).

import { codeOf } from './compaction.js'

/**
 * Track the step-boundary compaction of one run.
 *
 * `adopt()` is called for every agent the run drives — the invocation's agent at the
 * start, then the agent of each session a group boundary opens. It is idempotent per
 * context: the agent of a new session can be met twice (once when the session is
 * opened, once when its idleness is awaited), and a second listener with the same
 * name in one scope would be a duplicate.
 *
 * @param {object} options
 * @param {boolean} options.enabled - `compaction.midTask`; when false the gate is
 *   inert: no listener is registered and the service is never touched.
 * @param {(agent: object, signal?: AbortSignal) => Promise<unknown>} [options.compactIfNeeded] -
 *   one `compaction.compactIfNeeded(agent, 'pressure', signal)` call, as the
 *   environment supplies it. Absent, there is nothing to ask: the gate reports
 *   itself as disabled and registers no listener.
 * @param {object} [options.logger] - host logger; when it has `warn()`, a failed
 *   compaction is logged as well, because the report may arrive long after the step.
 * @returns {{enabled: boolean, warnings: {task?: import('./tasks.js').ApplyTask, code?: string}[], note: (task: import('./tasks.js').ApplyTask) => void, adopt: (agent?: object) => void, close: () => void}} the gate.
 */
export function createMidTaskGate({ enabled, compactIfNeeded, logger } = {}) {
  // "Enabled" means "will gate": without the seam there is no question to ask, and a
  // caller that checked only the configuration would resolve the agent of every
  // session early for a listener that cannot exist.
  const active = enabled === true && typeof compactIfNeeded === 'function'
  /** Scopes (agent contexts) that already carry the listener. */
  const scopes = new Set()
  /** @type {(() => void)[]} */
  const disposers = []
  /** @type {{task?: import('./tasks.js').ApplyTask, code?: string}[]} */
  const warnings = []
  /** The task the run is on: what a warning names when it has one. */
  let current

  /**
   * Ask for one pressure compaction before a step, and let the step proceed.
   *
   * The listener is a waterfall participant: it must delegate with `next()` in every
   * case, including when the compaction failed or the turn was cancelled. A stop is
   * not a compaction failure — the turn is ending anyway, and warning about it would
   * put noise in the report of a run that was asked to stop.
   *
   * @param {object} payload - `agent/pre-step` payload.
   * @param {object} payload.agent - agent whose step is being proposed.
   * @param {AbortSignal} [payload.signal] - cancellation of the current turn.
   * @param {() => Promise<object>} next - the downstream listener chain.
   * @returns {Promise<object>} the decision the step goes on with.
   */
  async function onPreStep({ agent: subject, signal }, next) {
    if (signal?.aborted !== true) {
      try {
        await compactIfNeeded(subject, signal)
      } catch (error) {
        // A compaction cut short by a stop is the stop, not something to report.
        if (signal?.aborted !== true) record(error)
      }
    }
    return next()
  }

  /**
   * Record one failed step compaction for the report.
   *
   * @param {unknown} error - thrown value; its `code` is what the report shows.
   * @returns {void}
   */
  function record(error) {
    const code = codeOf(error)
    warnings.push(current === undefined ? { code } : { task: current, code })
    if (typeof logger?.warn !== 'function') return
    const suffix = code === undefined ? '' : ` (${code})`
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`step compaction failed${suffix}: ${reason}; continuing the task`)
  }

  return {
    // Published so a caller can decide whether opening a session has to resolve its
    // agent early: the gate needs the agent to install itself on it.
    enabled: active,

    // The live list: it is appended during the run and read after `close()` by the
    // report, which is why closing the gate does not clear it.
    warnings,

    /**
     * Name the task the run is on.
     *
     * The gate hears steps, not tasks, so a warning would otherwise name only the
     * session. The loop announces each task as its message leaves, which is always
     * before the first step of its turn.
     *
     * @param {import('./tasks.js').ApplyTask} task - task the run just sent.
     * @returns {void}
     */
    note(task) {
      current = task
    },

    /**
     * Install the gate on one agent, unless this run already did.
     *
     * @param {object} [agent] - live agent; a value without a context that can
     *   register listeners is ignored.
     * @returns {void}
     */
    adopt(agent) {
      if (!active) return
      const scope = agent?.ctx
      if (scope === undefined || scope === null || typeof scope.on !== 'function') return
      if (scopes.has(scope)) return

      disposers.push(scope.on('agent/pre-step', onPreStep))
      scopes.add(scope)
    },

    /**
     * Remove every listener the run installed.
     *
     * Called once, when the run settles, whatever the ending. The set is emptied
     * first so a gate that is closed twice does not dispose a listener twice. The
     * warnings stay readable: the report is written after this call (6.3).
     *
     * @returns {void}
     */
    close() {
      scopes.clear()
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}
