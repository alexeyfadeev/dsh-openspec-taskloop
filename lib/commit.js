// dsh-openspec-taskloop — the commit that closes a task group (task 4.1).
//
// Design D15: the commit is the plugin's business, not the model's. The run knows
// which tasks it just finished and that the tree has to end up in the history, so
// it calls the configured tool itself. Letting the agent commit would make the one
// step that is easy to verify by machine — "the changes of this group are in the
// history" — depend on the model remembering to do it.
//
//     git status --porcelain -z -uall ──▶ no records ───────────▶ { kind: 'empty' }
//              │
//              ├─ setting off (D5): the records under openspec/ leave the set, and
//              │     └─ nothing left ─────────────────────────────▶ { kind: 'empty', excluded: n }
//              └─ changes ──▶ git add -A ──▶ git commit -m <msg> ──▶ { kind: 'committed' }
//                             or  but [branch new <name> [-A <anchor>]] ──▶
//                                 [rewrite <file>… to LF] (D8) ──▶
//                                 but commit [-b <name>] -m <msg> [<file>…]
//                                     │
//                                     └─ more than 200 files (D4): no <file>…, the whole
//                                        tree goes in ──▶ { kind: 'committed', openspecIncluded }
//
// Three properties shape the contract:
//
//   - Every argument is one argv element. There is no shell between the plugin and
//     the tool, so the commit message needs no escaping: quotes, spaces and line
//     breaks inside it stay a single argument, and a message the user typed can
//     never turn into a second command. The runner that resolves the executable and
//     spawns the process lives in `lib/environment.js` (task 4.2); this module only
//     builds the requests, which is why it is testable without a host.
//   - An exit code is data. A nonzero one does not throw: the command that failed,
//     its code and the tail of its stderr travel back in the outcome, so the run can
//     stop with a report that names the tool and the reason (design D17). Only a
//     request that cannot be made at all — a missing tool, a bad range — is an error.
//   - A stop is not a failure. A `/taskloop stop` that lands before or during the
//     commands ends the commit as `stopped`, and the run reports a stop rather than
//     an error the user did not cause. A commit that already went through stays
//     `committed` even when the stop lands while it finishes.
//
// The message is the user's text with the range of the group appended — `Добавить
// эндпоинт. Tasks 2.1 - 2.4` — because the text says what the work is for and the
// range says which part of it this commit is. A flat run has no task numbers to
// name (design D13), so its commit is the text alone; inventing a range for it
// would claim a structure the task list does not have.
//
// The tree is committed whole by default (`git add -A`, design D15): untracked files,
// a leftover edit of the user's, everything. That is the accepted trade-off — the
// alternative, snapshotting the tree at startup, is a much larger machine — and it is
// why an empty tree is not an error: the user may have committed by hand, and the run
// says so instead of committing an empty change set. With `commit.openspec` off, the same
// answer is filtered first (design D2, D5): the changes outside `openspec/` are what the
// gate counts, what the `git` requests commit (design D3) and which files a GitButler
// commit names (design D4), and the ones under it stay in the working tree. A tree that
// changed only under `openspec/` is therefore still `empty` — the setting adds no new
// ending — but its outcome counts what was left behind, so the report can say "nothing
// outside openspec/" instead of "nothing at all".
//
// The file list has a budget (design D4): past `COMMIT_FILES_MAX` paths the request would
// risk the operating system's command-line limit, so a GitButler commit names no file and
// takes the whole tree — `openspec/` included. That is a degradation, not a fallback kept
// quiet: the outcome carries `openspecIncluded`, and the report says the directory went
// into this commit instead of staying behind. Nothing is counted as excluded then,
// because nothing was.
//
// A GitButler commit that names its files first rewrites their endings to LF (task 5.4,
// design D8). `but` composes the new blob out of the old one and the changed regions of
// the working copy, and it does not tell CRLF from LF: a file whose blob ends its lines
// with LF while the working copy uses CRLF would arrive mixed — the untouched lines keep
// the old ending, the changed ones get the new one — and `git status` would keep reporting
// it as modified after the commit. `lib/eol.js` rewrites exactly the files this commit
// carries, right before `but` reads them, and the step lives behind a dependency so this
// module stays free of a file system. It names the files `but commit` names, and every
// change of the gate when the request names none (the setting is on, or the list was
// dropped past the budget) — because then `but` takes the whole tree from the working copy.
// A file stored in CRLF is left alone and a file whose history is already mixed stays
// mixed; the outcome says which ones, so the report can warn instead of promising a clean
// tree. Nothing is staged: the index is not a source of changes for `but`, and it is left
// as the user had it.
//
// A GitButler commit also names its branch (design D18): `but commit` is unambiguous
// only while the project has one applied branch, so the branch the user picked at the
// start of the run travels with every commit of it. A branch that does not exist yet is
// created by the first commit that has something to commit — `but branch new <name>
// [-A <anchor>]` right after the status check — and not before: an empty tree would
// otherwise leave a branch behind that no commit ever lands in. The plan of the run is
// a small mutable object ({@link createButBranch}) rather than a config value, because
// it exists for one run only and D18 keeps it out of any storage.
//
// For `git` the plan is not used at all: a run whose tool was switched to `gitbutler`
// mid-run may carry one, and `git` has no branches to choose, so the plan neither
// changes the requests nor appears in the outcome.

