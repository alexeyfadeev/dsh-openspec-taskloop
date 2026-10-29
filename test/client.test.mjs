// The Settings page (task 2.2).
//
// The page is the plugin's only client code, and it is plain module-loader CJS
// with no build step: the host serves `lib/client.js` as the package's `/client`
// bundle, and the factory receives a `require` over the platform seed words.
// This file therefore loads the real bundle the host loads — no copy of the page
// lives in the test — through `node:vm`, with three fakes standing in for the
// platform:
//
//   - `window.__ModuleLoader__` captures the factory registration;
//   - `require` answers `react` and `@deepseek-ai/dsh-client-ui-primitives`, the
//     two seed words the page uses;
//   - React itself is a hook runtime small enough to render the page without a
//     DOM, and the primitives become marker elements the test can find.
//
// What the tests pin: the page reaches the shell's `settings.section` list under
// the id and order design D12 fixes, it shows the values the config holds, each
// control writes its own field through the shared `configForms` entry with no
// Save button in between — a switch at once, a number on blur or Enter — and —
// the last test — every row the page renders is named in the README the way the
// page names it (task 2.4).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const bundleSource = readFileSync(bundlePath, 'utf8')

/** The config entry the page edits: the plugin row id in cordis.patch.yml. */
const CONFIG_ENTRY = 'openspec-taskloop'

/** A resolved config block, with every field set away from its default. */
const VALUE = {
  commit: { enabled: false, tool: 'gitbutler' },
  review: { enabled: false },
  pause: { enabled: true },
  compaction: {
    midTask: true,
    onFailure: 'continue',
    retry: { attempts: 5, delayMs: 20000, factor: 2 },
  },
  protocol: { systemSection: true },
}

/**
 * A hook runtime over plain objects: `createElement`, `useState`, `useEffect`.
 *
 * Effects run once, after the first render — the page subscribes with an empty
 * dependency list, and re-subscribing on every state change would only pile up
 * listeners the real React would have dropped.
 *
 * @returns {object} the fake React, a renderer, and a disposer.
 */
function createHooks() {
  const states = []
  const cleanups = []
  let cursor = 0
  let queued = []
  let mounted = false

  const createElement = (type, props, ...children) => {
    const element = { type, props: { ...(props ?? {}) } }
    if (children.length === 1) element.props.children = children[0]
    else if (children.length > 1) element.props.children = children
    return element
  }

  const React = {
    createElement,
    useState(initial) {
      const at = cursor++
      if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial
      return [states[at], (next) => { states[at] = typeof next === 'function' ? next(states[at]) : next }]
    },
    useEffect(effect) {
      if (mounted) return
      queued.push(effect)
    },
  }

  return {
    React,
    /**
     * Render one component and return the host elements it produced.
     *
     * @param {Function} component - the registered page component.
     * @param {object} props - the props the shell passes.
     * @returns {object[]} every host element, with function components expanded.
     */
    render(component, props) {
      cursor = 0
      queued = []
      const found = elements(component(props))
      if (!mounted) {
        mounted = true
        for (const effect of queued) {
          const cleanup = effect()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        }
      }
      return found
    },
    /** Release the subscriptions the page's effects opened. */
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

/**
 * Flatten a rendered tree into host elements, expanding function components.
 *
 * @param {unknown} node - element, array, string or nothing.
 * @param {object[]} [found] - accumulator.
 * @returns {object[]} the host elements, in render order.
 */
function elements(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found)
    return found
  }
  if (typeof node !== 'object') return found
  if (typeof node.type === 'function') return elements(node.type(node.props), found)
  found.push(node)
  return elements(node.props.children, found)
}

/**
 * The shared `configForms` entry of one config block, as the page sees it.
 *
 * Writes are recorded in host-realm shapes — the page's arrays come from the
 * `vm` context, and a prototype-mismatched deep comparison would fail on a
 * perfectly correct write.
 *
 * @param {object} state - `status`, `writable`, `value`, and optionally `accept`.
 * @returns {object} the fake form.
 */
