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
// A finished group is reviewed before anything else happens to it (3.3, design
// D14): the loop announces the group once its last task is verified, and this
// module hands it to `lib/review.js`, which opens a session of its own, narrows its
// approval policy to `never` and sends exactly one review instruction. The review
// settles before the loop selects the next task, so the session it runs in and the
// session the next group runs in are always two different sessions, and a review
// the stop ended is a run that sends nothing more. `review.enabled` decides whether
// the hook exists at all (D12); every review that ran is a sentence of the report,
// because its session is a place the user never watched (D17).
//
// The review session is opened through the same environment seam as a boundary
// session, but it is deliberately not handed `adoptAgent`: the protocol section
// restates the one-task-per-turn rule and the step gate bounds the steps of a task,
// and a one-turn review is neither. It does not belong to the task machinery, it
// only borrows the way a session is opened.
//
// After the review comes the commit of the same group (4.3, design D15): the plugin
// performs it itself through the configured tool, because the one step a machine can
// verify — "the changes of this group are in the history" — must not depend on the
// model remembering it. `commit.tool` is read at that moment rather than at the start
// of the run (D12), so switching the tool applies to the next group of an active run.
// What the commit settles with is the report's business: a commit that went through
// quotes the tool's own line (the commit id lives there), an empty working tree is a
// skip with a reason, and a failed one stops the run before another task is sent —
// the group is done, and the next one must not start on top of work that was never
// committed (D17).
//
// The message those commits carry is the user's own (5.2, design D16), so it is settled
// before the run claims its slot and before the first turn: the text stored for this
// change, or the answer to one question. A dismissed question is the end of the command —
// nothing is sent, nothing is written — while a deployment with no question channel runs
// on and commits nothing, which its report says in words. The text is never invented: a
// commit message is a sentence somebody wrote about the work, not one the plugin made up.
//
// The branch a GitButler run commits into is settled at the same moment and in the same
// card (7.3, design D18): the applied branches are read from `but status --json`, the user
// picks one or types a new name, and a new name asks for its anchor in a second card. The
// plan lives for the run only — `lib/commit.js` creates the branch on the first commit
// that has something in it — so nothing about it reaches the state file. The tool is read
// twice: here, because it decides whether there is a branch question at all, and again at
// each commit, because a switch in Settings applies to the next group; a run that switched
// to `gitbutler` after that point commits without a branch argument, and its report says
// so rather than pretending a branch was chosen.
//
// The text is kept for the change, which is what makes it survive a stop: the run that
// resumes after an interruption finds it and does not ask again. The one ending that makes
// it stale drops it (5.3, design D16) — `all_done` deletes the record, so the next
// `/taskloop` of that change asks for a sentence about the work still ahead instead of
// reusing the one written about the work that is finished. A deletion that fails is a
// warning, not a failure of the run: the tasks are done, and the report must not trade
// that for a stack trace.
//
// The optional protocol section (5.2) is a property of the run, not of the
// plugin: it is registered when the run starts on every agent the run drives —
// including the one of a session opened at a boundary — and it is removed in the
// same `finally` that releases the run slot, so a section never outlives the work
// it describes and a later run never meets a registration it does not own.
//
// A run is not tied to the request that started it. The invocation's signal belongs
// to the UI request, and the host aborts it when the response connection closes — a
// reloaded tab, a closed window, a dropped socket — none of which mean the run
// should end. The run slot owns the lifetime (design D8), only `/taskloop stop` ends
// it from outside, and a run that outlives its request appends its report to the
// session as a context notice, because the command result no longer has a reader.
//
// `/taskloop stop` and `/taskloop status` read that slot (4.3). Stop aborts the
// run's signal and waits for the run to return, so its answer names the task it
// interrupted rather than the task the run was on when the command arrived; status
// only reports. A second `/taskloop` while the slot is taken is refused, which is
// what keeps "one task per turn" true even when two sessions ask at once.
//
// `/taskloop explore` is the one form that is not a run at all (8.2, design D19):
// it resolves nothing, asks nothing and sends one fixed instruction, so it neither
// reads nor claims the slot — it answers while a run is active exactly as it does in
// a project with no change. Everything after that message is a dialogue between the
// user and the model, which this module deliberately does not observe.
//
// Before any of that, a run settles the installed `openspec` version (9.2, design D20):
// a CLI below the supported floor, or one that will not name its version, stops the
// command with advice to update, before the project is read and before the model hears
// anything. The gate sits inside the run path only — `explore`, `stop` and `status` never
// build a CLI, so they answer on any `openspec`.
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
import { COMMIT_END, commitIdOf, runCommit } from './commit.js'
import { CANCEL_STEP } from './commit-input.js'
import { COMMIT_TEXT } from './commit-text.js'
import { compactBetweenTasks } from './compaction.js'
import { EXPLORE_ANSWER } from './explore.js'
import { extractTaskNumber } from './groups.js'
import { GROUP_END, LOOP_END, runLoop } from './loop.js'
import { createNoticeMessage } from './message.js'
import { createMidTaskGate } from './midtask.js'
import { createProtocol } from './protocol.js'
import { REVIEW_END, runReview } from './review.js'
import { RUN_START, createRuns } from './runs.js'

