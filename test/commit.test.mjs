// Tests for the commit that closes a task group (task 4.1), the GitButler branch it
// commits into (task 7.2) and the line endings of the files it carries (task 5.4).
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
// run depends on. The rewrite of the endings is a dependency of the commit (D8), so a
// test can see the files it was handed and how many requests had already run — which is
// how the "after the branch, before the commit" order is pinned without a file system.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMIT_END,
  COMMIT_FILES_MAX,
  STATUS_COMMAND,
  buildCommitCommands,
  buildCommitMessage,
  commitIdOf,
  createButBranch,
  filterOpenspec,
  isOpenspecPath,
  parseStatus,
  runCommit,
} from '../lib/commit.js'
// The module namespace as well, so the tests can pin what the commit no longer offers
// (task 5.4: the staging builders of 4.4 are gone).
import * as commitModule from '../lib/commit.js'
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

/**
 * `count` changed files outside `openspec/`, as the paths `git status` prints.
 *
 * The budget tests count in hundreds, so the paths are built instead of typed.
 *
 * @param {number} count - how many paths to produce.
 * @returns {string[]} one path per file, in a stable order.
 */
function changedPaths(count) {
  return Array.from({ length: count }, (_, index) => `lib/f${String(index)}.js`)
}

/**
 * A rewrite of the endings that records the files it was handed and rewrites nothing.
 *
 * The step itself is pinned in `test/eol.test.mjs`, where real files sit in a real
 * directory; here it is the seam that lets a test see *which* files a commit hands over and
 * *where* in the request order the rewrite happens — the two things the commit owns (task
 * 5.4, D8). The injected function is called with the real contract, so a commit that reached
 * it wrongly would not pass.
 *
 * @param {object} [options]
 * @param {readonly {name: string}[]} [options.requests] - log of the fake runner: the number
 *   of requests already made is recorded with every call, which is what pins the order.
 * @param {string[]} [options.mixed] - files to report as left with a mixed history.
 * @returns {{normalizeEol: Function, calls: {files: readonly string[], cwd: string, after: number}[]}}
 *   the dependency and its log.
 */
function fakeNormalizer({ requests, mixed = [] } = {}) {
  const calls = []
  const normalizeEol = async (files, options) => {
    calls.push({
      files: [...files],
      cwd: options.cwd,
      after: requests === undefined ? 0 : requests.length,
    })
    assert.equal(typeof options.run, 'function', 'the rewrite needs the runner to inspect')
    return { rewritten: [...files], mixed }
  }
  return { normalizeEol, calls }
}

/**
 * The untracked-file records of these paths, as `git status` reports them.
 *
 * @param {readonly string[]} paths - paths of newly added files.
 * @returns {string[]} one `?? <path>` record per path.
 */
const untracked = (paths) => paths.map((path) => `?? ${path}`)

/**
 * The answer `git status --porcelain -z` gives for these records.
 *
 * @param {readonly string[]} records - entries, status characters and path.
 * @returns {string} the NUL-terminated output.
 */
const statusOf = (records) => records.map((record) => `${record}\0`).join('')

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

// --- the openspec exclusion of a git commit (task 3.1, design D3) -----------

test('with the setting off, git excludes openspec from staging and from the commit', () => {
  // The pathspec is in both requests and starts after `--` (design D3): `git add`
  // leaves `openspec/` out of the index, and `git commit` commits only what the same
  // pathspec names, so a user's earlier `git add openspec/...` cannot ride along.
  assert.deepEqual(
    buildCommitCommands({ tool: 'git', message: GROUPED, openspec: false }),
    [
      { executable: 'git', args: ['add', '-A', '--', '.', ':(exclude)openspec'] },
      { executable: 'git', args: ['commit', '-m', GROUPED, '--', '.', ':(exclude)openspec'] },
    ],
  )
})