import { normalizeEol as normalizeEolOnDisk } from './eol.js'
import { aborted } from './wait.js'

/**
 * Values of {@link CommitOutcome.kind}; callers switch on them.
 */
export const COMMIT_END = Object.freeze({
  /** The tool committed the tree; `output` is what it printed. */
  committed: 'committed',
  /** The tree had no changes; the tool was not asked to commit anything. */
  empty: 'empty',
  /** The tool ran and refused, or could not be run; `command` and `reason` say why. */
  failed: 'failed',
  /** The run was stopped before the commit went through; the next task must not start. */
  stopped: 'stopped',
})

/**
 * The read-only check that decides whether there is anything to commit (design D15).
 *
 * `-z` is the machine format {@link parseStatus} reads (design D2): NUL-separated
 * entries with the paths printed literally, so one request answers both "is there
 * anything" and "which files" — the gate and the commit cannot disagree about the
 * change set.
 *
 * `-uall` expands an untracked directory into the files inside it. Without the flag
 * git names the directory once, as `?? dir/`, and that entry is not something a commit
 * can carry: a GitButler commit takes files, so the group would end in a failure over
 * an argument the tool cannot resolve (D2, D4). The flag is what keeps a directory out
 * of the list; {@link parseStatus} refuses one as well, so a `-z` reader that somehow
 * received a folder still cannot hand it to the tool.
 */
export const STATUS_COMMAND = Object.freeze({
  executable: 'git',
  args: Object.freeze(['status', '--porcelain', '-z', '-uall']),
})

/** Longest stderr tail kept in a failure reason, in characters. */
const REASON_MAX_CHARS = 2_000

/**
 * Longest file list a GitButler commit names, in paths (design D4).
 *
 * `but commit` takes its files as argv, and the command line of an operating system is
 * finite — some 32 thousand characters on Windows. A group that touched hundreds of files
 * would exceed it after its work is already done, and the group would end in a failure the
 * user cannot prevent. The budget is far below that limit for a list of ordinary paths and
 * still far above any group of a normal change; beyond it the commit degrades visibly
 * instead (see {@link CommitOutcome.openspecIncluded}).
 *
 * A budget, not a rule about what may be committed: `git` has a pathspec and no length
 * problem, and a GitButler commit with the setting on names no file at all, so neither
 * path reads this number.
 */
export const COMMIT_FILES_MAX = 200

/**
 * How one commit ended.
 *
 * `tool` is the configured tool (`git` or `gitbutler`), not the executable that
 * failed — a report says "the commit through git" and the user can then check the
 * setting. `message` is the message the commit would have had, so a failure can be
 * retried by hand without composing it again.
 *
 * On a failure, `command` names the request that failed (`git status`, `git add`,
 * `git commit`, `but branch`, `but commit`) and `reason` carries the tail of its
 * stderr, the message it printed to stdout when stderr was empty, or a sentence about
 * the exit code when it printed nothing at all. `exitCode` is absent only when the tool
 * could not be run — an executable that is not on PATH has no code to report.
 *
 * `branch` is the GitButler branch the commit went into, and is absent whenever the
 * tool is `git` or the run selected no branch (D18). A report names it so the user
 * knows where the history moved without opening GitButler.
 *
 * `excluded` is how many changes under `openspec/` this commit left in the working
 * tree (D5), and is absent whenever the setting was on or dropped nothing. On an
 * `empty` outcome it is the marker that separates "nothing outside `openspec/`" from
 * "nothing at all"; on a `committed` one it is the number the report says is still
 * uncommitted, so a run that keeps the directory out of the history does not do so
 * silently.
 *
 * `openspecIncluded` is the opposite marker and the one case where the setting could not
 * be honoured: the file list was past {@link COMMIT_FILES_MAX}, so `but commit` named no
 * file and carried the changes under `openspec/` along with the rest (D4). It says only
 * that the directory went into this commit; the count is not repeated, because nothing
 * was left behind to count. The two markers never appear together — a commit either left
 * the directory in the tree or took it — which is what lets a report say one sentence or
 * the other, never both.
 *
 * `eolMixed` names the files this commit rewrote to LF but could not heal (D8): their
 * history already mixes CRLF and LF, the unchanged lines keep the bytes of the old blob,
 * and `git status` will keep reporting them as modified. The list is absent when nothing
 * was left half-done, so a report warns only where there is something to warn about, and
 * it is carried by a commit that went through only — the sentence speaks about a commit
 * that normalised the lines it changed.
 *
 * @typedef {object} CommitOutcome
 * @property {'committed'|'empty'|'failed'|'stopped'} kind - how the commit ended.
 * @property {'git'|'gitbutler'} tool - tool the configuration selected.
 * @property {string} message - message the commit carries (or would have carried).
 * @property {string} [branch] - GitButler branch of the commit, when one was named.
 * @property {number} [excluded] - changes under `openspec/` the commit left behind;
 *   present only when the setting was off and there were any.
 * @property {boolean} [openspecIncluded] - `true` when the commit carried the changes
 *   under `openspec/` despite the setting being off, because the file list was past the
 *   budget (D4); absent in every other ending.
 * @property {string[]} [eolMixed] - files whose endings this commit normalised while their
 *   history stays mixed (D8); absent when every rewritten file was healed.
 * @property {string} [output] - what the tool printed when it committed; the commit
 *   id is the part of it a report quotes.
 * @property {string} [command] - request that failed, e.g. `git commit`.
 * @property {number|null} [exitCode] - exit code of that request, `null` when a
 *   signal killed it; absent when it could not run.
 * @property {string} [reason] - why it failed: stderr tail, stdout tail or the code.
 */

