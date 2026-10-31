// dsh-openspec-taskloop — `/taskloop` runs, driven end to end (tasks 6.1, 5.1).
//
// Every module the command uses is the real one here, and the host is replaced at
// exactly one boundary: the Cordis context. `createEnvironment()` resolves the
// services a deployment composes, `createControl()` is the command the user runs, and
// everything below them — the loop, the step messages, the review, the commit, the
// message store and its file — is the shipped code. Nothing else is stubbed: the argv
// the commit tool receives, the range appended to the user's text, the order in which
// sessions are opened, the file under the harness home and the sentences of the report
// are all produced by the paths this change added.
//
//     /taskloop ─▶ ask ─▶ 2.3 ─▶ 2.4 ─▶ review ─▶ commit ─▶ new session ─▶ 3.1 ─▶ 3.2 ─▶ review ─▶ commit ─▶ all_done
//
// The scenario is the one the change exists for: two groups, each closed by a review
// and a commit of its own, a run that changes session between them, and a compaction
// policy the user switched to `continue` (6.2). The transitions inside a group cannot
// compact — no compaction service answers — so the run must send the task anyway and
// say in its report that it did so without the bound it was configured to have.
//
// What the fake host is allowed to do is only what a host does: answer the CLI, open
// sessions, accept prompts, take the turn (the fake model ticks the box of the task it
// was sent, which is the whole of its answer, design D4), ask the user for the commit
// message and start the commit tool. Everything the plugin decides is left to the
// plugin.
//
// The second scenario is the retry budget the same compaction runs on (5.1): the
// backend keeps failing with `summary`, the shipped schedule of 40, 60 and 90 seconds
// is waited in full — through an injected clock, so the test does not pay for it —
// and `break` withholds the second task of the open group instead of sending it.
//
// The third scenario is the pause (9.1, design D1/D2/D4/D6): the run sends its first
// task, `/taskloop pause` ends that turn through the session service and parks the loop
// before it reads again, the slot stays taken, `/taskloop resume` re-sends the same
// task because the box the pause left unchecked is not a failure, and `/taskloop stop`
// ends the run the second pause parked. The turn is a real one here — the fake model
// ends it only when it is cancelled or when the test lets it finish — so the test can
// tell a cancelled turn from a completed one by the checkbox alone.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { COMMIT_MESSAGE_QUESTION_ID } from '../lib/commit-text.js'
import { resolveConfig } from '../lib/config.js'
import { createControl } from '../lib/control.js'
import { createEnvironment } from '../lib/environment.js'
import { createRuns } from '../lib/runs.js'
import { readCommitMessage, stateFileOf, stateKeyOf } from '../lib/state.js'
import { statusOf } from '../lib/status.js'

/** Directory the run works in; the fake host answers for it and nothing is written there. */
const CWD = 'C:\\projects\\demo'

/** Change the fake CLI answers for. */
const CHANGE = 'add-taskloop-plugin'

/** Text the user types when the run asks for the commit message (5.2). */
const TEXT = 'Добавить эндпоинт'

/** Tracking file every fake task points at. */
const TASKS_FILE = `${CWD}\\openspec\\changes\\${CHANGE}\\tasks.md`

/**
 * The task list the fake CLI reports: two groups of two tasks each.
 *
 * Two groups are the smallest run that shows both endings — a boundary in the middle
 * and `all_done` at the end — and each of them is closed by its own review and commit,
 * which is what makes the order and the two commit messages observable.
 */
const TASKS = Object.freeze([
  { id: '3', description: '2.3 Реализовать разбор apply-инструкций', line: 12 },
  { id: '4', description: '2.4 Извлечь группу из описания задачи', line: 13 },
  { id: '5', description: '3.1 Зарегистрировать команду /taskloop', line: 17 },
  { id: '6', description: '3.2 Реализовать проверку инициализации', line: 18 },
])

/** A stdout/stderr reader whose whole retained text is `text`. */
const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })

/**
 * The `openspec list --json` answer: the run's own directory is the root.
 *
 * @returns {string} the document the CLI would print.
 */
