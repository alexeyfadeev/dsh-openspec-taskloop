// dsh-openspec-taskloop — the loopback HTTP surface of the run (tasks 7.1–7.3).
//
// The run has a command (`/taskloop pause`, `resume`, `stop`) and, since the UI
// change, a badge in the session header with a dialog behind it. The badge lives in
// the browser, the run lives in the host process, and the client half cannot call a
// command — so the two halves meet on HTTP: this module is the shape the client
// reads and writes (design D8). A headless profile has neither the web server nor a
// client, so nothing here is registered there (design "Non-Goals").
//
// Three endpoints, because a poll, a list and a decision are different requests:
//
//   GET  /api/openspec-taskloop/state    phase, change, directory, task, progress,
//                                        session — answered from the run slot's
//                                        memory, with no CLI and no file behind it
//   GET  /api/openspec-taskloop/tasks    the change's tasks, their counts and the state
//                                        the CLI reports — the one answer that costs an
//                                        `openspec instructions apply --json` call, which
//                                        is why it is its own route rather than part of
//                                        the poll (7.2)
//   POST /api/openspec-taskloop/action   { action: 'pause' | 'resume' | 'stop' } —
//                                        the same three actions the commands dispatch
//                                        to, answered with the snapshot that resulted
//
// The task list is the one answer that can fail, because it is the only one that leaves
// the process: a missing `openspec`, an expired deadline, a document that is not one.
// That failure is a state of its own and never an empty list (spec "Диалог прогона":
// "Задачи недоступны") — an empty list would read as "this change has no tasks", which
// is a worse thing to tell the user than "the list could not be read". So the failure is
// a 503 with an explanation and no `tasks` field at all, while a successful read carries
// the CLI's own state, counts and entries.
//
// What the list is read for is the dialog, which only exists while a run does, so the
// route reads the change and the directory from the run slot instead of accepting them
// from the caller: an endpoint that took a path would be a way to run `openspec` in any
// directory this machine can reach, asked by a web page.
//
// Only the machine may ask (design D8, spec "Только loopback"). The check is the one
// neighbouring host-only plugins use: the peer address of the socket, not a header —
// `x-forwarded-for` and friends are text a client chooses, while `remoteAddress` is
// what the kernel connected. Anything that is not loopback — another host, a
// container network, an address this module cannot parse, a request with no socket at
// all — is refused before the slot is read, so a refusal never carries the change, the
// task or the session of a run somebody else is driving.
//
// No answer may be cached (design D8): a phase is only true until the next turn, and a
// proxy or a browser keeping the previous answer would show a stopped run as working.
// Every response — success, refusal, error — therefore carries `cache-control:
// no-store`.
//
// The poll is answered by `lib/status.js`, which is a snapshot of the slot and nothing
// else: no process, no disk, no await, which is what makes it safe to ask from every
// session every two seconds (task 6.2). The action's answer is the same snapshot taken
// after the action settled, so the dialog that pressed a button does not have to wait
// for its next poll to show the new phase; the command's own report travels beside it
// as `text`, because the three refusals ("no run", "already paused", "nothing parked")
// are sentences the user should see rather than a silently unchanged button.
//
// The routes are plain objects in the shape `ctx.webServer.register()` takes, and this
// module touches a host service only in `installRoutes()` — the one function the mount
// calls (7.3). Everything else here is a function of the deployment: `lib/index.js` hands
// `installRoutes()` the slot, the actions and the CLI factory, and a test hands the
// handlers a request and a response of its own. That is what keeps the wire contract
// testable without a listener, a port or a browser.
//
// A headless profile composes no web server, and there the plugin must still mount and
// serve `/taskloop` (design "Non-Goals": the interface is not the run). So the service is
// requested rather than required: `ctx.inject(['webServer'], …)` registers the routes the
// moment a web server exists — immediately on a GUI profile, never on a headless one — and
// the registration is an effect of this plugin fiber, so an unload removes the routes and
// nothing keeps answering for a plugin that is gone.

import { readApplyInstructions } from './run.js'
import { statusOf } from './status.js'

/**
 * The endpoints of this surface (design D8); the client posts and polls these exact
 * paths, so they are a published contract rather than an implementation detail.
 */
export const ROUTE = Object.freeze({
  /** `GET`: the run as the interface sees it, from memory. */
  state: '/api/openspec-taskloop/state',
  /** `GET`: the change's tasks and counts, from one CLI call. */
  tasks: '/api/openspec-taskloop/tasks',
  /** `POST`: one of {@link ACTIONS}, answered with the resulting snapshot. */
  action: '/api/openspec-taskloop/action',
})