test('with the setting on, git gets no pathspec at all', () => {
  // `true` and the absent argument are the same request: a profile without the setting
  // keeps the argv byte for byte, which is what makes the default behaviour unchanged.
  const withSetting = buildCommitCommands({ tool: 'git', message: GROUPED, openspec: true })
  assert.deepEqual(withSetting, buildCommitCommands({ tool: 'git', message: GROUPED }))
  assert.deepEqual(withSetting, [
    { executable: 'git', args: ['add', '-A'] },
    { executable: 'git', args: ['commit', '-m', GROUPED] },
  ])
  // No request carries a `--` separator or a pathspec when every change is committed.
  for (const request of withSetting) assert.equal(request.args.includes('--'), false)
})

test('GitButler commits with one `but commit -m` request', () => {
  assert.deepEqual(buildCommitCommands({ tool: 'gitbutler', message: GROUPED }), [
    { executable: 'but', args: ['commit', '-m', GROUPED] },
  ])
})

// --- the openspec exclusion of a GitButler commit (task 4.1, design D4) -----

test('with the setting off, GitButler names the files outside openspec/', () => {
  // `but commit` has no exclusion flag, so the same boundary is the file list itself
  // (D4): the message stays before the paths, and every path is one argv element — the
  // space in `docs/a b.md` is part of the name, not a separator the tool would split on.
  assert.deepEqual(
    buildCommitCommands({
      tool: 'gitbutler',
      message: GROUPED,
      branch: { name: 'feature-a', exists: true },
      openspec: false,
      files: ['lib/control.js', 'docs/a b.md'],
    }),
    [{
      executable: 'but',
      args: ['commit', '-b', 'feature-a', '-m', GROUPED, 'lib/control.js', 'docs/a b.md'],
    }],
  )
})

test('a new branch is created before the commit that names the files', () => {
  // The order is the contract, as it is for a commit of the whole tree: the branch has to
  // exist before the commit travels into it (D18), and the file list belongs to the
  // commit, not to `but branch new`.
  assert.deepEqual(
    buildCommitCommands({
      tool: 'gitbutler',
      message: GROUPED,
      branch: { name: 'feature-b', anchor: 'feature-a', exists: false },
      openspec: false,
      files: ['lib/commit.js'],
    }),
    [
      { executable: 'but', args: ['branch', 'new', 'feature-b', '-A', 'feature-a'] },
      { executable: 'but', args: ['commit', '-b', 'feature-b', '-m', GROUPED, 'lib/commit.js'] },
    ],
  )
})

test('with the setting on, GitButler names no file at all', () => {
  // The whole tree is the change set, so there is nothing to single out: the argv is the
  // one of a profile without the setting, whatever list a caller happens to pass.
  const withSetting = buildCommitCommands({
    tool: 'gitbutler',
    message: GROUPED,
    branch: { name: 'feature-a', exists: true },
    openspec: true,
    files: ['lib/control.js'],
  })
  assert.deepEqual(
    withSetting,
    buildCommitCommands({ tool: 'gitbutler', message: GROUPED, branch: { name: 'feature-a', exists: true } }),
  )
  assert.deepEqual(withSetting, [
    { executable: 'but', args: ['commit', '-b', 'feature-a', '-m', GROUPED] },
  ])
})

test('a file list that does not name paths is refused', () => {
  // A path reaches the tool as argv: an empty one would be an argument that names
  // nothing, and the group would fail after its work was already done.
  assert.throws(
    () => buildCommitCommands({ tool: 'gitbutler', message: GROUPED, openspec: false, files: 'lib/a.js' }),
    /array of file paths/u,
  )
  assert.throws(
    () => buildCommitCommands({ tool: 'gitbutler', message: GROUPED, openspec: false, files: [''] }),
    /non-empty path/u,
  )
  assert.throws(
    () => buildCommitCommands({ tool: 'gitbutler', message: GROUPED, openspec: false, files: [42] }),
    /non-empty path/u,
  )
})

