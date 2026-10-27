// Tests for the commit that closes a task group (task 4.1) and the GitButler branch
// it commits into (task 7.2).
//
// The commit is the plugin's own step (design D15), so its contract is pinned here
// without a host: the message is the user's text plus the range of the group, the
// requests are argv arrays with the message as one element, an empty tree is a
// normal answer, and a refusal comes back as data — the tool, the request that
// failed, its exit code and its own explanation — rather than as a thrown error.
//
// The branch part is a plan object (design D18) rather than an argument: a new branch
// is created by the first commit that has something to commit and by no later one, so
// the tests drive two commits of a run through one plan and count the requests.
//
// The fakes record the requests in order: whether `git commit` follows `git add`,
// whether `but branch new` precedes `but commit`, and whether anything at all follows
// a status check that says the tree is empty, is exactly what the report on a failed
// run depends on.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMIT_END,
  STATUS_COMMAND,
  buildCommitCommands,
  buildCommitMessage,
  commitIdOf,
  createButBranch,
  runCommit,
} from '../lib/commit.js'
import { COMMIT_TOOLS } from '../lib/config.js'

const CHANGE = 'add-taskloop-review-commit'
const RANGE = { from: '2.1', to: '2.4' }
const TEXT = 'Добавить эндпоинт'
const GROUPED = 'Добавить эндпоинт. Tasks 2.1 - 2.4'

/** A request that succeeded. */
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })

/** A request that ran and refused. */
const no = (exitCode, { stderr = '', stdout = '' } = {}) => ({ exitCode, stdout, stderr })

/**
 * A runner that answers by request name (`git status`, `git add`, `git commit`, `but commit`).
 *
 * Every call is recorded with the request and the options it was given, so a test
 * can assert both the order and that `cwd` and the signal reach the runner.
 *
 * @param {Record<string, object|Error|(() => object)>} answers - one answer, rejection or thunk per name.
 * @param {string} [cwd] - directory the test expects to see.
 * @returns {{run: Function, calls: {name: string, args: readonly string[], cwd: string}[]}} the runner and its log.
 */
function fakeRunner(answers, cwd = '/repo') {
  const calls = []
  const run = async (request, options) => {
    const name = `${request.executable} ${request.args[0]}`
    calls.push({ name, args: request.args, cwd: options.cwd })
    assert.deepEqual(options.cwd, cwd)
    const answer = answers[name]
    if (answer === undefined) throw new Error(`unexpected request: ${name}`)
    const settled = typeof answer === 'function' ? answer() : answer
    if (settled instanceof Error) throw settled
    return settled
  }
  return { run, calls }
}

test('the commit message is the user text with the range of the group appended', () => {
  assert.equal(buildCommitMessage({ text: TEXT, range: RANGE }), GROUPED)
  // The exact example of the specification.
  assert.equal(
    buildCommitMessage({ text: 'Добавить эндпоинт', range: { from: '2.1', to: '2.4' } }),
    'Добавить эндпоинт. Tasks 2.1 - 2.4',
  )
})

test('a text that already ends its sentence does not get a second full stop', () => {
  // The text is the user's and is never rewritten; only the sentence break before the
  // range is not doubled. A message typed with a final period used to reach the history
  // as `…badge.. Tasks 2.1 - 2.7`.
  assert.equal(
    buildCommitMessage({ text: 'Change add-fallback-status-badge.', range: RANGE }),
    'Change add-fallback-status-badge. Tasks 2.1 - 2.4',
  )
  assert.equal(
    buildCommitMessage({ text: 'Change add-fallback-status-badge!', range: RANGE }),
    'Change add-fallback-status-badge! Tasks 2.1 - 2.4',
  )
  assert.equal(buildCommitMessage({ text: 'Why?', range: RANGE }), 'Why? Tasks 2.1 - 2.4')
  // A flat run carries the text alone, whatever its punctuation.
  assert.equal(
    buildCommitMessage({ text: 'Change add-fallback-status-badge.' }),
    'Change add-fallback-status-badge.',
  )
})

