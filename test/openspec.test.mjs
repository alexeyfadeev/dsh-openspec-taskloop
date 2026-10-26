// Tests for the `openspec` CLI invocation (tasks 2.1, 9.1).
//
// No real child process is started: the tests are about the wrapper's own
// contract — which failures it classifies, that a nonzero exit stays a result,
// that a hung CLI is cut off at `openspec.timeoutMs`, and that a CLI below the
// supported floor is refused before the first read. A fake subprocess service
// supplies the exit facts, so the assertions hold without `openspec` being
// installed and without depending on how fast a real CLI answers.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MIN_OPENSPEC_VERSION,
  OPENSPEC_COMMAND,
  OPENSPEC_ERROR,
  OpenSpecCli,
  OpenSpecError,
  compareOpenSpecVersions,
  parseOpenSpecVersion,
} from '../lib/openspec.js'

/** A reader whose whole retained text is `text`. */
const reader = (text, lossy = false) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy }) })

/**
 * Build a handle the wrapper can settle.
 *
 * @param {object} options
 * @param {{exitCode: number|null, signal?: string|null}} [options.outcome] - exit facts; omit for a run that never ends.
 * @param {string} [options.stdout] - collected stdout.
 * @param {string} [options.stderr] - retained stderr.
 * @param {boolean} [options.lossy] - whether stdout lost its head.
 */
function handleOf({ outcome, stdout = '', stderr = '', lossy = false } = {}) {
  const handle = {
    collected: { stdout: reader(stdout, lossy), stderr: reader(stderr) },
    done: outcome === undefined ? new Promise(() => {}) : Promise.resolve({ signal: null, ...outcome }),
    terminated: 0,
    terminate() {
      handle.terminated += 1
    },
  }
  return handle
}

/**
 * A fake `ctx.subprocess` that records the resolver calls and the spawn specs.
 *
 * @param {object} options
 * @param {string|Error} [options.executable] - resolved path, or the lookup failure.
 * @param {(spec: object) => object} options.spawn - handle factory.
 */
function fakeSubprocess({ executable = '/usr/local/bin/openspec', spawn }) {
  const calls = { resolve: [], spawn: [] }
  return {
    calls,
    async resolveExecutable(command, env, signal) {
      calls.resolve.push({ command, env, signal })
      if (executable instanceof Error) throw executable
      return executable
    },
    spawn(spec) {
      calls.spawn.push(spec)
      return spawn(spec)
    },
  }
}

const cwd = process.cwd()

test('the CLI is resolved by name and runs the requested arguments in the given directory', async () => {
  const handle = handleOf({ outcome: { exitCode: 0 }, stdout: '{"root":{"path":"/project"}}' })
  const subprocess = fakeSubprocess({ executable: '/opt/openspec/bin/openspec', spawn: () => handle })
  const cli = new OpenSpecCli(subprocess, { timeoutMs: 120_000 })

  const result = await cli.run(['list', '--json'], { cwd })

  assert.deepEqual(result, { exitCode: 0, stdout: '{"root":{"path":"/project"}}', stderr: '', truncated: false })
  assert.equal(OPENSPEC_COMMAND, 'openspec')
  const lookup = subprocess.calls.resolve[0]
  assert.equal(lookup.command, 'openspec')
  assert.equal(lookup.env, undefined)
  assert.ok(lookup.signal instanceof AbortSignal)

  const spec = subprocess.calls.spawn[0]
  assert.deepEqual(spec.argv, ['/opt/openspec/bin/openspec', 'list', '--json'])
  assert.equal(spec.cwd, cwd)
  assert.equal(spec.stdio.stdin, 'ignore')
  assert.ok(spec.stdio.stdout.maxBytes > 0)
  assert.ok(spec.stdio.stderr.maxBytes > 0)
  assert.ok(spec.graceMs > 0)
  assert.ok(spec.signal instanceof AbortSignal)
  assert.equal(spec.signal.aborted, false)
})