function createForm(state) {
  const writes = []
  const listeners = new Set()
  return {
    writes,
    /**
     * Replace the deployment's answer and notify every editor.
     *
     * @param {object} next - fields to change on the state.
     */
    set(next) {
      Object.assign(state, next)
      for (const listener of listeners) listener()
    },
    /** @returns {object} a fresh snapshot, as the real form returns. */
    getSnapshot() {
      return {
        status: state.status,
        value: state.value,
        base: {},
        user: {},
        revision: state.revision ?? 1,
        writable: state.writable,
      }
    },
    /**
     * @param {Function} listener - subscriber.
     * @returns {Function} the disposer.
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /**
     * @param {object[]} ops - the write operations the page queued.
     * @returns {Promise<boolean>} whether the deployment accepted them.
     */
    mutate(ops) {
      writes.push(Array.from(ops, (op) => ({ op: op.op, path: Array.from(op.path), value: op.value })))
      return Promise.resolve(state.accept ?? true)
    },
  }
}

/**
 * Load the real bundle the host serves and materialize its factory.
 *
 * @param {object} form - the fake config form the page will be given.
 * @returns {object} the bundle exports and the hook runtime.
 */
function loadBundle(form) {
  const hooks = createHooks()
  const primitives = {
    Switch: (props) => hooks.React.createElement('switch', props),
    SegmentedControl: (props) => hooks.React.createElement('segmented', props),
    Input: (props) => hooks.React.createElement('input', props),
  }
  const registrations = []
  const window = { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } }
  const require = (specifier) => {
    if (specifier === 'react') return hooks.React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`the page required a module outside the platform seed: ${specifier}`)
  }

  runInContext(bundleSource, createContext({ window, require }), { filename: bundlePath })
  assert.equal(registrations.length, 1, 'the bundle registers exactly one factory')
  const [registration] = registrations
  assert.equal(registration.id, 'dsh-openspec-taskloop', 'the factory id is the package name')

  return { registration, exports: registration.factory(require), hooks, form }
}

/**
 * A browser plugin context with the two services the page injects.
 *
 * `slots.inject` runs its callback at once, which is what the real service does
 * once the settings shell has declared the slot type.
 *
 * @param {object} form - the fake config form.
 * @returns {object} the context and what it was asked to do.
 */
