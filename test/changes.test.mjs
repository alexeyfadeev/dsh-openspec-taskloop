// Tests for `openspec list --json` parsing and change selection (task 2.2).
//
// The fixtures under `fixtures/listing/` are captured from openspec 1.14.1
// (`repo.json`, `no-root.json`, `empty.json`) plus two hand-written documents in
// the same shape (`multi.json`, `tie.json`) that make ordering and tie-breaking
// observable without depending on file timestamps. The captured documents are
// frozen evidence of the CLI's real output, so a shape change upstream shows up
// as a failing parse instead of a surprise during a run.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LISTING_ERROR, ListingError, parseChangeListing, SELECTION, selectChange } from '../lib/changes.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'listing')

/**
 * Read one listing fixture.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {string} raw document text.
 */
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8')

/**
 * Parse a fixture.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {import('../lib/changes.js').ChangeListing} parsed listing.
 */
const listingOf = (name) => parseChangeListing(fixture(name))

test('reads an initialized listing and its single change', () => {
  const listing = listingOf('repo.json')

  assert.equal(listing.root?.source, 'nearest')
  assert.ok(listing.root.path.endsWith('dsh-openspec-taskloop'), `unexpected root: ${listing.root.path}`)
  assert.deepEqual(listing.diagnostics, [])
  assert.equal(listing.changes.length, 1)

  const [change] = listing.changes
  assert.equal(change.name, 'add-taskloop-plugin')
  assert.equal(change.completedTasks, 3)
  assert.equal(change.totalTasks, 20)
  assert.equal(change.status, 'in-progress')
  // The CLI prints an ISO string; selection compares numbers.
  assert.equal(change.lastModified, Date.parse('2026-10-20T12:43:10.120Z'))
})

test('reads an uninitialized listing and keeps the CLI diagnostics', () => {
  const listing = listingOf('no-root.json')

  assert.equal(listing.root, null)
  assert.deepEqual(listing.changes, [])
  assert.equal(listing.diagnostics.length, 1)
  assert.equal(listing.diagnostics[0].code, 'no_openspec_root')
  assert.match(listing.diagnostics[0].message, /No OpenSpec root found/)
  assert.match(listing.diagnostics[0].fix, /openspec init/)
})

test('treats an absent root key as no root', () => {
  // `ListCommand` omits the key entirely when it has no root, while the CLI
  // wrapper prints `"root": null`; both mean the same thing to the plugin.
  assert.equal(parseChangeListing('{"changes":[]}').root, null)
})

test('reads an initialized project that has no changes yet', () => {
  const listing = listingOf('empty.json')

  assert.equal(listing.root?.source, 'nearest')
  assert.deepEqual(listing.changes, [])
  assert.equal(selectChange(listing).kind, SELECTION.empty)
})

test('picks the most recently modified change instead of the first listed', () => {
  const listing = listingOf('multi.json')

  assert.equal(listing.changes[0].name, 'add-billing', 'fixture should not be sorted by the parser')

  const selection = selectChange(listing)
  assert.equal(selection.kind, SELECTION.selected)
  assert.equal(selection.change.name, 'fix-login-redirect')
  assert.equal(selection.change.status, 'complete')
})

test('breaks a timestamp tie by name', () => {
  // `refactor-cli` is listed first and carries the same timestamp as
  // `fix-login-redirect`, so "first wins" would pick it. The rule is by name.
  const listing = listingOf('tie.json')

  assert.equal(listing.changes[0].name, 'refactor-cli')

  const selection = selectChange(listing)
  assert.equal(selection.kind, SELECTION.selected)
  assert.equal(selection.change.name, 'fix-login-redirect')
})