test('a missing executable is reported as `missing` before anything is spawned', async () => {
  const lookupFailure = Object.assign(new Error('openspec: command not found'), {
    name: 'SubprocessExecutableNotFoundError',
  })
  const subprocess = fakeSubprocess({ executable: lookupFailure, spawn: () => handleOf({ outcome: { exitCode: 0 } }) })
  const cli = new OpenSpecCli(subprocess, { timeoutMs: 120_000 })

  await assert.rejects(cli.run(['list', '--json'], { cwd }), (error) => {
    assert.ok(error instanceof OpenSpecError)
    assert.equal(error.code, OPENSPEC_ERROR.missing)
    assert.match(error.message, /openspec CLI is not available/)
    assert.match(error.message, /command not found/)
    assert.deepEqual(error.args, ['list', '--json'])
    assert.equal(error.cause, lookupFailure)
    return true
  })
  assert.equal(subprocess.calls.spawn.length, 0)
})

test('a nonzero exit is a result, not an exception', async () => {
  // This is the uninitialized-project answer: the CLI exits nonzero and still
  // prints `root: null`, which the caller has to be able to read.
  const handle = handleOf({ outcome: { exitCode: 1 }, stdout: '{"changes":[],"root":null}' })
  const cli = new OpenSpecCli(fakeSubprocess({ spawn: () => handle }), { timeoutMs: 120_000 })

  const result = await cli.run(['list', '--json'], { cwd })

  assert.equal(result.exitCode, 1)
  assert.deepEqual(JSON.parse(result.stdout), { changes: [], root: null })
})

test('a hung CLI is terminated at openspec.timeoutMs', async () => {
  const handle = handleOf() // `done` never settles: the CLI is stuck.
  const subprocess = fakeSubprocess({ spawn: () => handle })
  const cli = new OpenSpecCli(subprocess, { timeoutMs: 25 })
  const started = Date.now()

  await assert.rejects(cli.run(['instructions', 'apply', '--json'], { cwd }), (error) => {
    assert.ok(error instanceof OpenSpecError)
    assert.equal(error.code, OPENSPEC_ERROR.timeout)
    assert.equal(error.timeoutMs, 25)
    assert.match(error.message, /timed out after 25ms/)
    return true
  })

  assert.ok(Date.now() - started >= 20, 'the call was cut short before its deadline')
  assert.equal(handle.terminated, 1, 'the managed process range was terminated')
  assert.equal(subprocess.calls.spawn[0].signal.aborted, true, 'the provider received an aborted signal')
})

test('the caller\'s own cancellation is reported as `aborted`, not as a timeout', async () => {
  const handle = handleOf()
  const cli = new OpenSpecCli(fakeSubprocess({ spawn: () => handle }), { timeoutMs: 60_000 })
  const controller = new AbortController()

  const pending = cli.run(['list', '--json'], { cwd, signal: controller.signal })
  setTimeout(() => controller.abort(), 10)

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof OpenSpecError)
    assert.equal(error.code, OPENSPEC_ERROR.aborted)
    assert.match(error.message, /was aborted/)
    assert.equal(error.timeoutMs, undefined)
    return true
  })
  assert.equal(handle.terminated, 1)
})

test('truncated stdout is reported, and an absent stderr reader yields an empty string', async () => {
  const handle = handleOf({ outcome: { exitCode: 0 }, stdout: 'tail only', lossy: true })
  delete handle.collected.stderr
  const cli = new OpenSpecCli(fakeSubprocess({ spawn: () => handle }), { timeoutMs: 120_000 })

  const result = await cli.run(['list', '--json'], { cwd })

  assert.equal(result.truncated, true)
  assert.equal(result.stdout, 'tail only')
  assert.equal(result.stderr, '')
})