function createCtx(form) {
  const entries = []
  const injected = []
  const registrations = []
  const effects = []
  const disposers = []
  const ctx = {
    configForms: {
      get(entry) {
        entries.push(entry)
        return form
      },
    },
    slots: {
      inject(name, callback) {
        injected.push(name)
        const dispose = callback()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect(callback, label) {
      effects.push(label)
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  return { ctx, entries, injected, registrations, effects, disposers }
}

/**
 * Mount the page the way the loader does, and expose its renderer.
 *
 * @param {object} form - the fake config form.
 * @returns {object} the mounted page and its bookkeeping.
 */
function mount(form) {
  const loaded = loadBundle(form)
  const mounted = createCtx(form)
  loaded.exports.apply(mounted.ctx)
  const [entry] = mounted.registrations
  return {
    ...mounted,
    loaded,
    entry,
    form,
    render: () => loaded.hooks.render(entry.component, { close() {} }),
  }
}

/** Let the write promises settle. */
function settle() {
  return new Promise((resolve) => { setImmediate(resolve) })
}

/** The switches of a rendered page, in render order. */
function switchesOf(nodes) {
  return nodes.filter((node) => node.type === 'switch')
}

/** The segmented controls of a rendered page, in render order. */
function segmentsOf(nodes) {
  return nodes.filter((node) => node.type === 'segmented')
}

/** The numeric inputs of a rendered page, in render order. */
function inputsOf(nodes) {
  return nodes.filter((node) => node.type === 'input')
}

/**
 * The one control whose accessible name matches.
 *
 * @param {object[]} nodes - control elements.
 * @param {string} label - accessible name, which is also the row label.
 * @returns {object} the matched element.
 */
function controlLabelled(nodes, label) {
  const matches = nodes.filter((node) => node.props.label === label)
  assert.equal(matches.length, 1, `exactly one control is labelled "${label}"`)
  return matches[0]
}

/**
 * The one numeric input whose accessible name matches.
 *
 * @param {object[]} nodes - input elements.
 * @param {string} label - accessible name, which is also the row label.
 * @returns {object} the matched element.
 */
function inputLabelled(nodes, label) {
  const matches = nodes.filter((node) => node.props['aria-label'] === label)
  assert.equal(matches.length, 1, `exactly one input is labelled "${label}"`)
  return matches[0]
}

test('apply mounts the page into settings.section under the designed identity', () => {
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }))
  const { exports } = page.loaded

  assert.equal(typeof exports.apply, 'function', 'the client half activates through apply')
  assert.deepEqual(Array.from(exports.inject), ['slots', 'configForms'], 'the page waits for the slot registry and the config forms')

  assert.deepEqual(Array.from(page.entries), [CONFIG_ENTRY], 'the page edits the plugin\'s own config block')
  assert.deepEqual(Array.from(page.injected), ['settings.section'], 'the page is a section of the settings shell')

  assert.equal(page.registrations.length, 1, 'one page, one registration')
  const { options } = page.entry
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'openspec-taskloop', 'the nav row is addressed by this id')
  assert.equal(options.label, 'OpenSpec Taskloop', 'the nav row reads the name the design fixes')
  assert.ok(options.order > 10, 'the page sits after Models (order 10)')
  assert.ok(options.order < 15, 'the page sits ahead of the Plugins section (order 15)')

  assert.equal(page.effects.length, 1, 'the registration is owned by one effect, so it leaves with the plugin')
  assert.match(page.effects[0], /settings page/u, 'the effect is named for what it owns')
})

test('the page shows the seven switches and choices the config holds', () => {
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }))
  const nodes = page.render()
  const switches = switchesOf(nodes)
  const segments = segmentsOf(nodes)

  assert.equal(switches.length, 5, 'five settings are switches')
  assert.equal(segments.length, 2, 'two settings are choices')

  assert.equal(controlLabelled(switches, 'Commit after each task group').props.checked, false)
  assert.equal(controlLabelled(switches, 'Code review after each task group').props.checked, false)
  assert.equal(controlLabelled(switches, 'Pause after each task group').props.checked, true)
  assert.equal(controlLabelled(switches, 'Compact inside a task').props.checked, true)
  assert.equal(controlLabelled(switches, 'Protocol section').props.checked, true)

  const tool = controlLabelled(segments, 'Commit tool')
  assert.equal(tool.props.value, 'gitbutler', 'the tool the config names is the one selected')
  assert.deepEqual(Array.from(tool.props.options, (option) => option.value), ['git', 'gitbutler'])

  const onFailure = controlLabelled(segments, 'When the compaction budget runs out')
  assert.equal(onFailure.props.value, 'continue', 'the policy the config names is the one selected')
  assert.deepEqual(Array.from(onFailure.props.options, (option) => option.value), ['break', 'continue'])

  for (const node of [...switches, ...segments]) {
    assert.equal(node.props.disabled, false, 'a writable deployment leaves every control usable')
  }
})