test('a GitButler commit with the setting off names exactly the files the gate kept', async () => {
  // The gate and the request speak about one change set (D2/D4): the records under
  // `openspec/` are counted as left behind, and only the others become the file list.
  const { run, calls } = fakeRunner({
    'git status': ok(
      ' M lib/control.js\0 M openspec/changes/c/tasks.md\0?? docs/a b.md\0',
    ),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    openspec: false,
    cwd: '/repo',
    run,
  })

  // No staging request (D8): the index is not a source of changes for `but`, so the step
  // that used to prepare it is gone and the commit is the only thing that runs.
  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but commit'])
  // A space in a path stays one argument.
  assert.deepEqual(calls[1].args, ['commit', '-b', 'feature-a', '-m', GROUPED, 'lib/control.js', 'docs/a b.md'])
  assert.deepEqual(outcome, {
    kind: COMMIT_END.committed,
    tool: 'gitbutler',
    message: GROUPED,
    branch: 'feature-a',
    excluded: 1,
    output: 'Committed as 1a2b3c4',
  })
})

test('a new branch made by a filtered commit is created once and named by the list', async () => {
  // A plan that does not exist yet is created right before this commit, and the commit
  // that follows carries the file list — the two features meet in one request pair.
  const branch = createButBranch({ name: 'feature-b', anchor: 'feature-a' })
  const { run, calls } = fakeRunner({
    'git status': ok('?? lib/commit.js\0?? openspec/project.md\0'),
    'but branch': ok('Created branch feature-b\n'),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch,
    openspec: false,
    cwd: '/repo',
    run,
  })

  // The branch comes first, the commit last: a branch that cannot be created then fails
  // before anything reads or rewrites a file.
  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but branch', 'but commit'])
  assert.deepEqual(calls[1].args, ['branch', 'new', 'feature-b', '-A', 'feature-a'])
  assert.deepEqual(calls[2].args, ['commit', '-b', 'feature-b', '-m', GROUPED, 'lib/commit.js'])
  assert.equal(outcome.kind, COMMIT_END.committed)
  assert.equal(outcome.excluded, 1)
  assert.equal(branch.exists, true)
})

// --- the file budget of a GitButler commit (task 4.2, design D4) ------------

test('a file list past the budget names no file, and the commit takes openspec/ with it', async () => {
  // The command line has a limit (D4): a list of 201 files is dropped instead of risked,
  // so `but commit` names nothing and commits the whole tree. The changes under
  // `openspec/` therefore go in, and the outcome has to say so — a count of changes left
  // behind would describe a working tree that is not there.
  const paths = changedPaths(COMMIT_FILES_MAX + 1)
  const { run, calls } = fakeRunner({
    'git status': ok(statusOf([...untracked(paths), ' M openspec/changes/c/tasks.md'])),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    openspec: false,
    cwd: '/repo',
    run,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but commit'])
  assert.deepEqual(calls[1].args, ['commit', '-b', 'feature-a', '-m', GROUPED])
  assert.deepEqual(outcome, {
    kind: COMMIT_END.committed,
    tool: 'gitbutler',
    message: GROUPED,
    branch: 'feature-a',
    openspecIncluded: true,
    output: 'Committed as 1a2b3c4',
  })
})

test('a list of exactly the budget still names every file', async () => {
  // The budget is the longest list the tool is given, not one path less: the degradation
  // is the exception, and it must not start while the request still fits.
  const paths = changedPaths(COMMIT_FILES_MAX)
  const { run, calls } = fakeRunner({
    'git status': ok(statusOf([...untracked(paths), ' M openspec/changes/c/tasks.md'])),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    openspec: false,
    cwd: '/repo',
    run,
  })

  // The list at the budget is named path for path in the only request of the commit.
  // `commit -b <branch> -m <msg>` is five elements before the first file.
  assert.equal(calls[1].args.length, COMMIT_FILES_MAX + 5)
  assert.deepEqual(calls[1].args.slice(5), paths)
  assert.equal(outcome.excluded, 1)
  assert.equal('openspecIncluded' in outcome, false)
})

test('a long list is a degradation only when the setting left openspec/ behind', async () => {
  // The flag is about the directory going into the commit, not about the list being long.
  // Nothing under `openspec/` means nothing rode along, and the setting on means the whole
  // tree was the intended change set: neither may be reported as a boundary that broke.
  const paths = changedPaths(COMMIT_FILES_MAX + 1)
  for (const openspec of [false, true]) {
    const { run } = fakeRunner({
      'git status': ok(statusOf(untracked(paths))),
      'but commit': ok('Committed as 1a2b3c4\n'),
    })

    const outcome = await runCommit({
      tool: 'gitbutler',
      text: TEXT,
      range: RANGE,
      branch: { name: 'feature-a', exists: true },
      openspec,
      cwd: '/repo',
      run,
    })

    assert.equal('openspecIncluded' in outcome, false, `openspec: ${String(openspec)}`)
    assert.equal('excluded' in outcome, false)
  }
})

test('a commit that failed after the list was dropped claims nothing it did not do', async () => {
  // The flag describes a commit that exists. A refusal leaves the directory in the working
  // tree like any other change, so the ending is the failure and nothing else — the report
  // must not add that `openspec/` went into a commit that never happened.
  const paths = changedPaths(COMMIT_FILES_MAX + 1)
  const { run } = fakeRunner({
    'git status': ok(statusOf([...untracked(paths), ' M openspec/changes/c/tasks.md'])),
    'but commit': no(1, { stderr: 'no branch is applied\n' }),
  })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    openspec: false,
    cwd: '/repo',
    run,
  })

  assert.equal(outcome.kind, COMMIT_END.failed)
  assert.equal('openspecIncluded' in outcome, false)
  assert.equal('excluded' in outcome, false)
})