/**
 * The actions the route accepts, and the control method each one dispatches to.
 *
 * It is a table rather than `control[body.action]` so the route cannot become a way to
 * call anything else the control object happens to expose — `run` and `explore` are
 * commands, not buttons, and an unknown name must be a refusal (spec "Диалог прогона":
 * the dialog's buttons are the three commands).
 */
const ACTIONS = Object.freeze({
  pause: 'pause',
  resume: 'resume',
  stop: 'stop',
})

/** Ceiling of one request body; the only body is a three-word JSON object. */
const MAX_BODY_BYTES = 64 * 1024

/** Media type of every answer, including the refusals. */
const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * Build the route objects of the HTTP surface (tasks 7.1, 7.2).
 *
 * The caller registers the returned routes with `ctx.webServer.register()` and keeps the
 * disposers the registrations return; this module registers nothing itself, so a mount
 * without a web server simply never calls it (7.3) and a test can drive the handlers
 * without a listener.
 *
 * @param {object} deps
 * @param {{current: () => import('./runs.js').ActiveRun|null}} deps.runs - the process's run slot.
 * @param {{pause: Function, resume: Function, stop: Function}} deps.control - the command
 *   actions of `lib/control.js`; the route dispatches to exactly these three.
 * @param {() => {run: Function}} [deps.createCli] - the deployment's factory of an `openspec`
 *   wrapper, as `lib/environment.js` supplies it (7.2). Absent, the list route answers that
 *   this deployment cannot read tasks rather than throwing per request.
 * @returns {{kind: 'exact', path: string, handler: (req: object, res: object) => Promise<void>}[]}
 *   one route per entry of {@link ROUTE}.
 * @throws {TypeError} when the slot or one of the three actions is missing, so a
 *   miswired mount is named where it happens instead of failing in a request.
 */
export function createRoutes({ runs, control, createCli } = {}) {
  // The slot is required for the same reason `statusOf()` requires it: without one a
  // handler would fail per request with a message about an undefined property, and the
  // wiring mistake would surface as a 500 the user reads as a broken badge.
  if (typeof runs?.current !== 'function') {
    throw new TypeError('createRoutes requires the run slot')
  }
  // All three actions are checked up front: the dialog's buttons are the whole reason
  // the route exists, and a control object missing one of them is a mount that would
  // answer 500 for exactly one button.
  for (const action of Object.values(ACTIONS)) {
    if (typeof control?.[action] !== 'function') {
      throw new TypeError(`createRoutes requires control.${action}`)
    }
  }

  return [
    {
      kind: 'exact',
      path: ROUTE.state,
      handler: async (req, res) => {
        if (rejectForeignPeer(req, res)) return
        if (rejectMethod(req, res, 'GET')) return
        // Straight from the slot: the same snapshot `lib/status.js` hands a test, so the
        // poll neither spawns `openspec` nor reads `tasks.md` (task 6.2). A free slot
        // answers `{ active: false }` and nothing about the run that ended there.
        sendJson(res, 200, statusOf(runs))
      },
    },
    {
      kind: 'exact',
      path: ROUTE.tasks,
      handler: async (req, res) => {
        if (rejectForeignPeer(req, res)) return
        if (rejectMethod(req, res, 'GET')) return

        // The list belongs to the run, so it is read from the same slot the poll reads
        // (design D8): the change and the directory are what the run named, never a path
        // a caller supplied. The dialog that asks for it lives behind a badge, and the
        // badge only exists while a run does, so a free slot here is a race with a stop
        // rather than a question this route can answer — and it must not answer a list
        // for a change the user is no longer running.
        const snapshot = statusOf(runs)
        if (snapshot.active !== true) {
          sendJson(res, 409, { error: 'no run is active, so there are no tasks to read' })
          return
        }
        const { change, cwd } = snapshot
        if (typeof change !== 'string' || change === '' || typeof cwd !== 'string' || cwd === '') {
          // `runs.start()` always records both, so this is a mount that built its own run
          // objects: without a directory the CLI would read whichever project the host
          // process happens to sit in, which is not the run's.
          sendJson(res, 409, { error: 'the run has not named its change and its directory yet' })
          return
        }
        if (typeof createCli !== 'function') {
          sendJson(res, 503, { error: 'the task list is unavailable: this deployment has no openspec CLI' })
          return
        }

        let instructions
        try {
          // One call, and the only one the whole surface makes (design D8): the version gate
          // is the run's business, not the dialog's, because a list behind a badge is not the
          // place to start asking whether the installed OpenSpec is supported — the run that
          // owns this change already asked before it sent anything.
          instructions = await readApplyInstructions({ cli: createCli(), cwd, change })
        } catch (error) {
          // The failure is the answer (spec "Диалог прогона", "Задачи недоступны"): a missing
          // CLI, an expired deadline and a document that is not one all arrive here, and none
          // of them is an empty change. Nothing of the list travels with the refusal, so a
          // client that ignored the status could not mistake it for one.
          sendJson(res, 503, { error: `the task list is unavailable: ${messageOf(error)}` })
          return
        }

        // The CLI's own account of the file, passed through as it parsed it: the names it
        // reported (`state`, `progress`) are the ones the dialog renders, and `tasks` carries
        // the `line` a client needs to mark the run's current task. `change` is the CLI's
        // spelling of the name, which on a normal project is the one that was asked for.
        sendJson(res, 200, {
          change: instructions.change !== '' ? instructions.change : change,
          state: instructions.state,
          progress: instructions.progress,
          tasks: instructions.tasks,
        })
      },
    },
    {
      kind: 'exact',
      path: ROUTE.action,
      handler: async (req, res) => {
        if (rejectForeignPeer(req, res)) return
        if (rejectMethod(req, res, 'POST')) return

        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          // The body is the request's own, so its failures are 400/413 and never reach
          // the actions: nothing was paused, resumed or stopped.
          sendJson(res, error.status ?? 400, { error: messageOf(error) })
          return
        }
        const action = body?.action
        // `Object.hasOwn` on a frozen table: `pause` is a key, `toString` is not, and an
        // unknown name neither dispatches nor is mistaken for one of the three.
        if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) {
          const named = typeof action === 'string' && action !== '' ? `"${action}"` : 'no action'
          sendJson(res, 400, { error: `unknown action: ${named}` })
          return
        }

        let result
        try {
          // The awaited action is the command's own, so a stop that waits for a parked
          // run to settle (and a pause that ends a turn) answers only once it happened.
          result = await control[ACTIONS[action]]()
        } catch (error) {
          // An action that threw is a deployment failure, not a refusal: it says so as
          // one, and the snapshot is left out because it would read as "the action ran".
          sendJson(res, 500, { error: messageOf(error) })
          return
        }

        // The new snapshot is the point of the answer (design D8): the dialog that
        // pressed the button shows the phase it produced without waiting for its poll.
        const payload = { state: statusOf(runs) }
        if (typeof result?.text === 'string') payload.text = result.text
        sendJson(res, 200, payload)
      },
    },
  ]
}