function listing() {
  return JSON.stringify({
    changes: [{
      name: CHANGE,
      completedTasks: 0,
      totalTasks: TASKS.length,
      lastModified: '2026-10-20T12:43:10.120Z',
      status: 'in-progress',
    }],
    root: { path: CWD, source: 'nearest' },
  })
}

/**
 * A task file the fake model ticks, one turn at a time.
 *
 * The document is derived from the `done` flags on every read, so the loop always sees
 * the file as it stands after the last turn — the same way `openspec` reports it, and
 * the reason the loop can verify a task without trusting the turn that ran it (D4).
 *
 * @returns {object} the project: `dirty`, `tick()` and `reading()`.
 */
function createProject() {
  const tasks = TASKS.map((task) => ({ ...task, done: false, sourcePath: TASKS_FILE }))
  const project = {
    /**
     * Whether the working tree has changes the next commit would take.
     *
     * A turn that did work dirties the tree, a commit takes it back to clean: that is
     * what makes the second group's commit as real as the first.
     */
    dirty: false,

    /**
     * Tick the task whose box the turn completed.
     *
     * @param {string} label - `N.M` label the step message named.
     * @returns {void}
     * @throws {Error} when the run sends a task twice or one the list does not hold.
     */
    tick(label) {
      const task = tasks.find((candidate) => candidate.description.startsWith(`${label} `))
      if (task === undefined) throw new Error(`the run sent an unknown task: ${label}`)
      if (task.done) throw new Error(`the run sent task ${label} twice`)
      task.done = true
      project.dirty = true
    },

    /**
     * The `openspec instructions apply --json` answer for the current file.
     *
     * `all_done` is the CLI's own word for a finished change, and the loop reads the
     * ending from it rather than counting unchecked boxes itself (D4).
     *
     * @returns {string} the document the CLI would print.
     */
    reading() {
      const complete = tasks.filter((task) => task.done).length
      return JSON.stringify({
        changeName: CHANGE,
        state: complete === tasks.length ? 'all_done' : 'ready',
        progress: { total: tasks.length, complete, remaining: tasks.length - complete },
        tasks,
      })
    },
  }
  return project
}

/**
 * The host's subprocess service: `openspec` and the commit tool, both from an argv
 * array.
 *
 * The commit asserts on the array itself, because there is no shell between the plugin
 * and the tool (design D15): the message must arrive as one element, whatever
 * punctuation it holds. The CLI answers are not part of the ordering log — how often
 * the loop reads the file is its own business, and a read that did not happen would
 * leave a task unsent, which the log shows anyway.
 *
 * @param {object} project - the fake project, see {@link createProject}.
 * @param {string[]} events - shared ordering log of the run's phases.
 * @param {() => void} [snapshot] - called before every `git status`: where the test
 *   looks at the run's own state.
 * @returns {object} the service with a `spawned` log of the requests it received.
 */
function createSubprocess(project, events, snapshot = () => {}) {
  const spawned = []

  /**
   * What one program answers, and what the run learns from it.
   *
   * @param {string} program - `openspec` or `git`.
   * @param {string[]} args - arguments after the executable.
   * @returns {{exitCode?: number, stdout?: string, stderr?: string}} settled exit facts.
   * @throws {Error} when the run started something this fake host does not know.
   */
  const answerOf = (program, args) => {
    // `--version` is the first thing a run asks for (9.2, design D20), and it is answered
    // with a supported version: this scenario is about the group boundary, not the gate.
    if (program === 'openspec' && args[0] === '--version') return { stdout: '1.14.1\n' }
    if (program === 'openspec' && args[0] === 'list') return { stdout: listing() }
    if (program === 'openspec' && args[0] === 'instructions') return { stdout: project.reading() }
    if (program !== 'git') {
      throw new Error(`the run started a program the fake host does not know: ${program}`)
    }
    if (args[0] === 'status') {
      events.push('git status')
      snapshot()
      return { stdout: project.dirty ? ' M lib/control.js\n M lib/loop.js\n' : '' }
    }
    if (args[0] === 'add') {
      events.push('git add')
      return {}
    }
    if (args[0] === 'commit') {
      const message = args[2]
      events.push(`git commit ${message}`)
      project.dirty = false
      return { stdout: `[main 1a2b3c4] ${message}\n 2 files changed, 12 insertions(+)\n` }
    }
    throw new Error(`the run started an unexpected git request: ${args.join(' ')}`)
  }

  return {
    spawned,
    async resolveExecutable(command) {
      return `C:\\tools\\${command}.exe`
    },
    spawn(spec) {
      spawned.push(spec)
      const [executable, ...args] = spec.argv
      const program = executable.split(/[\\/]/u).at(-1).replace(/\.exe$/u, '')
      const answer = answerOf(program, args)
      return {
        collected: {
          stdout: reader(answer.stdout ?? ''),
          stderr: reader(answer.stderr ?? ''),
        },
        done: Promise.resolve({ exitCode: answer.exitCode ?? 0, signal: null }),
        terminate() {},
      }
    },
  }
}

