// The client-half declaration (task 2.1).
//
// The host's client module loader reads three things from a plugin package and
// fails without them: the `dsh.client` declaration (`platform` is required and
// only `web` composes), `exports["./client"]` naming the bundle it serves under
// `/plugins`, and the bundle file itself. `files` is the fourth, quieter one:
// npm packs only those paths, so a client bundle left out of the whitelist works
// from a checkout and disappears from an installed package.
//
// Nothing here executes the bundle — loading it against a fake loader and React
// belongs to task 2.2. This file pins the manifest contract, so a renamed bundle
// or a dropped field fails here instead of in the user's Settings page.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/**
 * Client packages whose services the Settings page consumes.
 *
 * `dsh-client-ui-settings` provides `configForms` and declares the
 * `settings.section` slot type; `dsh-client-ui-slots` provides the slot registry
 * the page registers into. The loader orders a row's `inject` packages ahead of
 * it, which is how the page finds both services already mounted.
 */
const REQUIRED_CLIENT_INJECT = [
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-slots',
]

/** The bundle the loader resolves through `exports["./client"]`. */
const CLIENT_BUNDLE = 'lib/client.js'

/**
 * Whether `files` would ship a package-relative path.
 *
 * Only the two shapes this manifest uses are modelled: an exact file, and a
 * directory whose whole subtree ships. npm also accepts globs and negations;
 * none are used here, and a helper that guessed at them would pass on a
 * whitelist that actually ships nothing.
 *
 * @param {string[]} files - the manifest's `files` whitelist.
 * @param {string} path - package-relative path to look for.
 * @returns {boolean} whether the path is inside the published package.
 */
function ships(files, path) {
  return files.some((entry) => {
    const clean = entry.replace(/^\.?\//u, '').replace(/\/$/u, '')
    return clean === path || path.startsWith(`${clean}/`)
  })
}

test('the manifest declares the web client half the host module loader reads', () => {
  assert.equal(typeof manifest.dsh, 'object', 'the host reads the client declaration from `dsh`')
  assert.notEqual(manifest.dsh, null)

  const client = manifest.dsh.client
  assert.equal(typeof client, 'object', 'the Settings page is a client half: `dsh.client` must be declared')
  assert.notEqual(client, null)
  assert.ok(!Array.isArray(client), '`dsh.client` is an object, not a list')

  assert.equal(client.platform, 'web', 'the loader composes only `platform: "web"` declarations')

  assert.ok(Array.isArray(client.inject), '`dsh.client.inject` lists the packages whose services the page uses')
  for (const name of client.inject) {
    assert.equal(typeof name, 'string', 'every `dsh.client.inject` entry is a package name')
    assert.notEqual(name, '')
  }
  for (const required of REQUIRED_CLIENT_INJECT) {
    assert.ok(
      client.inject.includes(required),
      `the page needs ${required}, so the loader must load it first`,
    )
  }
})

test('the ./client export names the bundle the loader serves', () => {
  assert.equal(
    manifest.exports['./client'],
    `./${CLIENT_BUNDLE}`,
    'the loader resolves the client bundle through this subpath export',
  )
  assert.ok(
    existsSync(join(packageRoot, CLIENT_BUNDLE)),
    `${CLIENT_BUNDLE} is the bundle \`exports["./client"]\` promises`,
  )
})

test('the client bundle ships with the package', () => {
  assert.ok(Array.isArray(manifest.files), '`files` decides what the published package contains')
  assert.ok(
    ships(manifest.files, CLIENT_BUNDLE),
    `${CLIENT_BUNDLE} must be inside \`files\`, or an installed plugin ships no client half`,
  )
})

test('the host half keeps its entry and bundle patch', () => {
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.main, 'lib/index.js')
  assert.ok(existsSync(join(packageRoot, 'lib/index.js')), 'the host entry must exist')
  assert.equal(
    manifest.dsh.bundle.patch,
    './cordis.patch.yml',
    'declaring a client half must not displace the bundle patch that mounts the host half',
  )
  assert.ok(existsSync(join(packageRoot, 'cordis.patch.yml')))
})
