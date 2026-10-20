// Tests for the `openspec` CLI invocation (task 2.1).
//
// No real child process is started: the tests are about the wrapper's own
// contract — which failures it classifies, that a nonzero exit stays a result,
// and that a hung CLI is cut off at `openspec.timeoutMs`. A fake subprocess
// service supplies the exit facts, so the assertions hold without `openspec`
// being installed and without depending on how fast a real CLI answers.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OPENSPEC_COMMAND, OPENSPEC_ERROR, OpenSpecCli, OpenSpecError } from '../lib/openspec.js'

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
