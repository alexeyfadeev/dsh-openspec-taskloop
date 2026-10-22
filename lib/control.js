// dsh-openspec-taskloop — the actions behind `/taskloop` (tasks 3.1–5.2).
//
// `run` is the entry point of a run. It resolves the working directory, settles
// the OpenSpec root (asking for `openspec init` when there is none), decides there
// is nothing to run when the project has no changes — asking for a task
// description and entering explore mode (3.3) — and, when a change is selected,
// drives the task loop (4.1–4.2) in the process's single run slot (4.3). The loop
// reads `tasks.md` through the CLI, sends one task message, waits for its turn and
// re-reads the file: a checked box continues the run, an unchecked one stops it
// with a report.
//
// A run that crosses a group boundary continues in a session it opens itself
// (5.1). This module only supplies the way to open one and puts the new session
// id in the report: the original session learns where the work went, because the
// plugin has no way to move the user's view to the other session.
//
// Compaction between tasks of one group (6.1) is a dependency of the run as well:
// this module builds the retried `compactNow` from the configured policy and hands
// it to the loop, which decides when a transition needs it. What a spent attempt
// budget means is the configured `onFailure` policy (6.2), and both outcomes reach
// the report: `break` names the task the run withheld and the last failure code,
// while `continue` names the task that went out without compaction as a warning —
// a run that skipped its bound must not read as if it had it.
//
// Compaction inside a task (6.3) is a third property of the run: an optional gate on
// the agents the run drives, built here for exactly that run's lifetime. It never
// stops the run — a failed step compaction is a warning in the report — because it
// is an opportunistic bound, not the one the next task inherits.
//
// The optional protocol section (5.2) is a property of the run, not of the
// plugin: it is registered when the run starts on every agent the run drives —
// including the one of a session opened at a boundary — and it is removed in the
// same `finally` that releases the run slot, so a section never outlives the work
// it describes and a later run never meets a registration it does not own.
//
// `/taskloop stop` and `/taskloop status` read that slot (4.3). Stop aborts the
// run's signal and waits for the run to return, so its answer names the task it
// interrupted rather than the task the run was on when the command arrived; status
// only reports. A second `/taskloop` while the slot is taken is refused, which is
// what keeps "one task per turn" true even when two sessions ask at once.
//
// The bootstrap is a chain of explicit outcomes rather than one long handler:
// each step returns a settled value that decides the next one, and every failure
// becomes a command result the user can read. That is what keeps the invariant
// "an unknown argument never starts a run" true at every branch.
//
// The module is a plain function of its dependencies — the CLI wrapper, the
// confirmation channel, the question channel, the follow-up channel and the
// session directory all arrive from `lib/environment.js` — so everything
// `/taskloop` does before the first task turn is testable with fakes.

import { BOOTSTRAP, ensureRoot } from './bootstrap.js'
import { SELECTION, selectChange } from './changes.js'
import { compactBetweenTasks } from './compaction.js'
import { EXPLORE_ANSWER } from './explore.js'
import { extractTaskNumber } from './groups.js'
import { LOOP_END, runLoop } from './loop.js'
import { createMidTaskGate } from './midtask.js'
import { createProtocol } from './protocol.js'
import { RUN_START, createRuns } from './runs.js'

/** Every command result starts with this, so a session log line is attributable. */
const PREFIX = 'taskloop: '

/**
 * Build the three actions the command dispatches to.
 *
 * The run slot is created here, once per mounted plugin — which is once per
 * process — because "one active run" is a property of the deployment, not of a
 * session: a second `/taskloop` from another session meets the same slot.
 *
 * @param {object} deps
 * @param {import('./config.js').Config} deps.config - resolved plugin configuration.
 * @param {() => {run: Function}} deps.createCli - builds the `openspec` wrapper for one run.
 * @param {(invocation: object) => string} deps.cwdOf - project directory of the invocation.
 * @param {(invocation: object, cwd: string) => Promise<'initialize'|'cancel'|'unavailable'>} deps.askInit -
 *   asks the user about initialising the project.
 * @param {(invocation: object, cwd: string) => Promise<import('./explore.js').DescriptionOutcome>} deps.askDescription -
 *   asks the user what task to explore in a project without changes.
 * @param {(invocation: object, description: string) => object} deps.followupExplore -
 *   sends the single explore message for that description.
 * @param {(invocation: object, context: {change: string, cwd: string, previous: object, task: object}) => Promise<object>} [deps.openSession] -
 *   opens the session a new group runs in (5.1). Absent, a run that reaches a group boundary
 *   stops with an error instead of continuing in the session it was leaving.
 * @param {(agent: object, signal?: AbortSignal) => Promise<unknown>} [deps.compactNow] -
 *   one `compaction.compactNow()` call for the session a task runs in (6.1). Absent, the run
 *   never compacts; the environment always supplies it and reports a missing service when called.
 * @param {(agent: object, signal?: AbortSignal) => Promise<unknown>} [deps.compactIfNeeded] -
 *   one `compaction.compactIfNeeded(agent, 'pressure', signal)` call for the step gate (6.3).
 *   Absent, the gate registers no listener; the environment always supplies it.
 * @param {object} [deps.logger] - host logger, for a step compaction that failed (6.3).
 * @returns {{run: Function, stop: Function, status: Function}} command actions.
 */
