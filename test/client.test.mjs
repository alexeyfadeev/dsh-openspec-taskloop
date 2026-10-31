// The client half: the Settings page and the run badge.
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
//
// The badge (task 8.1) is covered the same way: its registration in the session
// header row, the two phase pills, the empty fragment while no run is reported,
// and the poll — one request at mount, then one every two seconds, with the
// interval cleared when the header goes away.
//
// The run panel behind the badge (task 8.2) is the same bundle again: the panel
// opens on the badge's click, reads the task list once per open and again when
// the run moves to another task, draws the workspace, the bar and the rows with
// the current task marked, and its buttons post the three actions the commands
// dispatch to — with the phase the answer carries, not the next poll's.
//
// The panel's body states (task 8.3) are the same read seen three ways: the
// reading note before the answer, the host's own sentence when it refused, and
// the rows — or a worded empty change — when it answered. Closing the panel
// returns focus to the badge, which is a `ref` the bundle keeps for that.

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

/** The three routes the client half reads and writes; they are the contract (design D8). */
const STATE_URL = '/api/openspec-taskloop/state'
const TASKS_URL = '/api/openspec-taskloop/tasks'
const ACTION_URL = '/api/openspec-taskloop/action'

/** Marker the fake React gives a fragment, so the renderer can expand it. */
const FRAGMENT = Symbol('Fragment')

/** A resolved config block, with every field set away from its default. */
const VALUE = {
  commit: { enabled: false, openspec: false, tool: 'gitbutler' },
  review: { enabled: false },
  boundary: { enabled: true },
  compaction: {
    midTask: true,
    onFailure: 'continue',
    retry: { attempts: 5, delayMs: 20000, factor: 2 },
  },
  protocol: { systemSection: true },
}

/**
 * The tracking file both the run and the list report, and the two tasks the
 * panel tests care about: the run is on the second of the three (task 8.2).
 */
const SOURCE = 'C:\\work\\_dsh\\dsh-openspec-taskloop\\openspec\\changes\\add-pause-resume-ui\\tasks.md'

/** The `/state` answer of a run that is working on line 46. */
const RUN = {
  active: true,
  phase: 'running',
  change: 'add-pause-resume-ui',
  cwd: 'C:\\work\\_dsh\\dsh-openspec-taskloop',
  task: { id: '21', description: '8.2 Собрать диалог', done: false, sourcePath: SOURCE, line: 46 },
  progress: { complete: 19, total: 24 },
  sessionId: 'session-1',
}

/** The `/tasks` answer: one CLI reading, ahead of the poll's counts. */
const TASKS = {
  change: 'add-pause-resume-ui',
  state: 'ready',
  progress: { total: 24, complete: 20, remaining: 4 },
  tasks: [
    { id: '1', description: '8.1 Зарегистрировать бейдж', done: true, sourcePath: SOURCE, line: 45 },
    { id: '2', description: '8.2 Собрать диалог', done: false, sourcePath: SOURCE, line: 46 },
    { id: '3', description: '8.3 Покрыть состояния тела', done: false, sourcePath: SOURCE, line: 47 },
  ],
}

/**
 * A hook runtime over plain objects: `createElement`, `useState`, `useEffect`, `useRef`.
 *
 * Effects follow React's rule, which the badge and the panel depend on: the ones
 * whose dependency list changed run after the tree is known, the rest do not. A
 * dependency list is optional, and an effect without one runs on every render.
 * Cleanups run when the effect re-runs, and `dispose()` runs whatever is left.
 * `useRef` is a box whose `current` outlives renders, which is what the badge's
 * ref to its own button is.
 *
 * @returns {object} the fake React, a renderer, and a disposer.
 */
