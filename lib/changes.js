// dsh-openspec-taskloop — reading `openspec list --json` (task 2.2).
//
// The listing answers the two questions the plugin asks before it does anything
// else: is this directory an OpenSpec root at all, and which change does the
// user mean. Both answers arrive in one document, so this module is pure —
// stdout text in, data out, no CLI and no Cordis. The call itself is
// `OpenSpecCli.run(['list', '--json'])` (task 2.1); running the two together is
// part of the command bootstrap.
//
// Document shape, captured from openspec 1.14.1 (see test/fixtures/listing):
//
//   {
//     "changes": [
//       { "name", "completedTasks", "totalTasks", "lastModified", "status" }
//     ],
//     "root": { "path", "source" }
//   }
//
// Two wrinkles shape the parse:
//
//   - `root` is `null` when no root was found, and such a document also carries
//     a top-level `status` array of diagnostics. `status` therefore names both a
//     per-change state string and the failure channel of the document itself.
//   - The CLI sorts `changes` by `lastModified` descending, but its order for
//     equal timestamps comes from the directory listing. The plugin never
//     trusts that order: it compares timestamps itself and breaks ties by name,
//     so a run can be resumed from the same change twice in a row.

/**
 * Failure kinds reported by {@link ListingError}. Callers switch on the code
 * instead of matching message text.
 */
export const LISTING_ERROR = Object.freeze({
  /** stdout was not a JSON document of the documented shape. */
  malformed: 'malformed',
})

/**
 * Outcomes of {@link selectChange}; callers switch on `kind`.
 */
export const SELECTION = Object.freeze({
  /** A change was picked; the result carries it as `change`. */
  selected: 'selected',
  /** The project has no changes at all, so there is nothing to pick. */
  empty: 'empty',
  /** A name was requested and the listing does not contain it. */
  unknown: 'unknown',
})

/**
 * One entry of the `changes` array, normalised for the plugin.
 *
 * @typedef {object} ChangeEntry
 * @property {string} name - directory name of the change.
 * @property {number|null} completedTasks - checked tasks, `null` when the CLI omitted the count.
 * @property {number|null} totalTasks - total tasks, `null` when the CLI omitted the count.
 * @property {number} lastModified - newest file time of the change in epoch milliseconds.
 * @property {string|null} status - `in-progress`, `complete`, `no-tasks`, or `null` when absent.
 */

/**
 * One entry of the document's `status` array.
 *
 * @typedef {object} ListingDiagnostic
 * @property {string} code - machine-readable kind, e.g. `no_openspec_root`.
 * @property {string} message - human-readable explanation.
 * @property {string|null} fix - the CLI's own suggested remedy, when it has one.
 */

/**
 * A parsed `openspec list --json` document.
 *
 * @typedef {object} ChangeListing
 * @property {{path: string, source: string|null}|null} root - resolved root, `null` when uninitialized.
 * @property {ChangeEntry[]} changes - changes in the CLI's order, which selection does not rely on.
 * @property {ListingDiagnostic[]} diagnostics - why the document says what it says, when the CLI explains.
 */

/**
 * A document that is not a usable listing.
 *
 * Only shape failures land here: a well-formed document that reports
 * `root: null` is an answer, not an error, and is returned as data.
 */
export class ListingError extends Error {
  /**
   * @param {string} message - diagnostic naming the offending part.
   * @param {object} [details]
   * @param {Error} [details.cause] - underlying `JSON.parse` error, when any.
   */
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ListingError'
    this.code = LISTING_ERROR.malformed
  }
}

/**
 * Parse the stdout of `openspec list --json`.
 *
 * @param {string} stdout - collected stdout of the call.
 * @returns {ChangeListing} root, changes and diagnostics.
 * @throws {ListingError} when the text is not a listing of the documented shape.
 */
export function parseChangeListing(stdout) {
  if (typeof stdout !== 'string') {
    throw new TypeError('parseChangeListing requires the stdout string of the CLI call')
  }

  let document
  try {
    document = JSON.parse(stdout)
  } catch (cause) {
    throw new ListingError(`openspec list --json did not return JSON: ${describe(cause)}`, { cause })
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new ListingError('openspec list --json did not return a JSON object')
  }
  // The CLI always emits at least one of the two keys, including in its failure
  // shapes. Requiring one keeps an unrelated JSON document — a crash banner
  // wrapped in JSON, say — from reading as "no changes" and bootstrapping a run.
  if (!('changes' in document) && !('root' in document)) {
    throw new ListingError('openspec list --json output is not a change listing: neither `changes` nor `root` is present')
  }

  return {
    root: parseRoot(document.root),
    changes: parseChanges(document.changes),
    diagnostics: parseDiagnostics(document.status),
  }
}

