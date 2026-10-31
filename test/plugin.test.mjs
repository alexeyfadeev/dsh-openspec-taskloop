// The plugin's export shape, mount, loopback routes and settings-page policy (tasks 1.2,
// 2.3, 3.2 and 7.3).
//
// The Loader reads `name`, `inject`, `Config` and `apply` from the module's named
// exports; a stray default export would make it unwrap the module differently and
// drop the schema, so the shape is pinned here. `Config` being exported is what
// makes the loader validate the profile's config block and fill the defaults
// before `apply` runs.
//
// The mount test also pins that `apply` touches no service through `get`: the
// context's `get` throws, so a mount-time lookup of `subprocess` or
// `userQuestions` would fail here rather than in a deployment that composes no
// such service. Two services are requested through `ctx.inject` instead: Settings,
// whose page the client half renders (the policy below keeps the service from
// building a second, automatic one in Settings → Plugins, task 2.3), and the web
// server, which serves the badge's three loopback routes (task 7.3). Neither
// request may gate the mount: a headless profile has no web server and no browser
// and still serves `/taskloop`.
//
// The routes are registered through the requested service rather than through this
// test's own server, so these tests read like the deployment: request in, scoped
// context out, three routes registered, unload removes them (task 7.3). What each
// route answers is `test/routes.test.mjs`; here only the wiring is pinned.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as entry from '../lib/index.js'
import { apply } from '../lib/index.js'

/**
 * A context that records the mounted command and refuses service lookups.
 *
 * `inject` only records its callback: neither Settings nor a web server is composed
 * in this deployment, so neither policy is registered and the mount still has to
 * succeed — a headless run serves `/taskloop` without ever opening Settings or
 * answering a poll.
 *
 * @returns {{ctx: object, registrations: object[], injections: object[]}} fake context.
 */
function mountingContext() {
  const registrations = []
  const injections = []
  return {
    registrations,
    injections,
    ctx: {
      // The entry's own fiber: the policy is stored under it, because that is the
      // key the settings service reads the policy back by.
      fiber: { uid: 'openspec-taskloop' },
      logger: { info() {} },
      commands: {
        register(definition) {
          registrations.push(definition)
          return () => {}
        },
      },
      effect(callback) {
        return callback()
      },
      inject(dependencies, callback) {
        injections.push({ dependencies, callback })
      },
      get(name) {
        throw new Error(`apply must not read the ${name} service`)
      },
    },
  }
}

/**
 * The one request `apply` made for a service.
 *
 * @param {object[]} injections - the recorded requests.
 * @param {string} service - dependency name to find.
 * @returns {{dependencies: string[], callback: Function}} the request.
 */
function requestFor(injections, service) {
  const request = injections.find((entry) => entry.dependencies.length === 1 && entry.dependencies[0] === service)
  assert.ok(request !== undefined, `apply requests ${service}`)
  return request
}

/**
 * A web server that records the routes it is given and what is removed again.
 *
 * @returns {{registered: object[], removed: string[], register: Function}} the server.
 */
function recordingServer() {
  const registered = []
  const removed = []
  return {
    registered,
    removed,
    register(route) {
      registered.push(route)
      return () => {
        removed.push(route.path)
      }
    },
  }
}

/**
 * The context cordis hands an `inject` callback once its services exist.
 *
 * `effect` runs the callback now and keeps the disposer, the way the host does; `get`
 * answers only the service it was scoped to.
 *
 * @param {object} services - service name to value.
 * @param {object} [logger] - host logger the scoped context exposes.
 * @returns {{scoped: object, disposers: Function[]}} the scoped context and what it kept.
 */
function scopedContext(services, logger = { info() {} }) {
  const disposers = []
  return {
    disposers,
    scoped: {
      // Cordis exposes the injected services both ways: as properties the plugin's own
      // code reads (`scoped.settings`) and through `get(name)`, which the route
      // registration in `lib/routes.js` uses the way `lib/environment.js` does.
      ...services,
      logger,
      get(name) {
        return services[name]
      },
      effect(callback) {
        const dispose = callback()
        disposers.push(dispose)
        return dispose
      },
    },
  }
}