export function createControl({
  config, createCli, cwdOf, askInit, askDescription, followupExplore, openSession, compactNow,
  compactIfNeeded, logger,
}) {
  const runs = createRuns()
  // The retry policy belongs to the deployment, not to one run, so the compactor is
  // built once: every run of this plugin compacts the same way, and the policy's
  // delay is shared by the runs that follow it (6.1). The policy on exhausted
  // attempts (6.2) is applied by the loop that receives the outcome.
  const compact = typeof compactNow === 'function'
    ? (agent, signal) => compactBetweenTasks({
      compactNow,
      agent,
      signal,
      retry: config.compaction.retry,
    })
    : undefined

  return {
    run: (invocation, action) => startRun(
      {
        config,
        createCli,
        cwdOf,
        askInit,
        askDescription,
        followupExplore,
        openSession,
        compact,
        compactIfNeeded,
        logger,
        runs,
      },
      invocation,
      action ?? {},
    ),
    stop: () => stopRun(runs),
    status: () => reportRun(runs),
  }
}

/**
 * Resolve the project, the root and the change, then act on what was found.
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {object} invocation - command invocation: `agent`, `signal`, `rawInput`.
 * @param {{change?: string|null}} action - change named on the command line, `null` when absent.
 * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
 */
async function startRun(deps, invocation, { change }) {
  // A run already in flight is refused before any work: reading the listing,
  // answering an init question and selecting a change are all pointless for a
  // command that cannot start, and the answer must not look like a second run that
  // got as far as choosing one. The slot is still claimed again later — this check
  // makes the common case cheap, it does not make the claim optional.
  const active = deps.runs.current()
  if (active !== null) return refusalOf(active)

  try {
    const cwd = deps.cwdOf(invocation)
    // One wrapper for the whole run: the deadline and the executable lookup are
    // per invocation, and the step that follows reads the same project.
    const cli = deps.createCli()
    const outcome = await ensureRoot({
      cli,
      cwd,
      signal: invocation.signal,
      confirm: (request) => deps.askInit(invocation, request.cwd),
    })
    return await describeOutcome(deps, invocation, outcome, {
      cwd,
      cli,
      requested: change ?? deps.config.change,
    })
  } catch (error) {
    // A failure the user can act on belongs in the command result, not in a
    // thrown handler: the registry would log it as a command/done error and the
    // explanation would lose the `taskloop:` attribution.
    return { kind: 'error', text: `${PREFIX}${messageOf(error)}` }
  }
}

/**
 * Act on the settled root check: refuse, explore, or run the change's tasks.
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {object} invocation - command invocation.
 * @param {import('./bootstrap.js').BootstrapOutcome} outcome - settled root check.
 * @param {object} context
 * @param {string} context.cwd - project directory the check ran in.
 * @param {{run: Function}} context.cli - the `openspec` wrapper of this run.
 * @param {string|undefined} context.requested - change from the command line or configuration.
 * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
 */
async function describeOutcome(deps, invocation, outcome, { cwd, cli, requested }) {
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
    return await startExplore(deps, invocation, { cwd, head })
  }
  return await startTaskStep(deps, invocation, { cwd, cli, head, change: selection.change })
}

