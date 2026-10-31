// Tests for the `/taskloop` command surface (tasks 3.1, 8.1).
//
// Two things are pinned here: the grammar of the argument (pure, exhaustively
// covered) and the rule the spec states twice — an argument the command does not
// understand returns the usage text and starts nothing. The second is asserted
// against action spies rather than against wording, so filling the actions in
// later tasks cannot silently turn an unknown argument into a run.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ACTION, COMMAND, parseTaskloopArgs, registerTaskloopCommand, USAGE } from '../lib/command.js'
import { apply, inject, name } from '../lib/index.js'

/**
 * Minimal stand-in for the plugin context: records registrations and runs
 * effect callbacks immediately, the way the loader would on mount.
 *
 * @returns {{ctx: object, registrations: object[]}} fake context and its registrations.
 */
function fakeContext() {
  const registrations = []
  const ctx = {
    logger: { info() {} },
    commands: {
      register(definition) {
        registrations.push(definition)
        return () => {
          registrations.splice(registrations.indexOf(definition), 1)
        }
      },
    },
    effect(callback) {
      return callback()
    },
    // A deployment without Settings: `apply` asks for the service and the callback
    // never runs, so mounting a command stays independent of the client half.
    inject() {},
  }
  return { ctx, registrations }
}

/**
 * Build an invocation the registry would pass to the handler.
 *
 * @param {string} rawInput - text following the command name.
 * @returns {object} invocation.
 */
const invocation = (rawInput) => ({
  commandId: 'command-1',
  agent: { id: 'agent-1' },
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
})

/**
 * Control whose actions record their calls and return one fixed result.
 *
 * @param {object} [result] - result every action returns.
 * @returns {{control: object, calls: unknown[][], result: object}} control, recorded calls and the shared result.
 */
function fakeControl(result = { kind: 'success' }) {
  const calls = []
  const action = (kind) => (...args) => {
    calls.push([kind, ...args])
    return result
  }
  return {
    control: {
      run: action(ACTION.run),
      stop: action(ACTION.stop),
      status: action(ACTION.status),
      explore: action(ACTION.explore),
      pause: action(ACTION.pause),
      resume: action(ACTION.resume),
    },
    calls,
    result,
  }
}

test('an empty argument is a run request without a change name', () => {
  // The empty change is not a change named "": it means "not specified", which
  // the bootstrap resolves from config or the listing.
  assert.deepEqual(parseTaskloopArgs(''), { kind: ACTION.run, change: null })
  assert.deepEqual(parseTaskloopArgs('   '), { kind: ACTION.run, change: null })
  assert.deepEqual(parseTaskloopArgs('\t\n'), { kind: ACTION.run, change: null })
})

test('a single token is the change name', () => {
  assert.deepEqual(parseTaskloopArgs(' add-taskloop-plugin'), { kind: ACTION.run, change: 'add-taskloop-plugin' })
  assert.deepEqual(parseTaskloopArgs('add-taskloop-plugin '), { kind: ACTION.run, change: 'add-taskloop-plugin' })
})

test('stop, status and explore are subcommands, not change names', () => {
  assert.deepEqual(parseTaskloopArgs('stop'), { kind: ACTION.stop })
  assert.deepEqual(parseTaskloopArgs('  stop  '), { kind: ACTION.stop })
  assert.deepEqual(parseTaskloopArgs('status'), { kind: ACTION.status })
  assert.deepEqual(parseTaskloopArgs('\tstatus'), { kind: ACTION.status })
  // `explore` shadows a change of the same name — the accepted trade-off of the
  // fourth form (design D19), recorded here as behaviour rather than as an
  // accident: the subcommand wins whenever the whole argument is that word.
  assert.deepEqual(parseTaskloopArgs('explore'), { kind: ACTION.explore })
  assert.deepEqual(parseTaskloopArgs('  explore\n'), { kind: ACTION.explore })
})