/**
 * What the model does with one message: a task turn ticks its box, a review changes
 * nothing and just ends.
 *
 * This is the only place the fake model exists. The plugin never asks what the turn
 * did — it re-reads `tasks.md` (design D4) — so the box is the whole answer, and a
 * review that quietly "reviews" is exactly what an unattended review looks like.
 *
 * @param {string} text - message the run sent.
 * @param {string} where - agent or session that received it, for the log.
 * @param {object} project - the fake project.
 * @param {string[]} events - shared ordering log.
 * @returns {void}
 * @throws {Error} when the message is neither a task nor a review instruction.
 */
function takeTurn(text, where, project, events) {
  const task = /выполни task (\d+\.\d+), далее/u.exec(text)
  if (task !== null) {
    events.push(`task ${task[1]} in ${where}`)
    project.tick(task[1])
    return
  }
  const review = /\(задачи (\d+\.\d+) - (\d+\.\d+)\)/u.exec(text)
  if (review !== null) {
    events.push(`review tasks ${review[1]} - ${review[2]} in ${where}`)
    return
  }
  throw new Error(`the run sent a message the fake model cannot act on: ${text}`)
}

/**
 * The host's session controller, faked as numbered sessions.
 *
 * A session is created with the request the seam builds and receives one prompt per
 * task the run sends into it, which is all the plugin asks of the controller. Its agent
 * answers `whenIdle()` immediately: the turn the prompt started is the fake model's,
 * and it is over by the time the message is accepted.
 *
 * @param {object} project - the fake project.
 * @param {string[]} events - shared ordering log.
 * @returns {object} the controller with a `created` log.
 */
function createSessions(project, events) {
  const created = []
  let count = 0
  return {
    created,
    async create(request) {
      count += 1
      const sessionId = `session-${count}`
      created.push({ sessionId, request })
      events.push(`create ${sessionId}`)
      return { sessionId }
    },
    prompt(request) {
      takeTurn(request.content[0].text, request.sessionId, project, events)
      return Promise.resolve({ messageId: `${request.sessionId}-turn` })
    },
    async resolveAgent(sessionId) {
      // The id is what the approval policy and the compaction call are given back, so
      // the log can name the session a review ran in (design D17). The session takes the
      // commit line of the group it drove the same way the invocation's session does.
      return {
        id: sessionId,
        sessionId,
        session: {
          append(type, message) {
            events.push(`notice ${sessionId}: ${message.content[0].text}`)
          },
        },
        async whenIdle() {},
      }
    },
  }
}