test('selects the change named by the argument even when it is the oldest', () => {
  const listing = listingOf('multi.json')
  const before = listing.changes.map((change) => change.name)

  const selection = selectChange(listing, 'add-billing')
  assert.equal(selection.kind, SELECTION.selected)
  assert.equal(selection.change.name, 'add-billing')

  // Padding around a configured name is trimmed, and the configured default `''`
  // means "not given" — it must fall back to the newest change, not to nothing.
  assert.equal(selectChange(listing, '  add-billing  ').change.name, 'add-billing')
  assert.equal(selectChange(listing, '').change.name, 'fix-login-redirect')

  assert.deepEqual(listing.changes.map((change) => change.name), before, 'selection must not reorder the listing')
})

test('reports an unknown name together with the available names', () => {
  const selection = selectChange(listingOf('multi.json'), 'add-auth')

  assert.equal(selection.kind, SELECTION.unknown)
  assert.equal(selection.name, 'add-auth')
  assert.deepEqual(selection.available, ['add-billing', 'docs-update', 'fix-login-redirect', 'refactor-cli'])
})

test('rejects output that is not JSON', () => {
  assert.throws(
    () => parseChangeListing('openspec: command not found'),
    (error) => {
      assert.ok(error instanceof ListingError)
      assert.equal(error.code, LISTING_ERROR.malformed)
      assert.match(error.message, /did not return JSON/)
      return true
    },
  )
})

test('rejects a document that is not a listing', () => {
  for (const text of ['{}', '[]', '"changes"', 'null', '{"error":"boom"}']) {
    assert.throws(() => parseChangeListing(text), ListingError, `should reject: ${text}`)
  }
})

test('rejects a root that cannot name a directory', () => {
  assert.throws(() => parseChangeListing('{"root":"C:/projects/demo","changes":[]}'), /unexpected root/)
  assert.throws(() => parseChangeListing('{"root":{},"changes":[]}'), /root without a path/)
})

test('rejects a change entry without a usable timestamp', () => {
  const text = JSON.stringify({
    changes: [{ name: 'add-billing', lastModified: 'yesterday' }],
    root: { path: 'C:/projects/demo', source: 'nearest' },
  })

  assert.throws(() => parseChangeListing(text), (error) => {
    assert.ok(error instanceof ListingError)
    assert.match(error.message, /changes\[0\]/)
    assert.match(error.message, /add-billing/)
    assert.match(error.message, /lastModified/)
    return true
  })
})

test('keeps additive fields of the document out of the way', () => {
  // Newer CLI versions add `warnings`, `archived`, `nested` and `store_id`. None
  // of them may change the parse, and a diagnostic next to a present root is
  // still worth surfacing.
  const text = JSON.stringify({
    changes: [
      {
        name: 'add-billing',
        completedTasks: 1,
        totalTasks: 5,
        lastModified: '2026-10-02T08:15:00.000Z',
        status: 'in-progress',
        archived: false,
        nested: { path: 'openspec/changes/add-billing/wrapper' },
      },
    ],
    warnings: [{ code: 'nested_change_directory', name: 'add-billing', message: 'nested change' }],
    root: { path: 'C:/projects/demo', source: 'store', store_id: 'demo' },
    status: [{ severity: 'warning', code: 'something', message: 'heads up' }],
  })

  const listing = parseChangeListing(text)
  assert.equal(listing.root.path, 'C:/projects/demo')
  assert.equal(listing.root.source, 'store')
  assert.equal(listing.changes.length, 1)
  assert.equal(listing.changes[0].totalTasks, 5)
  assert.deepEqual(listing.diagnostics.map((d) => d.code), ['something'])
})

test('a missing task count becomes null instead of a wrong number', () => {
  const text = JSON.stringify({
    changes: [{ name: 'add-billing', lastModified: '2026-10-02T08:15:00.000Z' }],
    root: { path: 'C:/projects/demo', source: 'nearest' },
  })

  const [change] = parseChangeListing(text).changes
  assert.equal(change.completedTasks, null)
  assert.equal(change.totalTasks, null)
  assert.equal(change.status, null)
})
