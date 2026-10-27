// dsh-openspec-taskloop — the commit input of one run: its message and its branch
// (tasks 5.2, 7.1–7.3).
//
// Design D18: `but commit` is unambiguous only when the project has one applied
// branch. With several it refuses — `Multiple branches found. Specify a branch to
// commit to using the branch argument` — and with no terminal at all it refuses even
// earlier: `Please specify a branch`. The branch is therefore an input of the run,
// like the commit message text of 5.2, and this module owns that input: it turns
// `but status --json` into the list of applied branches, builds the questions that
// ask which branch the commits go to, asks them — together with the message question,
// in one card — and reads the answers back.
//
//     but status --json ──▶ ["feature-a", "feature-b"]
//                                   │
//        one card ◀─────────────────┘   message (when none is stored) + branch
//            │
//      selected ──┤
//                 ├── typed, matches an applied ──▶ { kind: 'branch' }   but commit <ветка> -m
//                 │
//                 ├── typed, new name ──▶ anchor question ──▶ { kind: 'create', name }
//                 │                                            but branch new <имя> -A <anchor>
//                 │
//                 └── dismissed ──▶ { kind: 'cancelled' }        the run must not start
//
// Four decisions shape the contract:
//
//   - The listing is the only source of branch names (D18), and its shape is not
//     documented, so the parser is tolerant: it walks the document for arrays of
//     branch-like entries instead of trusting one exact schema, treats an entry
//     without `applied` as applied — `but status` lists the applied stacks — and
//     falls back to GitButler's `cliId` when an entry carries no name. What it does
//     not tolerate is a document that is not JSON at all: there the CLI answered
//     something other than what this seam reads, and the run has to stop before its
//     first task rather than fail at the end of the first group (D18).
//   - An answer is either a selected option or free text, not both. Free text wins
//     when it is non-blank, because typing a name is a deliberate answer while a
//     highlighted row can be stale; a typed name equal to an applied branch selects
//     that branch instead of creating a second one of the same name (spec "Имя
//     совпало с существующей веткой").
//   - The anchor is a second question, asked only for a new name and only when the
//     project has an applied branch to stack on: the first branch cannot be stacked
//     (D18). An anchor that is not one of the offered branches is a refusal, because
//     an anchor the tool does not know would fail the first commit after the work is
//     done.
//   - The message and the branch are asked together, as one card (D18): two cards in
//     a row for two facts about the same run read as a form, and the message question
//     is the same free-text question it was before, so it composes without changing
//     (`lib/commit-text.js`). What this module does not do is decide *whether* to ask
//     or keep the answer: the stored text and the `but status` call are the seam's
//     business (`lib/environment.js`), which hands both in.
//
// Like `lib/commit-text.js` this module is free of Cordis: the question service arrives
// as an argument, so every scenario runs in tests without a host and a UI.

import { COMMIT_TEXT, buildMessageQuestion, readCommitText } from './commit-text.js'
import { createButBranch } from './commit.js'

/** Stable id of the question that asks which branch the commits go into. */
export const BRANCH_QUESTION_ID = 'openspec-commit-branch'

/** Stable id of the question that asks what a new branch stacks on (D18). */
export const ANCHOR_QUESTION_ID = 'openspec-commit-anchor'

/**
 * What a run says when it cannot read the branches of the project (design D18).
 *
 * A `but status` that fails is not a broken plugin but a project GitButler does not
 * know yet — or a `but` that is not installed — and the tool's own words rarely say
 * what to do about it. The sentence travels with the tool's output rather than instead
 * of it, so the report keeps both the diagnosis and the fix.
 */
export const GITBUTLER_HINT = 'The project must be a GitButler project (`but setup` in it) and `but` must be on PATH.'

/** Outcomes of {@link readBranchChoice}; callers switch on `kind`. */
export const BRANCH_CHOICE = Object.freeze({
  /** An applied branch was chosen; the result carries it as `branch`. */
  branch: 'branch',
  /** A name that is not an applied branch was typed; `name` is it, to be created. */
  create: 'create',
  /** The question was dismissed or left blank; the run must not start. */
  cancelled: 'cancelled',
})

