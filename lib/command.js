// dsh-openspec-taskloop — the `/taskloop` command surface (tasks 3.1, 8.1).
//
// The command is global: it is registered from the plugin context, not from an
// agent context, so every session sees it. It never reaches the model — the
// registry runs the handler directly and renders the returned `CommandResult`.
//
// Grammar (spec "Команда /taskloop"):
//
//   /taskloop            run the next task; the change comes from config or from
//                        the listing (the most recently modified one)
//   /taskloop <change>   run the next task of that change
//   /taskloop stop       stop the active run
//   /taskloop status     report the active run
//   /taskloop explore    open explore mode: one fixed message, no run
//
// Anything else is a usage error: the command returns the usage text and,
// crucially, calls none of the four actions, so an unknown argument can never
// start a run. Subcommands are matched exactly; their uppercase spellings stay
// change names. A change whose name is a subcommand is shadowed by it — already
// true for `stop` and `status`, and accepted for `explore` as well (design D19).
//
// Parsing is separated from acting on purpose: `parseTaskloopArgs` is pure and
// exhaustively testable, and `registerTaskloopCommand` receives the four actions
// from its caller. The run bootstrap (3.2–4.3) plugs into those actions without
// touching the grammar.

/**
 * Static command metadata; `hint` is what a composer shows before the user
 * types the argument.
 */
export const COMMAND = Object.freeze({
  name: 'taskloop',
  description: 'Run the next OpenSpec change task, one turn per task',
  hint: '[change] | stop | status | explore',
})

/** Shown verbatim when the argument does not fit the grammar. */
export const USAGE = [
  'Usage: /taskloop [change] - run the next task of a change, one per turn',
  '       /taskloop stop - stop the active run',
  '       /taskloop status - report the active run',
  '       /taskloop explore - open explore mode and ask what to investigate',
].join('\n')

/** The four forms the command accepts; also the `kind` of a parsed argument. */
export const ACTION = Object.freeze({
  /** Run the next task, optionally of a named change. */
  run: 'run',
  /** Stop the active run. */
  stop: 'stop',
  /** Report the active run without changing it. */
  status: 'status',
  /**
   * Enter explore mode with one fixed message (design D19). It reads no project,
   * asks no change and claims no run slot: the form exists precisely for the case
   * where there is no change to run.
   */
  explore: 'explore',
})

/**
 * Read the argument text after `/taskloop`.
 *
 * `rawInput` is everything after the command name, separator whitespace
 * included, so an argument-free invocation arrives as `''` or as blanks. A
 * single token that is not a subcommand is a change name; whether that change
 * exists is not decidable here (it needs `openspec list`) and is answered by
 * the bootstrap, which must reject an unknown name before any task is sent.
 * `explore` is a subcommand whose spelling is also a plausible change name; it
 * shadows that name, as design D19 records (and `stop` and `status` do the same).
 *
 * @param {string} rawInput - text following the command name.
 * @returns {{kind: 'run', change: string|null}|{kind: 'stop'}|{kind: 'status'}|{kind: 'explore'}|{kind: 'invalid', reason: string}} parsed argument.
 */
export function parseTaskloopArgs(rawInput) {
  if (typeof rawInput !== 'string') {
    throw new TypeError('parseTaskloopArgs requires the raw command input string')
  }

  const trimmed = rawInput.trim()
  const tokens = trimmed === '' ? [] : trimmed.split(/\s+/u)

  if (tokens.length === 0) return { kind: ACTION.run, change: null }
  if (tokens.length > 1) {
    return { kind: 'invalid', reason: `/taskloop takes at most one argument, got ${tokens.length}` }
  }

  const [token] = tokens
  if (token === ACTION.stop) return { kind: ACTION.stop }
  if (token === ACTION.status) return { kind: ACTION.status }
  if (token === ACTION.explore) return { kind: ACTION.explore }
  return { kind: ACTION.run, change: token }
}

/**
 * Register `/taskloop` on the command registry.
 *
 * @param {object} ctx - plugin context carrying `ctx.commands`.
 * @param {{run: Function, stop: Function, status: Function, explore: Function}} control - actions behind the four forms.
 * @returns {() => void} disposer that unregisters the command.
 */
export function registerTaskloopCommand(ctx, control) {
  for (const action of Object.values(ACTION)) {
    if (typeof control?.[action] !== 'function') {
      throw new TypeError(`registerTaskloopCommand requires control.${action}()`)
    }
  }

  return ctx.commands.register({
    name: COMMAND.name,
    description: COMMAND.description,
    input: { hint: COMMAND.hint },
    handler: (invocation) => dispatch(control, invocation),
  })
}

/**
 * Turn one invocation into one command result.
 *
 * @param {{run: Function, stop: Function, status: Function, explore: Function}} control - actions behind the four forms.
 * @param {object} invocation - registry invocation: `rawInput`, `agent`, `signal`, `commandId`.
 * @returns {object|Promise<object>} the action's `CommandResult`, or the usage error.
 */
function dispatch(control, invocation) {
  const parsed = parseTaskloopArgs(invocation.rawInput)

  if (parsed.kind === 'invalid') {
    // Only the usage error is produced here; a malformed argument never reaches
    // an action, which is what keeps an unknown argument from starting a run.
    return { kind: 'error', text: `${parsed.reason}\n${USAGE}` }
  }
  if (parsed.kind === ACTION.stop) return control.stop(invocation)
  if (parsed.kind === ACTION.status) return control.status(invocation)
  if (parsed.kind === ACTION.explore) return control.explore(invocation)
  return control.run(invocation, { change: parsed.change })
}