function createHooks() {
  const hooks = []
  const pending = []
  let cursor = 0

  const createElement = (type, props, ...children) => {
    const element = { type, props: { ...(props ?? {}) } }
    if (children.length === 1) element.props.children = children[0]
    else if (children.length > 1) element.props.children = children
    return element
  }

  /**
   * Whether an effect's dependency list is unchanged since its last run.
   *
   * @param {unknown[]|undefined} left - deps it last ran with.
   * @param {unknown[]|undefined} right - deps of this render.
   * @returns {boolean} true when the effect may be skipped.
   */
  const sameDeps = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }

  const React = {
    createElement,
    Fragment: FRAGMENT,
    useState(initial) {
      const at = cursor++
      const hook = hooks[at] ?? (hooks[at] = { kind: 'state', ready: false, value: undefined })
      if (!hook.ready) {
        hook.value = typeof initial === 'function' ? initial() : initial
        hook.ready = true
      }
      return [hook.value, (next) => { hook.value = typeof next === 'function' ? next(hook.value) : next }]
    },
    useEffect(effect, deps) {
      const at = cursor++
      const hook = hooks[at] ?? (hooks[at] = { kind: 'effect', first: true, deps: undefined, cleanup: undefined })
      const changed = hook.first === true || !sameDeps(hook.deps, deps)
      hook.first = false
      hook.deps = deps
      if (changed) pending.push({ hook, effect })
    },
    useRef(initial) {
      const at = cursor++
      const hook = hooks[at] ?? (hooks[at] = { kind: 'ref', box: { current: initial } })
      return hook.box
    },
  }

  return {
    React,
    /**
     * Render one component and return the host elements it produced.
     *
     * @param {Function} component - the registered page or badge component.
     * @param {object} props - the props the shell passes.
     * @returns {object[]} every host element, with function components expanded.
     */
    render(component, props) {
      cursor = 0
      const found = elements(component(props))
      // React runs effects after the tree is committed, which is why the panel's
      // first render draws no list and the effect that reads one starts here.
      for (const item of pending.splice(0)) {
        if (typeof item.hook.cleanup === 'function') item.hook.cleanup()
        const cleanup = item.effect()
        item.hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
      return found
    },
    /** Release the subscriptions and timers the effects opened. */
    dispose() {
      for (const hook of hooks) {
        if (hook.kind === 'effect' && typeof hook.cleanup === 'function') {
          hook.cleanup()
          hook.cleanup = undefined
        }
      }
      pending.length = 0
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
  if (node.type === FRAGMENT) return elements(node.props.children, found)
  if (typeof node.type === 'function') return elements(node.type(node.props), found)
  // A host element stands in for a DOM node in the two ways this bundle uses
  // one: a `ref` lands on it, and it can be asked for focus, which is what the
  // badge does when its panel closes (task 8.3).
  node.focus = () => { node.focused = true }
  if (typeof node.props.ref === 'object' && node.props.ref !== null) node.props.ref.current = node
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
 * `env` carries the browser globals a contribution may reach for. The Settings
 * page needs none, so its tests leave it out; the badge polls the host, so its
 * tests hand over a fake `fetch` and a fake timer table instead of waiting two
 * seconds per tick.
 *
 * @param {object} form - the fake config form the page will be given.
 * @param {object} [env] - browser globals: `fetch`, `setInterval`, `clearInterval`.
 * @returns {object} the bundle exports and the hook runtime.
 */
function loadBundle(form, env = {}) {
  const hooks = createHooks()
  const primitives = {
    Switch: (props) => hooks.React.createElement('switch', props),
    SegmentedControl: (props) => hooks.React.createElement('segmented', props),
    Input: (props) => hooks.React.createElement('input', props),
    Button: (props) => hooks.React.createElement('button', props),
    // The real `Modal` portals its tree into `document.body` and returns nothing
    // while closed; the fake keeps the same two facts — closed means the children
    // are never rendered — and drops the portal, which a DOM-less test cannot use.
    Modal: (props) => (props.open === true
      ? hooks.React.createElement('modal', props, props.children, props.footer)
      : null),
  }
  const registrations = []
  const window = { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } }
  const require = (specifier) => {
    if (specifier === 'react') return hooks.React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`the page required a module outside the platform seed: ${specifier}`)
  }
  const sandbox = {
    window,
    require,
    fetch: env.fetch ?? (() => Promise.reject(new Error('this test gave the bundle no host'))),
    setInterval: env.setInterval ?? (() => 0),
    clearInterval: env.clearInterval ?? (() => {}),
  }

  runInContext(bundleSource, createContext(sandbox), { filename: bundlePath })
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
 * Mount the client half the way the loader does, and expose both contributions.
 *
 * `apply` registers two slots — the settings page and the header badge — so the
 * helper finds each by the slot it fills rather than by registration order.
 *
 * @param {object} form - the fake config form.
 * @param {object} [env] - browser globals for the bundle, see {@link loadBundle}.
 * @returns {object} the mounted contributions and their bookkeeping.
 */
function mount(form, env) {
  const loaded = loadBundle(form, env)
  const mounted = createCtx(form)
  loaded.exports.apply(mounted.ctx)
  const entry = mounted.registrations.find((registration) => registration.options.name === 'settings.section')
  const badge = mounted.registrations.find((registration) => registration.options.name === 'conversation.session.header.utilities')
  return {
    ...mounted,
    loaded,
    entry,
    badge,
    form,
    render: () => loaded.hooks.render(entry.component, { close() {} }),
  }
}

/** Let the write promises settle. */
function settle() {
  return new Promise((resolve) => { setImmediate(resolve) })
}

/**
 * The badge's renderer, as the session header mounts it.
 *
 * @param {object} page - the mounted client half.
 * @returns {() => object[]} one render pass.
 */
function renderBadgeOf(page) {
  return () => page.loaded.hooks.render(page.badge.component, { sessionId: 'session-1' })
}

/** The badge button alone: the panel's buttons carry a variant of their own. */
function badgeButtonOf(nodes) {
  const found = nodes.filter((node) => node.type === 'button' && node.props.className === 'tls_badge')
  assert.equal(found.length, 1, 'the header holds exactly one badge')
  return found[0]
}

/** The open run panel. */
function panelOf(nodes) {
  const found = nodes.filter((node) => node.type === 'modal')
  assert.equal(found.length, 1, 'exactly one run panel is open')
  return found[0]
}

/** The phase pill of the open panel. */
function phaseOf(nodes) {
  const found = nodes.filter((node) => node.props.className === 'tls_phase')
  assert.equal(found.length, 1, 'the panel shows the phase once')
  return found[0]
}

/**
 * The one element of a class.
 *
 * @param {object[]} nodes - rendered host elements.
 * @param {string} className - the class the element must carry alone.
 * @returns {object} the matched element.
 */
function byClass(nodes, className) {
  const found = nodes.filter((node) => node.props.className === className)
  assert.equal(found.length, 1, `exactly one element is "${className}"`)
  return found[0]
}

/**
 * The panel's action button that reads `label`.
 *
 * @param {object[]} nodes - rendered host elements.
 * @param {string} label - visible label, which is the button's name.
 * @returns {object} the matched element.
 */
function actionButtonOf(nodes, label) {
  const found = nodes.filter((node) => node.type === 'button'
    && node.props.className !== 'tls_badge'
    && node.props.children === label)
  assert.equal(found.length, 1, `exactly one action button reads "${label}"`)
  return found[0]
}

/**
 * A fake host the badge polls and the panel reads, and the browser's timer table.
 *
 * The badge asks `GET /api/openspec-taskloop/state` in an effect and then on an
 * interval, so the test needs both halves under control: every fetch is recorded
 * (with its options, so `no-store` is checked) and the interval is registered
 * rather than waited out — one call to `tick()` is what two seconds would do.
 *
 * The panel adds the other two routes (task 8.2): `/tasks` answers the list the
 * test supplies and can be replaced or refused between reads (task 8.3 — a refusal
 * is a 503 whose body is the host's sentence and holds no list, exactly as
 * `lib/routes.js` answers), and `/action` records the action it was sent and
 * answers the snapshot the optional `onAction` produced, exactly as
 * `lib/routes.js` answers with the state taken after the action.
 *
 * @param {unknown} initial - the first `/state` body the host answers with.
 * @param {object} [options] - `tasks` (the `/tasks` body), `tasksRefusal` (the
 *   sentence a refused read carries), `onAction` (the snapshot an action produces).
 * @returns {object} the host: `answer(next)`, `answerTasks(next)`, `failTasks(reason)`,
 *   `tick()`, and what it recorded.
 */
function createHost(initial, options = {}) {
  let body = initial
  let tasks = options.tasks ?? null
  let refused = options.tasksRefusal ?? null
  const calls = []
  const actions = []
  const timers = new Map()
  let last = 0
  return {
    calls,
    actions,
    timers,
    /** @param {unknown} next - the body the next `/state` answer carries. */
    answer(next) { body = next },
    /** @param {unknown} next - the body the next `/tasks` answer carries. */
    answerTasks(next) { tasks = next; refused = null },
    /** @param {string} reason - the sentence the next `/tasks` answer refuses with. */
    failTasks(reason) { refused = reason; tasks = null },
    /** @param {string} url - requested path. @param {object} init - request options. */
    fetch(url, init = {}) {
      calls.push({ url, init })
      if (url === TASKS_URL) {
        if (refused !== null) {
          return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: refused }) })
        }
        if (tasks === null) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
        return Promise.resolve({ ok: true, json: () => Promise.resolve(tasks) })
      }
      if (url === ACTION_URL) {
        const { action } = JSON.parse(init.body)
        actions.push(action)
        if (typeof options.onAction === 'function') body = options.onAction(action, body)
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: body }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    },
    setInterval(handler, ms) {
      last += 1
      timers.set(last, { handler, ms })
      return last
    },
    clearInterval(id) { timers.delete(id) },
    /** Run every live interval once. */
    tick() {
      for (const timer of Array.from(timers.values())) timer.handler()
    },
  }
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
  assert.deepEqual(
    Array.from(page.injected),
    ['settings.section', 'conversation.session.header.utilities'],
    'apply fills the settings nav and the session header row',
  )

  assert.equal(page.registrations.length, 2, 'two contributions: the page and the run badge')
  const { options } = page.entry
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'openspec-taskloop', 'the nav row is addressed by this id')
  assert.equal(options.label, 'OpenSpec Taskloop', 'the nav row reads the name the design fixes')
  assert.ok(options.order > 10, 'the page sits after Models (order 10)')
  assert.ok(options.order < 15, 'the page sits ahead of the Plugins section (order 15)')

  assert.equal(page.effects.length, 2, 'each registration is owned by an effect, so both leave with the plugin')
  assert.match(page.effects[0], /settings page/u, 'the first effect is named for what it owns')
  assert.match(page.effects[1], /run badge/u, 'the second effect owns the badge')
})