/**
 * Drive the selected change's task loop and report what it settled with.
 *
 * The loop reads `tasks.md` itself (4.1–4.2), so a `blocked` or `all_done` change
 * is reported from the CLI's own account of the file rather than from the counts
 * in the listing. The report always names the tasks whose messages actually left
 * this run: on a stop it says which task the run was waiting on, and it never
 * claims a turn that was not started.
 *
 * The run slot is claimed before the first read (4.3): a second `/taskloop` while
 * this one is active is refused here, without reading `tasks.md` and without
 * adding anything to the session the user is watching.
 *
 * The protocol section (5.2) is registered before the first message and removed
 * when the run returns; `protocol.systemSection` decides whether it exists at
 * all, and the configuration default keeps it off. The step gate (6.3) has the
 * same lifetime and the same set of agents, and its failures only add a warning to
 * the report — they never turn a task into an error.
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {object} invocation - command invocation.
 * @param {object} context
 * @param {string} context.cwd - project directory the CLI runs in.
 * @param {{run: Function}} context.cli - the `openspec` wrapper of this run.
 * @param {string} context.head - sentence naming the settled root.
 * @param {import('./changes.js').ChangeEntry} context.change - selected change.
 * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
 */
async function startTaskStep(deps, invocation, { cwd, cli, head, change }) {
  const started = deps.runs.start(change.name, invocation.signal)

  // Refusing is the whole point of the slot: the active run keeps its position and
  // its signal, and this caller neither reads nor sends anything.
  if (started.kind !== RUN_START.started) return refusalOf(started.run)

  const run = started.run
  // The protocol section is this run's own (5.2): it is registered before the
  // first message and removed when the run settles, whatever the ending. With the
  // option off there is no callback at all, so opening a session resolves its
  // agent exactly as it did before the section existed.
  const protocol = createProtocol({ enabled: deps.config.protocol.systemSection })
  // Compaction inside a task (6.3) is built for this run too, and it has the same
  // lifetime: the gate installs a listener on each agent the run drives and is
  // removed in the same `finally`, so a later turn of the same session is not
  // gated by a run that is over. Off by default (D11).
  const midTask = createMidTaskGate({
    enabled: deps.config.compaction.midTask,
    compactIfNeeded: deps.compactIfNeeded,
    logger: deps.logger,
  })
  // One adoption hook for both session-level mechanisms: the run hands every agent
  // it drives to the protocol tracker and to the gate. With both options off there
  // is no callback at all, and opening a session resolves its agent only when its
  // turn is awaited.
  const adoptAgent = protocol.enabled || midTask.enabled
    ? (agent) => {
        protocol.apply(agent)
        midTask.adopt(agent)
      }
    : undefined
  // The run opens its own sessions through the environment; this closure fixes
  // the invocation those sessions belong to — its signal and its preset — and the
  // project directory the CLI already runs in. `adoptAgent` is how the session
  // opened at a boundary gives its agent the same protocol section and the same
  // step gate the invocation session got.
  const openSession = deps.openSession === undefined
    ? undefined
    : (context) => deps.openSession(invocation, {
        cwd,
        ...context,
        adoptAgent,
      })
  let outcome
  try {
    // Registered inside the guarded region: a registration that fails is a run
    // that never sent anything, and it must not leave the slot claimed.
    protocol.apply(invocation.agent)
    midTask.adopt(invocation.agent)
    outcome = await runLoop({
      cli,
      cwd,
      change: change.name,
      agent: invocation.agent,
      signal: run.signal,
      openSession,
      // Compaction between tasks of one group (6.1): the loop decides when a
      // transition needs it, this control supplies the retried call and the
      // policy for what a spent budget means (6.2).
      compact: deps.compact,
      onFailure: deps.config.compaction.onFailure,
      // The run learns which task it is on as each message leaves, so `/taskloop
      // stop` can name it without the loop knowing about the slot, and a failed
      // step compaction can name the task it happened in (6.3).
      onTask: (task) => {
        run.note(task)
        midTask.note(task)
      },
    })
  } finally {
    // Both registrations must be gone before the slot is released, so the next run
    // does not meet a listener or a section this one left behind.
    protocol.close()
    midTask.close()
    // Released even when the loop throws: a run that failed must not keep every
    // later `/taskloop` refused.
    deps.runs.finish(run)
  }
  const subject = `${head} Change "${change.name}"${progressOf(change, outcome.instructions)}.`
  const sent = sentClause(outcome.sent)
  const last = outcome.task === undefined ? '' : labelOf(outcome.task)
  // Named in every ending, because the original session is the only one the user
  // is looking at after the work moved elsewhere (5.1).
  const handoff = handoffClause(outcome.sessions)
  // Compactions the run survived are sentences of their own, placed before the
  // handoff so the ending of the run reads first: the `continue` policy's skips
  // (6.2) and the step compactions that failed inside a task (6.3).
  const carried = warningClause(outcome.warnings) + stepWarningClause(midTask.warnings) + handoff

  if (outcome.kind === LOOP_END.completed) {
    return {
      kind: 'success',
      text: sent === ''
        ? `${PREFIX}${subject} all tracked tasks are complete; no turn was started.${carried}`
        : `${PREFIX}${subject} ${sent}; all tracked tasks are complete.${carried}`,
    }
  }
  if (outcome.kind === LOOP_END.unmarked) {
    return {
      kind: 'error',
      text: `${PREFIX}${subject} ${sent}, but tasks.md still leaves ${last} unchecked; `
        + `the run stopped and no further task was sent.${carried}`,
    }
  }
  if (outcome.kind === LOOP_END.missing) {
    return {
      kind: 'error',
      text: `${PREFIX}${subject} ${sent}, but ${last} is no longer listed by openspec; `
        + `the run stopped and no further task was sent.${carried}`,
    }
  }
  if (outcome.kind === LOOP_END.blocked) {
    return {
      kind: 'error',
      text: `${PREFIX}${subject} ${sent === '' ? '' : `${sent}, then `}openspec blocked the change: ${outcome.reason}${carried}`,
    }
  }
  if (outcome.kind === LOOP_END.idle) {
    return {
      kind: 'error',
      text: sent === ''
        ? `${PREFIX}${subject} ${outcome.reason}; no turn was started.${carried}`
        : `${PREFIX}${subject} ${sent}; ${outcome.reason}; no further task was sent.${carried}`,
    }
  }
  if (outcome.kind === LOOP_END.compaction) {
    // The code is the actionable part: `changed` and `commit` say the history moved
    // under the backend and a `/taskloop` re-read will pick the run up where the
    // file stands, while a transient code says the backend was unavailable (6.1).
    const failure = outcome.compaction
    const code = failure.code === undefined ? '' : ` (${failure.code})`
    const why = failure.reason === undefined ? '' : `: ${failure.reason}`
    return {
      kind: 'error',
      text: `${PREFIX}${subject} ${sent === '' ? '' : `${sent}; `}compaction before task `
        + `${labelOf(failure.task)} failed after ${attemptCount(failure.attempts)}${code}${why}; `
        + `the run stopped and no further task was sent.${carried}`,
    }
  }
  if (outcome.kind === LOOP_END.cancelled) {
    // A stop reaches the session whose run it ended as well: without this line the
    // run would appear to vanish with the last message it sent.
    const how = run.stopped ? 'the run was stopped by /taskloop stop' : 'the run was cancelled'
    return {
      kind: 'success',
      text: sent === ''
        ? `${PREFIX}${subject} ${how} before any task was sent.${carried}`
        : `${PREFIX}${subject} ${sent}; ${how} after that turn.${carried}`,
    }
  }
  // A loop end this report does not know must not be rendered as a success.
  return {
    kind: 'error',
    text: `${PREFIX}${subject} the run ended in an unknown state: ${outcome.kind}.${carried}`,
  }
}

