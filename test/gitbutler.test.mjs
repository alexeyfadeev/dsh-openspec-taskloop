// Tests for the GitButler version gate (task 3.1, design D1/D4/D5).
//
// The version check is deliberately the pure half of the gate: the constant floor, the
// parser that reads the first `X.Y.Z` out of a `but --version` answer, and the numeric
// component comparison. No child process is started and no host is needed — the tests
// assert the parser and the comparator the same way `test/openspec.test.mjs` asserts
// `parseOpenSpecVersion` and `compareOpenSpecVersions`. Wiring the gate into the input
// card — calling `but --version` once per run and stopping below the floor — is task 3.2
// and lives in `lib/control.js`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GITBUTLER_COMMAND,
  MIN_GITBUTLER_VERSION,
  compareGitButlerVersions,
  parseGitButlerVersion,
} from '../lib/gitbutler.js'

test('the constant names the tool and the floor', () => {
  assert.equal(GITBUTLER_COMMAND, 'but')
  assert.equal(MIN_GITBUTLER_VERSION, '0.22.0')
})

test('the first X.Y.Z of a but --version answer is the version', () => {
  assert.deepEqual(parseGitButlerVersion('0.22.3\n'), { major: 0, minor: 22, patch: 3 })
  assert.deepEqual(parseGitButlerVersion('but 0.22.0\n'), { major: 0, minor: 22, patch: 0 })
  // Pre-release and build metadata are dropped: the gate is about the contract, not semver.
  assert.deepEqual(parseGitButlerVersion('0.22.0-beta.2'), { major: 0, minor: 22, patch: 0 })
  assert.deepEqual(parseGitButlerVersion('but cli v0.22.3+build.7 (x86_64)'), { major: 0, minor: 22, patch: 3 })
  // The first version in the text wins, whatever follows it.
  assert.deepEqual(parseGitButlerVersion('but 0.23.0 (node 20.11.0)'), { major: 0, minor: 23, patch: 0 })
})

test('an answer without a version is not a version', () => {
  assert.equal(parseGitButlerVersion(''), undefined)
  assert.equal(parseGitButlerVersion('but: unknown version'), undefined)
  assert.equal(parseGitButlerVersion('0.22'), undefined)
  // A number nobody could compare is not a version either.
  assert.equal(parseGitButlerVersion('99999999999999999999.1.1'), undefined)
  assert.equal(parseGitButlerVersion(undefined), undefined)
})

test('versions are compared by numeric components, not as text', () => {
  const version = (text) => parseGitButlerVersion(text)
  const minimum = version(MIN_GITBUTLER_VERSION)

  assert.ok(compareGitButlerVersions(version('0.21.0'), minimum) < 0, '0.21.0 is older than 0.22.0')
  // The reason the comparison exists: as text, '0.9.0' sorts after '0.22.0'.
  assert.ok('0.9.0' > MIN_GITBUTLER_VERSION)
  assert.equal(compareGitButlerVersions(version('0.22.0'), minimum), 0, '0.22.0 is the minimum itself')
  assert.ok(compareGitButlerVersions(version('1.0.0'), minimum) > 0, '1.0.0 is newer than the minimum')
  assert.ok(compareGitButlerVersions(version('0.22.1'), version('0.22.0')) > 0)
  assert.ok(compareGitButlerVersions(version('0.2.0'), version('0.22.0')) < 0)

  assert.throws(() => compareGitButlerVersions(undefined, minimum), TypeError)
  assert.throws(() => compareGitButlerVersions(version('0.22.0'), {}), TypeError)
})