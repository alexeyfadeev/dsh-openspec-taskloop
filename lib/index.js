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
// The settings service is the one exception, and it is requested rather than
// injected: the page policy is registered through `ctx.inject(['settings'], …)`
// so a deployment that composes no Settings still mounts, and the policy is
// what keeps the service from synthesizing a second page — the automatic form it
// builds from the schema in Settings → Plugins — next to the one the client half
// renders.

import { registerTaskloopCommand } from './command.js'
import { resolveConfig } from './config.js'
import { createControl } from './control.js'
import { createEnvironment } from './environment.js'

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
 *   `ctx.inject` the optional ones (`settings`, for the page policy).
 * @param {object} [config] - profile config block; already resolved by the
 *   loader, but resolved again so a direct mount gets the documented defaults.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const control = createControl({ config: settings, ...createEnvironment(ctx, settings) })
  ctx.effect(() => registerTaskloopCommand(ctx, control), 'openspec-taskloop: /taskloop')
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
