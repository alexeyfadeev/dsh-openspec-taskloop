// Tests for the configuration contract (task 1.2).
//
// The point of this file is the "defaults match design.md" claim: the documented
// block in D11 is parsed out of the change's design.md and compared with the
// resolved `Config({})`. A changed default that is not documented — or a doc
// block that no longer describes the code — fails here, so the number in the
// design cannot silently diverge from the number the plugin uses.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Config, resolveConfig } from '../lib/config.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Find the design.md that carries decision D11, wherever the change lives now.
 *
 * The change directory is `openspec/changes/add-taskloop-plugin/` while it is
 * active and `openspec/changes/archive/<date>-add-taskloop-plugin/` after
 * archiving, so the doc is looked up by content instead of by a fixed path: the
 * test keeps working across the archive step instead of becoming a stale guard.
 *
 * @returns {string} design.md content.
 */
function readDesignDoc() {
  const changesDir = join(repoRoot, 'openspec', 'changes')
  const candidates = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'design.md') candidates.push(path)
    }
  }
  walk(changesDir)

  const doc = candidates.find((path) => readFileSync(path, 'utf8').includes('### D11.'))
  assert.ok(doc, 'no design.md with decision D11 was found under openspec/changes')
  return readFileSync(doc, 'utf8')
}

/**
 * Extract the JSON defaults block that follows D11.
 *
 * @param {string} text - design.md content.
 * @returns {object} documented defaults.
 */
function documentedDefaults(text) {
  const decision = text.indexOf('### D11.')
  assert.notEqual(decision, -1, 'D11 is missing from design.md')

  const open = text.indexOf('```json', decision)
  assert.notEqual(open, -1, 'D11 carries no ```json defaults block')
  const start = text.indexOf('\n', open) + 1
  const end = text.indexOf('```', start)
  assert.notEqual(end, -1, 'the ```json block in D11 is not closed')

  return JSON.parse(text.slice(start, end))
}

test('defaults resolved by the schema equal the ones documented in design.md', () => {
  assert.deepEqual(resolveConfig(), documentedDefaults(readDesignDoc()))
})

test('an absent config block resolves to the same defaults as an empty one', () => {
  assert.deepEqual(resolveConfig(undefined), resolveConfig({}))
})

test('a configured change name is kept, the default means "not specified"', () => {
  assert.equal(resolveConfig({}).change, '')
  assert.equal(resolveConfig({ change: 'add-taskloop-plugin' }).change, 'add-taskloop-plugin')
})

test('both exhaustion policies are accepted, anything else is rejected', () => {
  assert.equal(resolveConfig({ compaction: { onFailure: 'continue' } }).compaction.onFailure, 'continue')
  assert.equal(resolveConfig({ compaction: { onFailure: 'break' } }).compaction.onFailure, 'break')
  assert.throws(() => resolveConfig({ compaction: { onFailure: 'retry' } }), /onFailure/)
})

test('retry values are bounded by the schema', () => {
  assert.throws(() => resolveConfig({ compaction: { retry: { attempts: 0 } } }), /attempts/)
  assert.throws(() => resolveConfig({ compaction: { retry: { factor: 0.5 } } }), /factor/)
  assert.throws(() => resolveConfig({ openspec: { timeoutMs: 0 } }), /timeoutMs/)

  const configured = resolveConfig({
    compaction: { retry: { attempts: 1, delayMs: 0, factor: 1.5, maxDelayMs: 0, codes: ['busy'] } },
  })
  assert.deepEqual(configured.compaction.retry, {
    attempts: 1,
    delayMs: 0,
    factor: 1.5,
    maxDelayMs: 0,
    codes: ['busy'],
  })
})

test('the mid-task gate and the protocol section stay off unless switched on', () => {
  const off = resolveConfig()
  assert.equal(off.compaction.midTask, false)
  assert.equal(off.protocol.systemSection, false)

  const on = resolveConfig({ compaction: { midTask: true }, protocol: { systemSection: true } })
  assert.equal(on.compaction.midTask, true)
  assert.equal(on.protocol.systemSection, true)
})