test('each control writes its own field, with no Save button in between', async () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE })
  const page = mount(form)
  const nodes = page.render()

  controlLabelled(switchesOf(nodes), 'Commit after each task group').props.onChange(true)
  controlLabelled(segmentsOf(nodes), 'Commit tool').props.onChange('git')
  controlLabelled(switchesOf(nodes), 'Code review after each task group').props.onChange(true)
  controlLabelled(switchesOf(nodes), 'Pause after each task group').props.onChange(false)
  controlLabelled(switchesOf(nodes), 'Compact inside a task').props.onChange(false)
  controlLabelled(segmentsOf(nodes), 'When the compaction budget runs out').props.onChange('break')
  controlLabelled(switchesOf(nodes), 'Protocol section').props.onChange(false)
  await settle()

  assert.deepEqual(form.writes, [
    [{ op: 'set', path: ['commit', 'enabled'], value: true }],
    [{ op: 'set', path: ['commit', 'tool'], value: 'git' }],
    [{ op: 'set', path: ['review', 'enabled'], value: true }],
    [{ op: 'set', path: ['pause', 'enabled'], value: false }],
    [{ op: 'set', path: ['compaction', 'midTask'], value: false }],
    [{ op: 'set', path: ['compaction', 'onFailure'], value: 'break' }],
    [{ op: 'set', path: ['protocol', 'systemSection'], value: false }],
  ], 'every control writes exactly its own field, in the order it was used')
})

test('the page shows the three retry numbers in the units the page promises', () => {
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }))
  const inputs = inputsOf(page.render())

  assert.equal(inputs.length, 3, 'three of the ten settings are numbers')

  assert.equal(inputLabelled(inputs, 'Compaction attempts').props.value, '5')
  assert.equal(
    inputLabelled(inputs, 'First retry wait (seconds)').props.value,
    '20',
    'the stored milliseconds are shown as seconds',
  )
  assert.equal(inputLabelled(inputs, 'Retry wait multiplier').props.value, '2')

  for (const node of inputs) {
    assert.equal(node.props.disabled, false, 'a writable deployment leaves every number usable')
  }
})

test('each retry number writes its own path on blur or Enter', async () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE })
  const page = mount(form)

  inputLabelled(inputsOf(page.render()), 'Compaction attempts').props.onChange({ target: { value: '6' } })
  assert.deepEqual(form.writes, [], 'a number is a draft while it is being typed')
  assert.equal(
    inputLabelled(inputsOf(page.render()), 'Compaction attempts').props.value,
    '6',
    'the typed text is on screen while it is a draft',
  )
  inputLabelled(inputsOf(page.render()), 'Compaction attempts').props.onBlur()
  await settle()

  inputLabelled(inputsOf(page.render()), 'First retry wait (seconds)').props.onChange({ target: { value: '25' } })
  inputLabelled(inputsOf(page.render()), 'First retry wait (seconds)').props.onKeyDown({ key: 'Enter' })
  await settle()

  inputLabelled(inputsOf(page.render()), 'Retry wait multiplier').props.onChange({ target: { value: '1.5' } })
  inputLabelled(inputsOf(page.render()), 'Retry wait multiplier').props.onBlur()
  await settle()

  assert.deepEqual(form.writes, [
    [{ op: 'set', path: ['compaction', 'retry', 'attempts'], value: 6 }],
    [{ op: 'set', path: ['compaction', 'retry', 'delayMs'], value: 25000 }],
    [{ op: 'set', path: ['compaction', 'retry', 'factor'], value: 1.5 }],
  ], 'each row writes its own path, and the delay is stored in milliseconds')
})

test('a refused retry number goes back to the snapshot value and says so', async () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE, accept: false })
  const page = mount(form)

  inputLabelled(inputsOf(page.render()), 'Compaction attempts').props.onChange({ target: { value: '0' } })
  inputLabelled(inputsOf(page.render()), 'Compaction attempts').props.onBlur()
  await settle()

  assert.deepEqual(form.writes, [
    [{ op: 'set', path: ['compaction', 'retry', 'attempts'], value: 0 }],
  ], 'the out-of-range value is offered to the deployment, which decides on it')

  const nodes = page.render()
  const alerts = nodes.filter((node) => node.props.role === 'alert')
  assert.equal(alerts.length, 1, 'the refusal is reported in the page')
  assert.match(String(alerts[0].props.children), /did not accept that value/u)
  assert.equal(
    inputLabelled(inputsOf(nodes), 'Compaction attempts').props.value,
    '5',
    'the field shows what the deployment holds, not the refused draft',
  )
})