/**
 * Stop the active run and report where it was.
 *
 * The abort is what the loop watches: the wait for quiescence loses its race, a
 * read in flight is cut short, and either way no message follows. Waiting for the
 * run to settle before answering is deliberate — the result then describes a loop
 * that has already returned, and the slot is free for the next `/taskloop`.
 *
 * @param {ReturnType<typeof import('./runs.js').createRuns>} runs - the run slot.
 * @returns {Promise<{kind: 'success', text: string}>} command result.
 */
async function stopRun(runs) {
  const run = runs.current()
  if (run === null) return { kind: 'success', text: `${PREFIX}no run is active.` }

  run.stop()
  await run.settled

  if (run.task === undefined) {
    return {
      kind: 'success',
      text: `${PREFIX}stopped the run for change "${run.change}" before any task was sent.`,
    }
  }
  return {
    kind: 'success',
    text: `${PREFIX}stopped the run for change "${run.change}" on task ${labelOf(run.task)} `
      + `(${taskCount(run.tasks.length)} sent); no further task was sent.`,
  }
}

/**
 * Report the active run without changing it.
 *
 * @param {ReturnType<typeof import('./runs.js').createRuns>} runs - the run slot.
 * @returns {{kind: 'success', text: string}} command result.
 */
function reportRun(runs) {
  const run = runs.current()
  if (run === null) return { kind: 'success', text: `${PREFIX}no run is active.` }
  if (run.task === undefined) {
    return {
      kind: 'success',
      text: `${PREFIX}a run for change "${run.change}" is active; no task has been sent yet.`,
    }
  }
  return {
    kind: 'success',
    text: `${PREFIX}a run for change "${run.change}" is active on task ${labelOf(run.task)}; `
      + `${taskCount(run.tasks.length)} sent so far.`,
  }
}

