// Tests for the loopback HTTP surface of the run (tasks 7.1, 7.2).
//
// The badge polls `/state` every other second and the dialog's buttons post `/action`,
// so this file pins the wire contract the client half will meet: which paths exist, what
// a snapshot looks like, what an action answers, and — the three refusals the task names
// — that another machine is turned away, that the wrong method is turned away, and that
// an action nobody offers is turned away. None of them may leak the run: a refusal that
// carried a change or a task would make the loopback rule decorative (spec "Только
// loopback").
//
// The dialog's list is the third endpoint (7.2) and the only one that costs a process, so
// its two outcomes are pinned against a scripted CLI: a read that settles answers the
// change's tasks and counts, and a read that fails answers that the list is unavailable —
// never an empty list, which would read as "this change has no tasks" (spec "Диалог
// прогона": "Задачи недоступны"). The document fed to the fake is the captured answer of a
// real CLI (`test/fixtures/apply/ready.json`), so the parser is the production one.
//
// The handlers are called directly with a request and a response of their own, because
// the module is a function of the deployment and registers nothing itself: the real
// registration through `ctx.webServer` belongs to the mount (task 7.3), and the socket
// a request arrives on is exactly one field of the object handed in here. That keeps
// this file free of a listener, a port and a browser.
//
// The slot and the three actions are real objects of this plugin — `createRuns()` and a
// control in which `pause`, `resume` and `stop` act on that slot — so "the action took
// effect" is checked against the slot rather than against a recording. The commands
// themselves, with all their reports and their refusals, are pinned by
// `test/control.test.mjs`; the end-to-end path through a starting run is
// `test/integration.test.mjs`.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ROUTE, createRoutes, isLoopback } from '../lib/routes.js'
import { PAUSE_STATE, createRuns } from '../lib/runs.js'
import { applyArgs } from '../lib/run.js'

const CWD = 'C:\\projects\\demo'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apply')

/**
 * Read one captured `instructions apply` answer.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {string} raw document text.
 */
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8')

/**
 * Build the exit facts of one CLI call.
 *
 * @param {string} stdout - collected stdout.
 * @param {number} [exitCode] - process exit code.
 * @returns {object} a settled CLI result.
 */
const cliResult = (stdout, exitCode = 0) => ({ exitCode, stdout, stderr: '', truncated: false })

/**
 * A CLI wrapper that answers each call from a script and records what it was asked.
 *
 * An `Error` in the script is thrown instead of returned, which is how the wrapper of a
 * missing executable answers: a call that could not run rejects (see `lib/openspec.js`).
 *
 * @param {(object|Error)[]} answers - settled results or failures, consumed in call order.
 * @returns {{calls: object[], run: Function}} the fake wrapper and the log of its calls.
 */