test('the run badge mounts into the session header row and stays empty without a run', async () => {
  const host = createHost({ active: false })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)

  assert.ok(page.badge !== undefined, 'the header row gets a contribution of its own')
  assert.equal(page.badge.options.id, 'openspec-taskloop-badge', 'the registration is addressed by the designed id')
  assert.equal(page.badge.options.order, 30, 'the badge sits after the session\'s own utilities')
  assert.equal(typeof page.badge.component, 'function', 'a slot contribution is a component')

  const renderBadge = () => page.loaded.hooks.render(page.badge.component, { sessionId: 'session-1' })
  const first = renderBadge()
  assert.equal(first.length, 0, 'nothing is drawn before the first answer')

  await settle()
  assert.equal(renderBadge().length, 0, 'a host without a run draws no pill, not a disabled one')
  assert.equal(host.calls.length, 1, 'the badge asks at once, not only on the first interval')
})

test('the badge names the phase and follows it: running, paused, gone after a stop', async () => {
  const running = {
    active: true,
    phase: 'running',
    change: 'add-pause-resume-ui',
    cwd: 'C:\\work\\_dsh\\dsh-openspec-taskloop',
    task: { id: '8.1', text: 'Register the badge', line: 45, done: false },
    progress: { complete: 19, total: 24 },
    sessionId: 'session-1',
  }
  const host = createHost(running)
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = () => page.loaded.hooks.render(page.badge.component, { sessionId: 'session-1' })
  const pill = () => {
    const nodes = renderBadge()
    const buttons = nodes.filter((node) => node.type === 'button')
    assert.equal(buttons.length, 1, 'an active run is exactly one pill')
    return buttons[0]
  }

  renderBadge()
  await settle()
  let badge = pill()

  assert.equal(badge.type, 'button', 'the badge is a button, not a span with a click')
  assert.equal(badge.props.type, 'button', 'a button outside a form does not submit anything')
  assert.equal(badge.props['data-state'], 'running', 'the phase is carried by a data attribute, never inline')
  assert.equal(badge.props['aria-haspopup'], 'dialog', 'the badge says that it opens a dialog')
  assert.match(badge.props['aria-label'], /working/u, 'the accessible name carries the phase')
  assert.equal(badge.props.title, badge.props['aria-label'], 'the mouse hint repeats the accessible name')

  const [dot, label] = badge.props.children
  assert.equal(dot.type, 'span')
  assert.equal(dot.props['aria-hidden'], 'true', 'the dot is decoration and stays out of the tree')
  assert.equal(String(label.props.children), 'Running', 'the label names the working phase')

  assert.equal(host.calls[0].url, '/api/openspec-taskloop/state', 'the badge polls the state route of the plugin')
  assert.equal(host.calls[0].init.cache, 'no-store', 'a cached answer would show a phase the run has left')

  const [timer] = Array.from(host.timers.values())
  assert.equal(timer.ms, 2000, 'the poll is one request every two seconds')

  host.answer({ ...running, phase: 'paused' })
  host.tick()
  await settle()
  badge = pill()
  assert.equal(badge.props['data-state'], 'paused', 'a parked run reads as paused')
  assert.match(badge.props['aria-label'], /paused/u, 'the name of a paused run says so')
  assert.equal(String(badge.props.children[1].props.children), 'Paused', 'the label changes with the phase')

  host.answer({ active: false })
  host.tick()
  await settle()
  assert.equal(renderBadge().length, 0, 'a stopped run takes the badge out of the header')

  page.loaded.hooks.dispose()
  assert.equal(host.timers.size, 0, 'unmounting clears the interval')
  const asked = host.calls.length
  host.tick()
  await settle()
  assert.equal(host.calls.length, asked, 'no request outlives the header')
})

