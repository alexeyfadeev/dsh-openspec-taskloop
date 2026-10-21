// dsh-openspec-taskloop — the optional static protocol section (task 5.2).
//
// The task instruction travels in the message that starts a turn (design D2), so
// it is the one thing a compaction inside a task can evict: once a summary
// replaces that message, the model sees a session that mentions a change but not
// the rule that it runs one task at a time. The section below restates only that
// invariant — never the task number — so it is static: it is the same text on
// every step, the prompt prefix it contributes to does not change between tasks,
// and the prompt cache survives (design D3).
//
// The section belongs to a session, not to the plugin: it is registered on the
// agent's own context, so it reaches exactly the agents this run drives and no
// other session inherits it. A run registers it in the session it was invoked
// from and, when it crosses a group boundary (5.1), in the session it moves to —
// the spec requires the new session to receive the same protocol. `close()`
// removes every copy, and `lib/control.js` calls it when the run settles, whatever
// the ending.
//
// It is off by default (`protocol.systemSection`, D11): while compaction stays
// between tasks the task message is never evicted, and a section nobody needs
// only spends prompt tokens.
//
// Registration is best-effort on purpose. A deployment that composes no
// `systemPrompt` service has no prompt to protect, and a session whose agent
// cannot be found at handoff time is not a reason to stop a run whose messages
// still go through: the section is a protection, not the mechanism.

/** The section's text: the invariant, with no task number and no change name. */
export const PROTOCOL_SECTION_TEXT = 'The user drives this session with /taskloop: exactly one task '
  + 'of the change runs per turn, and the task is named in the message that starts the turn. Do that '
  + 'task and then stop; do not start, plan or preview a following task, even when an earlier message '
  + 'asked for several. If a summary replaced the message that named the task, wait for the next '
  + 'message instead of guessing which task to run.'

/** The section this plugin registers, as `systemPrompt.section()` receives it. */
export const PROTOCOL_SECTION = Object.freeze({
  name: 'openspec-taskloop:protocol',
  text: PROTOCOL_SECTION_TEXT,
})

/**
 * Position used when the prompt service cannot name its own policy slot.
 *
 * It is the slot `PLAN_POLICY` occupies — the standing rules that shape a turn,
 * ahead of every tool section — so the section reads as policy rather than as
 * tool documentation.
 */
export const PROTOCOL_ORDER_FALLBACK = 500

/**
 * Track the protocol section for one run.
 *
 * `apply()` is called for every agent the run drives — the invocation's agent at
 * the start, then the agent of each session a group boundary opens. It is
 * idempotent per scope: the agent of a new session can be met twice (once when
 * the session is opened, once when its idleness is awaited), and a second
 * registration with the same name in the same scope would throw.
 *
 * @param {object} options
 * @param {boolean} options.enabled - `protocol.systemSection`; when false the
 *   tracker is inert and the prompt service is never touched.
 * @returns {{enabled: boolean, apply: (agent?: object) => void, close: () => void}} the tracker.
 */
export function createProtocol({ enabled }) {
  /** Scopes (agent contexts) that already carry the section. */
  const scopes = new Set()
  /** @type {(() => void)[]} */
  const disposers = []

  return {
    // Published so a caller can avoid the work that exists only for the section:
    // opening a session resolves its agent earlier than it otherwise would (5.2).
    enabled,

    /**
     * Register the section on one agent, unless this run already did.
     *
     * @param {object} [agent] - live agent; a value without a context is ignored.
     * @returns {void}
     */
    apply(agent) {
      if (!enabled) return
      const scope = agent?.ctx
      if (scope === undefined || scope === null) return
      if (scopes.has(scope)) return

      const service = promptService(scope)
      if (typeof service?.section !== 'function') return

      disposers.push(service.section({
        name: PROTOCOL_SECTION.name,
        order: sectionOrder(service),
        text: PROTOCOL_SECTION.text,
      }))
      scopes.add(scope)
    },

    /**
     * Remove every copy the run registered.
     *
     * Called once, when the run settles. The set is emptied first so a tracker
     * that is closed twice does not dispose a message twice.
     *
     * @returns {void}
     */
    close() {
      scopes.clear()
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

/**
 * The `systemPrompt` service of one agent's context.
 *
 * Read through the context rather than through `ctx.get()`: the service
 * registers the section in the scope of the context that called it, and only the
 * agent's own context puts the section on that agent. A context without the
 * service throws on the property read, which is the same answer as a missing
 * one — nothing to register.
 *
 * @param {object} scope - the agent's context.
 * @returns {object|undefined} the service, when this deployment composes one.
 */
function promptService(scope) {
  try {
    return scope.systemPrompt
  } catch {
    return undefined
  }
}

/**
 * The order the section is registered with.
 *
 * The prompt service owns the placement of policy sections (`getSectionOrder`),
 * so its answer is preferred; a fake or a deployment that does not expose the
 * lookup falls back to the slot that lookup returns for plan policy.
 *
 * @param {object} service - the `systemPrompt` service.
 * @returns {number} the sort order.
 */
function sectionOrder(service) {
  if (typeof service.getSectionOrder !== 'function') return PROTOCOL_ORDER_FALLBACK
  const order = service.getSectionOrder('PLAN_POLICY')
  return Number.isFinite(order) ? order : PROTOCOL_ORDER_FALLBACK
}