/**
 * Ask for a task description and hand it to the model in explore mode.
 *
 * Exactly one of three things happens: the description is sent as one follow-up
 * message, the cancellation is reported with nothing sent, or the missing
 * question channel becomes an error. No path reaches the task loop (spec "Сбор
 * описания задачи и вход в explore").
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {object} invocation - command invocation.
 * @param {object} context
 * @param {string} context.cwd - project directory the question names.
 * @param {string} context.head - sentence naming the settled root.
 * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
 */
async function startExplore(deps, invocation, { cwd, head }) {
  const decision = await deps.askDescription(invocation, cwd)

  if (decision.kind === EXPLORE_ANSWER.unavailable) {
    return {
      kind: 'error',
      text: `${PREFIX}${head} No OpenSpec change exists in ${cwd} yet, and this session cannot ask for a task `
        + 'description; describe the task in a message instead.',
    }
  }
  if (decision.kind === EXPLORE_ANSWER.cancelled) {
    return {
      kind: 'success',
      text: `${PREFIX}${head} no task description was given; nothing was sent to the model.`,
    }
  }

  deps.followupExplore(invocation, decision.description)
  return {
    kind: 'success',
    text: `${PREFIX}${head} no OpenSpec change exists yet, so the task description was sent to the model `
      + 'in explore mode; no task loop was started.',
  }
}

/**
 * `(7/20 tasks done)` for the counts the last reading reported, or `''`.
 *
 * The loop's final reading is preferred over the listing's counts: the listing
 * was taken before the run, so on a multi-task run its numbers are stale. The
 * listing is kept as the fallback for a reading without a usable `progress`.
 *
 * @param {import('./changes.js').ChangeEntry} change - selected change.
 * @param {import('./tasks.js').ApplyInstructions} [instructions] - last reading of the task file.
 * @returns {string} the parenthesised progress or an empty string.
 */
function progressOf(change, instructions) {
  const progress = instructions?.progress
  const completed = progress?.complete ?? change.completedTasks
  const total = progress?.total ?? change.totalTasks
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total)) return ''
  return ` (${completed}/${total} tasks done)`
}

/**
 * `4.1` for a numbered task, or the id a flat task is known by (design D5).
 *
 * @param {import('./tasks.js').ApplyTask} task - task the loop sent.
 * @returns {string} the label used in the report.
 */
function labelOf(task) {
  return extractTaskNumber(task.description)?.label ?? task.id
}

/**
 * `on task 2.3` / `no task sent yet` — where a run is, for a report about it.
 *
 * @param {import('./runs.js').ActiveRun} run - the run being reported.
 * @returns {string} the phrase, without sentence punctuation.
 */
function phaseOf(run) {
  return run.task === undefined ? 'no task sent yet' : `on task ${labelOf(run.task)}`
}

/**
 * The result of a `/taskloop` that met an active run (spec "Один активный прогон").
 *
 * Both refusals say the same three things, from one place: which run is active,
 * how far it got, and that this command neither started nor disturbed anything.
 *
 * @param {import('./runs.js').ActiveRun} run - the run that owns the slot.
 * @returns {{kind: 'error', text: string}} command result.
 */
function refusalOf(run) {
  return {
    kind: 'error',
    text: `${PREFIX}a run for change "${run.change}" is already active (${phaseOf(run)}); `
      + 'no second run was started and the active run was left as it was.',
  }
}

/**
 * `1 task` / `2 tasks` for a count of turns.
 *
 * @param {number} count - number of tasks sent.
 * @returns {string} the counted phrase.
 */