test('the badge opens the run panel: the change, the workspace, the bar and the tasks', async () => {
  const host = createHost(RUN, { tasks: TASKS })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = renderBadgeOf(page)

  renderBadge()
  await settle()
  assert.equal(renderBadge().filter((node) => node.type === 'modal').length, 0, 'the panel is closed until asked')

  badgeButtonOf(renderBadge()).props.onClick()
  const panel = panelOf(renderBadge())
  assert.equal(panel.props.open, true, 'the click opens one panel')
  assert.equal(badgeButtonOf(renderBadge()).props['aria-expanded'], 'true', 'the badge says that its panel is open')

  await settle()
  const nodes = renderBadge()

  assert.match(panel.props.title, /taskloop run/u, 'the panel is named for the run it shows')
  assert.equal(typeof panel.props.closeLabel, 'string', 'the close control has an accessible name')
  assert.equal(typeof panel.props.onClose, 'function', 'the panel can be dismissed')

  assert.equal(String(byClass(nodes, 'tls_runName').props.children), RUN.change, 'the panel names the change')
  assert.equal(String(byClass(nodes, 'tls_runPath').props.children), RUN.cwd, 'the panel names the workspace')
  assert.equal(byClass(nodes, 'tls_runPath').props.title, RUN.cwd, 'the whole path stays reachable when the text is cut')

  assert.equal(phaseOf(nodes).props['data-state'], 'running', 'the panel shows the phase it is in')
  assert.equal(String(phaseOf(nodes).props.children[1]), 'Running', 'the phase reads as a word, not only as a colour')

  const bars = nodes.filter((node) => node.props.role === 'progressbar')
  assert.equal(bars.length, 1, 'the panel shows one progress bar')
  assert.equal(bars[0].props['aria-valuenow'], 20, 'the bar counts the CLI reading, not the poll')
  assert.equal(bars[0].props['aria-valuemax'], 24, 'the bar is drawn against the total the CLI reported')
  assert.equal(String(bars[0].props['aria-valuetext']), '20 / 24 tasks done')
  assert.equal(String(byClass(nodes, 'tls_barText').props.children), '20 / 24 tasks done', 'the pair is also printed')
  assert.equal(byClass(nodes, 'tls_barFill').props.style.width, (20 / 24) * 100 + '%')

  const rows = nodes.filter((node) => node.type === 'li')
  assert.equal(rows.length, TASKS.tasks.length, 'every task the CLI listed is a row')
  assert.equal(rows[0].props['data-done'], 'true', 'a ticked task reads as done')
  assert.match(String(rows[0].props['aria-label']), /^Done: /u, 'a done row says so in words')
  assert.equal(rows[1].props['data-current'], 'true', 'the run\'s task is the current row')
  assert.equal(rows[1].props['aria-current'], 'step', 'the current task is announced as the step')
  assert.equal(rows[2].props['data-current'], 'false', 'a later task is not marked current')
  assert.equal(String(rows[1].props.children[1].props.children), TASKS.tasks[1].description)

  assert.equal(actionButtonOf(nodes, 'Pause').props.variant, 'primary', 'the phase-changing action is primary')
  assert.equal(actionButtonOf(nodes, 'Pause').props.disabled, false)
  assert.equal(actionButtonOf(nodes, 'Stop').props.variant, 'outline', 'stopping is not the default action')

  const reads = host.calls.filter((call) => call.url === TASKS_URL)
  assert.equal(reads.length, 1, 'the list is read once per open')
  assert.equal(reads[0].init.cache, 'no-store', 'a cached list would show tasks the run has left')
})

