// Tests for the configuration contract (tasks 1.1–1.3).
//
// The point of this file is the "defaults match design.md" claim: the documented
// block in D11 is parsed out of the base change's design.md, every later change
// may add a `<!-- config-defaults -->` block with the keys it introduces, and the
// merge is compared with the resolved `Config({})`. A changed default that is not
// documented — or a doc block that no longer describes the code — fails here, so
// the number in the design cannot silently diverge from the number the plugin uses.
//
// Fields added by D12 are volatile: the resolved config holds `Volatile`
// references, so the comparisons unwrap them first and a separate test pins that
// the new fields really are references rather than plain values. The same holds
// for `compaction.midTask`, `compaction.onFailure` and `protocol.systemSection`,
// which D12 moved to volatile without changing their defaults or their meaning.
// The `pause` switch (D21) joins them: volatile, off by default, and documented
// in the same `config-defaults` block rather than in the base contract.
// `add-compaction-retry-settings` (D1) turns `retry.attempts`, `retry.delayMs` and
// `retry.factor` volatile too, but deliberately not `retry.codes` or
// `retry.maxDelayMs` — those two must keep no page row at all.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  COMMIT_TOOLS,
  DEFAULT_MID_TASK,
  DEFAULT_ON_FAILURE,
  DEFAULT_PROTOCOL_SYSTEM_SECTION,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_CODES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RETRY_FACTOR,
  DEFAULT_RETRY_MAX_DELAY_MS,
  resolveConfig,
} from '../lib/config.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Marks a ```json block that documents the config keys a change adds. */
const CONFIG_DEFAULTS_MARKER = '<!-- config-defaults -->'

/** Shared symbol protocol of cosmokit volatile references (no import: transitive dep). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Tell a volatile config reference from a plain resolved value.
 *
 * @param {unknown} value - resolved config value.
 * @returns {boolean} whether `value` is a `Volatile` reference.
 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Unwrap every volatile reference in a resolved config so it can be compared with
 * the plain JSON documented in design.md.
 *
 * @param {unknown} value - resolved config value, possibly containing references.
 * @returns {unknown} the same shape with each reference replaced by its snapshot.
 */
function plain(value) {
  if (isVolatileRef(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  }
  return value
}

/**
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether `value` is a non-array object.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Collect the config paths that resolve to a volatile reference.
 *
 * This is the question the settings form asks of a resolved config: a reference
 * is a field the page can show and write, a plain value is not. So the paths
 * returned here are exactly the rows the page would offer for the subtree, and an
 * empty result is the test's way of saying "no row under this key".
 *
 * @param {unknown} value - resolved config value.
 * @param {string[]} [prefix] - path segments leading to `value`.
 * @returns {string[]} dotted paths of the references found.
 */
function volatilePaths(value, prefix = []) {
  if (isVolatileRef(value)) return [prefix.join('.')]
  if (!isPlainObject(value)) return []
  return Object.entries(value)
    .flatMap(([key, item]) => volatilePaths(item, [...prefix, key]))
}

/**
 * Overlay the defaults a later decision documents onto the base contract.
 *
 * @param {object} base - accumulated defaults.
 * @param {object} addition - keys added by one `config-defaults` block.
 * @returns {object} merged defaults; nested objects are merged, not replaced.
 */
function mergeDefaults(base, addition) {
  const result = { ...base }
  for (const [key, value] of Object.entries(addition)) {
    const previous = result[key]
    result[key] = isPlainObject(previous) && isPlainObject(value)
      ? mergeDefaults(previous, value)
      : value
  }
  return result
}

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

/**
 * Collect the `config-defaults` blocks of every change design doc.
 *
 * D11 documents the base contract; a later change records only the keys it adds,
 * so the defaults stay described once per decision instead of being repeated in
 * full by every change. The blocks keep working after the change is archived
 * because the walk covers `archive/` too.
 *
 * @returns {object[]} one parsed block per marker, in directory order.
 */
function documentedAdditions() {
  const changesDir = join(repoRoot, 'openspec', 'changes')
  const blocks = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'design.md') blocks.push(...defaultsBlocks(readFileSync(path, 'utf8')))
    }
  }
  walk(changesDir)
  return blocks
}

/**
 * Extract every ```json block that follows a `config-defaults` marker.
 *
 * @param {string} text - design.md content.
 * @returns {object[]} parsed blocks.
 */