test('a provider failure is reported as `spawn`', async () => {
  const failure = new Error('spawn EPERM')
  const handle = { ...handleOf(), done: Promise.reject(failure) }
  const cli = new OpenSpecCli(fakeSubprocess({ spawn: () => handle }), { timeoutMs: 120_000 })

  await assert.rejects(cli.run(['list', '--json'], { cwd }), (error) => {
    assert.ok(error instanceof OpenSpecError)
    assert.equal(error.code, OPENSPEC_ERROR.spawn)
    assert.match(error.message, /failed to run: spawn EPERM/)
    assert.equal(error.cause, failure)
    return true
  })
})

test('an already-aborted caller is refused before the CLI is started', async () => {
  const subprocess = fakeSubprocess({ spawn: () => handleOf({ outcome: { exitCode: 0 } }) })
  const cli = new OpenSpecCli(subprocess, { timeoutMs: 120_000 })

  await assert.rejects(cli.run(['list', '--json'], { cwd, signal: AbortSignal.abort() }), (error) => {
    assert.equal(error.code, OPENSPEC_ERROR.aborted)
    return true
  })
  assert.equal(subprocess.calls.spawn.length, 0)
})

test('a non-positive timeout is refused at construction', () => {
  const subprocess = fakeSubprocess({ spawn: () => handleOf({ outcome: { exitCode: 0 } }) })

  assert.throws(() => new OpenSpecCli(subprocess, { timeoutMs: 0 }), TypeError)
  assert.throws(() => new OpenSpecCli(subprocess, { timeoutMs: 1.5 }), TypeError)
  assert.throws(() => new OpenSpecCli(undefined, { timeoutMs: 1_000 }), TypeError)
})

/**
 * A CLI wrapper whose `--version` answer is `answer`.
 *
 * @param {string} answer - printed stdout.
 * @param {number} [exitCode] - process exit code.
 * @returns {{cli: OpenSpecCli, subprocess: object}} the wrapper and its recording fake.
 */
function versionCli(answer, exitCode = 0) {
  const subprocess = fakeSubprocess({
    spawn: () => handleOf({ outcome: { exitCode }, stdout: answer }),
  })
  return { cli: new OpenSpecCli(subprocess, { timeoutMs: 120_000 }), subprocess }
}

test('the first X.Y.Z of an answer is the version', () => {
  assert.deepEqual(parseOpenSpecVersion('1.14.1\n'), { major: 1, minor: 14, patch: 1 })
  assert.deepEqual(parseOpenSpecVersion('openspec 0.14.0\n'), { major: 0, minor: 14, patch: 0 })
  // Pre-release and build metadata are dropped: the gate is about the contract, not semver.
  assert.deepEqual(parseOpenSpecVersion('0.14.0-beta.2'), { major: 0, minor: 14, patch: 0 })
  assert.deepEqual(parseOpenSpecVersion('openspec cli v1.14.1+build.7 (node 24)'), { major: 1, minor: 14, patch: 1 })
  // The first version in the text wins, whatever follows it.
  assert.deepEqual(parseOpenSpecVersion('openspec 0.15.0 (node 20.11.0)'), { major: 0, minor: 15, patch: 0 })
})

test('an answer without a version is not a version', () => {
  assert.equal(parseOpenSpecVersion(''), undefined)
  assert.equal(parseOpenSpecVersion('openspec: unknown version'), undefined)
  assert.equal(parseOpenSpecVersion('1.14'), undefined)
  // A number nobody could compare is not a version either.
  assert.equal(parseOpenSpecVersion('99999999999999999999.1.1'), undefined)
  assert.equal(parseOpenSpecVersion(undefined), undefined)
})

