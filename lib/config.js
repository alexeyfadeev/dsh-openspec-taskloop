// dsh-openspec-taskloop — configuration contract.
//
// The loader validates the profile's config block against `Config` before
// `apply` runs, so `apply` sees a resolved object with every default filled in.
// The defaults are also written verbatim in the change's design.md (decision
// D11), and test/config.test.mjs fails when the two drift apart — that test is
// the reason the numbers below are not just code comments.
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
//     taken inside a task.

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

/**
 * The plugin configuration as the host passes it to `apply`.
 *
 * @typedef {object} Config
 * @property {string} change - Change name; an empty string means "the most
 *   recently modified change".
 * @property {object} compaction
 * @property {object} compaction.retry
 * @property {number} compaction.retry.attempts
 * @property {number} compaction.retry.delayMs
 * @property {number} compaction.retry.factor
 * @property {number} compaction.retry.maxDelayMs
 * @property {string[]} compaction.retry.codes
 * @property {'continue'|'break'} compaction.onFailure
 * @property {boolean} compaction.midTask
 * @property {object} protocol
 * @property {boolean} protocol.systemSection
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
      .description('Policy when the compaction retry budget is exhausted'),
    midTask: z
      .boolean()
      .default(DEFAULT_MID_TASK)
      .description('Compact by context pressure on a step boundary'),
  }),
  protocol: z.object({
    systemSection: z
      .boolean()
      .default(DEFAULT_PROTOCOL_SYSTEM_SECTION)
      .description('Register the static protocol section on agent.ctx for a run'),
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
 * @param {unknown} [value] - Config block from the profile; `undefined` means
 *   the plugin was mounted without one.
 * @returns {Config}
 */
export function resolveConfig(value) {
  return Config(value ?? {})
}
