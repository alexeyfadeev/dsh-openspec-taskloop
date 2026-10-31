// dsh-openspec-taskloop — client half: the run badge and the Settings page.
//
// The host serves this file as the package's `/client` bundle: it reads the
// `dsh.client` declaration from package.json, resolves the entry through
// `exports["./client"]`, and registers the factory below. The factory body runs
// lazily on first use, so nothing here executes while the page boots.
//
// The first contribution is the run badge (task 8.1, design D9): a button in the
// session header's utility row that says whether a `/taskloop` run is working or
// parked. It is registered in every session, reads
// `GET /api/openspec-taskloop/state` (design D8) once on mount and then every two
// seconds, and returns an empty fragment — not `null` — while no run is reported,
// so the header never holds a pill for a run that is over.
//
// Pressing the badge opens the run panel (task 8.2): a modal carrying the change
// and its workspace, a progress bar, Pause or Resume and Stop, and the change's
// tasks with the current one marked. The panel reads
// `GET /api/openspec-taskloop/tasks` when it opens and again whenever the run
// moves to another task, and its buttons post the same three actions to
// `POST /api/openspec-taskloop/action` that the commands dispatch to. The modal,
// its mask and Escape are the primitives' `Modal` (design D9), so this half only
// decides what the panel says.
//
// The panel's body tells its three situations apart (task 8.3): while the list is
// on its way it says that it is being read, a read the host could not complete says
// the list is unavailable and carries the host's own reason, and only a completed
// read draws rows — a change that lists no tasks says so in words, because an empty
// list would be a claim about the change rather than about the read. Closing the
// panel puts focus back on the badge, which is the control that opened it.
//
// The bundle is plain module-loader CJS with no build step (design D12): the
// loader hands the factory a `require` that resolves the platform seed words
// (`react`, `@deepseek-ai/dsh-client-ui-primitives`) and the package rows the
// manifest's `dsh.client.inject` names.
//
// The second contribution is the Settings page: one `settings.section` slot — the
// same slot type the General and Models pages fill — and it edits exactly the
// eleven volatile fields of this plugin's own config block (D12; `add-compaction-retry-settings`
// D1; `add-commit-openspec-toggle` D6):
//
//   commit.enabled, commit.openspec, commit.tool, review.enabled, boundary.enabled,
//   compaction.midTask, protocol.systemSection, compaction.onFailure,
//   compaction.retry.attempts, compaction.retry.delayMs, compaction.retry.factor
//
// Writes go straight through the shared `configForms` entry of that config
// block, so there is no Save button: a switch applies to the next `/taskloop`
// run without a reload, and a number is written on blur or Enter so a
// half-typed value never lands. The block itself lands in the profile's
// cordis.patch.yml, which is why the entry id below is the plugin row id.
//
// The three retry numbers carry a forecast under them: the waits the next
// transition would make and their worst-case total, computed by the same rule
// `lib/compaction.js` applies (D2), so a change to the numbers shows its price
// before any run pays it.
//
// Anything outside the eleven fields — `change`, `retry.codes`, `retry.maxDelayMs`
// and the `openspec` timeout — stays a profile decision: those are not
// volatile, so this form neither reads nor writes them (D12, D1).