function defaultsBlocks(text) {
  const blocks = []
  let marker = text.indexOf(CONFIG_DEFAULTS_MARKER)
  while (marker !== -1) {
    const open = text.indexOf('```json', marker)
    assert.notEqual(open, -1, `${CONFIG_DEFAULTS_MARKER} is not followed by a \`\`\`json block`)
    const start = text.indexOf('\n', open) + 1
    const end = text.indexOf('```', start)
    assert.notEqual(end, -1, 'a config-defaults ```json block is not closed')
    blocks.push(JSON.parse(text.slice(start, end)))
    marker = text.indexOf(CONFIG_DEFAULTS_MARKER, end)
  }
  return blocks
}

test('defaults resolved by the schema equal the ones documented in design.md', () => {
  const documented = documentedAdditions().reduce(mergeDefaults, documentedDefaults(readDesignDoc()))
  assert.deepEqual(plain(resolveConfig()), documented)
})

test('an absent config block resolves to the same defaults as an empty one', () => {
  assert.deepEqual(plain(resolveConfig(undefined)), plain(resolveConfig({})))
})

test('an already resolved config is passed through instead of validated again', () => {
  // `apply` receives the config the loader resolved, so its volatile fields are
  // references; re-validating that object would reject the very one the plugin
  // runs against (D12). A raw block still goes through the schema.
  const resolved = resolveConfig({ compaction: { midTask: true } })
  assert.equal(resolveConfig(resolved), resolved)
  assert.equal(resolveConfig(resolved).compaction.midTask.get(), true)
})

test('a configured change name is kept, the default means "not specified"', () => {
  assert.equal(resolveConfig({}).change, '')
  assert.equal(resolveConfig({ change: 'add-taskloop-plugin' }).change, 'add-taskloop-plugin')
})

test('commit and review are volatile fields with the documented defaults', () => {
  const config = resolveConfig()

  // Settings shows and writes only volatile fields, so these three must be
  // references even when the profile says nothing about them.
  assert.ok(isVolatileRef(config.commit.enabled), 'commit.enabled must be volatile')
  assert.ok(isVolatileRef(config.commit.tool), 'commit.tool must be volatile')
  assert.ok(isVolatileRef(config.review.enabled), 'review.enabled must be volatile')

  assert.equal(config.commit.enabled.get(), true)
  assert.equal(config.commit.tool.get(), 'git')
  assert.equal(config.review.enabled.get(), true)
})

test('pause is a volatile field, off by default', () => {
  const config = resolveConfig()

  // The pause switch (D21) is the seventh setting of the page, so it is a
  // reference like the commit and review fields: Settings can only show and
  // write volatile fields.
  assert.ok(isVolatileRef(config.pause.enabled), 'pause.enabled must be volatile')
  assert.equal(config.pause.enabled.get(), false)
  assert.equal(resolveConfig({ pause: { enabled: true } }).pause.enabled.get(), true)
})

test('enabling the pause leaves every other default untouched', () => {
  const { pause: pausedSwitch, ...pausedRest } = plain(resolveConfig({ pause: { enabled: true } }))
  const { pause: defaultSwitch, ...defaultRest } = plain(resolveConfig())

  // D21 changes where a run stops, not how any other setting resolves: with the
  // pause key removed, a paused config is byte-for-byte the empty-block config.
  assert.deepEqual(pausedSwitch, { enabled: true })
  assert.deepEqual(defaultSwitch, { enabled: false })
  assert.deepEqual(pausedRest, defaultRest)
})

test('both commit tools are accepted, an unknown one is rejected', () => {
  for (const tool of COMMIT_TOOLS) {
    assert.equal(resolveConfig({ commit: { tool } }).commit.tool.get(), tool)
  }
  assert.equal(resolveConfig({ commit: { enabled: false } }).commit.enabled.get(), false)
  assert.equal(resolveConfig({ review: { enabled: false } }).review.enabled.get(), false)

  // The offending path is part of the error, as it is for `onFailure`.
  assert.throws(() => resolveConfig({ commit: { tool: 'hg' } }), /commit\.tool/)
  assert.throws(() => resolveConfig({ commit: { tool: 'Git' } }), /commit\.tool/)
})

test('both exhaustion policies are accepted, anything else is rejected', () => {
  assert.equal(resolveConfig({ compaction: { onFailure: 'continue' } }).compaction.onFailure.get(), 'continue')
  assert.equal(resolveConfig({ compaction: { onFailure: 'break' } }).compaction.onFailure.get(), 'break')
  assert.throws(() => resolveConfig({ compaction: { onFailure: 'retry' } }), /onFailure/)
})