test('two groups are reviewed, committed and handed over in the shipped modules', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-taskloop-e2e-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const events = []
  /** The state file as the run left it before each commit: 5.2 keeps it, 5.3 drops it at the end. */
  const snapshots = []
  const project = createProject()
  const subprocess = createSubprocess(project, events, () => {
    snapshots.push(readFileSync(stateFileOf(home), 'utf8'))
  })
  const sessions = createSessions(project, events)
  const asked = []

  const services = {
    subprocess,
    sessionController: sessions,
    profileContext: { home },
    workingDirectory: { get: () => CWD },
    // The commit message is the user's (5.2): one free-text question, answered once.
    userQuestions: {
      async ask(request) {
        const [question] = request.questions
        if (question?.id !== COMMIT_MESSAGE_QUESTION_ID) {
          throw new Error(`the run asked an unexpected question: ${String(question?.id)}`)
        }
        asked.push(request)
        events.push('ask message')
        return { answers: [{ id: question.id, custom: TEXT }] }
      },
    },
    // The review's turn is unattended, so its policy is narrowed before it is sent (3.2).
    approval: {
      setPolicy(target, policy) {
        events.push(`approval ${target.id} ${policy}`)
      },
    },
    // A compaction service that answers, and fails: this is the deployment of 6.2 where
    // a spent budget is tolerated. The policy below decides what the run does with it.
    compaction: {
      async compactNow(agent) {
        events.push(`compact ${agent.id}`)
        throw Object.assign(new Error('the summarizer is unavailable'), { code: 'summary' })
      },
    },
  }
  const ctx = { get: (name) => services[name], logger: { warn() {} } }

  const config = resolveConfig({
    commit: { enabled: true, tool: 'git' },
    review: { enabled: true },
    // The setting this scenario changes: one attempt, then continue. The run must send
    // the task anyway and warn about the bound it did not have (6.2).
    compaction: { onFailure: 'continue', retry: { attempts: 1 } },
  })
  const agent = {
    id: 'agent-1',
    session: {
      header: { cwd: CWD },
      // The session a group ran in gets the commit id the moment the tool commits (4.3).
      append(type, message) {
        events.push(`notice agent-1: ${message.content[0].text}`)
      },
    },
    followup(message) {
      takeTurn(message.content[0].text, 'agent-1', project, events)
    },
    async whenIdle() {},
  }
  const control = createControl({ config, ...createEnvironment(ctx, config) })

  const result = await control.run(
    { commandId: 'command-1', agent, rawInput: '', attachments: [], signal: new AbortController().signal },
    { change: null },
  )

  assert.equal(result.kind, 'success')

  // The order the whole change is about: each group is reviewed before it is committed,
  // and the commit happens before the session of the next group is opened (D13, D14,
  // D15). The review session and the working session are different sessions, and the
  // compaction attempts sit exactly where the transitions inside a group are.
  assert.deepEqual(events, [
    'ask message',
    'task 2.3 in agent-1',
    'compact agent-1',
    'task 2.4 in agent-1',
    'create session-1',
    'approval session-1 never',
    'review tasks 2.3 - 2.4 in session-1',
    'git status',
    'git add',
    `git commit ${TEXT}. Tasks 2.3 - 2.4`,
    // The id is in the transcript of the group before the next session even exists.
    'notice agent-1: taskloop: commit 1a2b3c4 for tasks 2.3 - 2.4 (git).',
    'create session-2',
    'task 3.1 in session-2',
    'compact session-2',
    'task 3.2 in session-2',
    'create session-3',
    'approval session-3 never',
    'review tasks 3.1 - 3.2 in session-3',
    'git status',
    'git add',
    `git commit ${TEXT}. Tasks 3.1 - 3.2`,
    // Group 3 ran in session-2, so that session gets the line about its own commit.
    'notice session-2: taskloop: commit 1a2b3c4 for tasks 3.1 - 3.2 (git).',
  ])

  // The message is the user's text plus the range of the group, and it reaches the tool
  // as a single argv element (design D15): a shell could not have split it anyway.
  const commits = subprocess.spawned.filter((spec) => spec.argv[1] === 'commit')
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0].argv.slice(2), ['-m', `${TEXT}. Tasks 2.3 - 2.4`])
  assert.deepEqual(commits[1].argv.slice(2), ['-m', `${TEXT}. Tasks 3.1 - 3.2`])
  assert.equal(commits[0].argv.length, 4, 'the message travels as one argument')
  assert.equal(commits[0].cwd, CWD)

  // Every session the run opened — the two reviews and the group 3 handoff — is created
  // in the run's directory, which is the documented fallback when no workspace owns it.
  assert.deepEqual(sessions.created.map((entry) => entry.request), [
    { cwd: CWD },
    { cwd: CWD },
    { cwd: CWD },
  ])

  // One question, asked before the first turn, and it is free text: no options to pick.
  assert.equal(asked.length, 1)
  assert.equal(asked[0].questions.length, 1)
  assert.equal(asked[0].questions[0].options, undefined)
  assert.match(asked[0].questions[0].question, /change "add-taskloop-plugin"/u)

  // The stored text was there for the commits of both groups and is gone afterwards
  // (5.2, 5.3, design D16): the next `/taskloop` of this change asks again.
  const key = stateKeyOf({ cwd: CWD, change: CHANGE })
  assert.equal(snapshots.length, 2)
  for (const snapshot of snapshots) {
    assert.equal(JSON.parse(snapshot).changes[key].message, TEXT)
  }
  assert.deepEqual(JSON.parse(await readFile(stateFileOf(home), 'utf8')), { changes: {} })
  assert.equal(await readCommitMessage({ home, cwd: CWD, change: CHANGE }), undefined)

  // The report: what the run sent, the compactions it survived, both reviews, both
  // commits and where the work moved (design D17).
  assert.match(result.text, /^taskloop: OpenSpec root: C:\\projects\\demo\./u)
  assert.match(result.text, /Change "add-taskloop-plugin" \(4\/4 tasks done\)/u)
  assert.match(result.text, /sent tasks 2\.3, 2\.4, 3\.1 and 3\.2; all tracked tasks are complete\./u)
  assert.match(
    result.text,
    / Warnings: compaction before task 2\.4 failed after 1 attempt \(summary\): the summarizer is unavailable;/u,
  )
  assert.match(
    result.text,
    /; compaction before task 3\.2 failed after 1 attempt \(summary\): the summarizer is unavailable; the run continued without compaction\./u,
  )
  assert.match(result.text, / The review of tasks 2\.3 - 2\.4 ran in session session-1\./u)
  assert.match(result.text, / The review of tasks 3\.1 - 3\.2 ran in session session-3\./u)
  assert.match(
    result.text,
    / The commit of tasks 2\.3 - 2\.4 through git went through: \[main 1a2b3c4\] Добавить эндпоинт\. Tasks 2\.3 - 2\.4\./u,
  )
  assert.match(
    result.text,
    / The commit of tasks 3\.1 - 3\.2 through git went through: \[main 1a2b3c4\] Добавить эндпоинт\. Tasks 3\.1 - 3\.2\./u,
  )
  assert.match(result.text, / The run moved to session session-2 \(task 3\.1\) at the group boundary\./u)
  // The record was dropped, so there is nothing to warn about (5.3).
  assert.doesNotMatch(result.text, /could not be removed/u)

  // ...and it reads in the order things happened: the warnings of the transitions, then
  // the reviews, then the commits (each kind in the order it ran, design D17), and the
  // handoff that closes the report.
  const at = (needle) => {
    const index = result.text.indexOf(needle)
    assert.notEqual(index, -1, `the report does not mention ${needle}`)
    return index
  }
  assert.ok(at(' Warnings:') < at(' The review of tasks 2.3 - 2.4'))
  assert.ok(at(' The review of tasks 2.3 - 2.4') < at(' The review of tasks 3.1 - 3.2'))
  assert.ok(at(' The review of tasks 3.1 - 3.2') < at(' The commit of tasks 2.3 - 2.4'))
  assert.ok(at(' The commit of tasks 2.3 - 2.4') < at(' The commit of tasks 3.1 - 3.2'))
  assert.ok(at(' The commit of tasks 3.1 - 3.2') < at(' The run moved to session session-2'))
})