/**
 * One GitButler branch plan of one run: where its commits go, and whether the branch
 * still has to be created (design D18).
 *
 * The plan is a mutable object on purpose. `exists: false` means the branch does not
 * exist yet, so the first commit that has something to commit is preceded by
 * `but branch new <name> [-A <anchor>]`; {@link runCommit} flips it to `true` once that
 * request succeeded, which is what makes the creation lazy and one-off across the
 * groups of the run. An empty tree leaves it `false`, and so does a run that never
 * reaches a commit: no branch is created that no commit lands in.
 *
 * The plan lives in memory for one run and is never stored (D18): a branch topology
 * changes faster than a sentence about the work, and a name remembered from an earlier
 * run is a new class of failure this plugin could neither predict nor repair.
 *
 * @param {object} options
 * @param {string} options.name - branch the commits go into; the name `but branch new`
 *   creates when the branch does not exist yet.
 * @param {string} [options.anchor] - applied branch to stack a new branch on; absent
 *   when the project has no applied branch, where the first branch cannot be stacked.
 * @param {boolean} [options.exists] - whether the branch already exists. `true` for a
 *   branch the user selected from the listing, `false` (the default) for a new name.
 * @returns {{name: string, anchor?: string, exists: boolean}} the plan.
 * @throws {TypeError} when the name is empty, or an anchor is given but is empty.
 */
export function createButBranch({ name, anchor, exists = false } = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('createButBranch requires a non-empty branch name')
  }
  if (anchor !== undefined && (typeof anchor !== 'string' || anchor.trim() === '')) {
    throw new TypeError('createButBranch requires a non-empty anchor when one is given')
  }
  const plan = { name: name.trim(), exists: exists === true }
  if (anchor !== undefined) plan.anchor = anchor.trim()
  return plan
}

/**
 * The message a commit carries: the user's text plus the range of the group.
 *
 * Surrounding whitespace is dropped because the text is stored between runs and a
 * trailing newline would otherwise end up before the appended range. Inner line
 * breaks are kept: the message is a single argv element, so a multi-line body is
 * one argument the way a one-line message is.
 *
 * The range is added as a new sentence, and the sentence break is not doubled when
 * the user's text already ends with one: `Добавить эндпоинт` becomes
 * `Добавить эндпоинт. Tasks 2.1 - 2.4`, while a text typed as
 * `Change add-fallback-status-badge.` becomes `Change add-fallback-status-badge.
 * Tasks 2.1 - 2.7` — the same words the user wrote, with no `..` the tool would
 * carry into the history. A text that ends with `!` or `?` is a finished sentence
 * too, so it gets the same treatment.
 *
 * @param {object} options
 * @param {string} options.text - message text the user typed for this change (5.2).
 * @param {{from: string, to: string}} [options.range] - first and last task of the
 *   group, as written in `tasks.md`; absent for a flat run, whose commit carries the
 *   text alone.
 * @returns {string} the commit message.
 * @throws {TypeError} when the text is empty, or a range is given but is not a pair
 *   of non-empty labels.
 */
export function buildCommitMessage({ text, range }) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') {
    throw new TypeError('buildCommitMessage requires a non-empty message text')
  }
  if (range === undefined) return body
  if (typeof range?.from !== 'string' || range.from === '') {
    throw new TypeError('buildCommitMessage requires range.from when a range is given')
  }
  if (typeof range?.to !== 'string' || range.to === '') {
    throw new TypeError('buildCommitMessage requires range.to when a range is given')
  }
  // A sentence the user already ended stays one sentence: the range is appended as
  // a separate sentence rather than as a second full stop.
  const separator = /[.!?]$/u.test(body) ? ' ' : '. '
  return `${body}${separator}Tasks ${range.from} - ${range.to}`
}

/**
 * The commit id a tool printed, when its output names one.
 *
 * `git commit` answers with `[<branch> <hash>] <subject>` (and `[<branch>
 * (root-commit) <hash>] …` for the first commit of a repository), while `but
 * commit` prints `Committed as <hash>`. The id is taken from those two shapes only:
 * an arbitrary hex-looking word elsewhere in the output — a branch name, a path, a
 * word of the subject — must never be reported as the commit.
 *
 * @param {unknown} output - what the commit tool printed.
 * @returns {string|undefined} the abbreviated id, or `undefined` when the output
 *   names none.
 */
export function commitIdOf(output) {
  if (typeof output !== 'string') return undefined
  // The hash is the last token inside the brackets; a greedy prefix keeps a branch
  // name that happens to look hexadecimal from winning.
  const bracketed = /\[[^\]\n]*\b([0-9a-f]{7,40})\]/u.exec(output)
  if (bracketed !== null) return bracketed[1]
  const committed = /\bCommitted as\s+([0-9a-f]{7,40})\b/u.exec(output)
  if (committed !== null) return committed[1]
  return undefined
}