test('the commit id is read from the line the tool printed, and from nowhere else', () => {
  assert.equal(commitIdOf('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4'), '1a2b3c4')
  assert.equal(commitIdOf('[main (root-commit) 0f1e2d3] first commit'), '0f1e2d3')
  assert.equal(commitIdOf('Committed as 1a2b3c4.'), '1a2b3c4')
  // A branch name that happens to look hexadecimal must not win over the id.
  assert.equal(commitIdOf('[deadbeef 1a2b3c4] subject'), '1a2b3c4')
  assert.equal(commitIdOf('committed the tree'), undefined)
  assert.equal(commitIdOf('   '), undefined)
  assert.equal(commitIdOf(undefined), undefined)
  assert.equal(commitIdOf(42), undefined)
})

test('a flat run commits the user text alone, with no range to name', () => {
  const message = buildCommitMessage({ text: TEXT })

  assert.equal(message, TEXT)
  assert.doesNotMatch(message, /Tasks/u)
})

test('the message is trimmed but keeps its own line breaks', () => {
  assert.equal(buildCommitMessage({ text: '  Добавить эндпоинт\n' }), TEXT)
  assert.equal(buildCommitMessage({ text: '\nДобавить\nэндпоинт\n' }), 'Добавить\nэндпоинт')
})

test('a message needs text and a complete range', () => {
  assert.throws(() => buildCommitMessage({}), /non-empty message text/u)
  assert.throws(() => buildCommitMessage({ text: '' }), /non-empty message text/u)
  assert.throws(() => buildCommitMessage({ text: '   ' }), /non-empty message text/u)
  assert.throws(() => buildCommitMessage({ text: 42 }), /non-empty message text/u)
  assert.throws(() => buildCommitMessage({ text: TEXT, range: { from: '2.1' } }), /range\.to/u)
  assert.throws(() => buildCommitMessage({ text: TEXT, range: { to: '2.4' } }), /range\.from/u)
  assert.throws(() => buildCommitMessage({ text: TEXT, range: { from: '', to: '2.4' } }), /range\.from/u)
})

test('git stages the whole tree and then commits the message', () => {
  assert.deepEqual(buildCommitCommands({ tool: 'git', message: GROUPED }), [
    { executable: 'git', args: ['add', '-A'] },
    { executable: 'git', args: ['commit', '-m', GROUPED] },
  ])
})

test('GitButler commits with one `but commit -m` request', () => {
  assert.deepEqual(buildCommitCommands({ tool: 'gitbutler', message: GROUPED }), [
    { executable: 'but', args: ['commit', '-m', GROUPED] },
  ])
})

test('every tool the configuration accepts has a commit plan', () => {
  // Drift guard: a tool added to the schema without a plan here would be accepted
  // by the loader and then fail at the first group boundary.
  for (const tool of COMMIT_TOOLS) {
    assert.ok(buildCommitCommands({ tool, message: GROUPED }).length > 0, `no plan for ${tool}`)
  }
  assert.throws(() => buildCommitCommands({ tool: 'svn', message: GROUPED }), /unknown commit tool: svn/u)
  assert.throws(() => buildCommitCommands({ tool: 'git', message: '' }), /non-empty commit message/u)
})

test('the message reaches the tool as one argument, whatever it contains', () => {
  const text = 'Fix "quotes" $(rm -rf /) and `ticks`\nsecond line'
  const [stage, commit] = buildCommitCommands({ tool: 'git', message: text })

  assert.deepEqual(stage.args, ['add', '-A'])
  // No shell, no interpolation: the message is one argv element after `-m`.
  assert.deepEqual(commit.args, ['commit', '-m', text])
  assert.equal(commit.args.length, 3)
})

test('a commit through git checks the tree, stages it and commits it', async () => {
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/control.js\n?? lib/commit.js\n'),
    'git add': ok(),
    'git commit': ok('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n 2 files changed, 40 insertions(+)\n'),
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  // The order is the contract: the tree is checked, staged, then committed.
  assert.deepEqual(calls.map((call) => call.name), ['git status', 'git add', 'git commit'])
  assert.equal(calls[2].args[2], GROUPED)
  assert.deepEqual(calls[0].args, [...STATUS_COMMAND.args])
  assert.deepEqual(outcome, {
    kind: COMMIT_END.committed,
    tool: 'git',
    message: GROUPED,
    output: '[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n 2 files changed, 40 insertions(+)',
  })
})