/**
 * How the branch question settled.
 *
 * A created branch is not complete yet: D18 asks a second question for the anchor and
 * a project without applied branches creates the branch without one, so the caller
 * combines `name` with the anchor before it can build the plan of `lib/commit.js`.
 *
 * @typedef {object} BranchChoice
 * @property {'branch'|'create'|'cancelled'} kind - what the answer settled with.
 * @property {string} [branch] - applied branch the commits go into; present only when `branch`.
 * @property {string} [name] - name of the branch to create; present only when `create`.
 */

/**
 * The applied branches of a `but status --json` document, in the order they appear.
 *
 * The name is what `but commit` receives, because that is the argument the tool
 * documents; `cliId` is only the fallback for an entry that has no name, which is
 * also why it is not part of the result — a caller that names a branch in a report
 * wants the name, not the internal id. Entries the document marks `applied: false`
 * or `archived: true` are left out, together with every branch under an unapplied
 * stack: the commits of a run must not go to a branch that is not applied (D18).
 *
 * @param {unknown} stdout - what `but status --json` printed.
 * @returns {string[]} applied branch names; empty when the project has none.
 * @throws {TypeError} when the output is empty or is not JSON.
 */
export function parseAppliedBranches(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (text === '') {
    throw new TypeError('but status --json printed nothing that lists branches')
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (cause) {
    throw new TypeError(`but status --json did not print JSON: ${messageOf(cause)}`)
  }

  const branches = []
  collectBranches(document, true, branches, new Set())
  return branches
}

/**
 * Build the question that asks which branch this run's commits go into.
 *
 * With applied branches the question offers one option per branch and keeps the
 * free-text field for a new name; without any, it offers no options at all, because
 * there is nothing to choose and the only way forward is a name to create. The detail
 * names the laziness of D18: nothing is created now, and the choice is kept for this
 * run only, so nobody expects it to survive into the next one.
 *
 * @param {object} options
 * @param {string} options.change - OpenSpec change the commits belong to.
 * @param {string[]} [options.branches] - applied branches, as {@link parseAppliedBranches} read them.
 * @returns {object} a `ctx.userQuestions` question.
 */
export function buildBranchQuestion({ change, branches } = {}) {
  const list = namesOf(branches)
  const question = {
    id: BRANCH_QUESTION_ID,
    header: 'OpenSpec',
    question: `Which GitButler branch should the commits of change "${String(change)}" go into?`,
    detail: list.length === 0
      ? 'No applied branch was found, so type the name of the branch to create: `but branch new <name>` '
        + 'runs on the first commit of this run that has something to commit, and the first branch of a '
        + 'project has no anchor. The choice is kept for this run only. Cancelling starts no run.'
      : 'Pick an applied branch, or type the name of a new one. A typed name that matches an applied '
        + 'branch selects it; any other name is created with `but branch new <name> -A <anchor>` on the '
        + 'first commit of this run that has something to commit. The choice is kept for this run only. '
        + 'Cancelling starts no run.',
  }
  if (list.length > 0) {
    question.options = list.map((branch) => ({
      label: branch,
      description: 'Commit the groups of this run into this applied branch.',
    }))
  }
  return question
}

/**
 * Read which branch the answer names, or that it names none.
 *
 * Free text wins over a selection when it is not blank (see the module header), and a
 * typed name is compared with the applied branches the question offered: the same
 * name means "this branch", anything else means "create that one". The name is
 * trimmed but otherwise kept as typed, because it is an argument of a command, not a
 * sentence to rewrite.
 *
 * @param {unknown} answer - `{answers: [{id, selected, custom?}]}` shape.
 * @param {string[]} [branches] - applied branches the question offered.
 * @returns {BranchChoice} the settled choice.
 */
export function readBranchChoice(answer, branches) {
  const list = namesOf(branches)
  const item = answerItem(answer, BRANCH_QUESTION_ID)

  const typed = typeof item?.custom === 'string' ? item.custom.trim() : ''
  if (typed !== '') {
    const known = list.find((branch) => branch === typed)
    return known === undefined
      ? { kind: BRANCH_CHOICE.create, name: typed }
      : { kind: BRANCH_CHOICE.branch, branch: known }
  }

  const selected = selectedLabels(item)
  if (selected.length > 0) return { kind: BRANCH_CHOICE.branch, branch: selected[0] }
  return { kind: BRANCH_CHOICE.cancelled }
}

/**
 * Build the second question: what a new branch stacks on.
 *
 * Asked only for a name that is not an applied branch and only when the project has
 * applied branches at all (D18): with an empty list there is nothing to offer, and the
 * first branch of a project is created without `-a`. The detail says that the branch
 * and the anchor are both used at the first commit with something in it, so the answer
 * does not read as if the branch had been created already.
 *
 * @param {object} options
 * @param {string} options.change - OpenSpec change the commits belong to.
 * @param {string} options.name - name of the branch to create.
 * @param {string[]} [options.branches] - applied branches the anchor can be chosen from.
 * @returns {object} a `ctx.userQuestions` question.
 */
export function buildAnchorQuestion({ change, name, branches } = {}) {
  const list = namesOf(branches)
  const question = {
    id: ANCHOR_QUESTION_ID,
    header: 'OpenSpec',
    question: `Which applied branch should the new branch "${String(name)}" stack on?`,
    detail: `\`but branch new ${String(name)} -A <anchor>\` runs on the first commit of this run that has `
      + 'something to commit, and that commit goes into the new branch. Cancelling starts no run.',
  }
  if (list.length > 0) {
    question.options = list.map((branch) => ({
      label: branch,
      description: 'Stack the new branch on this applied branch.',
    }))
  }
  return question
}

/**
 * Read the anchor out of its answer.
 *
 * Only an applied branch of the offered list is an anchor (see the module header): a
 * typed value is accepted when it names one, a selection is accepted when it names
 * one, and anything else — a dismissal, a blank answer, a branch that is no longer in
 * the listing — is `null`, which the caller reports as a refused start.
 *
 * @param {unknown} answer - `{answers: [{id, selected, custom?}]}` shape.
 * @param {string[]} [branches] - applied branches the question offered.
 * @returns {string|null} the anchor branch, or `null` when none was chosen.
 */
export function readAnchorChoice(answer, branches) {
  const list = namesOf(branches)
  const item = answerItem(answer, ANCHOR_QUESTION_ID)

  const typed = typeof item?.custom === 'string' ? item.custom.trim() : ''
  if (typed !== '') return list.includes(typed) ? typed : null

  const selected = selectedLabels(item)
  if (selected.length === 0) return null
  return list.includes(selected[0]) ? selected[0] : null
}

/**
 * Which question of the card a dismissed input came from; the report names it.
 *
 * A refusal is the end of the command whatever the user dismissed (spec "Отмена
 * ввода", "Отмена выбора ветки"), but the sentence that explains it has to say what
 * was refused: a run that stopped because nobody picked a branch is not a run whose
 * commit message was withdrawn.
 */
export const CANCEL_STEP = Object.freeze({
  /** The message question was dismissed or left blank. */
  message: 'message',
  /** The branch question was dismissed, or left without a branch. */
  branch: 'branch',
  /** The anchor question for a new branch was dismissed or named no applied branch. */
  anchor: 'anchor',
})

/**
 * How the commit input of one run settled.
 *
 * `text` carries the message the commits will take; `branch` is the plan of
 * `lib/commit.js` when the tool is GitButler — `exists: true` for an applied branch the
 * user picked, `exists: false` for a name the first non-empty commit has to create. The
 * plan is the caller's to keep for the run: it is mutable on purpose, because
 * `runCommit()` flips `exists` once the branch exists (design D18).
 *
 * `cancelled` always names the question that was refused, so the command result can say
 * what was withdrawn instead of blaming the message for a dismissed branch.
 *
 * @typedef {object} CommitInputOutcome
 * @property {'text'|'cancelled'|'unavailable'} kind - what the input settled with.
 * @property {string} [text] - the message text of the run; present only when `text`.
 * @property {{name: string, anchor?: string, exists: boolean}} [branch] - GitButler
 *   branch plan of the run; absent when the tool is `git` or the branch is not chosen.
 * @property {'message'|'branch'|'anchor'} [step] - which question was refused.
 */

/**
 * Settle the commit input of one run: the message text and the GitButler branch.
 *
 * The card holds both questions when both are needed — the message is asked only when
 * nothing is stored for the change (design D16), the branch only when the configured
 * tool is `gitbutler` (design D18) — so the user answers one card instead of two in a
 * row. The anchor follows in a second card, because it exists only for a name that
 * has to be stacked on an applied branch.
 *
 * Three fallbacks are deliberate:
 *
 *   - No question channel at all (a headless run) is not a refusal: the stored text, if
 *     any, is used and the commits go without a branch argument, which is exactly the
 *     `but commit -m` of the design. Nothing is invented and nothing is asked.
 *   - A channel that turns out to have nobody behind it (`NO_PROVIDER`) answers the
 *     same way, because there nobody refused either.
 *   - A dismissal, a blank answer or an anchor that names no applied branch is a
 *     refusal, and the run must not start: without a branch the first commit would fail
 *     after the first group's work is done.
 *
 * A refusal of the anchor asks nothing further and names `anchor`; a project with no
 * applied branch skips the anchor question entirely, because the first branch of a
 * project cannot be stacked (D18).
 *
 * @param {object} request
 * @param {object} [request.questions] - the user-questions service, `ctx.userQuestions`.
 * @param {object} [request.agent] - live agent the questions belong to.
 * @param {string} request.change - OpenSpec change the commits belong to.
 * @param {string} request.cwd - project directory of the run.
 * @param {'git'|'gitbutler'} request.tool - commit tool the run was started with.
 * @param {string} [request.stored] - message already kept for this change, if any.
 * @param {string[]} [request.branches] - applied branches, as {@link parseAppliedBranches}
 *   read them; ignored when the tool is not GitButler.
 * @param {AbortSignal} [request.signal] - cancellation of the request that started the run.
 * @returns {Promise<CommitInputOutcome>} the settled input, refusal or missing channel.
 * @throws {Error} when a question fails for a reason other than dismissal.
 */
export async function requestCommitInput({
  questions, agent, change, cwd, tool, stored, branches, signal,
} = {}) {
  const asksBranch = tool === 'gitbutler'
  const asksMessage = stored === undefined
  const list = asksBranch ? namesOf(branches) : []

  if (!hasChannel(questions)) {
    // Nobody can be asked: a stored sentence still commits, and the branch stays
    // unnamed, which the report of the commit says in words (design D18).
    return stored === undefined
      ? { kind: COMMIT_TEXT.unavailable }
      : { kind: COMMIT_TEXT.text, text: stored }
  }
  if (!asksMessage && !asksBranch) return { kind: COMMIT_TEXT.text, text: stored }

  const card = []
  if (asksMessage) card.push(buildMessageQuestion({ change, cwd }))
  if (asksBranch) card.push(buildBranchQuestion({ change, branches: list }))

  /** Which question the first card refused, when it did. */
  const firstStep = asksMessage ? CANCEL_STEP.message : CANCEL_STEP.branch
  const asked = await askCard(questions, card, agent, signal)
  if (asked.kind === 'cancelled') return { kind: COMMIT_TEXT.cancelled, step: firstStep }
  if (asked.kind === 'unavailable') {
    // The channel exists but has nobody behind it: the same headless answer as above.
    return stored === undefined
      ? { kind: COMMIT_TEXT.unavailable }
      : { kind: COMMIT_TEXT.text, text: stored }
  }

  const text = asksMessage ? readCommitText(asked.answer) : stored
  if (text === null) return { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.message }
  if (!asksBranch) return { kind: COMMIT_TEXT.text, text }

  const choice = readBranchChoice(asked.answer, list)
  if (choice.kind === BRANCH_CHOICE.cancelled) return { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.branch }
  if (choice.kind === BRANCH_CHOICE.branch) {
    // An applied branch the user picked: the commits go into it as it is, so the plan
    // starts with `exists: true` and `but branch new` never runs for it.
    return { kind: COMMIT_TEXT.text, text, branch: createButBranch({ name: choice.branch, exists: true }) }
  }
  if (list.length === 0) {
    // No applied branch to stack on: the first branch of a project is created on its
    // own, so there is nothing to ask and `-a` is left out (D18).
    return { kind: COMMIT_TEXT.text, text, branch: createButBranch({ name: choice.name }) }
  }

  const anchor = await askCard(
    questions,
    [buildAnchorQuestion({ change, name: choice.name, branches: list })],
    agent,
    signal,
  )
  if (anchor.kind !== 'answered') return { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.anchor }
  const stackedOn = readAnchorChoice(anchor.answer, list)
  if (stackedOn === null) return { kind: COMMIT_TEXT.cancelled, step: CANCEL_STEP.anchor }
  return {
    kind: COMMIT_TEXT.text,
    text,
    branch: createButBranch({ name: choice.name, anchor: stackedOn }),
  }
}

/**
 * Ask one card and keep its three ways of not being answered apart.
 *
 * `cancelled` is the user's refusal (dismissed or aborted — a request that ended cannot
 * be answered either), `unavailable` is a channel with nobody behind it, and every other
 * failure is rethrown: a question service that broke is not an answer, and reading it as
 * one would either start a run without its input or refuse one nobody refused.
 *
 * @param {object} questions - the user-questions service.
 * @param {object[]} card - the questions to show together.
 * @param {object} [agent] - live agent the questions belong to.
 * @param {AbortSignal} [signal] - cancellation of the request that started the run.
 * @returns {Promise<{kind: 'answered', answer: unknown}|{kind: 'cancelled'}|{kind: 'unavailable'}>}
 *   the settled card.
 * @throws {Error} when the service fails for a reason other than dismissal.
 */
async function askCard(questions, card, agent, signal) {
  try {
    return { kind: 'answered', answer: await questions.ask({ questions: card, agent, signal }) }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') return { kind: 'cancelled' }
    if (code === 'NO_PROVIDER') return { kind: 'unavailable' }
    throw error
  }
}

/**
 * Whether a deployment has a question channel that could show a card.
 *
 * @param {unknown} questions - `ctx.userQuestions`, when the profile composes it.
 * @returns {boolean} whether a card can be asked.
 */
function hasChannel(questions) {
  return questions !== undefined && questions !== null && typeof questions.ask === 'function'
}

/**
 * Machine-readable code of a failed question, when it has one.
 *
 * @param {unknown} error - thrown value from the question service.
 * @returns {string|undefined} the code.
 */
function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : undefined
}