/**
 * The requests that perform one commit, in order, with the message already in place.
 *
 * `git` needs the tree staged first, so it takes two requests; GitButler's `but`
 * commits on its own and takes one. The message is the last element of the argv
 * rather than something interpolated into a command line: the tool receives it
 * byte for byte, whatever punctuation it holds.
 *
 * A GitButler plan that does not exist yet adds one request in front of the commit:
 * `but branch new <name> [-A <anchor>]` (design D18). The anchor is left out when the
 * plan has none — a project without applied branches, whose first branch cannot be
 * stacked — and the argument order is the one the tool documents, with the branch of
 * `but branch new` also being the branch of `but commit`. For `git` the plan is not
 * read at all: the tool has no branch to choose, and a plan that lingers after a switch
 * to `git` must not change a single argument.
 *
 * With `commit.openspec` off, `git` gets the same pathspec exclusion in both requests
 * (design D3): `git add -A -- . ':(exclude)openspec'` keeps the directory out of the
 * index, and `git commit -m <msg> -- . ':(exclude)openspec'` restricts the index the
 * commit takes. The second pathspec is what decides the commit: `git commit` commits
 * the index whole, so without it a change the user had staged under `openspec/` would
 * still ride along. With the setting on, no pathspec is added and the argv stays what
 * it was before the setting existed.
 *
 * GitButler has no exclusion flag, so the same boundary is expressed the other way round
 * (design D4): with the setting off, the files outside `openspec/` are named positionally
 * after the message — `but commit -b <branch> -m <msg> <file>…` — and `but` commits
 * exactly those. The list is the gate's own answer, in the order it read it, so the
 * commit cannot disagree with the check that decided there was one. With the setting on
 * the list is not read at all and the argv keeps its pre-setting shape.
 *
 * The budget of that list is the caller's decision, not this function's: past
 * {@link COMMIT_FILES_MAX} paths the caller hands over an empty list, and the request
 * names nothing. Measuring it here instead would hide the degradation inside a request,
 * where the commit outcome could no longer say that `openspec/` went in after all (D4).
 *
 * @param {object} options
 * @param {'git'|'gitbutler'} options.tool - configured commit tool (design D12).
 * @param {string} options.message - commit message, as {@link buildCommitMessage} built it.
 * @param {{name: string, anchor?: string, exists: boolean}} [options.branch] - GitButler
 *   branch plan of the run (D18); ignored by `git`.
 * @param {boolean} [options.openspec] - `commit.openspec` of the configuration (D1): when
 *   `false`, the `git` requests exclude the project's `openspec/`. Defaults to `true`,
 *   the whole tree, because that is what a profile without the setting gets.
 * @param {readonly string[]} [options.files] - changes outside `openspec/`, as the gate
 *   read them (D4): the files a GitButler commit names, in order. Read only when the
 *   tool is `gitbutler` and the setting is off; `git` has a pathspec instead and the
 *   setting on commits the whole tree. An empty list names no file at all, which is the
 *   request a caller makes only when it has dropped the list on purpose (D4 budget).
 * @returns {{executable: string, args: readonly string[]}[]} the requests, in order.
 * @throws {TypeError} when the tool is unknown, the message is empty, the plan is not a
 *   branch this module can turn into a request, or the file list is not a list of paths.
 */
export function buildCommitCommands({ tool, message, branch, openspec = true, files }) {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new TypeError('buildCommitCommands requires a non-empty commit message')
  }
  switch (tool) {
    case 'git': {
      // The pathspec is repeated in both requests on purpose (design D3): `add` keeps
      // `openspec/` out of the index, `commit` refuses to commit an entry a user staged
      // there themselves. An empty array is the whole tree, byte for byte as before.
      const pathspec = openspec === false ? ['--', '.', ':(exclude)openspec'] : []
      return [
        Object.freeze({ executable: 'git', args: Object.freeze(['add', '-A', ...pathspec]) }),
        Object.freeze({
          executable: 'git',
          args: Object.freeze(['commit', '-m', message, ...pathspec]),
        }),
      ]
    }
    case 'gitbutler': {
      const planned = branch === undefined ? undefined : checkedBranch(branch)
      // Positional `CHANGES` are the only exclusion `but commit` has (D4): with the
      // setting off the request names the files the commit carries, and with it on there
      // are none to name. The message stays before them, as the tool documents.
      const named = openspec === false ? checkedFiles(files) : []
      const requests = []
      if (planned !== undefined && planned.exists !== true) requests.push(branchNewCommand(planned))
      requests.push(Object.freeze({
        executable: 'but',
        args: Object.freeze([
          'commit',
          ...(planned === undefined ? [] : ['-b', planned.name]),
          '-m',
          message,
          ...named,
        ]),
      }))
      return requests
    }
    default:
      // The schema rejects this before a run starts; the check is repeated here
      // because a caller that bypasses the loader must not reach a silent no-op.
      throw new TypeError(`buildCommitCommands got an unknown commit tool: ${String(tool)}`)
  }
}

/**
 * `but branch new <name> [-A <anchor>]` — the request that creates a branch (D18).
 *
 * It runs right before the first commit that has something in it, never at the start
 * of the run: a branch created for a change set that turns out empty would be left
 * behind with no commit in it.
 *
 * @param {{name: string, anchor?: string}} branch - checked branch plan.
 * @returns {{executable: string, args: readonly string[]}} the request.
 */