test('retry values are bounded by the schema', () => {
  assert.throws(() => resolveConfig({ compaction: { retry: { attempts: 0 } } }), /attempts/)
  assert.throws(() => resolveConfig({ compaction: { retry: { factor: 0.5 } } }), /factor/)
  assert.throws(() => resolveConfig({ openspec: { timeoutMs: 0 } }), /timeoutMs/)

  const configured = resolveConfig({
    compaction: { retry: { attempts: 1, delayMs: 0, factor: 1.5, maxDelayMs: 0, codes: ['busy'] } },
  })
  // The three numbers are references now (D1), so compare what they read.
  assert.deepEqual(plain(configured.compaction.retry), {
    attempts: 1,
    delayMs: 0,
    factor: 1.5,
    maxDelayMs: 0,
    codes: ['busy'],
  })
})

test('the three retry numbers are volatile, codes and the ceiling are not (D1)', () => {
  const retry = resolveConfig().compaction.retry

  // Exactly three page rows, and none under `codes` or `maxDelayMs`: the settings
  // form is built from volatile leaves, so this set is what the page can write.
  assert.deepEqual(volatilePaths(retry).sort(), ['attempts', 'delayMs', 'factor'])

  assert.ok(isVolatileRef(retry.attempts), 'compaction.retry.attempts must be volatile')
  assert.ok(isVolatileRef(retry.delayMs), 'compaction.retry.delayMs must be volatile')
  assert.ok(isVolatileRef(retry.factor), 'compaction.retry.factor must be volatile')

  // Volatile changes where the value is read from, not what it is: the documented
  // defaults still resolve, now behind a reference.
  assert.equal(retry.attempts.get(), DEFAULT_RETRY_ATTEMPTS)
  assert.equal(retry.delayMs.get(), DEFAULT_RETRY_DELAY_MS)
  assert.equal(retry.factor.get(), DEFAULT_RETRY_FACTOR)

  // Plain fields, kept out of the page on purpose: `codes` is the service's own
  // list of transient codes, and `maxDelayMs` is a profile-level brake (D1).
  assert.equal(isVolatileRef(retry.codes), false, 'compaction.retry.codes must stay plain')
  assert.equal(isVolatileRef(retry.maxDelayMs), false, 'compaction.retry.maxDelayMs must stay plain')
  assert.deepEqual(retry.codes, [...DEFAULT_RETRY_CODES])
  assert.equal(retry.maxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS)

  // A profile value reaches the same leaf: the reference reads what was configured.
  const configured = resolveConfig({
    compaction: { retry: { attempts: 2, delayMs: 5000, factor: 3, maxDelayMs: 8000, codes: ['busy'] } },
  })
  assert.deepEqual(volatilePaths(configured.compaction.retry).sort(), ['attempts', 'delayMs', 'factor'])
  assert.equal(configured.compaction.retry.attempts.get(), 2)
  assert.equal(configured.compaction.retry.delayMs.get(), 5000)
  assert.equal(configured.compaction.retry.factor.get(), 3)
  assert.equal(configured.compaction.retry.maxDelayMs, 8000)
  assert.deepEqual(configured.compaction.retry.codes, ['busy'])
})

test('the mid-task gate and the protocol section stay off unless switched on', () => {
  const off = resolveConfig()
  assert.equal(off.compaction.midTask.get(), false)
  assert.equal(off.protocol.systemSection.get(), false)

  const on = resolveConfig({ compaction: { midTask: true }, protocol: { systemSection: true } })
  assert.equal(on.compaction.midTask.get(), true)
  assert.equal(on.protocol.systemSection.get(), true)
})

test('the pre-existing compaction and protocol fields are volatile too (D12)', () => {
  const config = resolveConfig()

  // Moving these three to volatile must not change what they mean: the values
  // are still the documented defaults, only read through a reference now.
  assert.ok(isVolatileRef(config.compaction.onFailure), 'compaction.onFailure must be volatile')
  assert.ok(isVolatileRef(config.compaction.midTask), 'compaction.midTask must be volatile')
  assert.ok(isVolatileRef(config.protocol.systemSection), 'protocol.systemSection must be volatile')

  assert.equal(config.compaction.onFailure.get(), DEFAULT_ON_FAILURE)
  assert.equal(config.compaction.midTask.get(), DEFAULT_MID_TASK)
  assert.equal(config.protocol.systemSection.get(), DEFAULT_PROTOCOL_SYSTEM_SECTION)

  // Plain values from a profile stay valid and are still what the reference reads.
  const configured = resolveConfig({
    compaction: { onFailure: 'continue', midTask: true },
    protocol: { systemSection: true },
  })
  assert.equal(configured.compaction.onFailure.get(), 'continue')
  assert.equal(configured.compaction.midTask.get(), true)
  assert.equal(configured.protocol.systemSection.get(), true)
})