function scriptedCli(answers) {
  const calls = []
  return {
    calls,
    async run(args, options) {
      calls.push({ args, options })
      const next = answers.shift()
      if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`)
      if (next instanceof Error) throw next
      return next
    },
  }
}

/**
 * A task as the loop records it; the snapshot hands the same object through.
 *
 * @param {number} line - line of the task in `tasks.md`.
 * @returns {import('../lib/tasks.js').ApplyTask} the task.
 */
const task = (line) => ({
  id: `task-${line}`,
  description: `${line}. Do the work`,
  done: false,
  sourcePath: 'tasks.md',
  line,
})

/**
 * The three command actions, acting on the slot the routes read.
 *
 * This is the deployment the route is built for: `lib/control.js` hands out exactly
 * these three functions, each one closing over the same run slot. A stop frees the slot
 * here the way the run's own `finally` does in `lib/control.js`, so the snapshot after a
 * stop is the absence a real stop answers with.
 *
 * @param {ReturnType<typeof createRuns>} runs - the run slot.
 * @returns {{calls: string[], pause: Function, resume: Function, stop: Function}} the
 *   actions and the names of the ones that ran.
 */
function controlFor(runs) {
  const calls = []
  const active = () => runs.current()
  return {
    calls,
    async pause() {
      calls.push('pause')
      const run = active()
      if (run === null) return { kind: 'success', text: 'taskloop: no run is active.' }
      run.pause()
      return { kind: 'success', text: `taskloop: parked the run for change "${run.change}".` }
    },
    async resume() {
      calls.push('resume')
      const run = active()
      if (run === null) return { kind: 'success', text: 'taskloop: no run is active; nothing was resumed.' }
      run.resume()
      return { kind: 'success', text: `taskloop: resumed the run for change "${run.change}".` }
    },
    async stop() {
      calls.push('stop')
      const run = active()
      if (run === null) return { kind: 'success', text: 'taskloop: no run is active.' }
      run.stop()
      runs.finish(run)
      return { kind: 'success', text: `taskloop: stopped the run for change "${run.change}".` }
    },
  }
}

/**
 * A request as the web server hands it to a route: a method, a peer address and a body.
 *
 * The address is the one fact the loopback rule reads, and a request without a socket is
 * a request the rule must refuse rather than admit (fail closed), so it can be left out.
 *
 * @param {object} [options]
 * @param {string} [options.method] - HTTP method, `GET` when absent.
 * @param {string|undefined} [options.address] - `socket.remoteAddress`; absent means no socket.
 * @param {unknown} [options.body] - value to send as JSON.
 * @param {string} [options.raw] - body text to send verbatim, for a malformed body.
 * @returns {Readable & {method: string, url: string, socket: object|undefined}} the request.
 */
function createRequest({ method = 'GET', address = '127.0.0.1', body, raw } = {}) {
  const text = raw ?? (body === undefined ? undefined : JSON.stringify(body))
  const request = Readable.from(text === undefined ? [] : [Buffer.from(text)])
  request.method = method
  request.url = '/'
  request.socket = address === undefined ? undefined : { remoteAddress: address }
  return request
}

/**
 * A response that records what a route wrote instead of sending it.
 *
 * @returns {{statusCode: number|undefined, headers: object|undefined, body: string,
 *   writeHead: Function, end: Function}} the response.
 */
function createResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(body = '') {
      this.body += body
    },
  }
}

/**
 * Call one route of the surface and settle what it answered.
 *
 * @param {object[]} routes - the routes built by {@link createRoutes}.
 * @param {string} path - path of the route to call.
 * @param {object} [options] - see {@link createRequest}.
 * @returns {Promise<{status: number|undefined, headers: object|undefined, body: string, json: unknown}>}
 *   the answer, with its body parsed when it has one.
 */
async function call(routes, path, options) {
  const route = routes.find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `the surface has a route for ${path}`)
  const response = createResponse()
  await route.handler(createRequest(options), response)
  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body,
    json: response.body === '' ? undefined : JSON.parse(response.body),
  }
}

/**
 * A slot holding one run that has sent a task and read the file once.
 *
 * @param {object} [options]
 * @param {{run: Function}} [options.cli] - fake CLI wrapper the tasks route is wired to; absent,
 *   the surface is built without the factory a deployment always passes (7.2).
 * @returns {{runs: ReturnType<typeof createRuns>, control: object, routes: object[],
 *   run: import('../lib/runs.js').ActiveRun, sent: object}} the fixture.
 */
function startedRun({ cli } = {}) {
  const runs = createRuns()
  const control = controlFor(runs)
  const routes = createRoutes({
    runs,
    control,
    ...(cli === undefined ? {} : { createCli: () => cli }),
  })
  const { run } = runs.start('add-a', { cwd: CWD, sessionId: 'session-1' })
  const sent = task(12)
  run.note(sent)
  run.setProgress({ complete: 5, total: 24 })
  return { runs, control, routes, run, sent }
}

test('the surface is the three exact endpoints of the design', () => {
  const runs = createRuns()
  const routes = createRoutes({ runs, control: controlFor(runs) })

  assert.deepEqual(
    routes.map(({ kind, path }) => ({ kind, path })),
    [
      { kind: 'exact', path: '/api/openspec-taskloop/state' },
      { kind: 'exact', path: '/api/openspec-taskloop/tasks' },
      { kind: 'exact', path: '/api/openspec-taskloop/action' },
    ],
    'the client polls and posts these paths, so they are a published contract',
  )
  assert.equal(ROUTE.state, '/api/openspec-taskloop/state')
  assert.equal(ROUTE.tasks, '/api/openspec-taskloop/tasks')
  assert.equal(ROUTE.action, '/api/openspec-taskloop/action')
})

test('GET /state answers the active run as the interface sees it', async () => {
  const { runs, routes, sent } = startedRun()

  const answer = await call(routes, ROUTE.state)

  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json, {
    active: true,
    phase: PAUSE_STATE.running,
    change: 'add-a',
    cwd: CWD,
    task: sent,
    progress: { complete: 5, total: 24 },
    sessionId: 'session-1',
  })
  // The answer is the slot read, not a copy of it: a second poll sees a change made to the
  // run in between, which is what makes the badge show the phase the run is in now.
  runs.current().pause()
  const after = await call(routes, ROUTE.state)
  assert.equal(after.json.phase, PAUSE_STATE.paused)
})

test('GET /state answers only the absence when no run holds the slot', async () => {
  const runs = createRuns()
  const { control } = { control: controlFor(runs) }
  const routes = createRoutes({ runs, control })
  const { run } = runs.start('add-a', { cwd: CWD, sessionId: 'session-1' })
  run.note(task(12))
  run.setProgress({ complete: 1, total: 2 })
  runs.finish(run)

  const answer = await call(routes, ROUTE.state)

  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json, { active: false })
  for (const field of ['change', 'cwd', 'task', 'progress', 'sessionId']) {
    assert.equal(field in answer.json, false, `a freed slot does not mention ${field}`)
  }
})

test('GET /tasks answers the listed tasks and their counts from one CLI call', async () => {
  const cli = scriptedCli([cliResult(fixture('ready.json'))])
  const { routes } = startedRun({ cli })

  const answer = await call(routes, ROUTE.tasks)

  assert.equal(answer.status, 200)
  // Exactly one call, for the change the run drives, in the directory the run named: the
  // dialog reads this list once per opening and once per current task, and neither may cost
  // a process more than the read itself (design D8).
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(cli.calls[0].args, applyArgs('add-a'))
  assert.equal(cli.calls[0].options.cwd, CWD)
  // The CLI's own account of the file: counts over every checkbox, the state the file was
  // read in, and the entries in file order — never recomputed from `tasks.length`, which can
  // disagree with `progress` by construction (see `lib/tasks.js`).
  assert.deepEqual(answer.json.progress, { total: 20, complete: 4, remaining: 16 })
  assert.equal(answer.json.state, 'ready')
  assert.equal(answer.json.tasks.length, 20)
  assert.equal(answer.json.tasks[0].done, true)
  assert.equal(answer.json.tasks[4].done, false)
  // The captured document is the CLI's answer for its own change; in production that name is
  // the one the run drives, and the route passes the CLI's spelling through rather than
  // rewriting what it was told.
  assert.equal(answer.json.change, 'add-taskloop-plugin')
  // The line travels with every task, because the dialog marks the run's current task by
  // matching it with the snapshot — the same identity `lib/tasks.js` uses across readings.
  assert.equal(answer.json.tasks[4].line, 12)
  assert.equal(answer.json.tasks[4].sourcePath.endsWith('tasks.md'), true)
})

test('GET /tasks answers a CLI that cannot be read as an unavailable list', async () => {
  // Two ways the one call fails: a wrapper that could not run at all (a missing executable
  // rejects) and a document that is not one. Both are the same state for the dialog, and
  // neither may be answered as an empty change (spec "Задачи недоступны").
  const broken = new Error('openspec CLI is not available: ENOENT')
  const missing = startedRun({ cli: scriptedCli([broken]) })

  const refused = await call(missing.routes, ROUTE.tasks)

  assert.equal(refused.status, 503)
  assert.match(refused.json.error, /task list is unavailable/)
  assert.match(refused.json.error, /ENOENT/, 'the reason the CLI gave is the explanation')
  for (const field of ['tasks', 'progress', 'state', 'change']) {
    assert.equal(field in refused.json, false, `an unavailable list carries no ${field}`)
  }

  const garbage = startedRun({ cli: scriptedCli([cliResult('openspec: not a JSON document')]) })
  const unusable = await call(garbage.routes, ROUTE.tasks)

  assert.equal(unusable.status, 503)
  assert.match(unusable.json.error, /task list is unavailable/)
  assert.equal('tasks' in unusable.json, false, 'a document nobody can parse is not an empty list')
})

test('GET /tasks turns away another machine before it runs anything', async () => {
  const cli = scriptedCli([])
  const { routes } = startedRun({ cli })

  const foreign = await call(routes, ROUTE.tasks, { address: '10.0.0.7' })

  assert.equal(foreign.status, 403)
  for (const field of ['active', 'change', 'cwd', 'state', 'progress', 'tasks']) {
    assert.equal(field in foreign.json, false, `the refusal does not reveal ${field}`)
  }

  const wrongMethod = await call(routes, ROUTE.tasks, { method: 'POST' })

  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'GET')
  // Neither refusal reached the CLI: a request this surface does not answer must not spawn
  // `openspec` on its way to being refused.
  assert.deepEqual(cli.calls, [])
})

test('GET /tasks asks nothing when no run holds the slot', async () => {
  const runs = createRuns()
  const cli = scriptedCli([])
  const routes = createRoutes({ runs, control: controlFor(runs), createCli: () => cli })

  const answer = await call(routes, ROUTE.tasks)

  // The list belongs to the run, and a stopped run has neither a change nor a directory to
  // read: the refusal says so instead of listing a change nobody is running.
  assert.equal(answer.status, 409)
  assert.match(answer.json.error, /no run is active/)
  assert.deepEqual(cli.calls, [])
  assert.equal('tasks' in answer.json, false)
})

test('a deployment without a CLI factory says the list is unavailable', async () => {
  // A profile the plugin mounts without a subprocess service still answers every route of
  // the surface; only the list cannot be read, and it says that instead of failing a request
  // with a message about an undefined function (7.3).
  const { routes } = startedRun()

  const answer = await call(routes, ROUTE.tasks)

  assert.equal(answer.status, 503)
  assert.match(answer.json.error, /no openspec CLI/)
  assert.equal('tasks' in answer.json, false)
})

test('a request from another machine is refused before the run is read', async () => {
  const { runs, control, routes, sent } = startedRun()

  const answer = await call(routes, ROUTE.state, { address: '10.0.0.7' })

  assert.equal(answer.status, 403)
  assert.match(answer.json.error, /loopback/)
  // Nothing of the run: not the change, not the task, not the session. The refusal must
  // not be a narrower version of the answer the caller was denied.
  for (const field of ['active', 'phase', 'change', 'cwd', 'task', 'progress', 'sessionId', 'state']) {
    assert.equal(field in answer.json, false, `the refusal does not reveal ${field}`)
  }
  // And the action route refuses the same peer, so another machine cannot press the
  // buttons either.
  const posted = await call(routes, ROUTE.action, {
    method: 'POST',
    address: '192.168.1.5',
    body: { action: 'pause' },
  })
  assert.equal(posted.status, 403)
  assert.deepEqual(control.calls, [], 'a foreign request reached no action')
  assert.equal(runs.current().paused, false, 'the run was not parked')
  assert.equal(runs.current().task, sent)
})

test('this machine is the whole loopback /8, ::1 and the mapped IPv4 form', async () => {
  // The forms a local client actually arrives in, plus the aliases a host can be
  // configured with. An address the check cannot parse is somebody else (fail closed).
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('127.8.9.10'), true, 'the whole /8 is this machine')
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('::ffff:127.0.0.1'), true, 'a dual-stack listener reports the mapped form')
  assert.equal(isLoopback('::ffff:10.0.0.7'), false)
  assert.equal(isLoopback('10.0.0.7'), false)
  assert.equal(isLoopback('192.168.1.5'), false)
  assert.equal(isLoopback('128.0.0.1'), false)
  assert.equal(isLoopback('127.0.0.999'), false, 'an octet above 255 is not an address')
  assert.equal(isLoopback('127.0.0.1.example.com'), false)
  assert.equal(isLoopback('localhost'), false, 'a name is not what the kernel connected')
  assert.equal(isLoopback(''), false)
  assert.equal(isLoopback(undefined), false, 'no socket is not a local socket')
  assert.equal(isLoopback(null), false)

  // Through the route, a mapped loopback peer is answered exactly like a plain one.
  const { routes, sent } = startedRun()
  const answer = await call(routes, ROUTE.state, { address: '::ffff:127.0.0.1' })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json.task, sent)
})

test('GET /state turns away a method it does not serve', async () => {
  const { routes } = startedRun()

  const answer = await call(routes, ROUTE.state, { method: 'POST', body: { action: 'pause' } })

  assert.equal(answer.status, 405)
  assert.equal(answer.headers.allow, 'GET')
  assert.match(answer.json.error, /GET only/)
  assert.equal('active' in answer.json, false, 'the refusal carries no snapshot')
})

test('POST /action turns away a method it does not serve', async () => {
  const { runs, control, routes } = startedRun()

  const answer = await call(routes, ROUTE.action)

  assert.equal(answer.status, 405)
  assert.equal(answer.headers.allow, 'POST')
  assert.deepEqual(control.calls, [], 'a GET reached no action')
  assert.equal(runs.current()?.paused, false)
})

test('an unknown action is refused and changes nothing', async () => {
  const { runs, control, routes } = startedRun()

  const answer = await call(routes, ROUTE.action, { method: 'POST', body: { action: 'explore' } })

  assert.equal(answer.status, 400)
  assert.match(answer.json.error, /unknown action/)
  assert.deepEqual(control.calls, [], 'the surface has no button but pause, resume and stop')
  assert.equal(runs.current().paused, false, 'the run was left exactly as it was')
  assert.equal(runs.current().tasks.length, 1, 'the run kept the one task it had sent')
})

test('an action with no name is refused like an unknown one', async () => {
  const { control, routes } = startedRun()

  for (const body of [{}, { action: '' }, { action: 42 }, { action: ['pause'] }]) {
    const answer = await call(routes, ROUTE.action, { method: 'POST', body })
    assert.equal(answer.status, 400, JSON.stringify(body))
    assert.match(answer.json.error, /unknown action/)
  }
  assert.deepEqual(control.calls, [])
})

test('a body that is not JSON is refused before any action runs', async () => {
  const { control, routes } = startedRun()

  const answer = await call(routes, ROUTE.action, { method: 'POST', raw: 'pause' })

  assert.equal(answer.status, 400)
  assert.match(answer.json.error, /not valid JSON/)
  assert.deepEqual(control.calls, [])
})

test('an empty body is not a chosen action', async () => {
  const { control, routes } = startedRun()

  const answer = await call(routes, ROUTE.action, { method: 'POST', raw: '   ' })

  assert.equal(answer.status, 400)
  assert.match(answer.json.error, /JSON object/)
  assert.deepEqual(control.calls, [])
})

test('a body above the ceiling is refused instead of buffered', async () => {
  const { control, routes } = startedRun()

  const answer = await call(routes, ROUTE.action, {
    method: 'POST',
    raw: `{"action":"pause","pad":"${'x'.repeat(70 * 1024)}"}`,
  })

  assert.equal(answer.status, 413)
  assert.match(answer.json.error, /too large/)
  assert.deepEqual(control.calls, [])
})

test('the pause button parks the run and answers the phase it produced', async () => {
  const { runs, control, routes, sent } = startedRun()

  const answer = await call(routes, ROUTE.action, { method: 'POST', body: { action: 'pause' } })

  assert.equal(answer.status, 200)
  assert.deepEqual(control.calls, ['pause'], 'the button is the command, not a second implementation')
  // The new snapshot travels in the same answer (design D8), so the dialog does not have
  // to wait for its next poll to show the parked phase — and the task it stopped on is
  // still the task it names.
  assert.equal(answer.json.state.active, true, 'a parked run still holds the slot')
  assert.equal(answer.json.state.phase, PAUSE_STATE.paused)
  assert.deepEqual(answer.json.state.task, sent)
  assert.match(answer.json.text, /parked the run/)
  assert.equal(runs.current().paused, true)
})

test('the resume button releases the parked run and answers the running phase', async () => {
  const { runs, control, routes } = startedRun()
  runs.current().pause()

  const answer = await call(routes, ROUTE.action, { method: 'POST', body: { action: 'resume' } })

  assert.equal(answer.status, 200)
  assert.deepEqual(control.calls, ['resume'])
  assert.equal(answer.json.state.phase, PAUSE_STATE.running)
  assert.match(answer.json.text, /resumed the run/)
  // The route reached the slot's own release, allowance included: the loop may re-send
  // the task the pause interrupted (design D6).
  assert.equal(runs.current().takeResumePending(), true)
})

test('the stop button ends the run and answers the absence that follows', async () => {
  const { runs, control, routes } = startedRun()
  runs.current().pause()

  const answer = await call(routes, ROUTE.action, { method: 'POST', body: { action: 'stop' } })

  assert.equal(answer.status, 200)
  assert.deepEqual(control.calls, ['stop'])
  assert.deepEqual(answer.json.state, { active: false }, 'a stopped run is not resumable')
  assert.equal(runs.current(), null)
})

test('an action that throws is answered as a failure, not as a snapshot', async () => {
  const runs = createRuns()
  const control = {
    async pause() {
      throw new Error('the session service is not composed')
    },
    async resume() {},
    async stop() {},
  }
  const routes = createRoutes({ runs, control })
  runs.start('add-a', { cwd: CWD, sessionId: 'session-1' })

  const answer = await call(routes, ROUTE.action, { method: 'POST', body: { action: 'pause' } })

  assert.equal(answer.status, 500)
  assert.match(answer.json.error, /session service is not composed/)
  assert.equal('state' in answer.json, false, 'a failed action did not produce a phase to show')
})

test('every answer is uncacheable, refusals included', async () => {
  const cli = scriptedCli([cliResult(fixture('ready.json')), new Error('openspec timed out after 30000ms')])
  const { routes } = startedRun({ cli })

  const answers = [
    await call(routes, ROUTE.state),
    await call(routes, ROUTE.state, { address: '10.0.0.7' }),
    await call(routes, ROUTE.state, { method: 'POST' }),
    await call(routes, ROUTE.tasks),
    await call(routes, ROUTE.tasks, { address: '10.0.0.7' }),
    await call(routes, ROUTE.tasks),
    await call(routes, ROUTE.action, { method: 'GET' }),
    await call(routes, ROUTE.action, { method: 'POST', body: { action: 'explode' } }),
    await call(routes, ROUTE.action, { method: 'POST', raw: 'not json' }),
    await call(routes, ROUTE.action, { method: 'POST', body: { action: 'pause' } }),
  ]

  for (const answer of answers) {
    assert.equal(answer.headers['cache-control'], 'no-store', `status ${String(answer.status)} is uncacheable`)
    assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8')
  }
  // A poll that has been answered with a phase must never be served from a cache: the
  // phase is true only until the next turn (design D8).
  assert.ok(answers.some((answer) => answer.status === 200))
  assert.ok(answers.some((answer) => answer.status !== 200))
})

test('a miswired mount is named where it is built', () => {
  assert.throws(() => createRoutes({}), /requires the run slot/)
  assert.throws(() => createRoutes({ runs: createRuns() }), /requires control\.pause/)

  const runs = createRuns()
  assert.throws(
    () => createRoutes({ runs, control: { pause() {}, resume() {} } }),
    /requires control\.stop/,
    'all three buttons must exist, not the first two',
  )
})