function branchNewCommand(branch) {
  const args = ['branch', 'new', branch.name]
  if (branch.anchor !== undefined) args.push('-A', branch.anchor)
  return Object.freeze({ executable: 'but', args: Object.freeze(args) })
}

/**
 * Validate a branch plan and hand it back in the shape this module reads.
 *
 * The check exists because a plan is built from an answer a user typed: an empty name
 * or an empty anchor would otherwise reach `but` as an argument that cannot name
 * anything, and the failure would surface as a commit error after a finished group
 * instead of as a caller's bug before it.
 *
 * @param {unknown} branch - candidate plan.
 * @returns {{name: string, anchor?: string, exists: boolean}} the plan.
 * @throws {TypeError} when the plan cannot name a branch.
 */
function checkedBranch(branch) {
  if (typeof branch !== 'object' || branch === null) {
    throw new TypeError('buildCommitCommands requires a branch plan object when one is given')
  }
  if (typeof branch.name !== 'string' || branch.name.trim() === '') {
    throw new TypeError('buildCommitCommands requires a non-empty branch name')
  }
  if (branch.anchor !== undefined && (typeof branch.anchor !== 'string' || branch.anchor.trim() === '')) {
    throw new TypeError('buildCommitCommands requires a non-empty anchor when one is given')
  }
  return {
    name: branch.name.trim(),
    ...(branch.anchor === undefined ? {} : { anchor: branch.anchor.trim() }),
    exists: branch.exists === true,
  }
}

/**
 * Validate the file list a GitButler commit names and hand it back as argv elements.
 *
 * A path is passed through as it was read — no trimming, no separator rewriting: it is a
 * name git printed, and it has to reach `but` as the same bytes. What is checked is only
 * that the caller passed a list of non-empty strings; an empty string would otherwise
 * become an argument that names nothing and turn a finished group into a failed commit.
 *
 * @param {unknown} files - paths outside `openspec/`, as the gate read them.
 * @returns {readonly string[]} the paths, in the order the gate printed them.
 * @throws {TypeError} when the list is not an array, or holds something else than a
 *   non-empty path.
 */
function checkedFiles(files) {
  if (files === undefined) return []
  if (!Array.isArray(files)) {
    throw new TypeError('buildCommitCommands requires an array of file paths when one is given')
  }
  for (const file of files) {
    if (typeof file !== 'string' || file === '') {
      throw new TypeError('buildCommitCommands requires a non-empty path for every file it names')
    }
  }
  return files
}

/**
 * The changes `git status --porcelain -z` reported, one record per change.
 *
 * The gate used to be a question about the answer's emptiness. It has to know the
 * paths now: with `commit.openspec` off, the same answer decides whether there is
 * anything to commit *and* which files the commit names (design D2), and asking twice
 * would let the gate and the tool disagree.
 *
 * `-z` is what makes the answer readable by machine. Entries are separated by NUL
 * instead of a newline, and a path is printed as itself — a name with a space, a quote
 * or a non-ASCII character arrives unchanged instead of quoted and backslash-escaped.
 *
 * An entry is two status characters, one space and the path (` M lib/a.js`,
 * `?? lib/b.js`). A rename or a copy is the only entry that takes two fields: the new
 * path first, then the original one, with no `->` between them. The second field
 * belongs to the change it follows, so it is read and skipped — read as a change of its
 * own, the old path would be committed under a name that no longer exists.
 *
 * Git terminates every entry with a NUL, which leaves one empty field at the end. The
 * last field is read whether or not that NUL survived, because a caller that trimmed
 * the answer must not lose the change it ends with.
 *
 * A path that ends at a separator names a directory, not a change, and is left out. The
 * status request asks git for `-uall`, so untracked files arrive one by one and a real
 * answer never holds such an entry; the refusal is here because the alternative is worse
 * than useless — a directory handed to a commit is a request the tool cannot resolve,
 * and it would fail the group after its work was already done (D2, D4).
 *
 * @param {unknown} stdout - what `git status --porcelain -z -uall` printed.
 * @returns {{status: string, path: string, from?: string}[]} one record per change, in
 *   the order git printed them; empty when the tree has nothing to commit.
 */
export function parseStatus(stdout) {
  if (typeof stdout !== 'string') return []
  const fields = stdout.split('\0')
  const changes = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    // The empty answer, the trailing NUL and a newline some provider appended are
    // fields, not changes; `XY<space><path>` is the shortest shape that names one.
    if (field.trim() === '' || field.length < 4) continue
    const status = field.slice(0, 2)
    const change = { status, path: field.slice(3) }
    // `R`/`C` in the index column: the next field is the path this one came from. It is
    // consumed before the directory test below, so the pairing stays right either way.
    if (/^[RC]/u.test(status)) {
      const from = fields[index + 1]
      if (from !== undefined && from !== '') {
        change.from = from
        index += 1
      }
    }
    if (change.path.endsWith('/')) continue
    changes.push(change)
  }
  return changes
}

/**
 * Whether a path from `git status` lives under the `openspec/` directory of the
 * project root (design D2).
 *
 * The rule is the first path segment, not a prefix of the string. `openspec/x` and
 * `openspec/changes/<change>/tasks.md` are the directory's own files; `openspec-foo/x`
 * and `src/openspec/x` are not under it, and a file named `openspec` — a name that
 * merely starts with the same letters — is not the directory either. A prefix test
 * would exclude all three of the latter, and a file the user meant to commit would
 * silently stay out.
 *
 * @param {unknown} path - path as `-z` printed it, relative to the project root.
 * @returns {boolean} whether the path is inside the project's `openspec/`.
 */
