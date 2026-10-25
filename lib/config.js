// dsh-openspec-taskloop — configuration contract.
//
// The loader validates the profile's config block against `Config` before
// `apply` runs, so `apply` sees a resolved object with every default filled in.
// The defaults are also written verbatim in the design docs: D11 carries the base
// contract, and a change that adds fields documents only its own keys in a
// `<!-- config-defaults -->` block. test/config.test.mjs merges both and fails
// when they drift apart — that test is the reason the numbers below are not just
// code comments.
//
// The choices the schema cannot express live in D11; in short:
//   - an empty `change` means "not specified": pick the change with the latest
//     `lastModified`;
//   - `retry.attempts` counts every `compactNow` call on one transition, the
//     first one included, and retries start only after it fails;
//   - `retry.codes` holds transient codes only. `changed`, `commit` and
//     `cancelled` are terminal and are never retried, whatever the config says
//     (D7);
//   - `onFailure: 'break'` stops the run — continuing without compaction grows
//     the context with no bound, while a stop is visible in the report (D7);
//     `continue` keeps the run going and puts the failure in the report as a
//     warning, for projects that prefer progress over a bounded context (6.2);
//   - `midTask` and `protocol.systemSection` are off by default (D3) and are
//     meant to be switched on together: the section exists to survive a summary
//     taken inside a task;
//   - `commit`, `review` and, from D12 on, `compaction.midTask`,
//     `compaction.onFailure` and `protocol.systemSection` are volatile: they are
//     editable in Settings and read through `.get()` at the moment they apply.

import z from '@deepseek-ai/schemastery'

import { ON_FAILURE } from './compaction.js'

/** Calls to `compactNow` allowed on one transition, the first call included. */
export const DEFAULT_RETRY_ATTEMPTS = 3

/** Delay before the first retry, in milliseconds. */
export const DEFAULT_RETRY_DELAY_MS = 1000

/** Multiplier applied to the delay before each further retry. */
export const DEFAULT_RETRY_FACTOR = 2

/** Ceiling for the retry delay, in milliseconds. */
export const DEFAULT_RETRY_MAX_DELAY_MS = 10_000

/** Codes `compactNow` reports for transient failures; only these are retried. */
export const DEFAULT_RETRY_CODES = Object.freeze(['summary', 'persistence', 'busy'])

/** Policy applied when the retry budget is exhausted: `continue` or `break`. */
export const DEFAULT_ON_FAILURE = ON_FAILURE.break

/** Compaction by pressure on a step boundary; off by default. */
export const DEFAULT_MID_TASK = false

/** Static protocol section on `agent.ctx`; off by default. */
export const DEFAULT_PROTOCOL_SYSTEM_SECTION = false

/** Timeout of a single `openspec` call, in milliseconds. */
export const DEFAULT_OPENSPEC_TIMEOUT_MS = 120_000

/** Commit after a completed task group; on by default (D12). */
export const DEFAULT_COMMIT_ENABLED = true

/** Values `commit.tool` accepts. */
export const COMMIT_TOOLS = Object.freeze(['git', 'gitbutler'])

/** Tool that performs the commit: plain `git` or GitButler's `but`. */
export const DEFAULT_COMMIT_TOOL = 'git'

/** Code review after a completed task group; on by default (D12). */
export const DEFAULT_REVIEW_ENABLED = true

/**
 * The plugin configuration as the host passes it to `apply`.
 *
 * @typedef {object} Config
 * @property {string} change - Change name; an empty string means "the most
 *   recently modified change".
 * @property {object} commit
 * @property {{get(): boolean}} commit.enabled - volatile reference (D12)
 * @property {{get(): 'git'|'gitbutler'}} commit.tool - volatile reference (D12)
 * @property {object} review
 * @property {{get(): boolean}} review.enabled - volatile reference (D12)
 * @property {object} compaction
 * @property {object} compaction.retry
 * @property {number} compaction.retry.attempts
 * @property {number} compaction.retry.delayMs
 * @property {number} compaction.retry.factor
 * @property {number} compaction.retry.maxDelayMs
 * @property {string[]} compaction.retry.codes
 * @property {{get(): 'continue'|'break'}} compaction.onFailure - volatile
 *   reference (D12)
 * @property {{get(): boolean}} compaction.midTask - volatile reference (D12)
 * @property {object} protocol
 * @property {{get(): boolean}} protocol.systemSection - volatile reference (D12)
 * @property {object} openspec
 * @property {number} openspec.timeoutMs
 */