/**
 * A clock that records the backoff instead of waiting for it.
 *
 * The pauses are the subject of the second scenario, and paying 40 + 60 + 90 seconds in
 * wall-clock time would make the test take longer than the run it describes. The
 * compactor takes its clock as a dependency; the control forwards this one in place of
 * the real `waitFor`.
 *
 * @param {number[]} pauses - shared log of the delays, in milliseconds.
 * @returns {(ms: number) => Promise<void>} the fake clock.
 */
const recordingSleep = (pauses) => async (ms) => {
  pauses.push(ms)
}

test('four failed compactions wait the default schedule and break holds back the next task', async () => {
  const events = []
  const pauses = []
  const project = createProject()
  const subprocess = createSubprocess(project, events)

  // The review and the commit are other changes' subjects and would only run at a
  // group boundary, which this run must never reach: the first transition already
  // spends the attempt budget of the compaction.
  const config = resolveConfig({
    commit: { enabled: false },
    review: { enabled: false },
    compaction: { onFailure: 'break' },
  })
  const services = {
    subprocess,
    workingDirectory: { get: () => CWD },
    // The backend stays down: every call fails with the transient code whose window
    // the default pauses exist to outlast.
    compaction: {
      async compactNow(agent) {
        events.push(`compact ${agent.id}`)
        throw Object.assign(new Error('manual compaction failed: summary'), { code: 'summary' })
      },
    },
  }
  const ctx = { get: (name) => services[name], logger: { warn() {} } }
  const agent = {
    id: 'agent-1',
    session: { header: { cwd: CWD } },
    followup(message) {
      takeTurn(message.content[0].text, 'agent-1', project, events)
    },
    async whenIdle() {},
  }
  const control = createControl({
    config,
    ...createEnvironment(ctx, config),
    sleep: recordingSleep(pauses),
  })

  const result = await control.run(
    { commandId: 'command-1', agent, rawInput: '', attachments: [], signal: new AbortController().signal },
    { change: null },
  )

  assert.equal(result.kind, 'error')

  // The shipped defaults, travelled end to end: four calls, three pauses, and the
  // growth of `factor` (1.5) with no ceiling (design D2, D3).
  assert.deepEqual(pauses, [40_000, 60_000, 90_000])
  assert.deepEqual(events, [
    'task 2.3 in agent-1',
    'compact agent-1',
    'compact agent-1',
    'compact agent-1',
    'compact agent-1',
  ])

  // 2.4 continues the group and was withheld: `break` stops the run before it is sent,
  // and the report names the four attempts the transition cost.
  assert.match(
    result.text,
    /sent task 2\.3; compaction before task 2\.4 failed after 4 attempts \(summary\): manual compaction failed: summary; the run stopped and no further task was sent\./,
  )
  assert.doesNotMatch(result.text, /Warning:/)
  // The turn of 2.3 is all that happened: no second task message was composed.
  assert.equal(events.filter((event) => event.startsWith('task ')).length, 1)
})

