// The plugin's export shape and mount (tasks 1.2 and 3.2).
//
// The Loader reads `name`, `inject`, `Config` and `apply` from the module's named
// exports; a stray default export would make it unwrap the module differently and
// drop the schema, so the shape is pinned here. `Config` being exported is what
// makes the loader validate the profile's config block and fill the defaults
// before `apply` runs.
//
// The mount test also pins that `apply` touches no service: the context's `get`
// throws, so a mount-time lookup of `subprocess` or `userQuestions` would fail
// here rather than in a deployment that composes no such service.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as entry from '../lib/index.js'
import { apply } from '../lib/index.js'

/**
 * A context that records the mounted command and refuses service lookups.
 *
 * @returns {{ctx: object, registrations: object[]}} fake context and its registrations.
 */
function mountingContext() {
  const registrations = []
  return {
    registrations,
    ctx: {
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
  assert.deepEqual(registrations[0].input, { hint: '[change] | stop | status' })
})
