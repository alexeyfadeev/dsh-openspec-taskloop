// dsh-openspec-taskloop — client half: the Settings page.
//
// The host serves this file as the package's `/client` bundle: it reads the
// `dsh.client` declaration from package.json, resolves the entry through
// `exports["./client"]`, and registers the factory below. The factory body runs
// lazily on first use, so nothing here executes while the page boots.
//
// The bundle is plain module-loader CJS with no build step (design D12): the
// loader hands the factory a `require` that resolves the platform seed words
// (`react`, `@deepseek-ai/dsh-client-ui-primitives`) and the package rows the
// manifest's `dsh.client.inject` names.
//
// The page is one `settings.section` contribution — the same slot type the
// General and Models pages fill — and it edits exactly the eleven volatile
// fields of this plugin's own config block (D12; `add-compaction-retry-settings`
// D1; `add-commit-openspec-toggle` D6):
//
//   commit.enabled, commit.openspec, commit.tool, review.enabled, pause.enabled,
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
    const { Input, SegmentedControl, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Config entry the plugin's own block is served under (its row id). */
    const CONFIG_ENTRY = 'openspec-taskloop'

    /** Nav identity of the page, and the marker the shell filters sections by. */
    const SECTION_ID = 'openspec-taskloop'

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
      pauseEnabled: 'Pause after each task group',
      pauseEnabledHint:
        'End the run on the boundary of the group instead of handing the next group its own session: review '
        + 'and commit still run, then the report names the group that closed and the task the next /taskloop '
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
    }

    /** Style tag identity, so a reload replaces rather than stacks the sheet. */
    const CSS_ID = 'dsh-openspec-taskloop/settings-page.css'

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
            label: COPY.pauseEnabled,
            hint: COPY.pauseEnabledHint,
            checked: value.pause?.enabled === true,
            disabled,
            onChange: (next) => { write(['pause', 'enabled'], next) },
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
     * Mount the page into the shell's `settings.section` list.
     *
     * `slots.inject` waits for the slot type, which the settings shell declares
     * at runtime, so the plugin can load before Settings is ever opened.
     * `ctx.effect` owns the disposer: the nav row leaves with the plugin.
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
    }

    exports.apply = apply
    exports.inject = inject

    return module.exports
  },
})