/**
 * Pick the change the run should work on.
 *
 * @param {ChangeListing} listing - parsed listing.
 * @param {string|undefined} [requested] - change name from the command line or configuration; empty means "not given".
 * @returns {{kind: 'selected', change: ChangeEntry}|{kind: 'empty'}|{kind: 'unknown', name: string, available: string[]}} selection.
 */
export function selectChange(listing, requested) {
  const changes = listing.changes
  if (changes.length === 0) return { kind: SELECTION.empty }

  const wanted = typeof requested === 'string' ? requested.trim() : ''
  if (wanted !== '') {
    const match = changes.find((change) => change.name === wanted)
    if (match === undefined) {
      return {
        kind: SELECTION.unknown,
        name: wanted,
        available: changes.map((change) => change.name).sort(compareNames),
      }
    }
    return { kind: SELECTION.selected, change: match }
  }

  // Most recently modified wins; equal timestamps fall back to the name, which
  // keeps the choice stable across runs instead of inheriting readdir order.
  let latest = changes[0]
  for (const change of changes.slice(1)) {
    if (change.lastModified > latest.lastModified) {
      latest = change
    } else if (change.lastModified === latest.lastModified && compareNames(change.name, latest.name) < 0) {
      latest = change
    }
  }
  return { kind: SELECTION.selected, change: latest }
}

/**
 * Normalise the document's `root`, whose absence and `null` both mean "no root".
 *
 * @param {unknown} value - raw `root` value.
 * @returns {{path: string, source: string|null}|null} resolved root or `null`.
 * @throws {ListingError} when the value is neither absent, `null`, nor a root object.
 */
function parseRoot(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.path !== 'string' || value.path === '') {
      throw new ListingError('openspec list --json returned a root without a path')
    }
    return { path: value.path, source: typeof value.source === 'string' ? value.source : null }
  }
  throw new ListingError(`openspec list --json returned an unexpected root of type ${typeof value}`)
}

/**
 * Normalise the `changes` array.
 *
 * @param {unknown} value - raw `changes` value.
 * @returns {ChangeEntry[]} parsed entries in the document's order.
 * @throws {ListingError} when the value is present but not an array, or an entry is unusable.
 */
function parseChanges(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ListingError('openspec list --json returned `changes` that is not an array')
  }
  return value.map((entry, index) => parseChange(entry, index))
}

/**
 * Normalise one change entry.
 *
 * @param {unknown} entry - raw entry.
 * @param {number} index - position in the array, for diagnostics.
 * @returns {ChangeEntry} parsed entry.
 * @throws {ListingError} when the entry cannot name a change.
 */
function parseChange(entry, index) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ListingError(`openspec list --json returned changes[${index}] that is not an object`)
  }
  if (typeof entry.name !== 'string' || entry.name === '') {
    throw new ListingError(`openspec list --json returned changes[${index}] without a name`)
  }
  // Selection is ordered by this value, so an unusable timestamp is fatal rather
  // than defaulted: guessing here would silently change which change runs.
  const lastModified = typeof entry.lastModified === 'string' ? Date.parse(entry.lastModified) : Number.NaN
  if (Number.isNaN(lastModified)) {
    throw new ListingError(
      `openspec list --json returned changes[${index}] (${entry.name}) without a usable lastModified`,
    )
  }
  return {
    name: entry.name,
    completedTasks: count(entry.completedTasks),
    totalTasks: count(entry.totalTasks),
    lastModified,
    status: typeof entry.status === 'string' ? entry.status : null,
  }
}

/**
 * Normalise the document's `status` array — diagnostics, not change states.
 *
 * Lenient by design: a diagnostic that cannot be read is still worth showing,
 * and none of them can make a listing unusable.
 *
 * @param {unknown} value - raw `status` value.
 * @returns {ListingDiagnostic[]} diagnostics of the document.
 */
function parseDiagnostics(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      code: typeof entry.code === 'string' ? entry.code : 'unknown',
      message: typeof entry.message === 'string' ? entry.message : '',
      fix: typeof entry.fix === 'string' ? entry.fix : null,
    }))
}

/**
 * Task counts are optional in the report, so a missing or odd value becomes `null`.
 *
 * @param {unknown} value - raw count.
 * @returns {number|null} the count, or `null` when it is not a non-negative integer.
 */
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Order names by UTF-16 code units. `localeCompare` would make the tie-break
 * depend on the process locale, and resume stability is the point of the rule.
 *
 * @param {string} left - first name.
 * @param {string} right - second name.
 * @returns {number} negative, zero, or positive, as `Array.prototype.sort` expects.
 */
function compareNames(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Message text for an unknown thrown value.
 *
 * @param {unknown} value - thrown value.
 * @returns {string} a message safe to embed.
 */
function describe(value) {
  return value instanceof Error ? value.message : String(value)
}