export function isOpenspecPath(path) {
  if (typeof path !== 'string') return false
  // The segment has to end at a separator: `openspec` alone is a file, not a directory.
  const separator = path.indexOf('/')
  return separator > 0 && path.slice(0, separator) === 'openspec'
}

/**
 * Split the changes of `git status` into what a commit carries and what it leaves in
 * the working tree (design D2, D5).
 *
 * With `commit.openspec` on, the whole answer is committed. With it off, the changes
 * under `openspec/` are the ones the commit must not include, and the rest is what the
 * gate counts and what a GitButler commit names (D4). Both halves come back from one
 * pass over one list, so the gate, the file list and the report speak about the same
 * change set: the excluded half is what the report says is still uncommitted.
 *
 * @param {{status: string, path: string, from?: string}[]} changes - records of
 *   {@link parseStatus}, in the order git printed them.
 * @returns {{changes: {status: string, path: string, from?: string}[], excluded: {status: string, path: string, from?: string}[]}}
 *   the changes outside `openspec/` and the ones under it, both in the original order.
 */
export function filterOpenspec(changes) {
  const kept = []
  const excluded = []
  for (const change of changes) {
    if (isOpenspecPath(change.path)) excluded.push(change)
    else kept.push(change)
  }
  return { changes: kept, excluded }
}

/**
 * Commit the tree of one finished group through the configured tool.
 *
 * The status check comes first because "nothing to commit" is a normal answer, not
 * a failure: `git add -A` on an empty tree would succeed and `git commit` would
 * fail on it, turning the user's own commit — or a group whose changes were already
 * in the history — into an error. A tree that does have changes is committed whole.
 *
 * With `commit.openspec` off, the same answer is filtered before it is counted (D2,
 * D5): the changes outside `openspec/` are what the tool is asked to commit, and the
 * ones under it are counted into `excluded` and left in the working tree. A filtered
 * set that turns out empty is the ordinary `empty` ending — no request is made — with
 * that count as the marker of *why* there was nothing to commit.
 *
 * A filtered GitButler commit names the kept files, up to {@link COMMIT_FILES_MAX} of
 * them (D4). Past the budget the list is dropped: the request names no file, the commit
 * takes the whole tree — the changes under `openspec/` ride along — and the outcome says
 * `openspecIncluded`, so the report can admit it instead of pretending the boundary held.
 *
 * A GitButler commit rewrites the endings of the files it carries before `but` reads them
 * (task 5.4, D8). The step is `lib/eol.js`, handed in as `normalizeEol` with the real
 * implementation as the default: it runs between the branch creation and `but commit`,
 * rewrites to LF the files whose blob is stored that way, and leaves alone a file stored in
 * CRLF, a binary, a symlink and a path that is gone. The files are the ones the request
 * names, and every change of the gate when the request names none — with the setting on or
 * past the budget `but commit` takes the whole tree from the working copy, so the whole
 * change set is what it will carry. A history that is already mixed stays mixed, and the
 * outcome names those files (`eolMixed`) instead of promising a clean tree. Nothing is
 * staged: `but` does not read the index as a source of changes, so the plugin no longer
 * touches it at all and a commit that did not happen leaves it exactly as the user had it.
 *
 * A stop is honoured before each request and after every request but the last: a
 * stop that lands while the files are being rewritten must not be followed by a commit,
 * while one that lands while the commit itself runs has already committed, and the
 * outcome says so.
 *
 * @param {object} options
 * @param {'git'|'gitbutler'} options.tool - configured commit tool, read at the
 *   moment of the commit so a change in Settings applies to the next group (D12).
 * @param {string} options.text - message text the user entered for this change.
 * @param {{from: string, to: string}} [options.range] - group the commit closes;
 *   absent for a flat run.
 * @param {{name: string, anchor?: string, exists: boolean}} [options.branch] - GitButler
 *   branch plan of the run (D18). A plan that does not exist yet is created right before
 *   the commit, and this function flips its `exists` to `true` once that request
 *   succeeded, so the plan is mutated on purpose and must be mutable. Ignored by `git`.
 * @param {boolean} [options.openspec] - `commit.openspec` of the configuration (D1),
 *   read at the moment of the commit like the tool: when `false`, the changes under
 *   `openspec/` are not counted by the gate and stay in the working tree — unless the
 *   GitButler list is past the budget, where they ride along and the outcome says so.
 *   Defaults to `true`, the whole tree.
 * @param {string} options.cwd - project directory the tool runs in.
 * @param {(request: {executable: string, args: readonly string[]}, options: {cwd: string, signal?: AbortSignal}) => Promise<{exitCode: number|null, stdout: string, stderr: string}>} options.run -
 *   executes one request without a shell. A request that cannot run at all must
 *   reject; an exit code comes back in the result (task 4.2).
 * @param {(files: readonly string[], options: {cwd: string, run: Function, signal?: AbortSignal}) => Promise<{rewritten: string[], mixed: string[]}>} [options.normalizeEol] -
 *   the step that rewrites the endings of the committed files to LF (task 5.4, D8);
 *   defaults to the real one from `lib/eol.js`. Injected for the same reason as `run`:
 *   the commit is pinned without a file system.
 * @param {AbortSignal} [options.signal] - cancellation of the whole run.
 * @returns {Promise<CommitOutcome>} how the commit ended and what it carried.
 * @throws {TypeError} when the runner is missing, or the text, the range, the plan or
 *   the tool cannot be turned into a request.
 */
