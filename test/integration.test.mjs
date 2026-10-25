// dsh-openspec-taskloop — one `/taskloop` run, driven end to end (task 6.1).
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
import { readCommitMessage, stateFileOf, stateKeyOf } from '../lib/state.js'

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