test('the panel\'s buttons send the three commands and show the phase they produce', async () => {
  const host = createHost(RUN, {
    tasks: TASKS,
    onAction: (action, current) => {
      if (action === 'pause') return { ...current, phase: 'paused' }
      if (action === 'resume') return { ...current, phase: 'running' }
      return { active: false }
    },
  })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = renderBadgeOf(page)

  renderBadge()
  await settle()
  badgeButtonOf(renderBadge()).props.onClick()
  await settle()

  actionButtonOf(renderBadge(), 'Pause').props.onClick()
  const waiting = renderBadge()
  assert.equal(actionButtonOf(waiting, 'Pause').props.disabled, true, 'the buttons wait for the answer')
  assert.equal(actionButtonOf(waiting, 'Stop').props.disabled, true)

  await settle()
  let nodes = renderBadge()
  assert.deepEqual(host.actions, ['pause'], 'the button sends the action the command dispatches')
  const post = host.calls.filter((call) => call.url === ACTION_URL)[0]
  assert.equal(post.init.method, 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { action: 'pause' })
  assert.equal(phaseOf(nodes).props['data-state'], 'paused', 'the answer\'s phase is shown without waiting for the poll')
  assert.equal(String(phaseOf(nodes).props.children[1]), 'Paused')

  actionButtonOf(nodes, 'Resume').props.onClick()
  await settle()
  nodes = renderBadge()
  assert.deepEqual(host.actions, ['pause', 'resume'])
  assert.equal(phaseOf(nodes).props['data-state'], 'running')
  assert.equal(actionButtonOf(nodes, 'Pause').props.disabled, false, 'the buttons come back after the answer')

  actionButtonOf(nodes, 'Stop').props.onClick()
  await settle()
  assert.deepEqual(host.actions, ['pause', 'resume', 'stop'])
  assert.equal(renderBadge().length, 0, 'the last answer takes the badge and its panel away')
})

