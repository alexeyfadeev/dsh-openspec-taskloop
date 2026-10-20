// dsh-openspec-taskloop — host plugin entry.
//
// The plugin is host-only (design D10): a global `/taskloop` command, no client
// half. `apply` registers that command and hands it the three actions built by
// `lib/control.js`; those actions own everything else — the OpenSpec bootstrap
// (3.2–3.3), the task loop and the session handoff (4.x–5.x), compaction (6.x).
//
// `inject` names only `commands`, which `apply` uses directly. The other Host
// services are read lazily per invocation by `lib/environment.js`, so the plugin
// stays mountable where one of them is absent. `Config` is exported because the
// loader validates the profile's config block against it and fills the defaults
// before `apply` runs.

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
 *   `ctx.logger` the host logger, `ctx.get(name)` the other Host services.
 * @param {object} [config] - profile config block; already resolved by the
 *   loader, but resolved again so a direct mount gets the documented defaults.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const control = createControl({ config: settings, ...createEnvironment(ctx, settings) })
  ctx.effect(() => registerTaskloopCommand(ctx, control), 'openspec-taskloop: /taskloop')
  ctx.logger.info('[openspec-taskloop] mounted: /taskloop is registered')
}