window.__ModuleLoader__.load({
  id: 'dsh-openspec-taskloop',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Button, Input, Modal, SegmentedControl, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Config entry the plugin's own block is served under (its row id). */
    const CONFIG_ENTRY = 'openspec-taskloop'

    /** Nav identity of the page, and the marker the shell filters sections by. */
    const SECTION_ID = 'openspec-taskloop'

    /**
     * The slot the session header lends to utility controls (task 8.1).
     *
     * A list slot: every registration is one item in the row beside the session
     * title, and the shell passes the owning session down as `sessionId`. The
     * badge does not read that prop — it reports the one process-wide run, which
     * is the same in every session — but the slot still renders it per session,
     * so a header that is closed and reopened gets a fresh poll.
     */
    const HEADER_SLOT = 'conversation.session.header.utilities'

    /** Registration identity inside the header row; unique among its neighbours. */
    const BADGE_ID = 'openspec-taskloop-badge'

    /**
     * Position in the header's utility row.
     *
     * The header's own controls sit low and the neighbouring plugins' utilities
     * spread over the tens, so 30 keeps the badge after the session's own
     * controls and clear of a neighbour that happens to pick the same number.
     */
    const BADGE_ORDER = 30

    /** How often the badge asks what the run is doing (design D9: two seconds). */
    const POLL_MS = 2000

    /** The state route of `lib/routes.js`, which the badge polls (design D8). */
    const STATE_URL = '/api/openspec-taskloop/state'

    /**
     * The task list route (task 8.2, design D8).
     *
     * One `openspec instructions apply --json` per request, which is why the
     * panel asks for it when it opens and not on the two-second poll: the list
     * is a document, and the phase is a word in memory.
     */
    const TASKS_URL = '/api/openspec-taskloop/tasks'

    /**
     * The action route (task 8.2, design D8).
     *
     * `pause`, `resume` and `stop` are the three commands, so a button in the
     * panel is the command it names — there is no second implementation of a
     * pause behind the interface.
     */
    const ACTION_URL = '/api/openspec-taskloop/action'

    /** Nav label; the design fixes it in English for both locales. */
    const SECTION_LABEL = 'OpenSpec Taskloop'

    /**
     * Nav position: right behind Models (10) and ahead of the Plugins section
     * (15), so the page reads as one more built-in settings page rather than a
     * plugin-management tab.
     */
    const SECTION_ORDER = 12

    /**
     * The page copy.
     *
     * Plain strings rather than a locale dictionary: this plugin's user-facing
     * text — the command report, the settings hints — is English throughout,
     * and the shell localizes its own chrome.
     */
    const COPY = {
      title: 'OpenSpec Taskloop',
      description: 'Commits, code review and compaction around the task groups a /taskloop run completes.',
      commitEnabled: 'Commit after each task group',
      commitEnabledHint:
        'Once every task of a group is verified, commit the working tree as the message you entered at the '
        + 'start of the run, suffixed with the task range of the group.',
      commitOpenspec: 'Commit openspec files',
      commitOpenspecHint:
        'Include the changes under openspec/ — the task ticks, the spec and design edits — in the commit of '
        + 'each group. Off, they stay uncommitted in the working tree, so the commit holds only what the group '
        + 'changed elsewhere, and a group that touched nothing else reports that there was nothing to commit '
        + 'outside openspec/.',
      commitTool: 'Commit tool',
      commitToolHint:
        'Plain git, or GitButler\'s but (0.22.0 or newer). GitButler asks which branch the commits of a run '
        + 'go into — an applied branch or a new name, plus the branch a new one stacks on — in the same card '
        + 'as the commit message, and commits with `but commit -b <branch> -m` (`but branch new <name> -A <anchor>` '
        + 'for a new one). Read at the moment of the commit, so switching it needs no restart.',
      git: 'Git',
      gitbutler: 'GitButler',
      reviewEnabled: 'Code review after each task group',
      reviewEnabledHint:
        'Review the group in a session of its own before the next group starts; findings reach you, the '
        + 'run keeps going.',
      boundaryEnabled: 'Stop at each task group boundary',
      boundaryEnabledHint:
        'End the run at the group boundary instead of handing the next group its own session: review and commit '
        + 'still run, then the report names the group the run stopped at and the task the next /taskloop '
        + 'continues from. Off, the next group starts in a fresh session as before.',
      midTask: 'Compact inside a task',
      midTaskHint: 'Ask for compaction by context pressure on a step boundary, not only between tasks.',
      onFailure: 'When the compaction budget runs out',
      onFailureHint: 'Break stops the run and says why; Continue records a warning in the report and goes on.',
      break: 'Break',
      continue: 'Continue',
      retryAttempts: 'Compaction attempts',
      retryAttemptsHint:
        'Calls to compaction on one transition between tasks, the first call included: four attempts are three '
        + 'waits. A successful compaction waits for none of them.',
      retryDelay: 'First retry wait (seconds)',
      retryDelayHint:
        'How long the run waits after the first failed compaction. A provider\'s quota window is measured in '
        + 'minutes, which is why the default is tens of seconds rather than one or two.',
      retryFactor: 'Retry wait multiplier',
      retryFactorHint: 'Each further wait is this many times the previous one; 1 waits the same every time.',
      retrySchedulePrefix: 'Waits between calls: ',
      retryScheduleTotal: '; worst case ',
      retryScheduleNone: 'No waits: this setting allows a single call, so nothing is retried.',
      systemSection: 'Protocol section',
      systemSectionHint:
        'Register the static protocol section for a run. Turn it on together with compaction inside a task: '
        + 'the section is what survives a summary taken mid-task.',
      loading: 'Reading the values this deployment holds…',
      unavailable: 'This deployment does not serve these settings, so nothing can be changed here.',
      readOnly: 'This deployment stores settings read-only.',
      refused: 'The deployment did not accept that value; the page now shows what it holds.',
      failed: 'The write failed: ',
      badgeRunning: 'Running',
      badgePaused: 'Paused',
      badgeRunningLabel: 'OpenSpec taskloop: the run is working. Open the run panel.',
      badgePausedLabel: 'OpenSpec taskloop: the run is paused. Open the run panel.',
      dialogTitle: 'OpenSpec taskloop run',
      dialogClose: 'Close the run panel',
      dialogUnknown: 'not reported yet',
      progressLabel: 'Tasks done in this run',
      tasksTitle: 'Tasks',
      tasksLoading: 'Reading the task list…',
      tasksUnavailable: 'The task list is unavailable: the page did not get an answer.',
      tasksEmpty: 'This change lists no tasks.',
      pauseAction: 'Pause',
      resumeAction: 'Resume',
      stopAction: 'Stop',
      taskDone: 'Done',
    }

    /**
     * Style tag identity, so a reload replaces rather than stacks the sheet.
     *
     * The marker names the sheet's version, not the plugin: a bundle that brings
     * new rules must not be skipped because an older tag is still in the document
     * (which is what a hot reload of the client half looks like), and the rules it
     * brings are new class names, so the older tag cannot conflict with them.
     */
    const CSS_ID = 'dsh-openspec-taskloop/client.css'

    /** The page's own styling; every colour comes from a `--dsw-*` token. */
    const CSS_TEXT = [
      '.tls_page { display: grid; gap: 20px; }',
      '.tls_title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.tls_desc { margin: 4px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }',
      '.tls_rows { display: grid; gap: 18px; }',
      '.tls_row { display: grid; gap: 6px; }',
      '.tls_head { display: flex; align-items: center; justify-content: space-between; gap: 16px;',
      '  font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }',
      '.tls_hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }',
      '.tls_note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }',
      '.tls_num { width: 96px; }',
      '.tls_forecast { margin: -8px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }',
      '.tls_error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }',
      // The run badge (task 8.1). A pill the height of the header's other
      // utilities; the phase is carried by `data-state`, never by an inline
      // colour, so both themes colour it through the same two rules below.
      '.tls_badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;',
      '  border: 0; border-radius: 999px; background: transparent; cursor: pointer; font: inherit;',
      '  font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary);',
      '  transition: background-color 150ms ease; }',
      '@media (hover: hover) {',
      '  .tls_badge:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }',
      '}',
      '.tls_badge:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));',
      '  outline-offset: 2px; }',
      '.tls_badgeDot { width: 8px; height: 8px; border-radius: 50%; flex: none;',
      '  background: var(--dsw-alias-label-tertiary); }',
      '.tls_badge[data-state="running"] .tls_badgeDot',
      '  { background: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)); }',
      '.tls_badge[data-state="paused"] .tls_badgeDot',
      '  { background: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary)); }',
      '.tls_badgeLabel { max-width: 9ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      // The run panel (task 8.2). The modal itself — mask, card, elevation,
      // radius, scrollable content — is the primitives' `Modal`; these rules
      // only lay out what it carries. Every colour stays a `--dsw-*` token, as
      // in the badge, so both themes follow without a second sheet.
      '.tls_run { display: grid; gap: 14px; min-width: 0; }',
      '.tls_runHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }',
      '.tls_runTitles { display: grid; gap: 2px; min-width: 0; }',
      '.tls_runName { font-size: 13px; line-height: 1.4; font-weight: 600; overflow: hidden;',
      '  text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }',
      '.tls_runPath { font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 1.5;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); }',
      '.tls_phase { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px;',
      '  border-radius: 999px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary);',
      '  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }',
      '.tls_phaseDot { width: 6px; height: 6px; border-radius: 50%; flex: none;',
      '  background: var(--dsw-alias-label-tertiary); }',
      '.tls_phase[data-state="running"] .tls_phaseDot',
      '  { background: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)); }',
      '.tls_phase[data-state="paused"] .tls_phaseDot',
      '  { background: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary)); }',
      '.tls_progress { display: grid; gap: 6px; }',
      '.tls_bar { height: 6px; border-radius: 999px; overflow: hidden;',
      '  background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }',
      '.tls_barFill { height: 100%; border-radius: inherit; transition: width 200ms ease;',
      '  background: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)); }',
      '.tls_barText { margin: 0; font-size: 12px; line-height: 1.5; font-variant-numeric: tabular-nums;',
      '  color: var(--dsw-alias-label-secondary); }',
      '.tls_tasks { display: grid; gap: 6px; min-width: 0; }',
      '.tls_tasksTitle { margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }',
      '.tls_taskList { display: grid; gap: 2px; max-height: 40vh; margin: 0; padding: 0; list-style: none;',
      '  overflow: auto; overscroll-behavior: contain; }',
      '.tls_task { display: grid; grid-template-columns: 14px 1fr; align-items: start; gap: 6px;',
      '  padding: 4px 6px; border-radius: 6px; font-size: 12px; line-height: 1.5;',
      '  color: var(--dsw-alias-label-secondary); }',
      '.tls_task[data-done="true"] { color: var(--dsw-alias-label-tertiary); }',
      '.tls_task[data-current="true"] { color: var(--dsw-alias-label-primary);',
      '  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }',
      '.tls_taskMark { text-align: center; font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
      '.tls_taskText { min-width: 0; overflow-wrap: anywhere; }',
      // The body's three states (task 8.3) are one note where the list would be:
      // the heading says the section exists, and the note says why it holds no
      // rows. The reading state is the quietest of the three, the refusal says
      // more, and both stay secondary to the rows they replace.
      '.tls_taskNote { margin: 0; padding: 4px 6px; font-size: 12px; line-height: 1.5;',
      '  overflow-wrap: anywhere; color: var(--dsw-alias-label-tertiary); }',
      '.tls_taskNote[data-state="unavailable"] { color: var(--dsw-alias-label-secondary); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .tls_badge, .tls_barFill { transition: none; }',
      '}',
    ].join('\n')

    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-openspec-taskloop'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
    }

    /**
     * What the badge shows for one poll's answer (task 8.1).
     *
     * The answer comes from `GET /api/openspec-taskloop/state` (design D8), whose
     * two shapes are `{ active: false }` and `{ active: true, phase, … }`. Anything
     * else — a body that is not an object, one this client could not parse — is
     * read as "no run" rather than as a phase: a badge that guessed would put a
     * run in the header that nobody started.
     *
     * Only `paused` is a phase of its own. A run that holds the slot and is not
     * parked is working, which is what a first poll sees while the first turn is
     * still running and what a resume returns to.
     *
     * @param {unknown} state - the JSON body of one `/state` answer.
     * @returns {{phase: 'running'|'paused', label: string, ariaLabel: string}|null}
     *   the visible state, or null when the header should stay empty.
     */
    function badgeView(state) {
      if (state === null || typeof state !== 'object' || state.active !== true) return null
      if (state.phase === 'paused') {
        return { phase: 'paused', label: COPY.badgePaused, ariaLabel: COPY.badgePausedLabel }
      }
      return { phase: 'running', label: COPY.badgeRunning, ariaLabel: COPY.badgeRunningLabel }
    }

    /**
     * A string the run reported, or null when it did not report one (task 8.2).
     *
     * `lib/status.js` leaves a field out rather than guessing it, so the panel has
     * to tell "the run named this directory" from "the run has not named one yet"
     * and say so instead of printing `undefined`.
     *
     * @param {unknown} value - the field of a `/state` answer.
     * @returns {string|null} the text, or null when there is none.
     */
    function named(value) {
      return typeof value === 'string' && value !== '' ? value : null
    }

    /**
     * The `complete`/`total` pair of an answer, when it carries a usable one.
     *
     * Both routes report counts, and both are checked the same way: a bar is a
     * claim about how much of the change is done, so an answer without two finite
     * numbers leaves the panel without a bar rather than with a zero.
     *
     * @param {unknown} source - a `/tasks` body or a `/state` snapshot.
     * @returns {{complete: number, total: number}|null} the pair, or null.
     */
    function progressOf(source) {
      const progress = source !== null && typeof source === 'object' ? source.progress : undefined
      if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) return null
      const { complete, total } = progress
      if (!Number.isFinite(complete) || !Number.isFinite(total) || total <= 0) return null
      return { complete, total }
    }

    /**
     * The text under the progress bar: the same pair of numbers the bar draws.
     *
     * The spec asks for the ratio in words as well as in length (spec "Диалог
     * прогона", "Прогресс-бар"), so this sentence is the bar's own caption and
     * the value a screen reader announces for it.
     *
     * @param {{complete: number, total: number}} progress - counts to print.
     * @returns {string} the caption, e.g. `19 / 24 tasks done`.
     */
    function progressText(progress) {
      return progress.complete + ' / ' + progress.total + ' tasks done'
    }

    /**
     * Whether one row of the list is the task the run last sent (task 8.2).
     *
     * The line in `tasks.md` is the identity both answers agree on: `lib/status.js`
     * reports the task the loop sent, `lib/routes.js` passes the CLI's `line`
     * through for exactly this comparison, and the task's `id` is a sequential
     * number over one reading, which the next reading may renumber.
     *
     * @param {unknown} entry - one entry of the `/tasks` list.
     * @param {unknown} current - the task of the `/state` snapshot.
     * @returns {boolean} whether the row is the run's current task.
     */
    function isCurrentTask(entry, current) {
      if (entry === null || typeof entry !== 'object') return false
      if (current === null || typeof current !== 'object') return false
      if (entry.line !== current.line) return false
      return entry.sourcePath === current.sourcePath
    }

    /**
     * The explanation a refused `/tasks` answer carries, when it carries one.
     *
     * `lib/routes.js` refuses an unreadable list with a 503 whose `error` is the
     * CLI's own complaint (`missing openspec`, a deadline, a document that is not
     * one). That sentence is the difference between a panel the user can act on
     * and one that only says "unavailable", so it travels through when it is a
     * string and is dropped when it is anything else.
     *
     * @param {unknown} body - the parsed body of a refused answer.
     * @returns {string|null} the route's sentence, or null.
     */
    function reasonOf(body) {
      if (body === null || typeof body !== 'object') return null
      return named(body.error)
    }

    /**
     * A `/tasks` read as one of the panel body's three states (task 8.3).
     *
     * `null` is the state the badge starts from and returns to on every open: the
     * read is on its way. `unavailable` is the answer the host gives when it could
     * not read the list — a state of its own, deliberately not an empty list (spec
     * "Диалог прогона": "Задачи недоступны"). `ready` is a list, and an empty one
     * is still `ready`: "this change lists no tasks" is a fact about the change,
     * while "the list could not be read" is a fact about the host, and the panel
     * must not say the first when it means the second.
     *
     * @param {unknown} read - the state the badge keeps for the route's answer.
     * @returns {{status: 'ready', body: object}|{status: 'unavailable', reason: string|null}|null}
     *   the read, or null while it is on its way.
     */
    function readOf(read) {
      if (read === null || typeof read !== 'object') return null
      if (read.status === 'unavailable') return { status: 'unavailable', reason: named(read.reason) }
      if (read.status === 'ready' && read.body !== null && typeof read.body === 'object') {
        return { status: 'ready', body: read.body }
      }
      return null
    }

    /**
     * One row of the task list: a tick for the finished ones, a mark for the
     * current one (task 8.2).
     *
     * The row is read-only — this panel never ticks a task, the model does — so
     * the tick is a glyph the row carries, and the current task is marked with
     * `aria-current="step"` as well as with the class that couriers it, because
     * colour alone says nothing to a screen reader.
     *
     * @param {object} task - one entry of the `/tasks` list.
     * @param {unknown} current - the task of the `/state` snapshot.
     * @returns {object} the `li` element.
     */
    function TaskRow(task, current) {
      const done = task.done === true
      const isCurrent = isCurrentTask(task, current)
      const text = String(task.description ?? '')
      return React.createElement('li', {
        key: task.id ?? task.line,
        className: 'tls_task',
        'data-done': done ? 'true' : 'false',
        'data-current': isCurrent ? 'true' : 'false',
        'aria-current': isCurrent ? 'step' : undefined,
        'aria-label': done ? COPY.taskDone + ': ' + text : undefined,
      },
        React.createElement('span', { className: 'tls_taskMark', 'aria-hidden': 'true' }, done ? '✓' : ''),
        React.createElement('span', { className: 'tls_taskText' }, text))
    }

    /**
     * What the panel draws where the list would be (task 8.3).
     *
     * One section with one heading, and then one of three things: the reading
     * note, the refusal with the host's reason, or the rows. The heading stays in
     * all three so the substitution is legible — a section that vanishes while it
     * loads reads as a panel that lost a control — and the note is a `role="status"`
     * region, so a screen reader hears the change of state without being told to
     * look for it.
     *
     * @param {ReturnType<typeof readOf>} read - the state of the one `/tasks` read.
     * @param {unknown} current - the task of the `/state` snapshot.
     * @returns {object} the section element.
     */
    function TaskBody(read, current) {
      const note = (text, state) => React.createElement('p', {
        className: 'tls_taskNote',
        role: 'status',
        'data-state': state,
      }, text)
      const section = (...children) => React.createElement('div', { className: 'tls_tasks' },
        React.createElement('h3', { className: 'tls_tasksTitle' }, COPY.tasksTitle),
        ...children)

      if (read === null) return section(note(COPY.tasksLoading, 'loading'))
      if (read.status === 'unavailable') {
        return section(note(read.reason ?? COPY.tasksUnavailable, 'unavailable'))
      }
      const entries = Array.isArray(read.body.tasks) ? read.body.tasks : []
      if (entries.length === 0) return section(note(COPY.tasksEmpty, 'empty'))
      return section(React.createElement('ul', { className: 'tls_taskList' },
        entries.map((entry) => TaskRow(entry, current))))
    }

    /**
     * The run panel behind the badge (task 8.2).
     *
     * Four things the dialog owes the user, and each has one source: which run
     * this is (the change and its workspace, from the poll), how far it got (the
     * bar, from the list's `complete`/`total` and, until that answer arrives, from
     * the poll), what it is doing now (the phase pill and the primary button,
     * which is Pause while working and Resume while parked), and the tasks
     * themselves with the current one marked (the one CLI reading), in one of the
     * three states {@link TaskBody} draws (task 8.3).
     *
     * The bar prefers the CLI's counts — design D8 calls the freshly read list
     * "источник истины на этот момент" — and falls back to the last reading in
     * memory, so the panel is not blank between opening and the list's answer.
     *
     * `open` is always true here: the badge mounts the panel only while it is
     * open, and `Modal` renders nothing when it is not. Entry focus, Escape, the
     * mask click and the Tab trap belong to the primitive (design D9), so no
     * handler here reimplements them; the return of focus to the badge is the
     * badge's own, because a click need not leave the badge focused.
     *
     * @param {object} props
     * @param {object} props.snapshot - the `/state` answer of the active run.
     * @param {unknown} props.tasks - the `/tasks` read as the badge keeps it, or
     *   null while it is on its way.
     * @param {boolean} props.busy - whether an action is still in flight.
     * @param {() => void} props.onClose - close the panel.
     * @param {(action: 'pause'|'resume'|'stop') => void} props.onAction - run one of the three commands.
     * @returns {object} the modal element.
     */
    function RunDialog({ snapshot, tasks, busy, onClose, onAction }) {
      const phase = snapshot.phase === 'paused' ? 'paused' : 'running'
      const change = named(snapshot.change)
      const cwd = named(snapshot.cwd)
      const read = readOf(tasks)
      const reading = progressOf(read !== null && read.status === 'ready' ? read.body : null)
        ?? progressOf(snapshot)

      const head = React.createElement('div', { className: 'tls_runHead' },
        React.createElement('div', { className: 'tls_runTitles' },
          React.createElement('span', { className: 'tls_runName' }, change ?? COPY.dialogUnknown),
          React.createElement('span', {
            className: 'tls_runPath',
            title: cwd ?? undefined,
          }, cwd ?? COPY.dialogUnknown)),
        React.createElement('span', { className: 'tls_phase', 'data-state': phase },
          React.createElement('span', { className: 'tls_phaseDot', 'aria-hidden': 'true' }),
          phase === 'paused' ? COPY.badgePaused : COPY.badgeRunning))

      // The bar is a progress meter, so it carries the value in attributes as
      // well as in width: a screen reader gets the numbers even though the fill
      // is only a colour. The text under it is the same pair in words.
      const bar = reading === null ? null : React.createElement('div', { className: 'tls_progress' },
        React.createElement('div', {
          className: 'tls_bar',
          role: 'progressbar',
          'aria-label': COPY.progressLabel,
          'aria-valuemin': 0,
          'aria-valuemax': reading.total,
          'aria-valuenow': reading.complete,
          'aria-valuetext': progressText(reading),
        }, React.createElement('div', {
          className: 'tls_barFill',
          style: { width: (Math.min(100, (reading.complete / reading.total) * 100)) + '%' },
        })),
        React.createElement('p', { className: 'tls_barText' }, progressText(reading)))

      // The list's section is drawn in all three states of the read, so the body
      // never grows or loses a heading while the answer arrives (task 8.3).
      const body = TaskBody(read, snapshot.task)

      return React.createElement(Modal, {
        open: true,
        onClose,
        title: COPY.dialogTitle,
        closeLabel: COPY.dialogClose,
        footer: React.createElement(React.Fragment, null,
          React.createElement(Button, {
            variant: 'primary',
            disabled: busy,
            onClick: () => { onAction(phase === 'paused' ? 'resume' : 'pause') },
          }, phase === 'paused' ? COPY.resumeAction : COPY.pauseAction),
          React.createElement(Button, {
            variant: 'outline',
            disabled: busy,
            onClick: () => { onAction('stop') },
          }, COPY.stopAction)),
      },
        React.createElement('div', { className: 'tls_run' }, head, bar, body))
    }

    /**
     * The run badge: one pill in the session header, or nothing (task 8.1),
     * with the run panel behind it (task 8.2).
     *
     * `null` state means "nothing is known yet": the first poll is on its way, and
     * the header stays empty rather than blinking a pill that may not be true. The
     * poll is one interval per mounted header — the badge's own — and the cleanup
     * clears it, so a closed session stops asking at once instead of leaving a
     * timer behind for the life of the page.
     *
     * A failed poll hides the badge as well. An unreachable host means the phase
     * cannot be told, and a phase kept from the last answer would be a claim about
     * a run this client can no longer see — which is exactly what a host restart
     * under an open page looks like. The same rule closes the panel: it belongs to
     * a run, so a run that ends takes it away and a run that starts later must be
     * asked for again rather than inherit an open panel from the previous one.
     *
     * The button carries the phase in `data-state` (so the sheet colours it) and in
     * its accessible name (so a screen reader hears it); the dot is decoration and
     * the visible label is the same sentence in short.
     *
     * The panel's list is read on open and again when the run's current task
     * changes (design D9): a run that keeps working while the panel is open would
     * otherwise leave the rows, the ticks and the bar behind. The task's line in
     * `tasks.md` is what the two answers can agree on.
     *
     * Every read is kept as the state it ended in (task 8.3), not as a body that
     * happens to be empty: `null` while it is on its way, `{ status: 'unavailable' }`
     * when the host refused it — the route's 503, whose sentence travels with it —
     * and `{ status: 'ready', body }` when it answered. A refused read that was
     * stored as "no list" would be drawn as an empty change, which is the one thing
     * the spec says the panel must not do.
     *
     * Closing the panel returns focus to the badge. `Modal` restores the element
     * that had focus when the layer opened, which is the badge after a keyboard
     * open but not after a click: browsers that refuse focus to a clicked button
     * leave `body` as the active element, and the layer would restore focus to
     * `body`. So the badge takes focus itself when the panel goes away — after the
     * layer unmounts, which is what an effect on `open` is — and both paths end on
     * the control that opened the panel.
     *
     * @returns {object} the pill and the panel, or an empty fragment while there
     *   is no run.
     */
    function RunBadge() {
      const [state, setState] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [tasks, setTasks] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      /**
       * Take one `/state` answer, and close the panel when it reports no run.
       *
       * Both the poll and an action's answer land here: a stop pressed in the
       * panel answers `{ active: false }` exactly as the next poll would, and the
       * panel must leave in either case.
       *
       * @param {unknown} body - the `/state` body.
       */
      const accept = (body) => {
        setState(body)
        if (body === null || typeof body !== 'object' || body.active !== true) setOpen(false)
      }

      React.useEffect(() => {
        let live = true
        const poll = () => {
          fetch(STATE_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
            .then((answer) => (answer.ok ? answer.json() : null))
            .then((body) => { if (live) accept(body) })
            .catch(() => { if (live) accept(null) })
        }
        poll()
        const timer = setInterval(poll, POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [])

      const current = state !== null && typeof state === 'object' && state.active === true
        ? state.task
        : undefined
      const refreshKey = open && current !== null && typeof current === 'object' ? current.line : null

      React.useEffect(() => {
        if (!open) {
          // The next open starts from a fresh read: a list kept from the previous
          // open would describe a run that has moved on since.
          setTasks(null)
          return undefined
        }
        let live = true
        fetch(TASKS_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
          // The answer's status is read before its body: a 503 carries the host's
          // sentence and no list at all (task 8.3), so the two branches are taken
          // apart here rather than by noticing that a body has no `tasks` field.
          .then((answer) => answer.json()
            .then((body) => ({ ok: answer.ok === true, body }))
            .catch(() => ({ ok: false, body: null })))
          .then((answer) => {
            if (!live) return
            setTasks(answer.ok
              ? { status: 'ready', body: answer.body }
              : { status: 'unavailable', reason: reasonOf(answer.body) })
          })
          .catch(() => { if (live) setTasks({ status: 'unavailable', reason: null }) })
        return () => { live = false }
      }, [open, refreshKey])

      const badge = React.useRef(null)
      const wasOpen = React.useRef(false)

      React.useEffect(() => {
        // `badge.current` is null while the run has no pill — a stop removes it in
        // the same answer that closes the panel — and then there is nothing to go
        // back to, which is the correct outcome rather than a focus call on a
        // detached node.
        if (wasOpen.current && !open && badge.current !== null) badge.current.focus()
        wasOpen.current = open
      }, [open])

      /**
       * Send one of the three commands and show the phase it produced (task 8.2).
       *
       * The action is the route's, so the button *is* `/taskloop pause` (design
       * D8): no pause logic lives in the browser. The buttons wait for the answer
       * — a second press while one is in flight would ask for a second decision —
       * and the answer's snapshot is taken after the action settled, so the panel
       * shows the new phase without waiting for the next poll.
       *
       * @param {'pause'|'resume'|'stop'} action - the command to run.
       */
      const act = (action) => {
        if (busy) return
        setBusy(true)
        fetch(ACTION_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ action }),
        })
          .then((answer) => (answer.ok ? answer.json() : null))
          .then((payload) => {
            if (payload !== null && typeof payload === 'object' && payload.state !== undefined) {
              accept(payload.state)
            }
          })
          .catch(() => {})
          .finally(() => { setBusy(false) })
      }

      const view = badgeView(state)
      if (view === null) {
        // The empty fragment, not `null`: the slot expects an element from every
        // registration, and a fragment is "no nodes" of an accepted type.
        return React.createElement(React.Fragment, null)
      }

      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          ref: badge,
          type: 'button',
          className: 'tls_badge',
          'data-state': view.phase,
          'aria-label': view.ariaLabel,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          title: view.ariaLabel,
          onClick: () => { setOpen(true) },
        },
          React.createElement('span', { className: 'tls_badgeDot', 'aria-hidden': 'true' }),
          React.createElement('span', { className: 'tls_badgeLabel' }, view.label)),
        open
          ? React.createElement(RunDialog, {
            snapshot: state,
            tasks,
            busy,
            onClose: () => { setOpen(false) },
            onAction: act,
          })
          : null)
    }

    /**
     * One settings row: the visible label beside its control, the hint below.
     *
     * The control carries the same text as its own accessible name, so the row
     * reads as one labelled control rather than a heading plus a mystery switch.
     *
     * @param {object} props
     * @param {string} props.label - visible row label.
     * @param {object} props.control - the switch or segmented control element.
     * @param {string} [props.hint] - explanation under the row.
     * @returns {object} the row element.
     */
    function Row({ label, control, hint }) {
      return React.createElement('div', { className: 'tls_row' },
        React.createElement('div', { className: 'tls_head' },
          React.createElement('span', null, label),
          control),
        hint === undefined ? null : React.createElement('p', { className: 'tls_hint' }, hint))
    }

    /**
     * One boolean row.
     *
     * @param {object} props
     * @param {string} props.label - row label and the switch's accessible name.
     * @param {string} [props.hint] - explanation under the row.
     * @param {boolean} props.checked - current value.
     * @param {boolean} props.disabled - whether the control refuses input.
     * @param {(next: boolean) => void} props.onChange - write the next value.
     * @returns {object} the row element.
     */
    function ToggleRow({ label, hint, checked, disabled, onChange }) {
      return React.createElement(Row, {
        label,
        hint,
        control: React.createElement(Switch, { checked, label, disabled, onChange }),
      })
    }

    /**
     * One numeric row: an input that keeps the text being typed until the write
     * lands, then falls back to the value the deployment holds.
     *
     * A number is written on blur or Enter, never on every keystroke: there is
     * no Save button, so a half-typed value would otherwise be stored and
     * applied by the next run. The draft lives until the write settles, so a
     * refused write leaves nothing behind — the input shows the snapshot again
     * and the page reports the refusal.
     *
     * @param {object} props
     * @param {string} props.id - input id.
     * @param {string} props.label - row label and the input's accessible name.
     * @param {string} [props.hint] - explanation under the row.
     * @param {number|null} props.value - value the deployment holds, in display units.
     * @param {number} props.min - smallest value the schema accepts.
     * @param {number} props.step - granularity the input offers.
     * @param {boolean} props.disabled - whether the input refuses input.
     * @param {(next: number) => (Promise<unknown>|undefined)} props.onCommit - write the parsed value.
     * @returns {object} the row element.
     */
    function NumberRow({ id, label, hint, value, min, step, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(null)
      const shown = draft === null
        ? (typeof value === 'number' && Number.isFinite(value) ? String(value) : '')
        : draft

      /**
       * Write the typed number, unless it is unchanged or not a number at all.
       *
       * An empty or unparsable field is a draft that cannot land: it is dropped
       * without a write, which is also what keeps `NaN` out of the config.
       */
      const commit = () => {
        if (draft === null) return
        const text = draft.trim()
        const next = text === '' ? Number.NaN : Number(text)
        if (!Number.isFinite(next) || next === value) {
          setDraft(null)
          return
        }
        const settled = onCommit(next)
        if (settled === undefined) {
          setDraft(null)
          return
        }
        Promise.resolve(settled).finally(() => { setDraft(null) })
      }

      return React.createElement(Row, {
        label,
        hint,
        control: React.createElement(Input, {
          id,
          className: 'tls_num',
          type: 'number',
          min,
          step,
          value: shown,
          'aria-label': label,
          disabled,
          onChange: (event) => { setDraft(event.target.value) },
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') commit() },
        }),
      })
    }

    /**
     * The waits one transition would make, in milliseconds.
     *
     * This is the rule `delayBefore` in `lib/compaction.js` applies (design D2),
     * restated because the client half cannot import the host module: zero
     * `maxDelayMs` means no ceiling at all, and a positive ceiling is raised to
     * at least the first wait, so a profile ceiling cannot shorten it. The first
     * call waits for nothing, which is why four attempts are three waits.
     *
     * @param {number} attempts - calls to compaction, the first one included.
     * @param {number} delayMs - first wait, in milliseconds.
     * @param {number} factor - multiplier between waits.
     * @param {number} maxDelayMs - ceiling for one wait; `0` means none.
     * @returns {number[]} the waits between calls, in order.
     */
    function pausesOf(attempts, delayMs, factor, maxDelayMs) {
      const calls = Math.max(1, Math.trunc(attempts))
      const ceiling = maxDelayMs > 0 ? Math.max(maxDelayMs, delayMs) : Infinity
      const pauses = []
      for (let attempt = 1; attempt < calls; attempt += 1) {
        pauses.push(Math.min(delayMs * factor ** (attempt - 1), ceiling))
      }
      return pauses
    }

    /**
     * One wait as the page shows it: seconds, with milliseconds below a second.
     *
     * @param {number} ms - the wait, in milliseconds.
     * @returns {string} the wait in display units.
     */
    function formatPause(ms) {
      if (ms === 0) return '0с'
      if (ms < 1000) return Math.round(ms) + 'мс'
      const seconds = ms / 1000
      return (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)) + 'с'
    }

    /**
     * The worst-case total as minutes and seconds: 190 s reads as `3m10s`.
     *
     * @param {number} ms - the sum of every wait, in milliseconds.
     * @returns {string} the total in display units.
     */
    function formatTotal(ms) {
      const total = Math.round(ms / 1000)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return hours + 'h' + (minutes > 0 ? minutes + 'm' : '') + (seconds > 0 ? seconds + 's' : '')
      if (minutes > 0) return minutes + 'm' + (seconds > 0 ? seconds + 's' : '')
      return seconds + 's'
    }

    /**
     * The forecast sentence under the three retry numbers.
     *
     * @param {number[]} pauses - waits between calls, in milliseconds.
     * @returns {string} the sentence the page shows.
     */
    function scheduleLine(pauses) {
      if (pauses.length === 0) return COPY.retryScheduleNone
      const total = pauses.reduce((sum, ms) => sum + ms, 0)
      return COPY.retrySchedulePrefix
        + pauses.map(formatPause).join(' → ')
        + COPY.retryScheduleTotal + formatTotal(total) + '.'
    }

    /**
     * The line that explains why the controls cannot be used, or null while they can.
     *
     * A namespace the deployment does not serve and one it serves read-only look
     * the same on screen (greyed controls) but mean different things, so they get
     * different sentences.
     *
     * @param {object} snapshot - the form snapshot.
     * @returns {object|null} the note element.
     */
    function statusNote(snapshot) {
      if (snapshot.status === 'loading') return React.createElement('p', { className: 'tls_note' }, COPY.loading)
      if (snapshot.status !== 'ready') return React.createElement('p', { className: 'tls_note' }, COPY.unavailable)
      if (snapshot.writable !== true) return React.createElement('p', { className: 'tls_note' }, COPY.readOnly)
      return null
    }

    /**
     * The Settings page: eleven controls over this plugin's config block.
     *
     * The form is the shared `configForms` entry for {@link CONFIG_ENTRY}, so a
     * value changed here is the value the next run snapshots — no reload and no
     * Harness restart (D12). Every write is immediate: there is no Save button,
     * and a refused write puts the deployment's values back on screen instead of
     * keeping a draft the user cannot land.
     *
     * Under the three retry numbers the page shows what those numbers buy: the
     * waits the next transition would make and their worst-case total (D4), so
     * the price of a run is on screen before the run pays it.
     *
     * @param {object} props
     * @param {object} props.form - the config form of this plugin's entry.
     * @returns {object} the page element.
     */
    function SettingsPage({ form }) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(null)
      React.useEffect(() => form.subscribe(() => { setSnapshot(form.getSnapshot()) }), [])

      const value = snapshot.value ?? {}
      const ready = snapshot.status === 'ready' && snapshot.writable === true
      const disabled = !ready || busy

      /**
       * Write one field and report a refusal in the page itself.
       *
       * `mutate`, not `set`: every field of this schema is nested one level
       * below the entry (`commit.enabled`, not `commitEnabled`).
       *
       * @param {string[]} path - field path inside the entry.
       * @param {unknown} next - value to store.
       * @returns {Promise<void>|undefined} settles when the write does, so a
       *   numeric field can hold its draft until the answer is known.
       */
      const write = (path, next) => {
        // A control is disabled exactly when this is false, so the guard only
        // catches a handler that outlived the snapshot it was rendered with.
        if (!ready) return undefined
        setBusy(true)
        setFailed(null)
        return Promise.resolve(form.mutate([{ op: 'set', path, value: next }]))
          .then((accepted) => { if (accepted !== true) setFailed(COPY.refused) })
          .catch((cause) => { setFailed(COPY.failed + String(cause?.message ?? cause)) })
          .finally(() => { setBusy(false) })
      }

      const tool = value.commit?.tool === 'gitbutler' ? 'gitbutler' : 'git'
      const onFailure = value.compaction?.onFailure === 'continue' ? 'continue' : 'break'
      const retry = value.compaction?.retry ?? {}
      const retryAttempts = typeof retry.attempts === 'number' ? retry.attempts : null
      const retryDelay = typeof retry.delayMs === 'number' ? retry.delayMs / 1000 : null
      const retryFactor = typeof retry.factor === 'number' ? retry.factor : null
      const forecast = typeof retry.attempts === 'number'
        && typeof retry.delayMs === 'number'
        && typeof retry.factor === 'number'
        ? scheduleLine(pausesOf(retry.attempts, retry.delayMs, retry.factor, retry.maxDelayMs ?? 0))
        : null

      return React.createElement('div', { className: 'tls_page' },
        React.createElement('div', null,
          React.createElement('h2', { className: 'tls_title' }, COPY.title),
          React.createElement('p', { className: 'tls_desc' }, COPY.description)),
        statusNote(snapshot),
        failed === null ? null : React.createElement('p', { className: 'tls_error', role: 'alert' }, failed),
        React.createElement('div', { className: 'tls_rows' },
          React.createElement(ToggleRow, {
            label: COPY.commitEnabled,
            hint: COPY.commitEnabledHint,
            checked: value.commit?.enabled === true,
            disabled,
            onChange: (next) => { write(['commit', 'enabled'], next) },
          }),
          React.createElement(ToggleRow, {
            label: COPY.commitOpenspec,
            hint: COPY.commitOpenspecHint,
            checked: value.commit?.openspec === true,
            disabled,
            onChange: (next) => { write(['commit', 'openspec'], next) },
          }),
          React.createElement(Row, {
            label: COPY.commitTool,
            hint: COPY.commitToolHint,
            control: React.createElement(SegmentedControl, {
              id: 'openspec-taskloop-commit-tool',
              value: tool,
              options: [
                { value: 'git', label: COPY.git },
                { value: 'gitbutler', label: COPY.gitbutler },
              ],
              label: COPY.commitTool,
              disabled,
              onChange: (next) => { write(['commit', 'tool'], next) },
            }),
          }),
          React.createElement(ToggleRow, {
            label: COPY.reviewEnabled,
            hint: COPY.reviewEnabledHint,
            checked: value.review?.enabled === true,
            disabled,
            onChange: (next) => { write(['review', 'enabled'], next) },
          }),
          React.createElement(ToggleRow, {
            label: COPY.boundaryEnabled,
            hint: COPY.boundaryEnabledHint,
            checked: value.boundary?.enabled === true,
            disabled,
            onChange: (next) => { write(['boundary', 'enabled'], next) },
          }),
          React.createElement(ToggleRow, {
            label: COPY.midTask,
            hint: COPY.midTaskHint,
            checked: value.compaction?.midTask === true,
            disabled,
            onChange: (next) => { write(['compaction', 'midTask'], next) },
          }),
          React.createElement(ToggleRow, {
            label: COPY.systemSection,
            hint: COPY.systemSectionHint,
            checked: value.protocol?.systemSection === true,
            disabled,
            onChange: (next) => { write(['protocol', 'systemSection'], next) },
          }),
          React.createElement(Row, {
            label: COPY.onFailure,
            hint: COPY.onFailureHint,
            control: React.createElement(SegmentedControl, {
              id: 'openspec-taskloop-compaction-on-failure',
              value: onFailure,
              options: [
                { value: 'break', label: COPY.break },
                { value: 'continue', label: COPY.continue },
              ],
              label: COPY.onFailure,
              disabled,
              onChange: (next) => { write(['compaction', 'onFailure'], next) },
            }),
          }),
          React.createElement(NumberRow, {
            id: 'openspec-taskloop-retry-attempts',
            label: COPY.retryAttempts,
            hint: COPY.retryAttemptsHint,
            value: retryAttempts,
            min: 1,
            step: 1,
            disabled,
            onCommit: (next) => write(['compaction', 'retry', 'attempts'], next),
          }),
          React.createElement(NumberRow, {
            id: 'openspec-taskloop-retry-delay',
            label: COPY.retryDelay,
            hint: COPY.retryDelayHint,
            value: retryDelay,
            min: 0,
            step: 1,
            disabled,
            onCommit: (seconds) => write(['compaction', 'retry', 'delayMs'], Math.round(seconds * 1000)),
          }),
          React.createElement(NumberRow, {
            id: 'openspec-taskloop-retry-factor',
            label: COPY.retryFactor,
            hint: COPY.retryFactorHint,
            value: retryFactor,
            min: 1,
            step: 0.1,
            disabled,
            onCommit: (next) => write(['compaction', 'retry', 'factor'], next),
          }),
          forecast === null ? null : React.createElement('p', { className: 'tls_forecast' }, forecast)))
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'configForms']

    /**
     * Mount the plugin's two contributions: the run badge and the Settings page.
     *
     * Both go through `slots.inject`, which waits for the slot type the shell
     * declares at runtime, so the plugin can load before Settings is ever opened
     * and before a session header is drawn. Each registration is owned by its own
     * `ctx.effect`: unloading the plugin takes both away, and the header never
     * keeps a badge for a plugin that is gone.
     *
     * The form is bound once, at apply time: `configForms.get` returns the one
     * controller every editor of this entry shares, and its snapshot carries the
     * deployment's values from then on.
     *
     * @param {object} ctx - browser plugin context.
     */
    function apply(ctx) {
      const form = ctx.configForms.get(CONFIG_ENTRY)
      const Page = (props) => SettingsPage({ ...props, form })
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: SECTION_LABEL,
      }, Page)), 'openspec-taskloop: settings page')
      ctx.effect(() => ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
        name: HEADER_SLOT,
        id: BADGE_ID,
        order: BADGE_ORDER,
      }, RunBadge)), 'openspec-taskloop: run badge')
    }

    exports.apply = apply
    exports.inject = inject

    return module.exports
  },
})