test('the entry exports the namespace-plugin shape', () => {
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'inject', 'name'])
  assert.equal(entry.name, 'openspec-taskloop')
  assert.deepEqual(entry.inject, ['commands'])
  assert.equal(typeof entry.apply, 'function')
  assert.ok(entry.Config !== undefined, 'the loader needs the Config export to validate the profile block')
  assert.ok(!('default' in entry))
})

test('apply mounts `/taskloop` without resolving any other service', () => {
  const { ctx, registrations } = mountingContext()

  apply(ctx, {})

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'taskloop')
  assert.deepEqual(registrations[0].input, { hint: '[change] | stop | status | explore | pause | resume' })
})

test('apply asks for the settings and web server services instead of looking them up', () => {
  const { ctx, injections } = mountingContext()

  apply(ctx, {})

  assert.deepEqual(
    injections.map(({ dependencies }) => dependencies),
    [['webServer'], ['settings']],
    'the routes need the web server and the page needs the policy; `get` was never called',
  )
})

test('once the settings service is composed, the automatic page is turned off once', () => {
  const { ctx, injections } = mountingContext()
  apply(ctx, {})

  const calls = []
  const disposer = () => {}
  const { scoped, disposers } = scopedContext({
    settings: {
      configure(presentation, owner) {
        calls.push({ presentation, owner })
        return disposer
      },
    },
  })

  requestFor(injections, 'settings').callback(scoped)

  assert.deepEqual(
    calls,
    [{ presentation: { auto: false }, owner: ctx.fiber }],
    'the page policy names this plugin instance, and it is the only call the mount makes',
  )
  assert.deepEqual(
    disposers,
    [disposer],
    'the effect keeps the disposer, so an unload gives the automatic page back',
  )
})

test('a composed web server gets the three routes, and an unload takes them back', async () => {
  const { ctx, injections } = mountingContext()
  apply(ctx, {})

  const server = recordingServer()
  const { scoped, disposers } = scopedContext({ webServer: server })

  requestFor(injections, 'webServer').callback(scoped)

  assert.deepEqual(
    server.registered.map(({ kind, path }) => ({ kind, path })),
    [
      { kind: 'exact', path: '/api/openspec-taskloop/state' },
      { kind: 'exact', path: '/api/openspec-taskloop/tasks' },
      { kind: 'exact', path: '/api/openspec-taskloop/action' },
    ],
    'the mount serves the published paths, and only over HTTP',
  )

  // The registered handler is the mount's own deps: a slot nothing holds a run in yet
  // answers "no run" through the highest level this file can reach, which is what proves
  // `apply` handed the routes the slot and not some placeholder.
  const state = server.registered[0]
  const response = {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body = '') {
      this.body += body
    },
  }
  await state.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, response)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { active: false })

  assert.equal(disposers.length, 1, 'all three routes are one effect, so one unload undoes them')
  disposers[0]()
  assert.deepEqual(
    server.removed,
    [
      '/api/openspec-taskloop/action',
      '/api/openspec-taskloop/tasks',
      '/api/openspec-taskloop/state',
    ],
    'the poll is the last to leave, so a mounted badge reads one more snapshot instead of a 404',
  )
})

test('a profile without a web server mounts, and `/taskloop` still answers', async () => {
  const { ctx, injections, registrations } = mountingContext()

  apply(ctx, {})

  // The request was made and nothing ran its callback — the deployment the plugin has to
  // survive (design "Non-Goals"). The command is registered all the same, and it answers
  // from the slot without any HTTP surface behind it.
  assert.deepEqual(requestFor(injections, 'webServer').dependencies, ['webServer'])
  assert.equal(registrations.length, 1)

  const result = await registrations[0].handler({
    commandId: 'command-1',
    rawInput: 'status',
    agent: { id: 'agent-1' },
    attachments: [],
  })
  assert.deepEqual(result, { kind: 'success', text: 'taskloop: no run is active.' })
})