/** Every command result starts with this, so a session log line is attributable. */
const PREFIX = 'taskloop: '

/**
 * A commit the run could not compose because it had no message text (5.2).
 *
 * Not a `CommitOutcome`: no tool ran, so there is no tool, no code and no message to
 * report. It exists so the report says the commit was skipped instead of leaving the
 * user to notice that a group finished without one.
 */
const COMMIT_SKIPPED = 'skipped'

/**
 * Build the three actions the command dispatches to.
 *
 * The run slot is created here, once per mounted plugin — which is once per
 * process — because "one active run" is a property of the deployment, not of a
 * session: a second `/taskloop` from another session meets the same slot.
 *
 * @param {object} deps
 * @param {import('./config.js').Config} deps.config - resolved plugin configuration.
 * @param {() => {run: Function, ensureSupportedVersion: Function}} deps.createCli - builds the
 *   `openspec` wrapper for one run: the caller of every read and, before the first of them, the
 *   version gate (9.2, design D20).
 * @param {(invocation: object) => string} deps.cwdOf - project directory of the invocation.
 * @param {(invocation: object, cwd: string) => Promise<'initialize'|'cancel'|'unavailable'>} deps.askInit -
 *   asks the user about initialising the project.
 * @param {(invocation: object, cwd: string) => Promise<import('./explore.js').DescriptionOutcome>} deps.askDescription -
 *   asks the user what task to explore in a project without changes.
 * @param {(invocation: object, description: string) => object} deps.followupExplore -
 *   sends the single explore message for that description.
 * @param {(invocation: object) => object} [deps.followupExploreMode] -
 *   sends the one fixed instruction of `/taskloop explore` (8.2, design D19). It takes no
 *   project and asks nothing, which is what lets the form run without reading anything.
 *   Absent, that form answers with an error instead of sending a message.
 * @param {(invocation: object, context: {change: string, cwd: string, previous?: object, task?: object, range?: object}) => Promise<object>} [deps.openSession] -
 *   opens a session the run needs: the one a new group runs in (5.1), and the one a
 *   finished group is reviewed in (3.3). Absent, a run that reaches a group boundary
 *   stops with an error instead of continuing in the session it was leaving, and a
 *   run that finishes a group stops instead of pretending the group was reviewed.
 * @param {(agent: object, signal?: AbortSignal) => Promise<unknown>} [deps.compactNow] -
 *   one `compaction.compactNow()` call for the session a task runs in (6.1). Absent, the run
 *   never compacts; the environment always supplies it and reports a missing service when called.
 * @param {(agent: object, signal?: AbortSignal) => Promise<unknown>} [deps.compactIfNeeded] -
 *   one `compaction.compactIfNeeded(agent, 'pressure', signal)` call for the step gate (6.3).
 *   Absent, the gate registers no listener; the environment always supplies it.
 * @param {(sessionId: string) => (void|Promise<void>)} [deps.setApproval] - narrows a review
 *   session's approval policy to `never` before its instruction is sent (3.3, design D14).
 *   Absent in a deployment without an approval service, where nothing could ask.
 * @param {(request: {executable: string, args: readonly string[]}, options: {cwd: string, signal?: AbortSignal}) => Promise<{exitCode: number|null, stdout: string, stderr: string}>} [deps.runCommitCommand] -
 *   executes one commit request without a shell (4.2). A request that cannot run at all
 *   rejects; an exit code comes back in the result, which is what makes a refusal of the
 *   tool a reportable outcome rather than a crash (4.3).
 * @param {(invocation: object, context: {change: string, cwd: string, tool: 'git'|'gitbutler'}) => Promise<{kind: 'text'|'cancelled'|'unavailable', text?: string, branch?: object, step?: string}>} [deps.commitInput] -
 *   the input the commits of this change take (5.2, 7.3: the message text plus, for
 *   GitButler, the branch they go into — the text read from the state of this change or
 *   asked for once, the branch asked for once, both before the first turn). `cancelled`
 *   is the user dismissing one of those questions, which starts no run; `unavailable`
 *   means the deployment has no source for the text, and a finished group says in the
 *   report that its commit was skipped for that reason. `branch` is the plan
 *   `lib/commit.js` creates and commits with. Absent, every run is in the
 *   `unavailable` case.
 * @param {(context: {change: string, cwd: string}) => Promise<void>} [deps.forgetCommitText] -
 *   drops the text stored for a change the run finished (5.3, design D16). Called once, and
 *   only when the loop settles on `all_done`; a failure does not fail the run, it becomes a
 *   warning in the report. Absent, this deployment stores no text on the run's behalf, so
 *   there is nothing to drop.
 * @param {(recipient: object, text: string) => (boolean|Promise<boolean>)} [deps.appendNotice] -
 *   appends one line to the session that drove a finished group, so the commit id is in that
 *   transcript the moment the history moves rather than only in the final report (4.3). The
 *   recipient is the agent or session runner the loop names in its group context. Best-effort:
 *   a missing session, an unimplemented `append()` or a rejection are all "the line was not
 *   written", never a reason to fail a run whose tasks are done. Absent, nothing is appended.
 * @param {object} [deps.logger] - host logger, for a step compaction that failed (6.3).
 * @returns {{run: Function, stop: Function, status: Function, explore: Function}} command actions.
 */
