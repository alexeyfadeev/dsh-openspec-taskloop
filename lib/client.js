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
// General and Models pages fill — and it edits exactly the six volatile fields
// of this plugin's own config block (D12):
//
//   commit.enabled, commit.tool, review.enabled,
//   compaction.midTask, compaction.onFailure, protocol.systemSection
//
// Writes go straight through the shared `configForms` entry of that config
// block, so there is no Save button: a switch applies to the next `/taskloop`
// run without a reload. The block itself lands in the profile's
// cordis.patch.yml, which is why the entry id below is the plugin row id.
//
// Anything outside the six fields — `change`, the retry parameters and the
// `openspec` timeout — stays a profile decision: those are not volatile, so
// this form neither reads nor writes them (D12).

window.__ModuleLoader__.load({
  id: 'dsh-openspec-taskloop',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { SegmentedControl, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

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
      commitTool: 'Commit tool',
      commitToolHint: 'Plain git, or GitButler\'s but. Read at the moment of the commit, so switching it needs no restart.',
      git: 'Git',
      gitbutler: 'GitButler',
      reviewEnabled: 'Code review after each task group',
      reviewEnabledHint:
        'Review the group in a session of its own before the next group starts; findings reach you, the '
        + 'run keeps going.',
      midTask: 'Compact inside a task',
      midTaskHint: 'Ask for compaction by context pressure on a step boundary, not only between tasks.',
      onFailure: 'When the compaction budget runs out',
      onFailureHint: 'Break stops the run and says why; Continue records a warning in the report and goes on.',
      break: 'Break',
      continue: 'Continue',
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
     * The Settings page: six controls over this plugin's config block.
     *
     * The form is the shared `configForms` entry for {@link CONFIG_ENTRY}, so a
     * value changed here is the value the next run snapshots — no reload and no
     * Harness restart (D12). Every write is immediate: there is no Save button,
     * and a refused write puts the deployment's values back on screen instead of
     * keeping a draft the user cannot land.
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
       */
      const write = (path, next) => {
        // A control is disabled exactly when this is false, so the guard only
        // catches a handler that outlived the snapshot it was rendered with.
        if (!ready) return
        setBusy(true)
        setFailed(null)
        Promise.resolve(form.mutate([{ op: 'set', path, value: next }]))
          .then((accepted) => { if (accepted !== true) setFailed(COPY.refused) })
          .catch((cause) => { setFailed(COPY.failed + String(cause?.message ?? cause)) })
          .finally(() => { setBusy(false) })
      }

      const tool = value.commit?.tool === 'gitbutler' ? 'gitbutler' : 'git'
      const onFailure = value.compaction?.onFailure === 'continue' ? 'continue' : 'break'

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
            label: COPY.midTask,
            hint: COPY.midTaskHint,
            checked: value.compaction?.midTask === true,
            disabled,
            onChange: (next) => { write(['compaction', 'midTask'], next) },
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
          React.createElement(ToggleRow, {
            label: COPY.systemSection,
            hint: COPY.systemSectionHint,
            checked: value.protocol?.systemSection === true,
            disabled,
            onChange: (next) => { write(['protocol', 'systemSection'], next) },
          })))
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