test('the panel reads the list again when the run moves to the next task', async () => {
  const host = createHost(RUN, { tasks: TASKS })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = renderBadgeOf(page)

  renderBadge()
  await settle()
  badgeButtonOf(renderBadge()).props.onClick()
  panelOf(renderBadge())
  await settle()
  assert.equal(host.calls.filter((call) => call.url === TASKS_URL).length, 1)

  // The run finishes 8.2 and starts 8.3, and the next reading of the file has
  // the tick and the new counts: both arrive only through a fresh list.
  host.answer({ ...RUN, task: { ...RUN.task, id: '22', description: TASKS.tasks[2].description, line: 47 } })
  host.answerTasks({
    ...TASKS,
    progress: { total: 24, complete: 21, remaining: 3 },
    tasks: TASKS.tasks.map((task) => (task.line === 46 ? { ...task, done: true } : task)),
  })
  host.tick()
  await settle()
  renderBadge()
  await settle()

  const nodes = renderBadge()
  assert.equal(host.calls.filter((call) => call.url === TASKS_URL).length, 2, 'a new current task reads the list again')
  assert.equal(String(byClass(nodes, 'tls_barText').props.children), '21 / 24 tasks done', 'the fresh counts reach the bar')

  const current = nodes.filter((node) => node.type === 'li' && node.props['data-current'] === 'true')
  assert.equal(current.length, 1, 'exactly one row is the current task')
  assert.equal(String(current[0].props.children[1].props.children), TASKS.tasks[2].description)

  const finished = nodes.filter((node) => node.type === 'li' && node.props['data-done'] === 'true')
  assert.equal(finished.length, 2, 'the tick the model added arrives with the same read')
})

test('closing the panel frees it, and reopening reads the list afresh', async () => {
  const host = createHost(RUN, { tasks: TASKS })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = renderBadgeOf(page)

  renderBadge()
  await settle()
  badgeButtonOf(renderBadge()).props.onClick()
  await settle()

  panelOf(renderBadge()).props.onClose()
  assert.equal(renderBadge().filter((node) => node.type === 'modal').length, 0, 'closing removes the panel')

  badgeButtonOf(renderBadge()).props.onClick()
  await settle()
  panelOf(renderBadge())
  assert.equal(host.calls.filter((call) => call.url === TASKS_URL).length, 2, 'each open costs one read of the list')
})