/**
 * Walk one `but status --json` value for branch-like entries.
 *
 * The documented shape is a list of stacks that carry their branches, but the exact
 * document is not specified (D18), so both containers are followed wherever they
 * appear and an array is read as a list of branches when its entries look like
 * branches. `applied` is inherited down the tree: a branch under an unapplied stack
 * is not applied either, whatever it says about itself.
 *
 * @param {unknown} value - part of the parsed document.
 * @param {boolean} applied - whether the enclosing containers are applied.
 * @param {string[]} branches - accumulator, in document order.
 * @param {Set<string>} seen - names already taken, so a branch listed twice counts once.
 * @returns {void}
 */
function collectBranches(value, applied, branches, seen) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isBranchEntry(entry)) addBranch(entry, applied, branches, seen)
      else collectBranches(entry, applied, branches, seen)
    }
    return
  }
  if (!isRecord(value)) return

  // An unapplied or archived stack hides everything below it: `but status` may keep
  // such entries in the document, and a commit must not go into one of their branches.
  if (!applied || value.applied === false || value.archived === true) return

  for (const entry of entriesOf(value.branches)) addBranch(entry, true, branches, seen)
  for (const entry of entriesOf(value.stacks)) collectBranches(entry, true, branches, seen)
}

/**
 * Take one branch-like entry into the list, if it is applied and not already there.
 *
 * @param {unknown} entry - candidate branch object.
 * @param {boolean} applied - whether the enclosing containers are applied.
 * @param {string[]} branches - accumulator.
 * @param {Set<string>} seen - names already taken.
 * @returns {void}
 */