/**
 * The model of the third scenario: a turn that ends only when it is told to.
 *
 * A pause ends a turn through the session service rather than by itself (design D4), so
 * the fake model has to be a turn the test can end from outside. `cancel()` is that
 * ending: the turn stops and nothing is ticked. `finish()` is the model doing its work:
 * the box of the task it was sent is ticked and the turn ends. Nothing else about the
 * run is the model's business — the loop re-reads the file and decides (design D4).
 *
 * @param {object} project - the fake project, see {@link createProject}.
 * @param {string[]} events - shared ordering log.
 * @returns {object} the agent, the tasks it was sent, and the two ways a turn ends.
 */
function createTurnModel(project, events) {
  /** @type {string[]} */
  const sent = []
  /** @type {{label: string, idle: Promise<void>, finish: () => void}|undefined} */
  let turn

  const agent = {
    id: 'agent-1',
    // The run starts in the session its command came from (design D7), and the pause
    // addresses that session rather than the agent (design D4).
    sessionId: 'session-1',
    session: { header: { cwd: CWD }, append() {} },
    followup(message) {
      const label = /выполни task (\d+\.\d+), далее/u.exec(message.content[0].text)?.[1]
      if (label === undefined) {
        throw new Error(`the run sent a message the fake model cannot act on: ${message.content[0].text}`)
      }
      sent.push(label)
      events.push(`task ${label} in session-1`)
      let finish
      const idle = new Promise((resolve) => {
        finish = resolve
      })
      turn = { label, idle, finish }
    },
    whenIdle() {
      return turn.idle
    },
  }

  return {
    agent,
    sent,
    /** The model works and is done: the task it was sent is ticked and the turn ends. */
    finish() {
      project.tick(turn.label)
      turn.finish()
    },
    /** The session service ends the turn: the task is left exactly as it was. */
    cancel() {
      turn.finish()
    },
  }
}

