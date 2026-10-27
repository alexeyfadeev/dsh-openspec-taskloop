// dsh-openspec-taskloop — version gate for the GitButler CLI (task 3.1, design D1/D4/D5).
//
// The plugin commits through `but` (design D18), and GitButler 0.22.x changed the
// syntax of `but commit` and `but branch new` (proposal.md — Why). The plugin supports
// exactly one set of commands — the 0.22.x forms — so, like the `openspec` version gate
// in `lib/openspec.js` (task 9.1, design D20), it refuses to run against a CLI below the
// floor rather than branching its argv by version.
//
// This module holds the *pure* part of that gate: the constant floor, the parser that
// pulls the first `X.Y.Z` out of a `but --version` answer, and the numeric component
// comparison. It is deliberately free of Cordis and of any subprocess provider, so every
// scenario runs in tests without a host — the same shape as `parseOpenSpecVersion` and
// `compareOpenSpecVersions`. The fail-closed check itself — calling `but --version` once
// per run and stopping the run below the floor — is wired into the GitButler input card
// in `lib/control.js` (task 3.2, design D2), which already owns the `but status --json`
// read and has the subprocess runner.

/** Executable that reports the installed GitButler version. */
export const GITBUTLER_COMMAND = 'but'

/**
 * Oldest `but` this plugin's commands are written against (task 3.1, design D4).
 *
 * Both `but commit -b` and `but branch new -A` exist only in 0.22.x, so the floor is
 * `0.22.0`. A constant, not a configuration value: a setting could only lower the floor,
 * and an old CLI does not become newer for it.
 */
export const MIN_GITBUTLER_VERSION = '0.22.0'

/** The first `X.Y.Z` anywhere in an answer; pre-release and build metadata are not part of it. */
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/u

/**
 * Read the version out of a `but --version` answer (task 3.1).
 *
 * The answer is treated as data rather than as a format: the first `X.Y.Z` anywhere in it
 * is the version, and anything without one is `undefined`. Pre-release and build metadata
 * are dropped on purpose (design D4) — the gate exists to exclude an old contract, not to
 * honour semantic-version ordering, so `0.22.0-beta` counts as `0.22.0`.
 *
 * @param {unknown} answer - printed stdout of `but --version`.
 * @returns {{major: number, minor: number, patch: number}|undefined} numeric components, or
 *   `undefined` when the answer holds no version at all.
 */
export function parseGitButlerVersion(answer) {
  if (typeof answer !== 'string') return undefined
  const match = VERSION_PATTERN.exec(answer)
  if (match === null) return undefined
  const [major, minor, patch] = match.slice(1).map((part) => Number(part))
  // A component that is not a safe integer cannot be compared, so it is not a version.
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return undefined
  return { major, minor, patch }
}

/**
 * Compare two parsed versions component by component (task 3.1).
 *
 * Deliberately not a string comparison: `'0.9.0' > '0.22.0'` as text, because `'9' > '2'`,
 * while 0.9.0 is the older release. The components are compared as numbers, major first.
 *
 * @param {{major: number, minor: number, patch: number}} left - parsed version.
 * @param {{major: number, minor: number, patch: number}} right - parsed version to compare against.
 * @returns {number} negative when `left` is older, zero when the two are equal, positive when newer.
 * @throws {TypeError} when either side is not a parsed version.
 */
export function compareGitButlerVersions(left, right) {
  for (const side of [left, right]) {
    if (!Number.isSafeInteger(side?.major) || !Number.isSafeInteger(side?.minor) || !Number.isSafeInteger(side?.patch)) {
      throw new TypeError('compareGitButlerVersions requires two parsed versions')
    }
  }
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1
  }
  return 0
}