test('the body says that it is reading the list until the answer arrives', async () => {
  const host = createHost(RUN, { tasks: TASKS })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = renderBadgeOf(page)

  renderBadge()
  await settle()
  badgeButtonOf(renderBadge()).props.onClick()

  const reading = renderBadge()
  panelOf(reading)
  const note = byClass(reading, 'tls_taskNote')
  assert.equal(note.props['data-state'], 'loading', 'the read says what it is doing, not that the change is empty')
  assert.equal(note.props.role, 'status', 'the note announces itself when it changes')
  assert.equal(String(note.props.children), 'Reading the task list…')
  assert.equal(byClass(reading, 'tls_tasksTitle').props.children, 'Tasks', 'the section keeps its heading while it loads')
  assert.equal(reading.filter((node) => node.type === 'li').length, 0, 'no rows are invented while the read is out')
  assert.equal(
    String(byClass(reading, 'tls_barText').props.children),
    '19 / 24 tasks done',
    'the bar falls back to the counts the poll already knows',
  )

  await settle()
  const answered = renderBadge()
  assert.equal(answered.filter((node) => node.props.className === 'tls_taskNote').length, 0, 'the note leaves with the answer')
  assert.equal(answered.filter((node) => node.type === 'li').length, TASKS.tasks.length, 'the rows arrive in its place')
  assert.equal(
    String(byClass(answered, 'tls_barText').props.children),
    '20 / 24 tasks done',
    'the bar takes the fresh reading over the poll',
  )
})

test('a refused read says the list is unavailable, never an empty list', async () => {
  const reason = 'the task list is unavailable: openspec is not on the PATH'
  const host = createHost(RUN, { tasks: TASKS, tasksRefusal: reason })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = renderBadgeOf(page)

  renderBadge()
  await settle()
  badgeButtonOf(renderBadge()).props.onClick()
  panelOf(renderBadge())
  await settle()

  const nodes = renderBadge()
  panelOf(nodes)
  const note = byClass(nodes, 'tls_taskNote')
  assert.equal(note.props['data-state'], 'unavailable')
  assert.equal(String(note.props.children), reason, 'the host\'s own sentence is what the panel repeats')
  assert.equal(note.props.role, 'status')
  assert.equal(nodes.filter((node) => node.type === 'li').length, 0, 'a failed read draws no rows')
  assert.equal(
    nodes.filter((node) => node.props.className === 'tls_taskList').length,
    0,
    'and no list either, so nothing reads as an empty change',
  )
  assert.equal(
    String(byClass(nodes, 'tls_barText').props.children),
    '19 / 24 tasks done',
    'the bar keeps the last counts the run reported',
  )

  // The panel is not stuck in the refusal: the next read of the same open — the
  // run moving on — replaces it with the rows.
  host.answerTasks(TASKS)
  host.answer({ ...RUN, task: { ...RUN.task, id: '22', line: 47 } })
  host.tick()
  await settle()
  renderBadge()
  await settle()
  const recovered = renderBadge()
  assert.equal(recovered.filter((node) => node.props.className === 'tls_taskNote').length, 0, 'a later read clears the refusal')
  assert.equal(recovered.filter((node) => node.type === 'li').length, TASKS.tasks.length)
})

test('a change with no tasks is told apart from a list that could not be read', async () => {
  const host = createHost(RUN, { tasks: { ...TASKS, tasks: [] } })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = renderBadgeOf(page)

  renderBadge()
  await settle()
  badgeButtonOf(renderBadge()).props.onClick()
  panelOf(renderBadge())
  await settle()

  const nodes = renderBadge()
  const note = byClass(nodes, 'tls_taskNote')
  assert.equal(note.props['data-state'], 'empty', 'an answered empty change is not a refusal')
  assert.equal(String(note.props.children), 'This change lists no tasks.')
  assert.equal(nodes.filter((node) => node.type === 'li').length, 0)
  assert.equal(
    String(byClass(nodes, 'tls_barText').props.children),
    '20 / 24 tasks done',
    'the counts still come from the answer, which happened',
  )
})

