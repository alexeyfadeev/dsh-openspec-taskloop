// Tests for the command actions (task 3.2): root check, change selection and the
// result text a user sees.
//
// The actions are driven with fakes for all three dependencies, so these tests
// pin the contract the Cordis seam has to satisfy — which directory the CLI is
// asked about, that a refusal writes nothing, and that a failure becomes a
// result instead of a thrown handler — without a host and without `openspec`
// installed.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { INIT_ARGS, INIT_ANSWER } from '../lib/bootstrap.js'
import { resolveConfig } from '../lib/config.js'
import { createControl } from '../lib/control.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'listing')

/**
 * Read one captured listing fixture.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {string} raw document text.
 */
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8')

const CWD = 'C:\\projects\\demo'

/**
 * Build the exit facts of one CLI call.
 *
 * @param {string} stdout - collected stdout.
 * @param {number} [exitCode] - process exit code.
 * @returns {object} a settled CLI result.
 */
const cliResult = (stdout, exitCode = 0) => ({ exitCode, stdout, stderr: '', truncated: false })

/**
 * A fake CLI that answers each call from a script and records the calls.
 *
 * @param {object[]} responses - settled results, consumed in call order.
 * @returns {object} the fake wrapper with a `calls` log.
 */
function scriptedCli(responses) {
  const calls = []
  return {
    calls,
    async run(args, options) {
      calls.push({ args, options })
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`)
      if (next instanceof Error) throw next
      return next
    },
  }
}

/**
 * Build a control with fakes for the directory, the CLI and the confirmation.
 *
 * @param {object} options
 * @param {() => object} options.createCli - factory for the fake CLI.
 * @param {Function} [options.confirm] - confirmation decision.
 * @param {object} [options.config] - raw config block.
 * @returns {{control: object, asked: object[]}} the control and the confirmations it requested.
 */
function harness({ createCli, confirm = async () => INIT_ANSWER.cancel, config = {} }) {
  const asked = []
  const control = createControl({
    config: resolveConfig(config),
    createCli,
    cwdOf: () => CWD,
    askInit: async (invocation, cwd) => {
      asked.push({ invocation, cwd })
      return confirm({ cwd })
    },
  })
  return { control, asked }
}

/** An invocation shaped like the registry's. */
const invocation = () => ({
  commandId: 'command-1',
  agent: { id: 'agent-1' },
  rawInput: '',
  attachments: [],
  signal: new AbortController().signal,
})

test('an initialized project reports its root and the change the run would use', async () => {
  const cli = scriptedCli([cliResult(fixture('repo.json'))])
  const { control } = harness({ createCli: () => cli })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /^taskloop: OpenSpec root: .*dsh-openspec-taskloop\./)
  assert.match(result.text, /Change "add-taskloop-plugin" \(/u)
  assert.match(result.text, /no task was started/)
  assert.equal(cli.calls.length, 1)
  assert.equal(cli.calls[0].options.cwd, CWD)
})

test('the configured change is used when the argument is absent', async () => {
  const cli = scriptedCli([cliResult(fixture('multi.json'))])
  const { control } = harness({ createCli: () => cli, config: { change: 'add-billing' } })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Change "add-billing"/)
  // The configured name wins even though `fix-login-redirect` is newer.
  assert.doesNotMatch(result.text, /fix-login-redirect/)
})

test('an unknown change is an error that lists the alternatives', async () => {
  const cli = scriptedCli([cliResult(fixture('multi.json'))])
  const { control } = harness({ createCli: () => cli })

  const result = await control.run(invocation(), { change: 'add-biling' })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /no change named "add-biling"/)
  assert.match(result.text, /add-billing/u)
  assert.match(result.text, /refactor-cli/u)
  // The listing ran once and nothing else: no init, no run.
  assert.equal(cli.calls.length, 1)
})

test('a refusal leaves the project as it was and reports the cancellation', async () => {
  const cli = scriptedCli([cliResult(fixture('no-root.json'), 1)])
  const { control, asked } = harness({
    createCli: () => cli,
    confirm: async () => INIT_ANSWER.cancel,
  })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /initialization cancelled/)
  assert.match(result.text, /no files were created/)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].cwd, CWD)
  assert.equal(cli.calls.length, 1)
})

test('a confirmed initialisation creates the root and then asks for nothing else', async () => {
  const cli = scriptedCli([
    cliResult(fixture('no-root.json'), 1),
    cliResult('OpenSpec Setup Complete'),
    cliResult(fixture('empty.json')),
  ])
  const { control } = harness({
    createCli: () => cli,
    confirm: async () => INIT_ANSWER.initialize,
  })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /initialized OpenSpec; the root is C:\\projects\\empty-project\./)
  assert.match(result.text, /no changes yet/)
  assert.match(result.text, /nothing was started/)
  assert.deepEqual(cli.calls[1].args, INIT_ARGS)
})

test('an initialized project without changes starts nothing', async () => {
  const cli = scriptedCli([cliResult(fixture('empty.json'))])
  const { control, asked } = harness({ createCli: () => cli })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /OpenSpec root: C:\\projects\\empty-project\./)
  assert.match(result.text, /no changes yet/)
  assert.equal(asked.length, 0)
})

test('a session without a confirmation channel reports the failure, not a refusal', async () => {
  const cli = scriptedCli([cliResult(fixture('no-root.json'), 1)])
  const { control } = harness({
    createCli: () => cli,
    confirm: async () => INIT_ANSWER.unavailable,
  })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /cannot ask for confirmation/)
  assert.match(result.text, /openspec init --tools dsh/)
  assert.equal(cli.calls.length, 1)
})

test('a CLI that cannot be built becomes an error result, not a thrown handler', async () => {
  const { control } = harness({
    createCli: () => {
      throw new Error('the openspec CLI cannot run because the subprocess service is not composed')
    },
  })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /subprocess service is not composed/)
})

test('a CLI that fails mid-call becomes an error result with its own message', async () => {
  const cli = scriptedCli([Object.assign(new Error('openspec CLI is not available: not found'), {
    name: 'OpenSpecError',
    code: 'missing',
  })])
  const { control } = harness({ createCli: () => cli })

  const result = await control.run(invocation(), { change: null })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /^taskloop: openspec CLI is not available/)
})

test('stop and status still answer that no run is active', () => {
  const { control } = harness({ createCli: () => ({}) })

  assert.deepEqual(control.stop(), { kind: 'success', text: 'taskloop: no run is active.' })
  assert.deepEqual(control.status(), { kind: 'success', text: 'taskloop: no run is active.' })
})