test('the pause row is the seventh setting, and writes pause.enabled', async () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE })
  const page = mount(form)

  const labels = switchesOf(page.render()).map((node) => node.props.label)
  assert.deepEqual(labels, [
    'Commit after each task group',
    'Code review after each task group',
    'Pause after each task group',
    'Compact inside a task',
    'Protocol section',
  ], 'the pause row sits right after code review and ahead of compaction (D12)')

  controlLabelled(switchesOf(page.render()), 'Pause after each task group').props.onChange(false)
  await settle()
  assert.deepEqual(form.writes, [
    [{ op: 'set', path: ['pause', 'enabled'], value: false }],
  ], 'the pause switch writes pause.enabled and nothing else')

  form.set({ value: { ...VALUE, pause: { enabled: false } } })
  const after = controlLabelled(switchesOf(page.render()), 'Pause after each task group')
  assert.equal(after.props.checked, false, 'a value changed elsewhere reaches this row without a reload')
})

test('the page follows the form, so a value changed elsewhere lands without a reload', () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE })
  const page = mount(form)

  const before = controlLabelled(switchesOf(page.render()), 'Commit after each task group')
  assert.equal(before.props.checked, false)

  form.set({ value: { ...VALUE, commit: { enabled: true, tool: 'git' } } })

  const after = controlLabelled(switchesOf(page.render()), 'Commit after each task group')
  assert.equal(after.props.checked, true, 'the subscription re-renders the page from the new snapshot')
  assert.equal(controlLabelled(segmentsOf(page.render()), 'Commit tool').props.value, 'git')
})

test('a deployment that cannot write says why and refuses input', async () => {
  const form = createForm({ status: 'unavailable', writable: false, value: undefined })
  const page = mount(form)
  const nodes = page.render()

  for (const node of [...switchesOf(nodes), ...segmentsOf(nodes), ...inputsOf(nodes)]) {
    assert.equal(node.props.disabled, true, 'an unserved namespace disables every control')
  }
  const notes = nodes.filter((node) => node.type === 'p' && node.props.className === 'tls_note')
  assert.equal(notes.length, 1, 'the page explains itself once')
  assert.match(String(notes[0].props.children), /does not serve these settings/u)

  controlLabelled(switchesOf(nodes), 'Commit after each task group').props.onChange(true)
  inputLabelled(inputsOf(nodes), 'Compaction attempts').props.onChange({ target: { value: '6' } })
  inputLabelled(inputsOf(page.render()), 'Compaction attempts').props.onBlur()
  await settle()
  assert.deepEqual(form.writes, [], 'a disabled control never writes')
})

test('a read-only deployment is distinguished from an unserved one', () => {
  const form = createForm({ status: 'ready', writable: false, value: VALUE })
  const nodes = mount(form).render()

  const notes = nodes.filter((node) => node.type === 'p' && node.props.className === 'tls_note')
  assert.equal(notes.length, 1)
  assert.match(String(notes[0].props.children), /read-only/u)

  for (const node of [...switchesOf(nodes), ...segmentsOf(nodes), ...inputsOf(nodes)]) {
    assert.equal(node.props.disabled, true)
  }
})

test('a refused write puts the deployment\'s values back on screen', async () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE, accept: false })
  const page = mount(form)

  controlLabelled(switchesOf(page.render()), 'Commit after each task group').props.onChange(true)
  await settle()

  const alerts = page.render().filter((node) => node.props.role === 'alert')
  assert.equal(alerts.length, 1, 'the refusal is reported in the page')
  assert.match(String(alerts[0].props.children), /did not accept that value/u)

  const after = controlLabelled(switchesOf(page.render()), 'Commit after each task group')
  assert.equal(after.props.checked, false, 'the page keeps showing what the deployment holds, not a draft')
})

