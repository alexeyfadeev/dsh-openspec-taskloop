// The plugin's export shape, mount and settings-page policy (tasks 1.2, 2.3 and 3.2).
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
// such service. The settings service is the one `apply` does need, and it is
// requested through `ctx.inject` instead of read: the client half renders the
// page, and the policy below is what keeps the service from building a second,
// automatic one in Settings → Plugins (task 2.3).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as entry from '../lib/index.js'
import { apply } from '../lib/index.js'

/**
 * A context that records the mounted command and refuses service lookups.
 *
 * `inject` only records its callback: no Settings service is composed in this
 * deployment, so the page policy is never registered and the mount still has to
 * succeed — a headless run serves `/taskloop` without ever opening Settings.
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

test('apply asks for the settings service instead of looking it up', () => {
  const { ctx, injections } = mountingContext()

  apply(ctx, {})

  assert.equal(injections.length, 1, 'the page policy needs exactly one service request')
  assert.deepEqual(injections[0].dependencies, ['settings'])
})

test('once the settings service is composed, the automatic page is turned off once', () => {
  const { ctx, injections } = mountingContext()
  apply(ctx, {})

  const calls = []
  const disposer = () => {}
  const effects = []
  const scoped = {
    settings: {
      configure(presentation, owner) {
        calls.push({ presentation, owner })
        return disposer
      },
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
  }

  injections[0].callback(scoped)

  assert.deepEqual(
    calls,
    [{ presentation: { auto: false }, owner: ctx.fiber }],
    'the page policy names this plugin instance, and it is the only call the mount makes',
  )
  assert.deepEqual(
    effects,
    [disposer],
    'the effect keeps the disposer, so an unload gives the automatic page back',
  )
})
