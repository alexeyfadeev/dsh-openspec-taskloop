// dsh-openspec-taskloop — host plugin entry.
//
// The host half owns the run: a global `/taskloop` command whose three actions
// are built by `lib/control.js`, and those actions own everything else — the
// OpenSpec bootstrap (3.2–3.3), the task loop and the session handoff (4.x–5.x),
// compaction (6.x). The client half declared through `dsh.client` renders the
// Settings page and nothing else, so the plugin still works headless.
//
// `inject` names only `commands`, which `apply` uses directly. The other Host
// services are read lazily per invocation by `lib/environment.js`, so the plugin
// stays mountable where one of them is absent. `Config` is exported because the
// loader validates the profile's config block against it and fills the defaults
// before `apply` runs.
//
// The settings service and the web server are the two exceptions, and both are requested
// rather than injected: the page policy is registered through `ctx.inject(['settings'], …)`
// so a deployment that composes no Settings still mounts, and the policy is what keeps the
// service from synthesizing a second page — the automatic form it builds from the schema in
// Settings → Plugins — next to the one the client half renders. The loopback surface is
// registered through `ctx.inject(['webServer'], …)` for the same reason: a headless profile
// has no web server and no browser, and there the plugin is still just `/taskloop` (7.3).

import { registerTaskloopCommand } from './command.js'
import { resolveConfig } from './config.js'
import { createControl } from './control.js'
import { createEnvironment } from './environment.js'
import { installRoutes } from './routes.js'
import { createRuns } from './runs.js'

export { Config } from './config.js'

export const name = 'openspec-taskloop'

/**
 * Services the plugin consumes, declared so the loader orders them first.
 */
export const inject = ['commands']

/**
 * Activate the plugin.
 *
 * @param {object} ctx - loader context; `ctx.commands` is the command registry,
 *   `ctx.logger` the host logger, `ctx.get(name)` the other Host services,
 *   `ctx.inject` the optional ones (`settings` for the page policy, `webServer` for the
 *   loopback routes).
 * @param {object} [config] - profile config block; already resolved by the
 *   loader, but resolved again so a direct mount gets the documented defaults.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const environment = createEnvironment(ctx, settings)
  // One slot for the whole deployment, created here rather than inside `createControl()`:
  // the command and the HTTP surface both act on the run, and a slot each would let the
  // badge report a run that `/taskloop stop` cannot see (task 7.3, design D1). The
  // composition root is where that sharing is visible, so it is where the slot lives.
  const runs = createRuns()
  const control = createControl({ config: settings, runs, ...environment })
  ctx.effect(() => registerTaskloopCommand(ctx, control), 'openspec-taskloop: /taskloop')
  // The badge polls `/state`, the dialog reads `/tasks` and its buttons post `/action`.
  // A profile without a web server keeps all of that unregistered and still serves
  // `/taskloop`, which is the headless deployment (task 7.3, design D8).
  installRoutes(ctx, { runs, control, createCli: environment.createCli })
  // The client half renders this plugin's page, so the automatic one the settings
  // service builds from the schema has to go (design D12). The policy is
  // attributed to this plugin's own fiber — the key `describe()` reads it back by
  // — and the effect keeps the disposer, so the automatic page returns if the
  // plugin unloads.
  ctx.inject(['settings'], (scoped) => {
    scoped.effect(
      () => scoped.settings.configure({ auto: false }, ctx.fiber),
      'openspec-taskloop: settings page policy',
    )
  })
  ctx.logger.info('[openspec-taskloop] mounted: /taskloop is registered')
}