test('versions are compared by numeric components, not as text', () => {
  const version = (text) => parseOpenSpecVersion(text)
  const minimum = version(MIN_OPENSPEC_VERSION)

  assert.ok(compareOpenSpecVersions(version('0.9.0'), minimum) < 0, '0.9.0 is older than 0.14.0')
  // The reason the comparison exists: as text, '0.9.0' sorts after '0.14.0'.
  assert.ok('0.9.0' > MIN_OPENSPEC_VERSION)
  assert.equal(compareOpenSpecVersions(version('0.14.0'), minimum), 0, '0.14.0 is the minimum itself')
  assert.ok(compareOpenSpecVersions(version('1.14.1'), minimum) > 0, '1.14.1 is newer than the minimum')
  assert.ok(compareOpenSpecVersions(version('0.14.1'), version('0.14.0')) > 0)
  assert.ok(compareOpenSpecVersions(version('0.2.0'), version('0.14.0')) < 0)

  assert.throws(() => compareOpenSpecVersions(undefined, minimum), TypeError)
  assert.throws(() => compareOpenSpecVersions(version('0.14.0'), {}), TypeError)
})

test('a supported CLI resolves its version and is asked once per run', async () => {
  const { cli, subprocess } = versionCli('1.14.1\n')

  assert.deepEqual(await cli.ensureSupportedVersion({ cwd }), { major: 1, minor: 14, patch: 1 })
  // The second ask is the same answer, not a second process: the wrapper remembers the verdict.
  assert.deepEqual(await cli.ensureSupportedVersion({ cwd }), { major: 1, minor: 14, patch: 1 })

  assert.deepEqual(subprocess.calls.spawn[0].argv, ['/usr/local/bin/openspec', '--version'])
  assert.equal(subprocess.calls.spawn[0].cwd, cwd)
  assert.equal(subprocess.calls.spawn.length, 1)
})

test('the minimum version itself is supported', async () => {
  const { cli } = versionCli('0.14.0')

  assert.deepEqual(await cli.ensureSupportedVersion({ cwd }), { major: 0, minor: 14, patch: 0 })
})

test('a pre-release at the floor counts as the floor', async () => {
  // Design D20: the gate exists to exclude the old contract, not to honour semver ordering.
  const { cli } = versionCli('0.14.0-beta.2\n')

  assert.deepEqual(await cli.ensureSupportedVersion({ cwd }), { major: 0, minor: 14, patch: 0 })
})

test('a CLI below the floor is refused with both versions and the advice to update', async () => {
  const { cli } = versionCli('0.9.0\n')

  await assert.rejects(cli.ensureSupportedVersion({ cwd }), (error) => {
    assert.ok(error instanceof OpenSpecError)
    assert.equal(error.code, OPENSPEC_ERROR.outdated)
    assert.match(error.message, /openspec 0\.9\.0 is older than the minimum 0\.14\.0/)
    assert.match(error.message, /update OpenSpec to 0\.14\.0 or newer/)
    assert.deepEqual(error.args, ['--version'])
    return true
  })
})

test('an answer without a version stops the run instead of guessing', async () => {
  const { cli } = versionCli('openspec: unknown build\n./src/cli.ts\n')

  await assert.rejects(cli.ensureSupportedVersion({ cwd }), (error) => {
    assert.equal(error.code, OPENSPEC_ERROR.unrecognized)
    assert.match(error.message, /the openspec version could not be determined/)
    assert.match(error.message, /printed no X\.Y\.Z version/)
    assert.match(error.message, /0\.14\.0 or newer is required/)
    return true
  })
})

test('a --version that fails is unrecognized even when it printed something', async () => {
  const { cli } = versionCli('0.9.0', 2)

  await assert.rejects(cli.ensureSupportedVersion({ cwd }), (error) => {
    assert.equal(error.code, OPENSPEC_ERROR.unrecognized)
    assert.match(error.message, /openspec --version exited with code 2/)
    return true
  })
})

test('a hung --version is the wrapper\'s timeout, not an unrecognized version', async () => {
  const handle = handleOf() // `done` never settles.
  const cli = new OpenSpecCli(fakeSubprocess({ spawn: () => handle }), { timeoutMs: 25 })

  await assert.rejects(cli.ensureSupportedVersion({ cwd }), (error) => {
    assert.equal(error.code, OPENSPEC_ERROR.timeout)
    return true
  })
  assert.equal(handle.terminated, 1)
})