/**
 * Wait until the run reaches a state the test can act on.
 *
 * The run is a chain of turns and CLI answers, so the test can only observe it between
 * two ticks of the event loop. This turns "the message left" and "the run parked" into
 * conditions instead of a fixed number of `setImmediate` calls, which is what keeps the
 * scenario from depending on the order in which those promises happen to settle.
 *
 * @param {() => boolean} predicate - condition to wait for.
 * @param {string} message - what to report when it never becomes true.
 * @returns {Promise<void>} resolves once the condition holds.
 * @throws {assert.AssertionError} when it never does.
 */
async function until(predicate, message) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

/**
 * How many times the fake CLI was asked for the task file of the run.
 *
 * The count is what makes "a parked run reads nothing" observable: the loop reads the
 * file once per decision, and a pause that still cost a read would show up here even
 * when no message followed it.
 *
 * @param {object} subprocess - the fake subprocess service, see {@link createSubprocess}.
 * @returns {number} the number of `openspec instructions apply` calls.
 */
const instructionReads = (subprocess) =>
  subprocess.spawned.filter((spec) => spec.argv[1] === 'instructions').length

test('a pause cancels the turn and parks the run, and resume and stop end it from there', async () => {
  // The scenario of the UI change, end to end (design D1/D2/D4/D6, spec "Пауза прогона",
  // "Возобновление прогона"): a run that starts, is paused in the middle of its first
  // turn, keeps the slot while it waits, re-sends the same task after a resume, and is
  // ended by a stop while the second pause holds it. The review and the commit are off
  // because the scenario stops inside the first group: a boundary would open a session
  // and that is another change's subject.
  const events = []
  const project = createProject()
  const subprocess = createSubprocess(project, events)
  const model = createTurnModel(project, events)
  /** Sessions whose turn the pause or the stop asked to end, in order (design D4). */
  const cancelled = []

  const services = {
    subprocess,
    // The service the composer's stop button uses: a pause and a stop end the turn
    // through it, by session id, and it is what makes the cancelled turn a turn that
    // really ended rather than a wait the test abandoned. It resolves the agent of a
    // session the way the host does, which is how the between-task compaction finds the
    // agent to shrink.
    sessionController: {
      async cancel(request) {
        cancelled.push(request.sessionId)
        events.push(`cancel ${request.sessionId}`)
        model.cancel()
      },
      async resolveAgent(sessionId) {
        return sessionId === model.agent.sessionId ? model.agent : undefined
      },
    },
    // A compaction service that answers: a task that continues its group is compacted
    // before it is sent (6.1), so a deployment of this scenario has one. Nothing is
    // asserted about it beyond its place in the order.
    compaction: {
      async compactNow(agent) {
        events.push(`compact ${agent.id}`)
      },
    },
    workingDirectory: { get: () => CWD },
  }
  const ctx = { get: (name) => services[name], logger: { warn() {} } }
  const config = resolveConfig({ review: { enabled: false }, commit: { enabled: false } })
  // The slot is the deployment's own, so the test reads the same one the commands and a
  // badge would read (7.3); `statusOf` is the badge's own view of it (6.1).
  const runs = createRuns()
  const control = createControl({ config, ...createEnvironment(ctx, config), runs })

  const running = control.run(
    { commandId: 'command-1', agent: model.agent, rawInput: '', attachments: [], signal: new AbortController().signal },
    { change: null },
  )

  // The run starts: one message for the first unchecked task, and its turn is in flight.
  await until(() => model.sent.length === 1, 'the run did not send its first task')
  assert.deepEqual(model.sent, ['2.3'])

  // The pause ends that turn through the session service and parks the loop: the gate
  // closes before the service is asked, so nothing new can leave while it is asked.
  const parked = await control.pause()
  assert.match(
    parked.text,
    /^taskloop: parked the run for change "add-taskloop-plugin" \(on task 2\.3\); it stays paused until \/taskloop resume\./u,
  )
  assert.deepEqual(cancelled, ['session-1'], 'the pause ended the turn of the session the run leads')
  await until(() => statusOf(runs).phase === 'paused', 'the run did not park after the pause')

  // The slot stays taken while the run waits (design D1): the snapshot says the run is
  // active and paused, on the task it stopped at, in the session it leads, with the
  // progress of the last reading — and a parked run sends nothing.
  const snapshot = statusOf(runs)
  assert.equal(snapshot.active, true)
  assert.equal(snapshot.change, CHANGE)
  assert.equal(snapshot.cwd, CWD)
  assert.equal(snapshot.sessionId, 'session-1')
  assert.equal(snapshot.task.description, TASKS[0].description)
  assert.deepEqual(snapshot.progress, { complete: 0, total: TASKS.length })
  assert.equal(model.sent.length, 1, 'a parked run sends nothing')

  // A second `/taskloop` meets the parked run and offers the command that releases it,
  // instead of a refusal that would leave the user guessing why the run is not moving.
  const otherMessages = []
  const refusal = await control.run(
    {
      commandId: 'command-2',
      agent: {
        id: 'agent-2',
        sessionId: 'session-2',
        followup: (message) => otherMessages.push(message),
        async whenIdle() {},
      },
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
    },
    { change: null },
  )
  assert.equal(refusal.kind, 'error')
  assert.match(
    refusal.text,
    /^taskloop: a run for change "add-taskloop-plugin" is paused \(on task 2\.3\); \/taskloop resume continues it, and no second run was started\./u,
  )
  assert.equal(otherMessages.length, 0)
  // A parked run reads no task file: the one read was the one that chose 2.3.
  assert.equal(instructionReads(subprocess), 1)

  // The resume re-reads `tasks.md` and finds 2.3 unchecked — the box the pause left
  // that way — so the same task goes out again instead of the run ending as a failure
  // (design D6). The reading is the run's own, and the allowance is spent by it.
  const resumed = await control.resume()
  assert.match(
    resumed.text,
    /^taskloop: resumed the run for change "add-taskloop-plugin"; the run re-reads tasks\.md and re-sends task 2\.3 unless it is now checked\./u,
  )
  await until(() => model.sent.length === 2, 'the resumed run did not re-send the task')
  assert.deepEqual(model.sent, ['2.3', '2.3'])
  assert.equal(statusOf(runs).phase, 'running')
  assert.equal(instructionReads(subprocess), 2)

  // The re-sent turn now does its work, and the run moves on to the next task of the group.
  model.finish()
  await until(() => model.sent.length === 3, 'the run did not continue after the re-sent task')
  assert.equal(model.sent[2], '2.4')

  // The second pause parks the run again, and this time a stop ends it: a parked run is
  // released by the stop rather than left waiting for a resume nobody will send (design D2).
  const parkedAgain = await control.pause()
  assert.match(parkedAgain.text, /parked the run for change "add-taskloop-plugin" \(on task 2\.4\)/u)
  await until(() => statusOf(runs).phase === 'paused', 'the run did not park the second time')

  const stopped = await control.stop()
  const result = await running

  // The stop names the task the parked run was on and how many turns left the session —
  // the re-sent task counts as one of them — and it frees the slot for the next run.
  assert.match(
    stopped.text,
    /^taskloop: stopped the run for change "add-taskloop-plugin" on task 2\.4 \(3 tasks sent\)/u,
  )
  assert.equal(runs.current(), null)
  assert.deepEqual(statusOf(runs), { active: false })
  assert.equal(model.sent.length, 3, 'the parked run sent nothing while it was stopped')

  // The report of the stopped run: what left the session, the ending, and the progress
  // of the last reading rather than the listing's stale counts.
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^taskloop: OpenSpec root: C:\\projects\\demo\./u)
  assert.match(result.text, /Change "add-taskloop-plugin" \(1\/4 tasks done\)/u)
  assert.match(
    result.text,
    /sent tasks 2\.3, 2\.3 and 2\.4; the run was stopped by \/taskloop stop after that turn\./u,
  )

  // The order the sessions and the services saw: the task, the pause that ended its
  // turn, the compaction of the transition the resume led to, the same task again, the
  // next one, the second pause, and the stop that freed the slot.
  assert.deepEqual(events, [
    'task 2.3 in session-1',
    'cancel session-1',
    'compact agent-1',
    'task 2.3 in session-1',
    'compact agent-1',
    'task 2.4 in session-1',
    'cancel session-1',
    'cancel session-1',
  ])
  assert.deepEqual(cancelled, ['session-1', 'session-1', 'session-1'])
  // Three decisions, three reads: the first task, the re-sent one, the next one.
  assert.equal(instructionReads(subprocess), 3)
})