export async function runCommit({
  tool, text, range, branch, openspec = true, cwd, run, normalizeEol = normalizeEolOnDisk, signal,
}) {
  if (typeof run !== 'function') {
    throw new TypeError('runCommit requires a run() that executes one commit request')
  }
  // Composed before anything runs: a message that cannot be built is a caller's bug,
  // and files half-rewritten by a commit that never had a message would be left that way.
  const message = buildCommitMessage({ text, range })
  /** Branch a report names, or `undefined` when this commit went into none. */
  const branchName = tool === 'gitbutler' && branch !== undefined ? branch.name.trim() : undefined
  // Set once the gate has read the tree (D5). `0` until then, so an ending that never
  // reached the gate — a stop, a status that failed — carries no count it cannot know.
  let excluded = 0
  // Set by the same answer, when the list was too long to name (D4). `false` until then,
  // so no ending claims the directory went into a commit the gate never decided.
  let openspecIncluded = false
  // Set by the rewrite of the committed files (D8). Empty until then, so an ending that
  // never reached that step claims nothing about a history it did not see.
  let eolMixed = []

  /** Fields every ending of this commit carries. */
  const outcome = (kind) => ({
    kind,
    tool,
    message,
    ...(branchName === undefined ? {} : { branch: branchName }),
    ...(excluded === 0 ? {} : { excluded }),
  })
  const stopped = () => outcome(COMMIT_END.stopped)
  /**
   * The outcome of a commit that went through, with the facts only it can carry.
   *
   * `openspecIncluded` belongs here and not to the shared fields (D4): a request that
   * failed or a stop leaves the directory in the working tree like every other change, so
   * the flag on such an ending would be a claim about a commit that never happened. The
   * same holds for `eolMixed` (D8): the sentence it earns speaks about the lines a commit
   * normalised, and there is no such commit when the step ended otherwise.
   *
   * @param {string} [output] - what the tool printed, when it said anything.
   * @returns {CommitOutcome} the committed outcome.
   */
  const committed = (output) => ({
    ...outcome(COMMIT_END.committed),
    ...(openspecIncluded ? { openspecIncluded: true } : {}),
    ...(eolMixed.length === 0 ? {} : { eolMixed: [...eolMixed] }),
    ...(output === undefined ? {} : { output }),
  })
  /**
   * @param {string} command - request that failed.
   * @param {number|null} [exitCode] - its exit code, when it ran.
   * @param {string} [reason] - its account of the failure.
   * @returns {CommitOutcome} the failed outcome.
   */
  const failed = (command, exitCode, reason) => {
    const result = { ...outcome(COMMIT_END.failed), command }
    if (exitCode !== undefined) result.exitCode = exitCode
    if (reason !== undefined) result.reason = reason
    return result
  }

  if (aborted(signal)) return stopped()

  const status = await attempt(run, STATUS_COMMAND, cwd, signal)
  if (aborted(signal)) return stopped()
  if (status.error !== undefined) {
    return failed(commandName(STATUS_COMMAND), undefined, describe(status.error))
  }
  if (status.result.exitCode !== 0) {
    return failed(commandName(STATUS_COMMAND), status.result.exitCode, reasonOf(status.result))
  }
  // One pass over one answer decides both questions (D2): what the tool is asked to
  // commit, and how much stays in the tree. With the setting on the filter is not
  // applied at all, so the change set is exactly what git reported.
  const reported = parseStatus(status.result.stdout)
  const gate = openspec === false ? filterOpenspec(reported) : { changes: reported, excluded: [] }
  // A `but commit` names its files as argv, and a command line has a limit (D4): past the
  // budget the list is dropped rather than risked. The request then names nothing and the
  // commit takes the whole tree, so the changes under `openspec/` go in with the rest —
  // the one case where `excluded` has to stay empty, because nothing was left behind, and
  // where the outcome admits the directory went into the commit instead (design D4, D5).
  const overBudget =
    openspec === false && tool === 'gitbutler' && gate.changes.length > COMMIT_FILES_MAX
  excluded = overBudget ? 0 : gate.excluded.length
  openspecIncluded = overBudget && gate.excluded.length > 0
  // The requests are built from the gate's answer, not before it: a GitButler commit
  // names the files outside `openspec/` itself (D4), and that list is what the gate just
  // read. Nothing has touched the tree yet — the status check only reads it — so a tool
  // or a plan that cannot become a request still fails before the first request that
  // would change anything, and before the branch of a new run is created.
  const files = overBudget ? [] : gate.changes.map((change) => change.path)
  const commands = buildCommitCommands({ tool, message, branch, openspec, files })
  // The files whose endings this commit rewrites to LF (task 5.4, D8). It is the list the
  // request names — and when the request names none, every change the gate read, both halves
  // included: with the setting on and past the budget `but commit` takes the whole tree from
  // the working copy, so the whole change set is what it will compose the commit out of, and
  // the changes under `openspec/` ride along there like the rest. `git` needs no list:
  // `git add -A` normalises on its own and `git commit` reads the index.
  const eolFiles = tool !== 'gitbutler'
    ? []
    : openspec === false && !overBudget
      ? files
      : reported.map((change) => change.path)
  // The request that creates the branch, when this commit is the one that does. The
  // plan is flipped right after it succeeded, so the next group of the same run commits
  // into the branch instead of trying to create it a second time (D18).
  const creation = commands[0]?.args[0] === 'branch' ? commands[0] : undefined
  // Nothing outside `openspec/` is the ordinary empty tree (D5): the setting changes
  // what there was to commit, never how a commit that has nothing ends.
  if (gate.changes.length === 0) return outcome(COMMIT_END.empty)

  // The commit is the last request of every plan, and the rewrite of the endings belongs
  // right before it: after `but branch new` — a branch that cannot be created must not
  // rewrite a file — and before `but commit`, which is the only request that reads them.
  const commitRequest = commands[commands.length - 1]

  /** @type {{exitCode: number|null, stdout: string, stderr: string}|undefined} */
  let last

  for (const [index, request] of commands.entries()) {
    if (aborted(signal)) return stopped()

    if (request === commitRequest && eolFiles.length > 0) {
      const rewritten = await normalizeEol(eolFiles, { cwd, run, signal })
      eolMixed = rewritten.mixed
      // A stop that landed while the files were being rewritten ends the step: the commit
      // itself has not run, so nothing of this group is in the history yet.
      if (aborted(signal)) return stopped()
    }
    const result = await attempt(run, request, cwd, signal)
    // A stop that cut the request short is the stop, not a tool that failed.
    if (aborted(signal) && (result.error !== undefined || result.result.exitCode !== 0)) {
      return stopped()
    }
    if (result.error !== undefined) {
      return failed(commandName(request), undefined, describe(result.error))
    }
    if (result.result.exitCode !== 0) {
      return failed(commandName(request), result.result.exitCode, reasonOf(result.result))
    }
    // The branch exists once `but branch new` succeeded, whatever happens to the
    // commit that follows: a later retry must not try to create it again.
    if (request === creation && branch !== undefined) branch.exists = true
    // The commit is the last request: once it went through the tree is committed,
    // and a stop arriving while it finished must not pretend otherwise.
    if (index < commands.length - 1 && aborted(signal)) return stopped()
    last = result.result
  }

  const output = last === undefined ? undefined : tailOf(last.stdout)
  return committed(output)
}