/**
 * Register the surface on the host web server, if the profile has one (task 7.3).
 *
 * This is the whole contact between the routes and the host: `createRoutes()` builds
 * plain objects, and this function asks for the one service that can serve them. The
 * request goes through `ctx.inject` rather than `ctx.get`, for the reason the plugin's
 * `apply` asks for Settings the same way: a profile without a web server is a supported
 * deployment — headless, the run is driven by `/taskloop` alone — so its absence must
 * not fail the mount, and a web server that appears later must still get the routes.
 * With the service composed the callback runs straight away; without it, nothing here
 * ever runs and no route exists to answer.
 *
 * The registration is an effect of this plugin's fiber, so unloading the plugin (or the
 * web server going away) removes all three routes. The disposers run in reverse order of
 * registration, which leaves `/state` — the route a running badge polls — as the last one
 * to leave: a badge that is still mounted reads one more snapshot instead of a 404.
 *
 * A registration that throws is not swallowed: a duplicate path means another plugin
 * claimed one of our three endpoints, which is a composition error worth failing loudly
 * (the web server's own `register()` contract).
 *
 * @param {object} ctx - the plugin context; supplies `inject` and `logger`.
 * @param {object} deps - see {@link createRoutes}: the slot, the three actions and the
 *   deployment's CLI factory (the real one is `lib/environment.js`'s `createCli`, bound to
 *   the configured deadline, so a profile without a subprocess service answers
 *   "unavailable" from the list route instead of crashing).
 * @returns {void}
 */
export function installRoutes(ctx, deps) {
  // Built once, outside the callback: the handlers close over the deployment's own
  // objects, and nothing about them depends on when the web server arrives.
  const routes = createRoutes(deps)

  /**
   * Register every route and return the disposer that removes them all.
   *
   * @param {{register: (route: object) => () => void}} server - the host web server.
   * @returns {() => void} disposer of the whole surface.
   */
  const register = (server) => {
    const disposers = routes.map((route) => server.register(route))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => register(scoped.get('webServer')),
      'openspec-taskloop: /api routes',
    )
    // Visible in the host log because the interface is the only part of the plugin that
    // can be absent from a correct mount: "mounted without a web server" is otherwise a
    // plugin that silently has no badge.
    scoped.logger?.info?.('[openspec-taskloop] loopback routes registered')
  })
}