// --- the endings of the files a GitButler commit carries (task 5.4, design D8) ---

test('the step that staged the tree is gone, together with its rollback', () => {
  // Task 4.4 staged the committed files before `but commit`; `but` does not read the index
  // as a source of changes, so the step could not help and is replaced by the rewrite of the
  // endings (D8). A leftover builder would be a second way to prepare a commit — and the
  // one the tool ignores.
  assert.equal(commitModule.buildStageCommand, undefined)
  assert.equal(commitModule.buildUnstageCommand, undefined)
})

test('the commit rewrites the endings of its files after the branch and before the commit', async () => {
  // The order is the contract (D8): the tree is checked, the branch is created, the files
  // the commit will carry are rewritten to LF, and only then does `but` compose the commit
  // out of the working copy. A branch that cannot be created must not rewrite a file, so
  // the rewrite waits for it — hence two requests already run when it happens.
  const branch = createButBranch({ name: 'feature-b', anchor: 'feature-a' })
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/control.js\0?? docs/a b.md\0 M openspec/changes/c/tasks.md\0'),
    'but branch': ok('Created branch feature-b\n'),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })
  const { normalizeEol, calls: normalised } = fakeNormalizer({ requests: calls })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch,
    openspec: false,
    cwd: '/repo',
    run,
    normalizeEol,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but branch', 'but commit'])
  assert.equal(normalised.length, 1)
  assert.equal(normalised[0].after, 2)
  // The files the commit names, in the order the gate read them; `openspec/` is not one.
  assert.deepEqual(normalised[0].files, ['lib/control.js', 'docs/a b.md'])
  assert.equal(normalised[0].cwd, '/repo')
  assert.deepEqual(outcome, {
    kind: COMMIT_END.committed,
    tool: 'gitbutler',
    message: GROUPED,
    branch: 'feature-b',
    excluded: 1,
    output: 'Committed as 1a2b3c4',
  })
})