/**
 * Run one request and keep a rejection as a value.
 *
 * Both ways a request can fail end in the same report — the tool's own refusal and
 * the runner's inability to start it — so they meet here rather than at every call
 * site. The rejection is returned, not swallowed: the caller turns it into the
 * `reason` of a failed commit.
 *
 * @param {Function} run - runner handed in by the caller.
 * @param {{executable: string, args: readonly string[]}} command - request to run.
 * @param {string} cwd - project directory.
 * @param {AbortSignal} [signal] - cancellation of the whole run.
 * @returns {Promise<{result: object}|{error: unknown}>} the result or the rejection.
 */
async function attempt(run, command, cwd, signal) {
  try {
    const result = await run(
      { executable: command.executable, args: [...command.args] },
      { cwd, signal },
    )
    return { result }
  } catch (error) {
    return { error }
  }
}

/**
 * Why a request that ran failed, as the report should quote it.
 *
 * stderr is the tool's own explanation and wins; GitButler prints some refusals to
 * stdout, so that is the second source; a silent refusal still gets a sentence, so
 * the report never shows a failure with no reason at all.
 *
 * @param {{exitCode: number|null, stdout?: string, stderr?: string}} result - settled
 *   request whose exit code was not zero.
 * @returns {string} the reason to report.
 */
function reasonOf(result) {
  const said = tailOf(result.stderr) ?? tailOf(result.stdout)
  if (said !== undefined) return said
  if (result.exitCode === null) return 'the command was terminated by a signal before it exited'
  return `the command exited with code ${String(result.exitCode)}`
}

/**
 * The last `REASON_MAX_CHARS` characters of a tool's output, or `undefined` when it
 * said nothing.
 *
 * A tool can print a whole diff or a page of hints; the report wants the sentence at
 * the end of it. The text is trimmed but not otherwise rewritten: what the tool said
 * is what the user gets.
 *
 * @param {unknown} value - output captured from the tool.
 * @returns {string|undefined} the tail, when there is one.
 */
function tailOf(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length <= REASON_MAX_CHARS ? text : text.slice(-REASON_MAX_CHARS)
}

/**
 * How a request is named in a report: `git commit`, `git add`, `git status`, `but commit`.
 *
 * The message is left out on purpose — it is already the outcome's `message`, and a
 * failure report should not quote it twice.
 *
 * @param {{executable: string, args: readonly string[]}} command - request.
 * @returns {string} executable and subcommand.
 */
function commandName(command) {
  return [command.executable, command.args[0]].filter((part) => typeof part === 'string' && part !== '').join(' ')
}

/**
 * Message text of an unknown thrown value.
 *
 * @param {unknown} value - thrown value from the runner.
 * @returns {string} a message safe to embed.
 */
function describe(value) {
  return value instanceof Error ? value.message : String(value)
}