/**
 * Whether a peer address is this machine (design D8, spec "Только loopback").
 *
 * The forms a loopback peer actually arrives in: `127.0.0.0/8` over IPv4, `::1` over
 * IPv6, and the IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) a dual-stack listener
 * reports for an IPv4 client. Everything else is somebody else — including a value that
 * is not an address at all, because a check that guessed would be a check that admitted
 * the one value it did not understand (fail closed).
 *
 * The octets are validated rather than pattern-matched, so `127.0.0.999` and
 * `127.0.0.1.example` are not loopback while `127.8.9.10` still is: the whole /8 is
 * this machine, and a host configured with a different loopback alias must not lose its
 * own interface.
 *
 * @param {unknown} remoteAddress - `req.socket.remoteAddress`, when there is a socket.
 * @returns {boolean} whether the address belongs to this machine.
 */
export function isLoopback(remoteAddress) {
  if (typeof remoteAddress !== 'string') return false
  const address = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress
  if (address === '::1') return true

  const octets = address.split('.')
  if (octets.length !== 4) return false
  const numbers = octets.map((octet) => (/^\d{1,3}$/u.test(octet) ? Number(octet) : Number.NaN))
  if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0 || number > 255)) return false
  return numbers[0] === 127
}

/**
 * Refuse a request that came from another machine (design D8).
 *
 * The answer is a bare 403 with an explanation and no field of the run: refusing with
 * the snapshot would make the loopback rule decorative. It is written before anything
 * else in both handlers, so not even the method of a foreign request is answered.
 *
 * @param {{socket?: {remoteAddress?: string}}} req - the HTTP request.
 * @param {{writeHead: Function, end: Function}} res - the HTTP response.
 * @returns {boolean} true when the request was refused and the handler must stop.
 */
function rejectForeignPeer(req, res) {
  if (isLoopback(req?.socket?.remoteAddress)) return false
  sendJson(res, 403, { error: 'this endpoint answers loopback requests only' })
  return true
}

/**
 * Refuse a request with the wrong method (task 7.1).
 *
 * A method mismatch is not a request this surface understands, so it is answered 405
 * with the one method that would work — no run data, because the caller has not proven
 * it is the machine yet in the state route's case, and because a refusal that carried a
 * snapshot would answer a question nobody validly asked.
 *
 * @param {{method?: string}} req - the HTTP request.
 * @param {{writeHead: Function, end: Function}} res - the HTTP response.
 * @param {'GET'|'POST'} allowed - the method this route serves.
 * @returns {boolean} true when the method was refused and the handler must stop.
 */
function rejectMethod(req, res, allowed) {
  if (req?.method === allowed) return false
  sendJson(res, 405, { error: `this endpoint answers ${allowed} only` }, { allow: allowed })
  return true
}

/**
 * Read and parse the JSON body of one request, or say why it cannot be read.
 *
 * The ceiling exists because the only body this surface reads is a single JSON object:
 * a client streaming megabytes has made a mistake (or is not a client), and buffering it
 * would be the one unbounded allocation on a route anybody can reach. An empty body is
 * not JSON either — the action is required — so it is refused with the same 400 as a
 * malformed one instead of being read as "no action chosen yet".
 *
 * @param {AsyncIterable<Buffer|string>} req - the HTTP request, read as a stream.
 * @returns {Promise<unknown>} the parsed body.
 * @throws {Error} with a `status` of 413 when the body is too large, 400 when it is not JSON.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw badRequest(413, 'the request body is too large')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw badRequest(400, 'the request body must be a JSON object')
  try {
    return JSON.parse(text)
  } catch {
    throw badRequest(400, 'the request body is not valid JSON')
  }
}

/**
 * An error the route answers with a status of its own.
 *
 * @param {number} status - HTTP status to answer with.
 * @param {string} message - explanation safe to return to the caller.
 * @returns {Error & {status: number}} the error.
 */
function badRequest(status, message) {
  const error = new Error(message)
  return Object.assign(error, { status })
}

/**
 * Answer one request with JSON, uncacheable (design D8).
 *
 * `no-store` is set here rather than per handler so no answer can forget it: the whole
 * surface reports a state that changes with the next turn, and a cached copy would be a
 * lie about the present.
 *
 * @param {{writeHead: Function, end: Function}} res - the HTTP response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serialisable body.
 * @param {Record<string, string>} [headers] - extra headers, e.g. `allow`.
 * @returns {void}
 */
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  })
  res.end(body)
}

/**
 * Message text for an unknown thrown value.
 *
 * @param {unknown} value - thrown value.
 * @returns {string} a message safe to return.
 */
function messageOf(value) {
  return value instanceof Error ? value.message : String(value)
}