export function createControl({
  config, createCli, cwdOf, askInit, askDescription, followupExplore, followupExploreMode, openSession,
  compactNow, compactIfNeeded, setApproval, runCommitCommand, commitInput, forgetCommitText, appendNotice,
  logger,
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
        setApproval,
        runCommitCommand,
        commitInput,
        forgetCommitText,
        appendNotice,
        logger,
        runs,
      },
      invocation,
      action ?? {},
    ),
    stop: () => stopRun(runs),
    status: () => reportRun(runs),
    // `/taskloop explore` never touches the slot: it is not a run, and refusing it
    // because some run happens to be active would hide the one form that is safe
    // to use at any time (design D19).
    explore: (invocation) => startExploreMode({ followupExploreMode }, invocation),
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
    // The version gate is the first thing after the wrapper and before any read (9.2,
    // design D20): every document this run depends on is defined by a recent `openspec`,
    // so an older CLI — or one that will not say which version it is — is refused here,
    // with the floor and the advice to update, rather than failing mid-run after some
    // tasks are already ticked off. A refusal says nothing to the model and never claims
    // the run slot: both happen further down. `explore`, `stop` and `status` do not reach
    // this line at all, which is what makes them usable with any CLI.
    await cli.ensureSupportedVersion({ cwd, signal: invocation.signal })
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
    // explanation would lose the `taskloop:` attribution. A run that outlived its
    // request says the same thing in the session instead (see deliverReport).
    return deliverReport(deps, invocation, { kind: 'error', text: `${PREFIX}${messageOf(error)}` })
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
 * The text this run's commits carry (5.2) is dropped once the change is finished
 * (5.3): it is what the next `/taskloop` for that change would otherwise reuse, and
 * a group that does not exist any more has no commit to put it in.
 *
 * The run it returns from outlives the command that started it: the slot owns the
 * lifetime, not the request. So the result is the report for a live request and a
 * session notice for a run whose request ended first (see deliverReport); either
 * way the tasks kept coming while the request was gone.
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
  // The two options that decide what happens to a finished group are volatile (D12),
  // so they are read once, here, and the whole run keeps that answer.
  const reviewEnabled = deps.config.review.enabled.get()
  const commitEnabled = deps.config.commit.enabled.get()
  // The tool is read twice on purpose: here, because it decides whether the run has a
  // GitButler branch question at all (D18), and again at the moment of each commit (D12),
  // because a switch in Settings applies to the next group. A switch to `gitbutler`
  // mid-run therefore commits without a branch argument, and the report says so.
  const commitTool = commitEnabled ? deps.config.commit.tool.get() : undefined
  // The input of this run's commits is settled before the slot is claimed (5.2, 7.3,
  // design D16/D18): the message text stored for this change or the answer to a question
  // asked once, and — for GitButler — the branch, in the same card. A dismissed question
  // starts nothing at all — a run refused its input would commit nothing — while a
  // deployment that has nobody to ask goes on without a message or without a branch, and
  // the report of a finished group says which.
  const input = commitEnabled
    ? await resolveCommitInput(deps, invocation, { change: change.name, cwd, tool: commitTool })
    : { kind: COMMIT_TEXT.unavailable }
  if (input.kind === COMMIT_TEXT.cancelled) {
    return {
      kind: 'success',
      text: `${PREFIX}${head} ${commitInputRefusal(input, change.name)}, so the run was `
        + 'not started; nothing was sent to the model and no files were changed.',
    }
  }
  const text = input.kind === COMMIT_TEXT.text ? input.text : undefined
  // One plan for the whole run (D18): `lib/commit.js` creates the branch on the first
  // commit that has something in it and flips `exists`, so the next group commits into it
  // instead of trying to create it again.
  const branch = input.kind === COMMIT_TEXT.text ? input.branch : undefined
  const started = deps.runs.start(change.name)

  // Refusing is the whole point of the slot: the active run keeps its position and
  // its signal, and this caller neither reads nor sends anything.
  if (started.kind !== RUN_START.started) return refusalOf(started.run)

  const run = started.run
  // The protocol section is this run's own (5.2): it is registered before the
  // first message and removed when the run settles, whatever the ending. With the
  // option off there is no callback at all, so opening a session resolves its
  // agent exactly as it did before the section existed. The option is volatile
  // (D12), so the run starts from a snapshot taken here.
  const protocol = createProtocol({ enabled: deps.config.protocol.systemSection.get() })
  // Compaction inside a task (6.3) is built for this run too, and it has the same
  // lifetime: the gate installs a listener on each agent the run drives and is
  // removed in the same `finally`, so a later turn of the same session is not
  // gated by a run that is over. Off by default (D11); volatile since D12, so it
  // is read once, when the run starts.
  const midTask = createMidTaskGate({
    enabled: deps.config.compaction.midTask.get(),
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
  // the invocation those sessions belong to — its preset and the project directory
  // the CLI already runs in — and hands them the *run's* signal rather than the
  // request's: a request that goes away must not leave the new session with a turn
  // that was cancelled before it started. `adoptAgent` is how the session opened at
  // a boundary gives its agent the same protocol section and the same step gate the
  // invocation session got.
  const openSession = deps.openSession === undefined
    ? undefined
    : (context) => deps.openSession(invocation, {
        cwd,
        ...context,
        signal: run.signal,
        adoptAgent,
      })
  // The review of a finished group (3.3, design D13/D14) borrows the session opener
  // but not the run's task machinery: it is not handed `adoptAgent`, because neither
  // the protocol section nor the step gate describes a one-turn review. The commit of
  // the same group follows it in the same hook (4.3, design D15). Each option is
  // volatile (D12) and was read once above; with both off the loop is not given the
  // hook at all and the run behaves exactly as it did before either existed.
  /** @type {{kind: string, sessionId?: string, range?: {from: string, to: string}}[]} */
  const reviews = []
  /** @type {{kind: string, tool?: string, output?: string, range?: {from: string, to: string}}[]} */
  const commits = []
  const openReviewSession = deps.openSession === undefined
    ? () => {
        throw new Error('the review of a finished group cannot open a session because this run has no session opener')
      }
    : ({ change: reviewed, range }) => deps.openSession(invocation, {
        cwd,
        change: reviewed,
        ...(range === undefined ? {} : { range }),
        signal: run.signal,
      })
  const onGroupComplete = reviewEnabled || commitEnabled
    ? async ({ change: reviewed, range, agent: groupAgent }) => {
        if (reviewEnabled) {
          const review = await runReview({
            change: reviewed,
            range,
            openSession: openReviewSession,
            setApproval: deps.setApproval,
            signal: run.signal,
          })
          reviews.push(range === undefined
            ? { kind: review.kind, sessionId: review.sessionId }
            : { kind: review.kind, sessionId: review.sessionId, range })
          // A review the stop ended is the end of the run, and nothing may be committed
          // after it (design D14): the loop sees the abort and settles as `cancelled`.
          if (review.kind === REVIEW_END.cancelled) return undefined
        }
        if (!commitEnabled) return undefined
        // No text, no commit: the message is the user's, and inventing one would put a
        // sentence in the history that nobody wrote (design D16). The skip is a sentence
        // of the report, not a silent one.
        if (text === undefined) {
          commits.push(range === undefined ? { kind: COMMIT_SKIPPED } : { kind: COMMIT_SKIPPED, range })
          return undefined
        }
        const commit = await runCommit({
          // Volatile, and read at the moment of the commit rather than at the start of
          // the run (D12): switching the tool applies to the next group.
          tool: deps.config.commit.tool.get(),
          text,
          range,
          // The plan of the run (D18), when there is one. A switch to `gitbutler` after
          // the input was settled has none, so the commits go without a branch argument
          // and the report names that; a switch to `git` ignores the plan entirely.
          ...(branch === undefined ? {} : { branch }),
          cwd,
          run: deps.runCommitCommand,
          signal: run.signal,
        })
        if (commit.kind === COMMIT_END.failed) {
          // The group is finished and ticked off, so carrying the run into the next one
          // would leave this group's work outside the history (4.3, design D15/D17).
          return { kind: GROUP_END.commit, commit: range === undefined ? commit : { ...commit, range } }
        }
        // A commit cut short by a stop is the stop, and the loop reports it as one; only
        // what actually happened to the tree earns a sentence (design D17).
        if (commit.kind === COMMIT_END.committed || commit.kind === COMMIT_END.empty) {
          const recorded = range === undefined ? commit : { ...commit, range }
          commits.push(recorded)
          // The group's own session gets the id as soon as the history moved (4.3): the
          // final report is read wherever the work went next, and until it arrives a run
          // that committed and moved on looks exactly like one that skipped the commit.
          if (commit.kind === COMMIT_END.committed) {
            await appendCommitNotice(deps, groupAgent ?? invocation.agent, recorded)
          }
        }
        return undefined
      }
    : undefined
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
      onGroupComplete,
      // Compaction between tasks of one group (6.1): the loop decides when a
      // transition needs it, this control supplies the retried call and the
      // policy for what a spent budget means (6.2).
      compact: deps.compact,
      // Volatile since D12: the policy is taken once per run, so a switch made
      // while a run is active applies to the next one.
      onFailure: deps.config.compaction.onFailure.get(),
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
  // The message is kept for the change because a stopped run resumes into it; `all_done` is
  // the one ending that leaves no group to commit, so the record goes (5.3, design D16) and
  // the next `/taskloop` of this change asks again. Asked after the slot was released, so a
  // slow state file cannot keep a finished run in the way of the next one.
  const forgotten = outcome.kind === LOOP_END.completed
    ? await forgetCommitText(deps, { change: change.name, cwd })
    : undefined
  // Named in every ending, because the original session is the only one the user
  // is looking at after the work moved elsewhere (5.1). Compactions the run
  // survived are sentences of their own, placed before the handoff so the ending
  // of the run reads first: the `continue` policy's skips (6.2) and the step
  // compactions that failed inside a task (6.3). The reviews follow them in the
  // order they ran, then what became of each commit (4.3), then the message record
  // that outlived its change (5.3), and the handoff closes the report: it is the last
  // thing that happened to the work (3.3).
  const carried = warningClause(outcome.warnings) + stepWarningClause(midTask.warnings)
    + reviewClause(reviews) + commitClause(commits) + forgetClause(forgotten) + handoffClause(outcome.sessions)
  const result = renderReport({
    subject,
    sent: sentClause(outcome.sent),
    carried,
    outcome,
    stopped: run.stopped,
  })
  // A result reaches the user only through the request that asked for it. A run
  // that outlived its request (a reloaded tab, a closed window) still has to say
  // how it ended, so the report goes into the session instead (see deliverReport).
  return deliverReport(deps, invocation, result)
}

/**
 * The commit input of this run, or the refusal that ends the command (tasks 5.2, 7.3).
 *
 * The input belongs to the change and to the tool the run was started with (design
 * D16/D18), so the seam is asked once at the start of the run: it reads what is stored
 * for this change, reads the applied branches when the tool is GitButler, and asks for
 * what is missing in one card. The outcome is flattened to "the input" or "nothing"
 * here, because only the refusal changes what the command does — everything else is
 * whether a commit can be composed at all, and with which branch.
 *
 * A value that is not a known outcome is a caller's bug and is reported as one: reading
 * it as "no input" would silently skip the commits of a deployment that thinks it
 * supplied one. Blank text is the same "no text" for the same reason — whitespace is
 * not a sentence anybody wrote — and the branch plan is passed through untouched,
 * because `lib/commit.js` is what validates and uses it.
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {object} invocation - command invocation.
 * @param {{change: string, cwd: string, tool: 'git'|'gitbutler'}} context - change, project
 *   directory and the tool the run was started with.
 * @returns {Promise<{kind: 'text'|'cancelled'|'unavailable', text?: string, branch?: object, step?: string}>}
 *   the settled input.
 * @throws {TypeError} when the deployment answers with an unknown outcome.
 */
async function resolveCommitInput(deps, invocation, context) {
  if (typeof deps.commitInput !== 'function') return { kind: COMMIT_TEXT.unavailable }
  const outcome = await deps.commitInput(invocation, context)

  switch (outcome?.kind) {
    case COMMIT_TEXT.text: {
      const text = typeof outcome.text === 'string' ? outcome.text.trim() : ''
      if (text === '') return { kind: COMMIT_TEXT.unavailable }
      return {
        kind: COMMIT_TEXT.text,
        text,
        ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
      }
    }
    case COMMIT_TEXT.cancelled:
      return { kind: COMMIT_TEXT.cancelled, ...(typeof outcome.step === 'string' ? { step: outcome.step } : {}) }
    case COMMIT_TEXT.unavailable:
      return { kind: COMMIT_TEXT.unavailable }
    default:
      throw new TypeError(
        `the commit input source answered with an unknown outcome: ${String(outcome?.kind)}`,
      )
  }
}

/**
 * What a refused commit input withheld, phrased to follow the sentence naming the change (7.3).
 *
 * The report has to say which question was dismissed: a run stopped because no branch was
 * picked is not a run whose commit message was withdrawn, and the next `/taskloop` is
 * answered differently in each case. An input that names no step is read as the message
 * question, which is what a single-question deployment can only be refusing.
 *
 * @param {{step?: string}} input - refused input, as {@link resolveCommitInput} settled it.
 * @param {string} change - name of the change the run was for.
 * @returns {string} the clause, without its trailing comma.
 */
function commitInputRefusal(input, change) {
  if (input.step === CANCEL_STEP.branch) {
    return `no GitButler branch was chosen for change "${change}"`
  }
  if (input.step === CANCEL_STEP.anchor) {
    return `no anchor branch was chosen for the new GitButler branch of change "${change}"`
  }
  return `no commit message was given for change "${change}"`
}

/**
 * Drop the text stored for the change this run finished (5.3, design D16).
 *
 * A deployment without the seam stores nothing, so there is nothing to drop and this is
 * the ordinary quiet answer. A failure is returned rather than thrown: the run is over and
 * its tasks are done, and the report is the only place where that good news can be lost —
 * so the cost of a stale record (the next run reuses the text) becomes a sentence instead.
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {{change: string, cwd: string}} context - change and project directory of the run.
 * @returns {Promise<string|undefined>} why the record could not be dropped, or `undefined`.
 */
async function forgetCommitText(deps, context) {
  if (typeof deps.forgetCommitText !== 'function') return undefined
  try {
    await deps.forgetCommitText(context)
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * Turn one settled loop outcome into the command result a user reads.
 *
 * Kept apart from {@link startTaskStep} so the ending a run outlived its request
 * with and the ending it did not are rendered by the same sentences: only the
 * channel differs.
 *
 * @param {object} report
 * @param {string} report.subject - sentence naming the root, the change and its progress.
 * @param {string} report.sent - `sent task 4.1` clause, or `''` when nothing was sent.
 * @param {string} report.carried - warnings and the handoff that follow every ending.
 * @param {import('./loop.js').LoopOutcome} report.outcome - how the run ended.
 * @param {boolean} report.stopped - whether `/taskloop stop` ended the run.
 * @returns {{kind: 'success'|'error', text: string}} the command result.
 */
function renderReport({ subject, sent, carried, outcome, stopped }) {
  const last = outcome.task === undefined ? '' : labelOf(outcome.task)

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
  if (outcome.kind === LOOP_END.commit) {
    // The tool, its exit code and its own account of the failure are what makes this
    // stop actionable: the group is done and ticked off, only the history did not move
    // (4.3, design D15/D17). A tool that could not be run at all has no code, and says
    // so by leaving the clause out rather than inventing one. The branch is named as
    // well, because `but branch new` and `but commit` fail for different reasons and the
    // user has to know which branch the run was trying to reach (design D18).
    const failure = outcome.commit
    const code = typeof failure.exitCode === 'number' ? ` with exit code ${String(failure.exitCode)}` : ''
    const where = failure.command === undefined ? '' : ` at ${failure.command}`
    const why = failure.reason === undefined ? '' : `: ${failure.reason}`
    return {
      kind: 'error',
      text: `${PREFIX}${subject} ${sent === '' ? '' : `${sent}; `}the commit of ${scopeOf(failure.range)} `
        + `through ${failure.tool}${branchPlaceOf(failure.tool, failure.branch)} failed${where}${code}${why}; `
        + 'the run stopped and no further task was sent.'
        + carried,
    }
  }
  if (outcome.kind === LOOP_END.cancelled) {
    // A stop reaches the session whose run it ended as well: without this line the
    // run would appear to vanish with the last message it sent.
    const how = stopped ? 'the run was stopped by /taskloop stop' : 'the run was cancelled'
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
 * Deliver a settled run's report to whoever can still read it.
 *
 * A run outlives the request that started it, so the request may be gone by the
 * time the run ends — and with it the only reader of the returned result. The
 * report is then appended to the session as a context notice: the user sees how
 * the run ended in the transcript they are already reading, and the model does
 * not get a turn it did not ask for. A live request keeps the plain command
 * result; appending as well would print the same sentences twice.
 *
 * The append is best-effort on purpose: a run whose report cannot be written is
 * still over, and failing the command handler for a log write would replace the
 * report with a stack trace.
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {object} invocation - command invocation; `signal` says whether the request is alive.
 * @param {{kind: 'success'|'error', text: string}} result - the rendered report.
 * @returns {{kind: 'success'|'error', text: string}} the same result, for a live request.
 */
function deliverReport(deps, invocation, result) {
  if (invocation?.signal?.aborted !== true) return result
  const session = invocation.agent?.session
  if (session === undefined || session === null || typeof session.append !== 'function') return result

  try {
    session.append('user/message', createNoticeMessage(result.text), { surfaceOp: 'append' })
  } catch (error) {
    deps.logger?.warn?.(
      `[openspec-taskloop] the report of a run whose request ended could not be appended to the session: ${messageOf(error)}`,
    )
  }
  return result
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
 * Send the fixed explore instruction and report the command (8.2, design D19).
 *
 * Nothing else happens on this path: no working directory is resolved, no `openspec`
 * call is made, no question is asked and the run slot is neither read nor claimed.
 * That is what makes the form usable when there is no change to run and while a run
 * is active — it adds one message to the session and returns, and the dialogue that
 * follows belongs to the user and the model.
 *
 * @param {{followupExploreMode?: Function}} deps - the follow-up seam of the design.
 * @param {object} invocation - command invocation: `agent` receives the message.
 * @returns {{kind: 'success'|'error', text: string}} command result.
 */
function startExploreMode(deps, invocation) {
  if (typeof deps.followupExploreMode !== 'function') {
    return {
      kind: 'error',
      text: `${PREFIX}this deployment cannot send the explore instruction; describe the task in a message instead.`,
    }
  }
  try {
    deps.followupExploreMode(invocation)
  } catch (error) {
    // The agent could not take a message: the command says why instead of letting a
    // handler throw, the same rule every other action follows.
    return { kind: 'error', text: `${PREFIX}${messageOf(error)}` }
  }
  return {
    kind: 'success',
    text: `${PREFIX}explore mode requested; the model will ask what to investigate, and no task loop was started.`,
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
 * ` The review of tasks 2.1 - 2.4 ran in session review-1.` for every review the run
 * ran, or `''` when it reviewed nothing.
 *
 * One sentence per review rather than one list: a run can have reviewed one group
 * and been stopped during the next, and what became of each review is exactly what
 * the report is for. The session id is the only trace the user has of a session
 * they never watched (design D17); a review the stop ended before its session
 * existed says that instead of naming nothing.
 *
 * @param {{kind: string, sessionId?: string, range?: {from: string, to: string}}[]} [reviews] -
 *   reviews of this run, in the order they ran.
 * @returns {string} the sentences, or an empty string when no group was reviewed.
 */
function reviewClause(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return ''
  return reviews.map(({ kind, sessionId, range }) => {
    const where = sessionId === undefined ? '' : ` in session ${sessionId}`
    const verb = kind === REVIEW_END.cancelled ? 'was stopped' : 'ran'
    return ` The review of ${scopeOf(range)} ${verb}${where}.`
  }).join('')
}

/**
 * ` The commit of tasks 2.1 - 2.4 through git went through: [main 1a2b3c4] …` for every
 * commit the run performed or skipped, or `''` when it committed nothing.
 *
 * A commit that went through quotes the tool's own line, because that line is where the
 * commit id lives and the report is the only place a user can find it (design D17). The
 * empty tree and the missing message text are both skips, and both say why: a group that
 * finished without a commit must not read as if it had one. A failed commit is not here
 * — it ended the run, and the report's own branch for it names the tool, the code and
 * the reason.
 *
 * A GitButler commit names its branch (design D18): that is where the history moved, and
 * the user never sees the question once the run is over. A run that ended up committing
 * without a branch — a headless deployment, or a switch of the tool in the middle of the
 * run — says that too, because a `but commit` without an argument is the one case where
 * the tool, not the run, picked the branch.
 *
 * @param {{kind: string, tool?: string, branch?: string, output?: string, range?: {from: string, to: string}}[]} [commits] -
 *   commits of this run, in the order they ran.
 * @returns {string} the sentences, or an empty string when no group was committed.
 */
function commitClause(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return ''
  return commits.map(({ kind, tool, branch, output, range }) => {
    const scope = scopeOf(range)
    if (kind === COMMIT_END.committed) {
      const said = output === undefined ? '' : `: ${firstLineOf(output)}`
      return ` The commit of ${scope} through ${tool}${branchPlaceOf(tool, branch)} went through${said}.`
    }
    if (kind === COMMIT_END.empty) {
      return ` The commit of ${scope} was skipped: the working tree had no uncommitted changes.`
    }
    return ` The commit of ${scope} was skipped: the run has no commit message text.`
  }).join('')
}

/**
 * Append the commit id to the session the finished group ran in (4.3, design D17).
 *
 * The report is read wherever the run went next, and a group boundary opens a new
 * session in the same second the commit lands: without a line in the transcript the
 * user is left watching, a group that was committed and one whose commit was skipped
 * look the same. The append is best-effort in the way the report's own is (see
 * {@link deliverReport}): a session that cannot take the line is a line lost, never a
 * failed run whose work is already in the history.
 *
 * @param {object} deps - resolved dependencies, see {@link createControl}.
 * @param {object} recipient - agent or session runner that drove the group.
 * @param {{tool: string, branch?: string, output?: string, range?: {from: string, to: string}}} commit -
 *   the commit that went through, as the report records it.
 * @returns {Promise<void>} resolves once the line was offered to the session.
 */
async function appendCommitNotice(deps, recipient, commit) {
  if (typeof deps.appendNotice !== 'function') return
  try {
    await deps.appendNotice(recipient, commitNoticeText(commit))
  } catch (error) {
    deps.logger?.warn?.(
      '[openspec-taskloop] the commit line of a finished group could not be appended '
        + `to its session: ${messageOf(error)}`,
    )
  }
}

/**
 * `taskloop: commit 1a2b3c4 for tasks 2.1 - 2.4 (git).` — the line the session gets (4.3).
 *
 * The id comes first because that is what a user greps the history with; the tool is
 * named because a deployment can switch it between groups, and the branch is named
 * because a GitButler commit that does not say where it landed leaves the user to open
 * GitButler to find out (design D18). When the tool printed no id, the line quotes what
 * it did print instead of inventing a hash — the same rule the report follows.
 *
 * @param {{tool: string, branch?: string, output?: string, range?: {from: string, to: string}}} commit -
 *   the commit that went through.
 * @returns {string} the notice text, prefixed like every other line of the plugin.
 */
function commitNoticeText(commit) {
  const scope = scopeOf(commit.range)
  const place = branchPlaceOf(commit.tool, commit.branch)
  const id = commitIdOf(commit.output)
  if (id !== undefined) return `${PREFIX}commit ${id} for ${scope}${place} (${commit.tool}).`
  const said = commit.output === undefined ? '' : `: ${firstLineOf(commit.output)}`
  return `${PREFIX}the commit of ${scope} through ${commit.tool}${place} went through${said}.`
}

/**
 * ` into branch "feature-a"`, ` without naming a branch`, or `''` for a `git` commit (7.4).
 *
 * The branch is part of every sentence that says where a commit landed (design D18), and
 * the two cases are not the same fact: a named branch is where the history moved, while
 * an unnamed one means `but commit` without the argument — the tool picked, not the run.
 * `git` has no branch of its own to report, so it adds nothing.
 *
 * @param {string} [tool] - commit tool of the outcome.
 * @param {string} [branch] - branch the commit went into, when the run named one.
 * @returns {string} the clause, empty for `git`.
 */
function branchPlaceOf(tool, branch) {
  if (tool !== 'gitbutler') return ''
  return branch === undefined ? ' without naming a branch' : ` into branch "${branch}"`
}

/**
 * ` Warning: the stored commit message of this change could not be removed (…); the next
 * run will reuse it.` for a record the finished run could not drop (5.3), or `''`.
 *
 * The sentence exists because the failure is invisible otherwise: the run succeeded, and
 * what it lost is a question the user will not be asked next time — a commit message from
 * earlier work would quietly be used again. It names the reason the store gave, so a
 * permissions problem or a full disk is actionable rather than mysterious.
 *
 * @param {string} [failure] - why the stored text could not be removed.
 * @returns {string} the sentence, or an empty string when the record was dropped.
 */
function forgetClause(failure) {
  if (failure === undefined) return ''
  return ' Warning: the stored commit message of this change could not be removed '
    + `(${failure}); the next run will reuse it.`
}

/**
 * `tasks 2.1 - 2.4` / `the whole task list` for a group a review or a commit closes.
 *
 * The same pair of words as the review instruction's scope clause (`lib/review.js`), so
 * the report of a group reads the same whether it is about the review or the commit; a
 * flat run has no numbers to name and says so instead of inventing a range (design D13).
 *
 * @param {{from: string, to: string}} [range] - first and last task of the group.
 * @returns {string} the scope clause.
 */
function scopeOf(range) {
  return range === undefined ? 'the whole task list' : `tasks ${range.from} - ${range.to}`
}

/**
 * The first non-empty line of a tool's output, for a sentence that quotes it.
 *
 * A commit prints its summary and then the diffstat; only the summary names the commit,
 * and embedding the rest would turn one clause into a paragraph.
 *
 * @param {string} output - what the tool printed.
 * @returns {string} the first line, trimmed.
 */
function firstLineOf(output) {
  const line = output.split('\n').map((part) => part.trim()).find((part) => part !== '')
  return line ?? output.trim()
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