function taskCount(count) {
  return `${count} task${count === 1 ? '' : 's'}`
}

/**
 * `1 attempt` / `3 attempts` for a count of compaction calls (6.1).
 *
 * @param {number} count - number of `compactNow` calls.
 * @returns {string} the counted phrase.
 */
function attemptCount(count) {
  return `${count} attempt${count === 1 ? '' : 's'}`
}

/**
 * `sent task 4.1` / `sent tasks 4.1 and 4.2` for the loop's audit trail, or `''`.
 *
 * @param {import('./tasks.js').ApplyTask[]} tasks - tasks whose messages left the run.
 * @returns {string} the clause naming them, or an empty string when none was sent.
 */
function sentClause(tasks) {
  if (tasks.length === 0) return ''
  const labels = tasks.map(labelOf)
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
  return `sent ${tasks.length === 1 ? 'task' : 'tasks'} ${list}`
}

/**
 * ` Warning: compaction before task 2.4 failed after 3 attempts (summary); the run
 * continued without compaction.` for the compactions a run survived, or `''`.
 *
 * The warning exists because `continue` (6.2) trades a bound for progress: the run
 * went on, but its context was not shrunk, and a report that said nothing would
 * describe a run that had the bound it was configured to have. Each entry names the
 * task that went out uncompacted and the failure that stopped the retries; several
 * transitions of one run are listed in the order they happened.
 *
 * @param {{task: import('./tasks.js').ApplyTask, attempts: number, code?: string, reason?: string}[]} [warnings] -
 *   compactions the run survived, in order.
 * @returns {string} the sentence, or an empty string when every compaction succeeded.
 */
function warningClause(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return ''
  const parts = warnings.map(({ task, attempts, code, reason }) => {
    const suffix = code === undefined ? '' : ` (${code})`
    const why = reason === undefined ? '' : `: ${reason}`
    return `compaction before task ${labelOf(task)} failed after ${attemptCount(attempts)}${suffix}${why}`
  })
  const head = warnings.length === 1 ? ' Warning: ' : ' Warnings: '
  return `${head}${parts.join('; ')}; the run continued without compaction.`
}

/**
 * ` Warning: compaction during task 2.3 failed (busy); the task continued without
 * compaction.` for the step compactions a task survived, or `''`.
 *
 * The spec asks the run to record a failed step compaction and carry on (6.3), so
 * this is a warning and never an ending: the task did run, and the only thing it
 * lost is the bound the gate would have restored. The task is named when the run
 * had one at the boundary; a compaction taken before the run's first message has no
 * task to name, and says so instead of inventing one.
 *
 * @param {{task?: import('./tasks.js').ApplyTask, code?: string}[]} [warnings] - step
 *   compactions the run survived, in order.
 * @returns {string} the sentence, or an empty string when every step compaction succeeded.
 */
function stepWarningClause(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return ''
  const parts = warnings.map(({ task, code }) => {
    const suffix = code === undefined ? '' : ` (${code})`
    const where = task === undefined ? 'a task' : `task ${labelOf(task)}`
    return `compaction during ${where} failed${suffix}`
  })
  const head = warnings.length === 1 ? ' Warning: ' : ' Warnings: '
  const subject = warnings.length === 1 ? 'the task' : 'the tasks'
  return `${head}${parts.join('; ')}; ${subject} continued without compaction.`
}

/**
 * ` The run moved to session sess-2 (task 3.1) at the group boundary.` for the
 * sessions a run opened, or `''` when it never left the session it started in.
 *
 * The clause names the session *and* the task it took over at: the id is what a
 * user can find in the sidebar, and the task is what they were watching when the
 * work left their session (5.1). A leading space keeps it attachable to a report
 * that already ends with a full stop, without a second separator per branch.
 *
 * @param {{sessionId: string, task: import('./tasks.js').ApplyTask}[]} [sessions] - sessions the
 *   run moved to, in order.
 * @returns {string} the clause, or an empty string when the run stayed in one session.
 */
function handoffClause(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return ''
  const named = sessions.map(({ sessionId, task }) => `${sessionId} (task ${labelOf(task)})`)
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
  const where = sessions.length === 1 ? 'session' : 'sessions'
  const boundary = sessions.length === 1 ? 'boundary' : 'boundaries'
  return ` The run moved to ${where} ${list} at the group ${boundary}.`
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