test('with the setting on, every changed file is rewritten, openspec/ included', async () => {
  // The commit takes the whole tree, so the whole tree is what `but` reads the lines from:
  // a change under `openspec/` goes into the history like any other, and a CRLF there would
  // dirty the file exactly the same way (D8).
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/a.js\0 M openspec/changes/c/tasks.md\0?? docs/b.md\0'),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })
  const { normalizeEol, calls: normalised } = fakeNormalizer({ requests: calls })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    cwd: '/repo',
    run,
    normalizeEol,
  })

  assert.deepEqual(normalised[0].files, [
    'lib/a.js',
    'openspec/changes/c/tasks.md',
    'docs/b.md',
  ])
  // Only the status check had run: this commit creates no branch.
  assert.equal(normalised[0].after, 1)
  assert.equal(outcome.kind, COMMIT_END.committed)
})

test('past the budget the rewrite covers the whole change set, because the commit will too', async () => {
  // The request names no file (D4), so `but` takes the whole tree from the working copy and
  // the changes under `openspec/` ride along: they are part of this commit's lines and are
  // rewritten with the rest, even with the setting off.
  const paths = changedPaths(COMMIT_FILES_MAX + 1)
  const { run, calls } = fakeRunner({
    'git status': ok(statusOf([...untracked(paths), ' M openspec/changes/c/tasks.md'])),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })
  const { normalizeEol, calls: normalised } = fakeNormalizer({ requests: calls })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    openspec: false,
    cwd: '/repo',
    run,
    normalizeEol,
  })

  assert.deepEqual(normalised[0].files, [...paths, 'openspec/changes/c/tasks.md'])
  assert.deepEqual(calls[1].args, ['commit', '-b', 'feature-a', '-m', GROUPED])
  assert.equal(outcome.openspecIncluded, true)
})

test('git never rewrites a file: git add -A normalises on its own', async () => {
  // Two requests carry a `git` commit and both are git's own: `add` normalises the endings
  // and `commit` reads the index, so a rewrite here would be work the tool repeats.
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/a.js\0'),
    'git add': ok(),
    'git commit': ok('[main 1a2b3c4] x\n'),
  })

  const outcome = await runCommit({
    tool: 'git',
    text: TEXT,
    range: RANGE,
    cwd: '/repo',
    run,
    normalizeEol: () => {
      throw new Error('a git commit must not rewrite the endings itself')
    },
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'git add', 'git commit'])
  assert.equal(outcome.kind, COMMIT_END.committed)
})

test('an empty tree is not rewritten: there is nothing to commit', async () => {
  const { run, calls } = fakeRunner({ 'git status': ok('') })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    cwd: '/repo',
    run,
    normalizeEol: () => {
      throw new Error('an empty tree has no file to rewrite')
    },
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status'])
  assert.equal(outcome.kind, COMMIT_END.empty)
})

test('a commit that refused after the rewrite keeps the files and touches no index', async () => {
  // The rewrite is content, not staging (D8): it leaves the files in the form the repository
  // stores its blobs, and the index was never touched, so there is nothing to undo. The
  // ending is the refusal of `but commit` and nothing else.
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/control.js\0?? docs/a.md\0'),
    'but commit': no(1, { stderr: 'no branch is applied\n' }),
  })
  const { normalizeEol, calls: normalised } = fakeNormalizer({
    requests: calls,
    mixed: ['lib/control.js'],
  })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    openspec: false,
    cwd: '/repo',
    run,
    normalizeEol,
  })

  assert.equal(normalised.length, 1)
  assert.deepEqual(calls.map((call) => call.name), ['git status', 'but commit'])
  assert.equal(outcome.kind, COMMIT_END.failed)
  assert.equal(outcome.command, 'but commit')
  assert.match(outcome.reason, /no branch is applied/u)
  // A mixed history belongs to the sentence about the lines a commit normalised, and this
  // commit never happened.
  assert.equal('eolMixed' in outcome, false)
})

test('a history that is already mixed is named in the outcome of the commit', async () => {
  // The rewrite heals the lines this group changed and nothing else (D8): a file whose blob
  // was mixed before keeps the old bytes on the lines the group did not touch, and `git
  // status` will keep reporting it. Saying so is the only thing the plugin can do, so it
  // says it.
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/control.js\0 M test/control.test.mjs\0'),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })
  const { normalizeEol } = fakeNormalizer({
    requests: calls,
    mixed: ['lib/control.js', 'test/control.test.mjs'],
  })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    cwd: '/repo',
    run,
    normalizeEol,
  })

  assert.deepEqual(outcome.eolMixed, ['lib/control.js', 'test/control.test.mjs'])
  assert.equal(outcome.kind, COMMIT_END.committed)
})