/**
 * Loader-facing schema. `Config({})` yields every default; an invalid value
 * (an unknown `onFailure`, a non-positive `attempts`, a key the schema does not
 * declare) throws with the offending path.
 */
export const Config = z.object({
  change: z
    .string()
    .default('')
    .description('Change name; empty means the change with the latest lastModified'),
  commit: z.object({
    enabled: z
      .boolean()
      .default(DEFAULT_COMMIT_ENABLED)
      .description('Commit after a completed task group')
      .volatile(),
    tool: z
      .union([z.const('git'), z.const('gitbutler')])
      .default(DEFAULT_COMMIT_TOOL)
      .description('Tool that performs the commit: git or GitButler')
      .volatile(),
  }),
  review: z.object({
    enabled: z
      .boolean()
      .default(DEFAULT_REVIEW_ENABLED)
      .description('Code review in a new session after a completed task group')
      .volatile(),
  }),
  compaction: z.object({
    retry: z.object({
      attempts: z
        .number()
        .min(1)
        .default(DEFAULT_RETRY_ATTEMPTS)
        .description('Calls to compactNow on one transition, the first call included'),
      delayMs: z
        .number()
        .min(0)
        .default(DEFAULT_RETRY_DELAY_MS)
        .description('Delay before the first retry, in milliseconds'),
      factor: z
        .number()
        .min(1)
        .default(DEFAULT_RETRY_FACTOR)
        .description('Multiplier applied to the delay before each further retry'),
      maxDelayMs: z
        .number()
        .min(0)
        .default(DEFAULT_RETRY_MAX_DELAY_MS)
        .description('Ceiling for the retry delay, in milliseconds'),
      codes: z
        .array(z.string())
        .default([...DEFAULT_RETRY_CODES])
        .description('Transient compactNow codes; only these are retried'),
    }),
    onFailure: z
      .union([z.const(ON_FAILURE.continue), z.const(ON_FAILURE.break)])
      .default(DEFAULT_ON_FAILURE)
      .description('Policy when the compaction retry budget is exhausted')
      .volatile(),
    midTask: z
      .boolean()
      .default(DEFAULT_MID_TASK)
      .description('Compact by context pressure on a step boundary')
      .volatile(),
  }),
  protocol: z.object({
    systemSection: z
      .boolean()
      .default(DEFAULT_PROTOCOL_SYSTEM_SECTION)
      .description('Register the static protocol section on agent.ctx for a run')
      .volatile(),
  }),
  openspec: z.object({
    timeoutMs: z
      .number()
      .min(1)
      .default(DEFAULT_OPENSPEC_TIMEOUT_MS)
      .description('Timeout of a single openspec call, in milliseconds'),
  }),
})

/**
 * Resolve a raw configuration block the way the loader does.
 *
 * `apply` receives the config the loader already resolved, so every volatile
 * field there is a `Volatile` reference and the plain value validation expects
 * is gone; validating it again would reject the object this plugin is meant to
 * run against (D12). A resolved config is therefore returned as is, and only a
 * raw profile block goes through the schema and gets its defaults filled in.
 *
 * @param {unknown} [value] - Config block from the profile; `undefined` means
 *   the plugin was mounted without one.
 * @returns {Config}
 */
export function resolveConfig(value) {
  if (isResolvedConfig(value)) return value
  return Config(value ?? {})
}

/** Symbol protocol of cosmokit volatile references (no import: transitive dep). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Tell a volatile config reference from a plain resolved value.
 *
 * @param {unknown} value - resolved config value.
 * @returns {boolean} whether `value` is a `Volatile` reference.
 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Whether a config was already resolved by the loader.
 *
 * A config the loader resolved carries at least one `Volatile` reference: the
 * plugin's schema declares volatile fields, so a resolved object cannot be
 * mistaken for a raw profile block (a YAML block cannot hold these objects).
 *
 * @param {unknown} value - candidate config.
 * @returns {boolean} whether `value` is an already resolved config.
 */
function isResolvedConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).some(holdsVolatileRef)
}

/**
 * Whether any value in a config subtree is a volatile reference.
 *
 * @param {unknown} value - config value to inspect.
 * @returns {boolean} whether a reference was found.
 */
function holdsVolatileRef(value) {
  if (isVolatileRef(value)) return true
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value).some(holdsVolatileRef)
}