test('closing the panel puts focus back on the badge', async () => {
  const host = createHost(RUN, { tasks: TASKS })
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }), host)
  const renderBadge = renderBadgeOf(page)

  renderBadge()
  await settle()
  assert.equal(badgeButtonOf(renderBadge()).focused, undefined, 'a badge alone is not given focus')

  badgeButtonOf(renderBadge()).props.onClick()
  await settle()
  panelOf(renderBadge()).props.onClose()

  const closed = renderBadge()
  assert.equal(closed.filter((node) => node.type === 'modal').length, 0, 'the panel is gone')
  assert.equal(badgeButtonOf(closed).focused, true, 'and the control that opened it has the focus again')
  assert.equal(badgeButtonOf(closed).props['aria-expanded'], 'false', 'the badge says its panel is closed')
})

test('the page shows the eight switches and choices the config holds', () => {
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }))
  const nodes = page.render()
  const switches = switchesOf(nodes)
  const segments = segmentsOf(nodes)

  assert.equal(switches.length, 6, 'six settings are switches')
  assert.equal(segments.length, 2, 'two settings are choices')

  assert.equal(controlLabelled(switches, 'Commit after each task group').props.checked, false)
  assert.equal(controlLabelled(switches, 'Commit openspec files').props.checked, false)
  assert.equal(controlLabelled(switches, 'Code review after each task group').props.checked, false)
  assert.equal(controlLabelled(switches, 'Stop at each task group boundary').props.checked, true)
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
  controlLabelled(switchesOf(nodes), 'Commit openspec files').props.onChange(true)
  controlLabelled(segmentsOf(nodes), 'Commit tool').props.onChange('git')
  controlLabelled(switchesOf(nodes), 'Code review after each task group').props.onChange(true)
  controlLabelled(switchesOf(nodes), 'Stop at each task group boundary').props.onChange(false)
  controlLabelled(switchesOf(nodes), 'Compact inside a task').props.onChange(false)
  controlLabelled(segmentsOf(nodes), 'When the compaction budget runs out').props.onChange('break')
  controlLabelled(switchesOf(nodes), 'Protocol section').props.onChange(false)
  await settle()

  assert.deepEqual(form.writes, [
    [{ op: 'set', path: ['commit', 'enabled'], value: true }],
    [{ op: 'set', path: ['commit', 'openspec'], value: true }],
    [{ op: 'set', path: ['commit', 'tool'], value: 'git' }],
    [{ op: 'set', path: ['review', 'enabled'], value: true }],
    [{ op: 'set', path: ['boundary', 'enabled'], value: false }],
    [{ op: 'set', path: ['compaction', 'midTask'], value: false }],
    [{ op: 'set', path: ['compaction', 'onFailure'], value: 'break' }],
    [{ op: 'set', path: ['protocol', 'systemSection'], value: false }],
  ], 'every control writes exactly its own field, in the order it was used')
})

test('the page shows the three retry numbers in the units the page promises', () => {
  const page = mount(createForm({ status: 'ready', writable: true, value: VALUE }))
  const inputs = inputsOf(page.render())

  assert.equal(inputs.length, 3, 'three of the eleven settings are numbers')

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

test('the switches sit in the order the design fixes, and the boundary row writes boundary.enabled', async () => {
  const form = createForm({ status: 'ready', writable: true, value: VALUE })
  const page = mount(form)

  const labels = switchesOf(page.render()).map((node) => node.props.label)
  assert.deepEqual(labels, [
    'Commit after each task group',
    'Commit openspec files',
    'Code review after each task group',
    'Stop at each task group boundary',
    'Compact inside a task',
    'Protocol section',
  ], 'the openspec switch follows the commit switch, and the protocol section sits next to compaction inside a task (D6)')

  form.set({ value: { ...VALUE, commit: { ...VALUE.commit, openspec: true } } })
  assert.equal(
    controlLabelled(switchesOf(page.render()), 'Commit openspec files').props.checked,
    true,
    'the openspec switch shows commit.openspec',
  )

  controlLabelled(switchesOf(page.render()), 'Stop at each task group boundary').props.onChange(false)
  await settle()
  assert.deepEqual(form.writes, [
    [{ op: 'set', path: ['boundary', 'enabled'], value: false }],
  ], 'the boundary switch writes boundary.enabled and nothing else')

  form.set({ value: { ...VALUE, boundary: { enabled: false } } })
  const after = controlLabelled(switchesOf(page.render()), 'Stop at each task group boundary')
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
  assert.equal(labels.length, 11, 'the page has eleven settings, so the README documents eleven')
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