function addBranch(entry, applied, branches, seen) {
  if (!applied || !isRecord(entry)) return
  if (entry.applied === false || entry.archived === true) return

  const name = identifierOf(entry)
  if (name === undefined || seen.has(name)) return
  seen.add(name)
  branches.push(name)
}

/**
 * Whether a value looks like a branch of the listing rather than a container of them.
 *
 * A stack carries `branches` (or `stacks`) of its own; an entry with such a child is
 * walked through instead of being taken as a branch, which is what keeps a named stack
 * from being committed into. Without a name or a `cliId` an entry cannot be named on a
 * command line at all, so it is not a branch this seam can offer.
 *
 * @param {unknown} value - part of the parsed document.
 * @returns {boolean} whether the value is a branch entry.
 */
function isBranchEntry(value) {
  return isRecord(value)
    && !Array.isArray(value.branches)
    && !Array.isArray(value.stacks)
    && identifierOf(value) !== undefined
}

/**
 * What an entry is called: its name, or GitButler's `cliId` when it has no name.
 *
 * `cliId` is the fallback argument of D18 — an id is still something `but commit`
 * accepts, while an unnamed entry would otherwise drop out of the listing silently.
 * The snake_case spelling is accepted too, because a JSON written by a CLI that lives
 * in a Rust codebase can use either and the parser is meant to be tolerant.
 *
 * @param {object} value - branch-like entry.
 * @returns {string|undefined} the identifier, or `undefined` when the entry has none.
 */