test('pause and resume are subcommands that shadow changes of the same name', () => {
  // The two forms the pause feature adds: the whole argument being the word makes it
  // a subcommand, so a change that happens to be called `pause` or `resume` cannot be
  // started through that spelling — the same trade-off `explore` records (design D19).
  assert.deepEqual(parseTaskloopArgs('pause'), { kind: ACTION.pause })
  assert.deepEqual(parseTaskloopArgs('  pause  '), { kind: ACTION.pause })
  assert.deepEqual(parseTaskloopArgs('resume'), { kind: ACTION.resume })
  assert.deepEqual(parseTaskloopArgs('\tresume\n'), { kind: ACTION.resume })
  for (const name of ['pause', 'resume']) {
    assert.notDeepEqual(parseTaskloopArgs(name), { kind: ACTION.run, change: name })
  }
})

test('matches subcommands exactly, so their uppercase spellings stay change names', () => {
  // OpenSpec change names are lowercase, so no real change is shadowed by this;
  // an uppercase subcommand reaching the bootstrap fails there as an unknown
  // change, with the list of names to choose from.
  assert.deepEqual(parseTaskloopArgs('STOP'), { kind: ACTION.run, change: 'STOP' })
  assert.deepEqual(parseTaskloopArgs('Status'), { kind: ACTION.run, change: 'Status' })
  assert.deepEqual(parseTaskloopArgs('Explore'), { kind: ACTION.run, change: 'Explore' })
  assert.deepEqual(parseTaskloopArgs('Pause'), { kind: ACTION.run, change: 'Pause' })
  assert.deepEqual(parseTaskloopArgs('Resume'), { kind: ACTION.run, change: 'Resume' })
})

test('more than one argument is a usage error naming the count', () => {
  for (const rawInput of [
    'stop now', 'status extra', 'explore now', 'pause now', 'resume now', 'a b', '  add-auth  please ',
  ]) {
    const parsed = parseTaskloopArgs(rawInput)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /at most one argument/)
  }
  assert.match(parseTaskloopArgs('a b').reason, /got 2/)
})

test('rejects input that is not a string', () => {
  assert.throws(() => parseTaskloopArgs(undefined), TypeError)
})

test('registers the command with its metadata and no attachments', () => {
  const { ctx, registrations } = fakeContext()
  const { control } = fakeControl()
  const dispose = registerTaskloopCommand(ctx, control)

  assert.equal(typeof dispose, 'function')
  assert.equal(registrations.length, 1)
  const [definition] = registrations
  assert.equal(definition.name, 'taskloop')
  assert.equal(definition.description, COMMAND.description)
  // No `attachments` flag: the registry then refuses files and images for the
  // command before the handler runs, which the grammar has no use for.
  assert.deepEqual(definition.input, { hint: COMMAND.hint })
  assert.equal(typeof definition.handler, 'function')
})

test('refuses to register without all six actions', () => {
  const { ctx } = fakeContext()
  for (const missing of [
    ACTION.run, ACTION.stop, ACTION.status, ACTION.explore, ACTION.pause, ACTION.resume,
  ]) {
    const { control } = fakeControl()
    delete control[missing]
    assert.throws(() => registerTaskloopCommand(ctx, control), new RegExp(`control\\.${missing}`))
  }
  assert.throws(() => registerTaskloopCommand(ctx, undefined), TypeError)
})

test('an unknown argument returns the usage and reaches no action', () => {
  const { ctx, registrations } = fakeContext()
  const { control, calls } = fakeControl()
  registerTaskloopCommand(ctx, control)
  const [{ handler }] = registrations

  const result = handler(invocation(' stop now '))

  assert.equal(result.kind, 'error')
  assert.match(result.text, /at most one argument/)
  assert.ok(result.text.includes(USAGE))
  assert.deepEqual(calls, [])
})

test('a run request reaches start with the change and the invocation', () => {
  const { ctx, registrations } = fakeContext()
  const { control, calls, result } = fakeControl()
  registerTaskloopCommand(ctx, control)

  const request = invocation(' add-auth')
  // The handler passes the action's own result through untouched.
  assert.equal(registrations[0].handler(request), result)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], ACTION.run)
  assert.equal(calls[0][1], request)
  assert.deepEqual(calls[0][2], { change: 'add-auth' })
})

