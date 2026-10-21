// Tests for the optional protocol section (task 5.2).
//
// The section is the one part of the plugin that writes into the prompt: it is
// registered on an agent's own context and must disappear with the run that
// registered it. These tests pin the two properties the task asks for — off means
// the prompt service is never touched, on means exactly one static section per
// agent the run drives — without a host: the service is a fake that records the
// registrations and the disposers it hands out.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PROTOCOL_ORDER_FALLBACK,
  PROTOCOL_SECTION,
  PROTOCOL_SECTION_TEXT,
  createProtocol,
} from '../lib/protocol.js'

/**
 * A prompt service that records what is registered on it.
 *
 * @param {object} [options]
 * @param {number} [options.order] - answer of `getSectionOrder`.
 * @param {boolean} [options.lookup] - whether the service exposes `getSectionOrder` at all.
 * @returns {object} the service with `registered` and `disposed` logs.
 */
function fakePrompt({ order = 500, lookup = true } = {}) {
  const registered = []
  const disposed = []
  const service = {
    registered,
    disposed,
    section(section) {
      registered.push(section)
      return () => {
        disposed.push(section.name)
      }
    },
  }
  if (lookup) service.getSectionOrder = () => order
  return service
}

/**
 * An agent whose context exposes the given prompt service.
 *
 * @param {object} [systemPrompt] - the prompt service; omitted means a context without one.
 * @returns {object} fake agent.
 */
const agentWith = (systemPrompt) => ({
  id: 'agent-1',
  ctx: systemPrompt === undefined ? {} : { systemPrompt },
})

test('with the option off the prompt service is never touched', () => {
  const service = fakePrompt()
  const protocol = createProtocol({ enabled: false })

  protocol.apply(agentWith(service))
  protocol.close()

  assert.equal(protocol.enabled, false)
  assert.deepEqual(service.registered, [])
  assert.deepEqual(service.disposed, [])
})

test('the section is static and names the invariant without a task number', () => {
  assert.equal(PROTOCOL_SECTION.name, 'openspec-taskloop:protocol')
  assert.equal(PROTOCOL_SECTION.text, PROTOCOL_SECTION_TEXT)
  assert.match(PROTOCOL_SECTION_TEXT, /exactly one task/u)
  // A task number in the text would change the prompt prefix between tasks and
  // invalidate the cache it is there to keep warm (design D2/D3).
  assert.doesNotMatch(PROTOCOL_SECTION_TEXT, /\d+\.\d+/u)
})

test('the section is registered once per agent and removed on close', () => {
  const service = fakePrompt()
  const protocol = createProtocol({ enabled: true })
  const agent = agentWith(service)

  protocol.apply(agent)
  // The same agent can be met twice — opened and then awaited — and a second
  // registration with the same name in one scope would throw.
  protocol.apply(agent)

  assert.deepEqual(service.registered, [{
    name: PROTOCOL_SECTION.name,
    order: 500,
    text: PROTOCOL_SECTION_TEXT,
  }])
  assert.deepEqual(service.disposed, [])

  protocol.close()

  assert.deepEqual(service.disposed, [PROTOCOL_SECTION.name])
  // Closing twice must not dispose a message that is already gone.
  protocol.close()
  assert.deepEqual(service.disposed, [PROTOCOL_SECTION.name])
})

test('every session the run drives gets its own copy, and all of them are removed', () => {
  const source = fakePrompt()
  const boundary = fakePrompt()
  const protocol = createProtocol({ enabled: true })

  protocol.apply(agentWith(source))
  protocol.apply(agentWith(boundary))
  protocol.close()

  assert.equal(source.registered.length, 1)
  assert.equal(boundary.registered.length, 1)
  assert.deepEqual(source.disposed, [PROTOCOL_SECTION.name])
  assert.deepEqual(boundary.disposed, [PROTOCOL_SECTION.name])
})

test('the position comes from the prompt service, with a documented fallback', () => {
  const placed = fakePrompt({ order: 610 })
  const unplaced = fakePrompt({ lookup: false })
  const protocol = createProtocol({ enabled: true })

  protocol.apply(agentWith(placed))
  protocol.apply(agentWith(unplaced))

  assert.equal(placed.registered[0].order, 610)
  assert.equal(unplaced.registered[0].order, PROTOCOL_ORDER_FALLBACK)
})

test('an agent without a prompt service is skipped, not fatal', () => {
  const failing = {
    id: 'agent-3',
    ctx: {
      get systemPrompt() {
        throw new Error('cannot get property "systemPrompt" without inject')
      },
    },
  }
  const protocol = createProtocol({ enabled: true })

  // No context at all, a context without the service, and a real Cordis context
  // that throws on a missing service are the same answer: nothing to register.
  assert.doesNotThrow(() => {
    protocol.apply({ id: 'agent-1' })
    protocol.apply(agentWith(undefined))
    protocol.apply(failing)
    protocol.apply(undefined)
    protocol.close()
  })
})