/** The forecast line under the retry numbers. */
function forecastOf(nodes) {
  const matches = nodes.filter((node) => node.props.className === 'tls_forecast')
  assert.equal(matches.length, 1, 'the page forecasts the retry schedule exactly once')
  return matches[0]
}

test('the page forecasts the waits and their worst case under the retry numbers', () => {
  const value = {
    ...VALUE,
    compaction: { ...VALUE.compaction, retry: { attempts: 4, delayMs: 40000, factor: 1.5 } },
  }
  const page = mount(createForm({ status: 'ready', writable: true, value }))
  const nodes = page.render()
  const forecast = forecastOf(nodes)

  const text = String(forecast.props.children)
  assert.ok(text.includes('40с'), 'the first wait is the configured first pause')
  assert.ok(text.includes('60с'), 'the second wait grows by the multiplier')
  assert.ok(text.includes('90с'), 'the third wait grows again')
  assert.ok(text.includes('3m10s'), 'the worst case is every wait added up')

  const factor = nodes.indexOf(inputLabelled(inputsOf(nodes), 'Retry wait multiplier'))
  assert.ok(nodes.indexOf(forecast) > factor, 'the forecast sits under the numbers it describes')
})

test('the forecast follows the snapshot and honours a profile ceiling', () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE })
  const page = mount(form)

  assert.ok(String(forecastOf(page.render()).props.children).includes('20с'))

  form.set({
    value: { ...VALUE, compaction: { ...VALUE.compaction, retry: { attempts: 3, delayMs: 40000, factor: 2 } } },
  })
  assert.equal(
    String(forecastOf(page.render()).props.children),
    'Waits between calls: 40с → 80с; worst case 2m.',
    'a value changed elsewhere reaches the forecast without a reload',
  )

  form.set({
    value: {
      ...VALUE,
      compaction: { ...VALUE.compaction, retry: { attempts: 4, delayMs: 40000, factor: 1.5, maxDelayMs: 50000 } },
    },
  })
  assert.equal(
    String(forecastOf(page.render()).props.children),
    'Waits between calls: 40с → 50с → 50с; worst case 2m20s.',
    'a positive ceiling caps the growth and never drops below the first wait',
  )

  form.set({
    value: { ...VALUE, compaction: { ...VALUE.compaction, retry: { attempts: 1, delayMs: 40000, factor: 1.5 } } },
  })
  assert.match(
    String(forecastOf(page.render()).props.children),
    /No waits/u,
    'one attempt is one call, so there is nothing to wait for',
  )
})

test('the README names every settings row the way the page shows it', () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE })
  const page = mount(form)
  const nodes = page.render()
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8')

  const labels = [
    ...switchesOf(nodes).map((node) => node.props.label),
    ...segmentsOf(nodes).map((node) => node.props.label),
    ...inputsOf(nodes).map((node) => node.props['aria-label']),
  ]
  assert.equal(labels.length, 10, 'the page has ten settings, so the README documents ten')
  for (const label of labels) {
    assert.ok(readme.includes(label), `the README must name the row "${label}" exactly as the page does`)
  }

  // The documented defaults (4 / 40 s / 1.5, no ceiling), rendered by the page itself.
  form.set({
    value: {
      ...VALUE,
      compaction: { ...VALUE.compaction, retry: { attempts: 4, delayMs: 40000, factor: 1.5 } },
    },
  })
  const forecast = String(forecastOf(page.render()).props.children)
  assert.ok(
    readme.includes(forecast),
    'the README must quote the forecast line as the page prints it for the defaults',
  )
  assert.ok(
    readme.includes('No waits: this setting allows a single call'),
    'the README must quote the line the page prints for a single attempt',
  )
  assert.ok(
    readme.includes(page.entry.options.label),
    'the README must name the page the way its nav row does',
  )
})