test('GitButler runs its own commit request and reports what it printed', async () => {
  const { run, calls } = fakeRunner({
    'git status': ok('M lib/commit.js\n'),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })

  const outcome = await runCommit({ tool: 'gitbutler', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but commit'])
  assert.equal(outcome.kind, COMMIT_END.committed)
  assert.equal(outcome.tool, 'gitbutler')
  assert.equal(outcome.output, 'Committed as 1a2b3c4')
})

test('an empty tree is not committed and is not an error', async () => {
  const { run, calls } = fakeRunner({ 'git status': ok('') })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.deepEqual(calls.map((call) => call.name), ['git status'])
  assert.deepEqual(outcome, { kind: COMMIT_END.empty, tool: 'git', message: GROUPED })
})

test('a blank status answer is still an empty tree', async () => {
  const { run } = fakeRunner({ 'git status': ok('\n\n') })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.equal(outcome.kind, COMMIT_END.empty)
})

test('a status check that fails stops the commit before anything is staged', async () => {
  const { run, calls } = fakeRunner({
    'git status': no(128, { stderr: 'fatal: not a git repository (or any of the parent directories)\n' }),
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.deepEqual(calls.map((call) => call.name), ['git status'])
  assert.equal(outcome.kind, COMMIT_END.failed)
  assert.equal(outcome.command, 'git status')
  assert.equal(outcome.exitCode, 128)
  assert.match(outcome.reason, /not a git repository/u)
})

test('a staging that fails is reported with its code and its stderr', async () => {
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/control.js\n'),
    'git add': no(128, { stderr: 'fatal: pathspec is outside the repository\n' }),
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  // Nothing is committed on top of a half-staged tree.
  assert.deepEqual(calls.map((call) => call.name), ['git status', 'git add'])
  assert.equal(outcome.kind, COMMIT_END.failed)
  assert.equal(outcome.command, 'git add')
  assert.equal(outcome.exitCode, 128)
  assert.match(outcome.reason, /pathspec is outside the repository/u)
})

test('a commit the tool refused carries its code and the reason it gave', async () => {
  const { run } = fakeRunner({
    'git status': ok(' M lib/control.js\n'),
    'git add': ok(),
    'git commit': no(1, { stderr: 'Author identity unknown\n\n*** Please tell me who you are.\n' }),
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.equal(outcome.kind, COMMIT_END.failed)
  assert.equal(outcome.command, 'git commit')
  assert.equal(outcome.exitCode, 1)
  assert.match(outcome.reason, /Author identity unknown/u)
  // The report can still name what the commit was meant to be.
  assert.equal(outcome.message, GROUPED)
})

test('a failure that printed only to stdout still explains itself', async () => {
  const { run } = fakeRunner({
    'git status': ok(' M lib/commit.js\n'),
    'git add': ok(),
    'git commit': no(1, { stdout: 'error: nothing to commit\n' }),
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.equal(outcome.reason, 'error: nothing to commit')
})

test('a silent refusal still says which code it exited with', async () => {
  const { run } = fakeRunner({
    'git status': ok(' M lib/commit.js\n'),
    'git add': ok(),
    'git commit': no(2),
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.reason, 'the command exited with code 2')
})

test('a reason keeps the tail of a long stderr', async () => {
  const stderr = `${'hint: a lot of explaining\n'.repeat(500)}fatal: the last word\n`
  const { run } = fakeRunner({
    'git status': ok(' M lib/commit.js\n'),
    'git add': ok(),
    'git commit': no(1, { stderr }),
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.ok(outcome.reason.length <= 2_000)
  assert.match(outcome.reason, /fatal: the last word$/u)
})

test('a tool that cannot run is a failure of the commit, not a crash', async () => {
  const spawn = new Error('git CLI is not available: spawn git ENOENT')
  const { run } = fakeRunner({
    'git status': ok(' M lib/commit.js\n'),
    'git add': ok(),
    'git commit': spawn,
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.equal(outcome.kind, COMMIT_END.failed)
  assert.equal(outcome.command, 'git commit')
  // No exit code exists: the tool never ran.
  assert.equal('exitCode' in outcome, false)
  assert.match(outcome.reason, /not available/u)
})

test('a run stopped before the commit performs no request', async () => {
  const controller = new AbortController()
  controller.abort()
  const { run, calls } = fakeRunner({})

  const outcome = await runCommit({
    tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run, signal: controller.signal,
  })

  assert.deepEqual(calls, [])
  assert.deepEqual(outcome, { kind: COMMIT_END.stopped, tool: 'git', message: GROUPED })
})

test('a stop while the tree is being staged does not commit it', async () => {
  const controller = new AbortController()
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/control.js\n'),
    'git add': () => {
      controller.abort()
      return ok()
    },
  })

  const outcome = await runCommit({
    tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run, signal: controller.signal,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'git add'])
  assert.equal(outcome.kind, COMMIT_END.stopped)
})

test('a stop during the status check is a stop, not a failed tool', async () => {
  const controller = new AbortController()
  const { run } = fakeRunner({
    'git status': () => {
      controller.abort()
      return no(1, { stderr: 'interrupted' })
    },
  })

  const outcome = await runCommit({
    tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run, signal: controller.signal,
  })

  assert.equal(outcome.kind, COMMIT_END.stopped)
})

test('a commit that went through stays committed when the stop lands while it finishes', async () => {
  const controller = new AbortController()
  const { run } = fakeRunner({
    'git status': ok(' M lib/control.js\n'),
    'git add': ok(),
    'git commit': () => {
      controller.abort()
      return ok('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n')
    },
  })

  const outcome = await runCommit({
    tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run, signal: controller.signal,
  })

  assert.equal(outcome.kind, COMMIT_END.committed)
})

test('a commit without a runner is refused before anything is built', async () => {
  await assert.rejects(
    () => runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo' }),
    /requires a run\(\)/u,
  )
})

test('a message that cannot be built is refused before the tree is touched', async () => {
  const { run, calls } = fakeRunner({})

  await assert.rejects(
    () => runCommit({ tool: 'git', text: '  ', range: RANGE, cwd: '/repo', run }),
    /non-empty message text/u,
  )
  assert.deepEqual(calls, [])
})

test('the tool is part of every outcome, so a report can name it', async () => {
  const { run } = fakeRunner({
    'git status': ok('M lib/commit.js\n'),
    'but commit': no(1, { stderr: 'no branch assigned\n' }),
  })

  const outcome = await runCommit({ tool: 'gitbutler', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.equal(outcome.tool, 'gitbutler')
  assert.equal(outcome.command, 'but commit')
  assert.equal(outcome.exitCode, 1)
  assert.match(outcome.reason, /no branch assigned/u)
})

// --- the GitButler branch of a run (task 7.2, design D18) -------------------

const BRANCH = { name: 'feature-a', exists: true }

test('GitButler commits into the branch the run selected', () => {
  assert.deepEqual(buildCommitCommands({ tool: 'gitbutler', message: GROUPED, branch: BRANCH }), [
    { executable: 'but', args: ['commit', '-b', 'feature-a', '-m', GROUPED] },
  ])
})

test('a new branch is created by name, with its anchor when there is one', () => {
  assert.deepEqual(
    buildCommitCommands({
      tool: 'gitbutler', message: GROUPED, branch: { name: 'feature-b', anchor: 'feature-a', exists: false },
    }),
    [
      { executable: 'but', args: ['branch', 'new', 'feature-b', '-A', 'feature-a'] },
      { executable: 'but', args: ['commit', '-b', 'feature-b', '-m', GROUPED] },
    ],
  )
  // A project without applied branches has nothing to stack on: no `-A` at all.
  assert.deepEqual(
    buildCommitCommands({ tool: 'gitbutler', message: GROUPED, branch: { name: 'first', exists: false } }),
    [
      { executable: 'but', args: ['branch', 'new', 'first'] },
      { executable: 'but', args: ['commit', '-b', 'first', '-m', GROUPED] },
    ],
  )
})

test('git ignores a branch plan, so a switch to git changes no argument', () => {
  assert.deepEqual(buildCommitCommands({ tool: 'git', message: GROUPED, branch: { name: 'x', exists: false } }), [
    { executable: 'git', args: ['add', '-A'] },
    { executable: 'git', args: ['commit', '-m', GROUPED] },
  ])
})

test('a branch plan that cannot name a branch is refused before anything runs', () => {
  assert.throws(() => createButBranch({}), /non-empty branch name/u)
  assert.throws(() => createButBranch({ name: '   ' }), /non-empty branch name/u)
  assert.throws(() => createButBranch({ name: 'feature-a', anchor: '' }), /non-empty anchor/u)
  assert.throws(
    () => buildCommitCommands({ tool: 'gitbutler', message: GROUPED, branch: { exists: true } }),
    /non-empty branch name/u,
  )
  assert.throws(
    () => buildCommitCommands({ tool: 'gitbutler', message: GROUPED, branch: { name: 'x', anchor: ' ' } }),
    /non-empty anchor/u,
  )
})

test('the plan reads its branch name and anchor, and exists only when it says so', () => {
  assert.deepEqual(createButBranch({ name: ' feature-a ' }), { name: 'feature-a', exists: false })
  assert.deepEqual(
    createButBranch({ name: 'feature-b', anchor: 'feature-a' }),
    { name: 'feature-b', anchor: 'feature-a', exists: false },
  )
  assert.deepEqual(
    createButBranch({ name: 'feature-a', exists: true }),
    { name: 'feature-a', exists: true },
  )
})

test('a new branch is created on the first commit and not on the next one', async () => {
  const branch = createButBranch({ name: 'feature-b', anchor: 'feature-a' })
  const { run, calls } = fakeRunner({
    'git status': ok('M lib/commit.js\n'),
    'but branch': ok('Created branch feature-b\n'),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })

  const first = await runCommit({ tool: 'gitbutler', text: TEXT, range: RANGE, branch, cwd: '/repo', run })

  // The order is the contract: the tree is checked, the branch created, then committed.
  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but branch', 'but commit'])
  assert.deepEqual(calls[1].args, ['branch', 'new', 'feature-b', '-A', 'feature-a'])
  assert.deepEqual(calls[2].args, ['commit', '-b', 'feature-b', '-m', GROUPED])
  assert.equal(first.kind, COMMIT_END.committed)
  assert.equal(first.branch, 'feature-b')
  assert.equal(branch.exists, true)

  // The second group of the same run finds the branch and only commits into it.
  calls.length = 0
  const next = { from: '2.5', to: '2.8' }
  const second = await runCommit({ tool: 'gitbutler', text: TEXT, range: next, branch, cwd: '/repo', run })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but commit'])
  assert.deepEqual(calls[1].args, ['commit', '-b', 'feature-b', '-m', 'Добавить эндпоинт. Tasks 2.5 - 2.8'])
  assert.equal(second.kind, COMMIT_END.committed)
})

test('an empty tree creates no branch and leaves the plan for the next group', async () => {
  const branch = createButBranch({ name: 'feature-b', anchor: 'feature-a' })
  const { run, calls } = fakeRunner({ 'git status': ok('') })

  const outcome = await runCommit({
    tool: 'gitbutler', text: TEXT, range: RANGE, branch, cwd: '/repo', run,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status'])
  assert.equal(outcome.kind, COMMIT_END.empty)
  assert.equal(outcome.branch, 'feature-b')
  assert.equal(branch.exists, false)
})

test('a branch creation that failed stops the commit before anything is committed', async () => {
  const branch = createButBranch({ name: 'feature-b', anchor: 'feature-a' })
  const { run, calls } = fakeRunner({
    'git status': ok('M lib/commit.js\n'),
    'but branch': no(1, { stderr: 'branch feature-b already exists\n' }),
  })

  const outcome = await runCommit({
    tool: 'gitbutler', text: TEXT, range: RANGE, branch, cwd: '/repo', run,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but branch'])
  assert.equal(outcome.kind, COMMIT_END.failed)
  assert.equal(outcome.command, 'but branch')
  assert.equal(outcome.exitCode, 1)
  assert.match(outcome.reason, /already exists/u)
  // Nothing was created, so the plan still owes the request.
  assert.equal(branch.exists, false)
})

test('a stop while the branch is being created commits nothing and keeps the plan pending', async () => {
  const controller = new AbortController()
  const branch = createButBranch({ name: 'feature-b', anchor: 'feature-a' })
  const { run, calls } = fakeRunner({
    'git status': ok('M lib/commit.js\n'),
    'but branch': () => {
      controller.abort()
      return ok('Created branch feature-b\n')
    },
  })

  const outcome = await runCommit({
    tool: 'gitbutler', text: TEXT, range: RANGE, branch, cwd: '/repo', run, signal: controller.signal,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but branch'])
  assert.equal(outcome.kind, COMMIT_END.stopped)
  // The tool did create it, so a later attempt must not create it again.
  assert.equal(branch.exists, true)
})

test('a commit without a branch stays `but commit -m`, as before the plan existed', async () => {
  const { run, calls } = fakeRunner({
    'git status': ok('M lib/commit.js\n'),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })

  const outcome = await runCommit({ tool: 'gitbutler', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.deepEqual(calls[1].args, ['commit', '-m', GROUPED])
  // No branch was named, so the report has none to name either.
  assert.equal('branch' in outcome, false)
})