test('a stop that lands during the rewrite never reaches the commit', async () => {
  // The stop is checked before every request (D17/D8): whatever the rewrite managed to do,
  // a run the user ended must not put anything in the history after it.
  const controller = new AbortController()
  const { run, calls } = fakeRunner({ 'git status': ok(' M lib/control.js\0') })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch: { name: 'feature-a', exists: true },
    openspec: false,
    cwd: '/repo',
    run,
    normalizeEol: async (files) => {
      controller.abort()
      return { rewritten: [...files], mixed: [] }
    },
    signal: controller.signal,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status'])
  assert.equal(outcome.kind, COMMIT_END.stopped)
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

// --- the status check (task 2.1, design D2) --------------------------------

test('the status parser reads the NUL-separated records of `-z`', () => {
  // `-z` prints each path literally: the space in the last one is part of the name,
  // not a quoting artefact, and the entry does not end with a newline.
  assert.deepEqual(parseStatus(' M lib/control.js\0?? lib/commit.js\0A  docs/a b.md\0'), [
    { status: ' M', path: 'lib/control.js' },
    { status: '??', path: 'lib/commit.js' },
    { status: 'A ', path: 'docs/a b.md' },
  ])
})

test('a rename or a copy keeps its original path inside the same record', () => {
  // `R`/`C` occupy two fields — the new path and the path it came from. The second
  // field is not a change of its own, or the old path would be committed again.
  assert.deepEqual(parseStatus('R  lib/new.js\0lib/old.js\0 M lib/other.js\0'), [
    { status: 'R ', path: 'lib/new.js', from: 'lib/old.js' },
    { status: ' M', path: 'lib/other.js' },
  ])
  assert.deepEqual(parseStatus('C  lib/copy.js\0lib/source.js\0'), [
    { status: 'C ', path: 'lib/copy.js', from: 'lib/source.js' },
  ])
})

test('an empty status answer is an empty list of changes', () => {
  assert.deepEqual(parseStatus(''), [])
  // The NUL that terminates the last entry leaves one empty field behind.
  assert.deepEqual(parseStatus('\0'), [])
  // A provider that appended a newline said nothing either.
  assert.deepEqual(parseStatus('\n\n'), [])
  assert.deepEqual(parseStatus(undefined), [])
})

test('the last record is read even when the answer ends without a NUL', () => {
  assert.deepEqual(parseStatus(' M a.js\0?? b.js'), [
    { status: ' M', path: 'a.js' },
    { status: '??', path: 'b.js' },
  ])
  // One record and no terminator at all is still one change.
  assert.deepEqual(parseStatus('?? b.js'), [{ status: '??', path: 'b.js' }])
})

// --- the openspec boundary (task 2.2, design D2) ---------------------------

test('a path under the project openspec directory is excluded', () => {
  assert.equal(isOpenspecPath('openspec/x'), true)
  assert.equal(isOpenspecPath('openspec/changes/c/tasks.md'), true)
  // A directory path is under it too: the predicate is about paths, whatever shape the
  // parser happened to keep.
  assert.equal(isOpenspecPath('openspec/'), true)
})

test('a path that only starts with the same letters is not excluded', () => {
  // The first segment is the rule, not a prefix of the string: all of these live
  // outside the project's `openspec/` and must reach the commit.
  assert.equal(isOpenspecPath('openspec-foo/x'), false)
  assert.equal(isOpenspecPath('src/openspec/x'), false)
  // A file named `openspec` is not the directory, however the name starts.
  assert.equal(isOpenspecPath('openspec'), false)
  assert.equal(isOpenspecPath('openspec.md'), false)
  // A path is what git printed; anything else names nothing.
  assert.equal(isOpenspecPath(undefined), false)
})

test('the filter keeps the changes outside openspec and hands the rest back', () => {
  const { changes, excluded } = filterOpenspec(parseStatus(
    ' M lib/control.js\0?? openspec/changes/c/tasks.md\0A  openspec-foo/x\0?? openspec\0',
  ))
  // Order is preserved on both sides, and a change that only looks like the directory
  // stays with the commit.
  assert.deepEqual(changes.map((change) => change.path), [
    'lib/control.js',
    'openspec-foo/x',
    'openspec',
  ])
  assert.deepEqual(excluded.map((change) => change.path), ['openspec/changes/c/tasks.md'])
})

test('a tree without changes is empty on both sides of the filter', () => {
  assert.deepEqual(filterOpenspec(parseStatus('')), { changes: [], excluded: [] })
})

// --- untracked directories (task 2.3, design D2) ---------------------------

test('the status check asks git to expand an untracked directory into its files', () => {
  // `-uall` is what keeps `?? dir/` out of the answer: the commit names files, and a
  // directory is an argument neither tool resolves (D2, D4).
  assert.deepEqual(STATUS_COMMAND.args, ['status', '--porcelain', '-z', '-uall'])
})

test('a directory entry is not a path the commit names', () => {
  // Should a directory entry reach the parser anyway, it must not become a change: the
  // files it holds are what a commit carries, and `-uall` prints exactly those.
  const changes = parseStatus('?? dir/\0?? dir/a.js\0?? dir/sub/b.js\0')
  assert.deepEqual(changes.map((change) => change.path), ['dir/a.js', 'dir/sub/b.js'])
  assert.equal(changes.every((change) => !change.path.endsWith('/')), true)
})

test('a rename of a directory keeps its pairing even though the entry is dropped', () => {
  // The original path of a `R`/`C` entry is read before the directory test, so dropping
  // the entry cannot make the path it came from look like a change of its own.
  assert.deepEqual(parseStatus('R  dir/\0dir-old\0 M lib/a.js\0'), [
    { status: ' M', path: 'lib/a.js' },
  ])
})

test('a commit through git checks the tree, stages it and commits it', async () => {
  const { run, calls } = fakeRunner({
    'git status': ok(' M lib/control.js\0?? lib/commit.js\0'),
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
    'git status': ok('M lib/commit.js\0'),
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

test('with the setting off, a tree that changed only under openspec/ has nothing to commit', async () => {
  // The gate filters before it counts (design D2/D5): every record belongs to
  // `openspec/`, so the filtered set is empty and the tool is never asked to commit.
  // The count of what stayed behind is the marker that tells this empty tree from a
  // tree that had no changes at all — the report needs it to phrase the skip.
  const { run, calls } = fakeRunner({
    'git status': ok(' M openspec/changes/add-commit-openspec-toggle/tasks.md\0?? openspec/specs/new.md\0'),
  })

  const outcome = await runCommit({
    tool: 'git',
    text: TEXT,
    range: RANGE,
    openspec: false,
    cwd: '/repo',
    run,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status'])
  assert.deepEqual(outcome, {
    kind: COMMIT_END.empty,
    tool: 'git',
    message: GROUPED,
    excluded: 2,
  })
})

test('with the setting off, gitbutler also commits nothing when only openspec/ changed', async () => {
  // The same gate answers for both tools (D2), so the branch is not created and no
  // `but` request is made — the plan is left for a group that has something to commit.
  const branch = { name: 'feature-a', exists: false }
  const { run, calls } = fakeRunner({ 'git status': ok('?? openspec/project.md\0') })

  const outcome = await runCommit({
    tool: 'gitbutler',
    text: TEXT,
    range: RANGE,
    branch,
    openspec: false,
    cwd: '/repo',
    run,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status'])
  assert.deepEqual(outcome, {
    kind: COMMIT_END.empty,
    tool: 'gitbutler',
    message: GROUPED,
    branch: 'feature-a',
    excluded: 1,
  })
  assert.equal(branch.exists, false)
})

// --- the count of what the commit left behind (task 3.3, design D5) --------

test('with the setting off, a commit that went through counts the openspec/ changes it left', async () => {
  // Both sides of the filter have changes, so this is a real commit: the requests carry
  // the pathspec of task 3.1, and the outcome names how many changes under `openspec/`
  // are still uncommitted — the number the report turns into a sentence (D5).
  const { run, calls } = fakeRunner({
    'git status': ok(
      ' M lib/control.js\0 M openspec/changes/c/tasks.md\0?? openspec/specs/new.md\0',
    ),
    'git add': ok(),
    'git commit': ok('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n'),
  })

  const outcome = await runCommit({
    tool: 'git',
    text: TEXT,
    range: RANGE,
    openspec: false,
    cwd: '/repo',
    run,
  })

  assert.deepEqual(calls.map((call) => call.name), ['git status', 'git add', 'git commit'])
  // The boundary the gate counted is the one the tool is asked to commit (D2/D3).
  assert.deepEqual(calls[1].args, ['add', '-A', '--', '.', ':(exclude)openspec'])
  assert.deepEqual(calls[2].args, ['commit', '-m', GROUPED, '--', '.', ':(exclude)openspec'])
  // Two of the three records are under `openspec/`; only the one outside it is committed.
  assert.deepEqual(outcome, {
    kind: COMMIT_END.committed,
    tool: 'git',
    message: GROUPED,
    excluded: 2,
    output: '[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4',
  })
})

test('with the setting on, a commit that went through carries no count at all', async () => {
  // With the setting on the whole tree is the change set, `openspec/` included, so
  // nothing was left behind and the outcome has no `excluded` field to report — the
  // report of task 5.2 keys its extra sentence on exactly that absence.
  const { run } = fakeRunner({
    'git status': ok(' M openspec/changes/c/tasks.md\0?? openspec/specs/new.md\0'),
    'git add': ok(),
    'git commit': ok('[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4\n'),
  })

  const outcome = await runCommit({
    tool: 'git',
    text: TEXT,
    range: RANGE,
    openspec: true,
    cwd: '/repo',
    run,
  })

  assert.equal(Object.hasOwn(outcome, 'excluded'), false)
  assert.deepEqual(outcome, {
    kind: COMMIT_END.committed,
    tool: 'git',
    message: GROUPED,
    output: '[main 1a2b3c4] Добавить эндпоинт. Tasks 2.1 - 2.4',
  })
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
    'git status': ok(' M lib/control.js\0'),
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
    'git status': ok(' M lib/control.js\0'),
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
    'git status': ok(' M lib/commit.js\0'),
    'git add': ok(),
    'git commit': no(1, { stdout: 'error: nothing to commit\n' }),
  })

  const outcome = await runCommit({ tool: 'git', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.equal(outcome.reason, 'error: nothing to commit')
})

test('a silent refusal still says which code it exited with', async () => {
  const { run } = fakeRunner({
    'git status': ok(' M lib/commit.js\0'),
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
    'git status': ok(' M lib/commit.js\0'),
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
    'git status': ok(' M lib/commit.js\0'),
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
    'git status': ok(' M lib/control.js\0'),
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
    'git status': ok(' M lib/control.js\0'),
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
    'git status': ok('M lib/commit.js\0'),
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
    'git status': ok('M lib/commit.js\0'),
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
    'git status': ok('M lib/commit.js\0'),
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
    'git status': ok('M lib/commit.js\0'),
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
    'git status': ok('M lib/commit.js\0'),
    'but commit': ok('Committed as 1a2b3c4\n'),
  })

  const outcome = await runCommit({ tool: 'gitbutler', text: TEXT, range: RANGE, cwd: '/repo', run })

  assert.deepEqual(calls[1].args, ['commit', '-m', GROUPED])
  // No branch was named, so the report has none to name either.
  assert.equal('branch' in outcome, false)
})