function identifierOf(value) {
  for (const key of ['name', 'cliId', 'cli_id']) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  }
  return undefined
}

/**
 * The entry of one question in a settled answer, if the answer carries it.
 *
 * @param {unknown} answer - `{answers: [...]}` shape.
 * @param {string} id - question id to find.
 * @returns {object|undefined} the answer entry.
 */
function answerItem(answer, id) {
  const answers = Array.isArray(answer?.answers) ? answer.answers : []
  return answers.find((entry) => entry?.id === id)
}

/**
 * The non-blank labels an answer selected.
 *
 * The question service answers with the labels of the options it showed (the bootstrap
 * reads its consent exactly this way), so a selection is a branch name as it was
 * offered. A blank or non-string element is dropped rather than turned into a branch.
 *
 * @param {object|undefined} item - answer entry of one question.
 * @returns {string[]} the selected labels, trimmed.
 */
function selectedLabels(item) {
  if (!Array.isArray(item?.selected)) return []
  return item.selected
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
}

/**
 * Normalise the branch list a question was built from.
 *
 * The list arrives from {@link parseAppliedBranches} and is compared with user input,
 * so blank and non-string entries are dropped and a repeated name is kept once: a
 * duplicate option would make the answer ambiguous for no gain.
 *
 * @param {unknown} branches - applied branches.
 * @returns {string[]} the usable names, trimmed.
 */
function namesOf(branches) {
  if (!Array.isArray(branches)) return []
  const names = []
  for (const branch of branches) {
    if (typeof branch !== 'string') continue
    const name = branch.trim()
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * The entries of a container that may hold branches, or nothing.
 *
 * @param {unknown} value - candidate array.
 * @returns {unknown[]} the entries, when the value is an array.
 */
function entriesOf(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Whether a parsed JSON value is an object this walker can read.
 *
 * @param {unknown} value - parsed JSON value.
 * @returns {boolean} whether the value is a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Message text of an unknown thrown value.
 *
 * @param {unknown} value - thrown value from `JSON.parse`.
 * @returns {string} a message safe to embed.
 */
function messageOf(value) {
  return value instanceof Error ? value.message : String(value)
}