test('an argument-free run request passes no change', () => {
  const { ctx, registrations } = fakeContext()
  const { control, calls } = fakeControl()
  registerTaskloopCommand(ctx, control)

  registrations[0].handler(invocation('   '))

  assert.deepEqual(calls[0][2], { change: null })
})

test('stop and status reach their own actions', () => {
  const { ctx, registrations } = fakeContext()
  const { control, calls, result } = fakeControl()
  registerTaskloopCommand(ctx, control)
  const [{ handler }] = registrations

  const stopInvocation = invocation('stop')
  const statusInvocation = invocation(' status ')
  assert.equal(handler(stopInvocation), result)
  assert.equal(handler(statusInvocation), result)

  assert.deepEqual(calls.map((call) => call[0]), [ACTION.stop, ACTION.status])
  assert.equal(calls[0][1], stopInvocation)
  assert.equal(calls[1][1], statusInvocation)
})

test('an explore request reaches only the explore action', () => {
  const { ctx, registrations } = fakeContext()
  const { control, calls, result } = fakeControl()
  registerTaskloopCommand(ctx, control)
  const [{ handler }] = registrations

  const exploreInvocation = invocation(' explore ')
  assert.equal(handler(exploreInvocation), result)

  // Nothing else is reached: no run is asked for, so the form cannot start one.
  assert.deepEqual(calls.map((call) => call[0]), [ACTION.explore])
  assert.equal(calls[0][1], exploreInvocation)
  assert.equal(calls[0].length, 2, 'explore takes no action options')
})

test('pause and resume reach their own actions and nothing else', () => {
  const { ctx, registrations } = fakeContext()
  const { control, calls, result } = fakeControl()
  registerTaskloopCommand(ctx, control)
  const [{ handler }] = registrations

  const pauseInvocation = invocation('pause')
  const resumeInvocation = invocation(' resume ')
  assert.equal(handler(pauseInvocation), result)
  assert.equal(handler(resumeInvocation), result)

  assert.deepEqual(calls.map((call) => call[0]), [ACTION.pause, ACTION.resume])
  assert.equal(calls[0][1], pauseInvocation)
  assert.equal(calls[1][1], resumeInvocation)
  // Neither form takes the action options a run takes: a pause and a resume name no
  // change, and passing one would be a second way to start a run.
  assert.equal(calls[0].length, 2)
  assert.equal(calls[1].length, 2)
})

test('the usage text names every form the command accepts', () => {
  assert.equal(USAGE.split('\n').length, 6, 'one line per form')
  for (const form of ['[change]', 'stop', 'status', 'explore', 'pause', 'resume']) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    assert.match(USAGE, new RegExp(`/taskloop ${escaped}(?:$| -)`, 'mu'))
  }
  assert.match(COMMAND.hint, /pause/)
  assert.match(COMMAND.hint, /resume/)
})

test('apply mounts the command through an effect', () => {
  const { ctx, registrations } = fakeContext()

  apply(ctx)

  assert.equal(name, 'openspec-taskloop')
  assert.ok(inject.includes('commands'))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'taskloop')
})

test('the mounted command answers usage errors and reports that no run is active', async () => {
  const { ctx, registrations } = fakeContext()
  apply(ctx)
  const [{ handler }] = registrations

  const invalid = handler(invocation(' stop now'))
  assert.equal(invalid.kind, 'error')
  assert.ok(invalid.text.includes(USAGE))

  // Mounting registers the command but starts nothing, so all four control forms
  // answer without inventing a run. `stop` answers asynchronously: it waits for the
  // run it ended to return before it reports where that run was.
  assert.match((await handler(invocation('stop'))).text, /no run is active/)
  assert.match((await handler(invocation('status'))).text, /no run is active/)
  // A pause and a resume without a run report the absence and start nothing.
  assert.match((await handler(invocation('pause'))).text, /no run is active/)
  assert.match((await handler(invocation('resume'))).text, /no run is active/)
})
