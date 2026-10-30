// Tests for the line endings of the files a GitButler commit carries (task 5.4, design D8).
//
// The step exists because `but commit` does not tell CRLF from LF: it composes the new blob
// out of the old one and the changed regions of the working copy, so a file whose blob is LF
// while the working copy is CRLF arrives mixed and `git status` keeps reporting it after the
// commit. The rule is "rewrite the files of the commit to LF", and these tests pin the two
// halves of it: which files it touches — decided by the blob in `HEAD`, not by the working
// copy — and what it leaves alone.
//
// The files here are real files in a temporary directory, because the module reads and
// rewrites bytes; the index is a fake runner answering `git ls-files --eol`, because that is
// the one thing the module asks git for.

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  EOL_BINARY_SCAN_BYTES,
  eolRewriteOf,
  lsFilesEolCommand,
  normalizeEol,
  parseEolListing,
} from '../lib/eol.js'

/** A file whose lines end with CRLF. */
const CRLF = 'a\r\nb\r\n'

/** The same file the way the repository stores it. */
const LF = 'a\nb\n'

/**
 * A fresh project directory, removed when the test ends.
 *
 * @param {object} t - test context, which owns the cleanup.
 * @returns {Promise<string>} absolute path of the directory.
 */
async function project(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openspec-taskloop-eol-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/**
 * A runner that answers the listing request with the index forms of these files.
 *
 * The shape is the one `git ls-files --eol -z` prints — padded columns, a tab, the path —
 * because the parser reads it as the tool prints it. A path that is not in `forms` is not in
 * the answer at all: that is how git reports an untracked file.
 *
 * @param {Record<string, string>} forms - index form per path (`lf`, `crlf`, `mixed`, …).
 * @param {object} [options]
 * @param {{name: string, args: readonly string[]}[]} [options.calls] - log to append to.
 * @param {Error} [options.reject] - a rejection the runner throws instead of answering.
 * @param {number} [options.exitCode] - an exit code other than zero to answer with.
 * @returns {Function} the runner.
 */
function eolRunner(forms, { calls = [], reject, exitCode = 0 } = {}) {
  return async (request, options) => {
    calls.push({ name: `${request.executable} ${request.args[0]}`, args: request.args, cwd: options.cwd })
    if (reject !== undefined) throw reject
    const stdout = Object.entries(forms)
      .map(([path, form]) => `i/${form}   w/${form}   attr/                  \t${path}\0`)
      .join('')
    return { exitCode, stdout, stderr: '' }
  }
}

test('the listing request asks git about these files and nothing else', () => {
  assert.deepEqual(lsFilesEolCommand(['lib/a.js', 'docs/a b.md']), {
    executable: 'git',
    args: ['ls-files', '--eol', '-z', '--', 'lib/a.js', 'docs/a b.md'],
  })
  // An empty list would list the whole index, which is a wider question than the commit asks.
  assert.throws(() => lsFilesEolCommand([]), /at least one path/u)
  assert.throws(() => lsFilesEolCommand(['']), /non-empty path/u)
  assert.throws(() => lsFilesEolCommand('lib/a.js'), /array of file paths/u)
})

test('the listing is read from the index column, one record per NUL', () => {
  const stdout = 'i/lf    w/crlf  attr/                  \tlib/a.js\0'
    + 'i/crlf  w/crlf  attr/                  \tlib/b.js\0'
    + 'i/mixed w/lf    attr/                  \tlib/c.js\0'
    + 'i/none  w/none  attr/                  \tlib/empty.js\0'
    + 'i/-text w/-text attr/                  \tlib/logo.png\0'

  const listing = parseEolListing(stdout)

  assert.deepEqual([...listing.keys()], ['lib/a.js', 'lib/b.js', 'lib/c.js', 'lib/empty.js', 'lib/logo.png'])
  assert.equal(listing.get('lib/a.js'), 'lf')
  assert.equal(listing.get('lib/b.js'), 'crlf')
  assert.equal(listing.get('lib/c.js'), 'mixed')
  assert.equal(listing.get('lib/empty.js'), 'none')
  // The binary marker is kept as git printed it: what it means is decided by the caller.
  assert.equal(listing.get('lib/logo.png'), '-text')
})

test('a listing that is empty or malformed says nothing about any file', () => {
  // Every one of these shapes has to end as "no information", never as a wrong form: the
  // rewrite of a file it cannot place would be worse than no rewrite at all.
  for (const stdout of ['', '\0', 'nonsense', 'i/lf w/lf attr/\0', 'i/lf    w/lf\nlib/a.js\n', undefined, 42]) {
    assert.equal(parseEolListing(stdout).size, 0, `answer: ${String(stdout)}`)
  }
})

test('the index form decides whether a file is rewritten, skipped or reported', () => {
  // Untracked: nothing to disagree with, the content is new and goes in as LF.
  assert.equal(eolRewriteOf(undefined), 'rewrite')
  assert.equal(eolRewriteOf('lf'), 'rewrite')
  assert.equal(eolRewriteOf('none'), 'rewrite')
  // Stored in CRLF: rewriting it would leave `i/crlf w/lf`, a file git reports for good.
  assert.equal(eolRewriteOf('crlf'), 'skip')
  // Rewritten all the same, but the history stays mixed and the report has to say so.
  assert.equal(eolRewriteOf('mixed'), 'mixed')
  // Binary in the index, and anything a later git invents: not ours to rewrite.
  assert.equal(eolRewriteOf('-text'), 'skip')
  assert.equal(eolRewriteOf('something-new'), 'skip')
})

test('a file whose blob is LF is rewritten to LF and the request names it', async (t) => {
  const directory = await project(t)
  await writeFile(join(directory, 'lib-a.js'), CRLF, 'utf8')
  const calls = []

  const result = await normalizeEol(['lib-a.js'], {
    cwd: directory,
    run: eolRunner({ 'lib-a.js': 'lf' }, { calls }),
  })

  assert.deepEqual(result, { rewritten: ['lib-a.js'], mixed: [] })
  assert.equal(await readFile(join(directory, 'lib-a.js'), 'utf8'), LF)
  assert.deepEqual(calls.map((call) => call.name), ['git ls-files'])
  assert.deepEqual(calls[0].args, ['ls-files', '--eol', '-z', '--', 'lib-a.js'])
  assert.equal(calls[0].cwd, directory)
})

test('a file that is already LF is not read into a request at all', async (t) => {
  const directory = await project(t)
  await writeFile(join(directory, 'lib-a.js'), LF, 'utf8')

  const result = await normalizeEol(['lib-a.js'], {
    cwd: directory,
    run: () => {
      throw new Error('a file without CRLF asks git nothing')
    },
  })

  assert.deepEqual(result, { rewritten: [], mixed: [] })
  assert.equal(await readFile(join(directory, 'lib-a.js'), 'utf8'), LF)
})

test('an untracked file is rewritten, because no blob stands behind it', async (t) => {
  const directory = await project(t)
  await mkdir(join(directory, 'docs'))
  await writeFile(join(directory, 'docs/new.md'), CRLF, 'utf8')

  // The listing is empty: git has no entry for a file it has never seen.
  const result = await normalizeEol(['docs/new.md'], { cwd: directory, run: eolRunner({}) })

  assert.deepEqual(result, { rewritten: ['docs/new.md'], mixed: [] })
  assert.equal(await readFile(join(directory, 'docs/new.md'), 'utf8'), LF)
})

test('a file stored in CRLF is left exactly as it is', async (t) => {
  const directory = await project(t)
  await writeFile(join(directory, 'lib-a.js'), CRLF, 'utf8')

  const result = await normalizeEol(['lib-a.js'], {
    cwd: directory,
    run: eolRunner({ 'lib-a.js': 'crlf' }),
  })

  assert.deepEqual(result, { rewritten: [], mixed: [] })
  assert.equal(await readFile(join(directory, 'lib-a.js'), 'utf8'), CRLF)
})

test('a mixed history is rewritten and named, so the report can warn', async (t) => {
  const directory = await project(t)
  await writeFile(join(directory, 'lib-a.js'), CRLF, 'utf8')

  const result = await normalizeEol(['lib-a.js'], {
    cwd: directory,
    run: eolRunner({ 'lib-a.js': 'mixed' }),
  })

  assert.deepEqual(result, { rewritten: ['lib-a.js'], mixed: ['lib-a.js'] })
  assert.equal(await readFile(join(directory, 'lib-a.js'), 'utf8'), LF)
})

test('a binary file is not rewritten, even when it holds a CR and an LF', async (t) => {
  const directory = await project(t)
  const bytes = Buffer.from([0x41, 0x00, 0x0d, 0x0a, 0x42])
  await writeFile(join(directory, 'logo.bin'), bytes)

  const result = await normalizeEol(['logo.bin'], {
    cwd: directory,
    run: () => {
      throw new Error('a binary file asks git nothing')
    },
  })

  assert.deepEqual(result, { rewritten: [], mixed: [] })
  assert.deepEqual(await readFile(join(directory, 'logo.bin')), bytes)
})

test('a NUL past the scanned window does not make a text file binary', async (t) => {
  // The decision is git's own: a NUL in the first kilobytes means binary. A file that has one
  // further in is still a text file, and its endings are still the commit's problem.
  const directory = await project(t)
  const bytes = Buffer.concat([Buffer.from(`${'x'.repeat(EOL_BINARY_SCAN_BYTES)}a\r\nb\r\n`), Buffer.from([0x00])])
  await writeFile(join(directory, 'lib-a.js'), bytes)

  const result = await normalizeEol(['lib-a.js'], { cwd: directory, run: eolRunner({ 'lib-a.js': 'lf' }) })

  assert.deepEqual(result.rewritten, ['lib-a.js'])
  const rewritten = await readFile(join(directory, 'lib-a.js'))
  assert.equal(rewritten.includes(0x0d), false)
  // The NUL is beyond the window and stays where it was: only the endings were rewritten.
  assert.equal(rewritten[rewritten.length - 1], 0x00)
})

test('a path that is not a regular file is skipped', async (t) => {
  const directory = await project(t)
  await mkdir(join(directory, 'sub'))
  await writeFile(join(directory, 'gone-then-back.md'), CRLF, 'utf8')
  await rm(join(directory, 'gone-then-back.md'))

  const result = await normalizeEol(['sub', 'missing.md', ''], {
    cwd: directory,
    run: () => {
      throw new Error('nothing here has an ending to rewrite')
    },
  })

  assert.deepEqual(result, { rewritten: [], mixed: [] })
})

test('a symlink is not rewritten through to its target', async (t) => {
  // Writing through a link would rewrite a file that is not this commit's file (D8). A
  // platform that cannot create one has no link to test.
  const directory = await project(t)
  await writeFile(join(directory, 'target.js'), CRLF, 'utf8')
  try {
    await symlink('target.js', join(directory, 'link.js'))
  } catch {
    t.skip('this platform cannot create a symlink without extra privileges')
    return
  }

  const result = await normalizeEol(['link.js'], {
    cwd: directory,
    run: () => {
      throw new Error('a symlink asks git nothing')
    },
  })

  assert.deepEqual(result, { rewritten: [], mixed: [] })
  assert.equal(await readFile(join(directory, 'target.js'), 'utf8'), CRLF)
})

test('a listing that failed rewrites nothing, and does not fail the commit', async (t) => {
  // Without the index there is no way to tell a file that agrees with its blob from one that
  // would be left permanently dirty, so the step does nothing rather than guess.
  const directory = await project(t)
  await writeFile(join(directory, 'lib-a.js'), CRLF, 'utf8')

  const refused = await normalizeEol(['lib-a.js'], {
    cwd: directory,
    run: eolRunner({ 'lib-a.js': 'lf' }, { exitCode: 128 }),
  })
  const broken = await normalizeEol(['lib-a.js'], {
    cwd: directory,
    run: eolRunner({ 'lib-a.js': 'lf' }, { reject: new Error('git is not available') }),
  })

  assert.deepEqual(refused, { rewritten: [], mixed: [] })
  assert.deepEqual(broken, { rewritten: [], mixed: [] })
  assert.equal(await readFile(join(directory, 'lib-a.js'), 'utf8'), CRLF)
})

test('a file the process cannot write is left as it is, and the rest are rewritten', async (t) => {
  // A read-only file is the ordinary shape of "this one is closed to us": the step must not
  // abandon the others over it, and must not fail the commit either (see the module header).
  const directory = await project(t)
  const locked = join(directory, 'locked.js')
  await writeFile(locked, CRLF, 'utf8')
  await chmod(locked, 0o444)
  await writeFile(join(directory, 'lib-a.js'), CRLF, 'utf8')

  try {
    const result = await normalizeEol(['locked.js', 'lib-a.js'], {
      cwd: directory,
      run: eolRunner({ 'locked.js': 'lf', 'lib-a.js': 'lf' }),
    })

    assert.deepEqual(result.rewritten, ['lib-a.js'])
    assert.equal(await readFile(locked, 'utf8'), CRLF)
  } finally {
    // The cleanup has to be able to delete it again.
    await chmod(locked, 0o644)
  }
})

test('the content survives the rewrite byte for byte, apart from the endings', async (t) => {
  // latin1 is what makes this true for a file in any encoding: the rewrite must not decode
  // the text and guess at it.
  const directory = await project(t)
  const bytes = Buffer.from('Привет\r\nмир\r\n', 'utf8')
  await writeFile(join(directory, 'lib-a.js'), bytes)

  await normalizeEol(['lib-a.js'], { cwd: directory, run: eolRunner({ 'lib-a.js': 'lf' }) })

  assert.deepEqual(await readFile(join(directory, 'lib-a.js')), Buffer.from('Привет\nмир\n', 'utf8'))
})

test('an empty list asks nothing and rewrites nothing', async () => {
  const result = await normalizeEol([], {
    run: () => {
      throw new Error('an empty list asks git nothing')
    },
  })

  assert.deepEqual(result, { rewritten: [], mixed: [] })
})

test('a list with a CRLF file and no runner is a caller bug', async (t) => {
  const directory = await project(t)
  await writeFile(join(directory, 'lib-a.js'), CRLF, 'utf8')

  await assert.rejects(
    () => normalizeEol(['lib-a.js'], { cwd: directory }),
    /requires a run\(\)/u,
  )
})

test('a stop leaves the files it has not reached alone', async (t) => {
  const directory = await project(t)
  await writeFile(join(directory, 'lib-a.js'), CRLF, 'utf8')
  await writeFile(join(directory, 'lib-b.js'), CRLF, 'utf8')
  const controller = new AbortController()
  controller.abort()

  const result = await normalizeEol(['lib-a.js', 'lib-b.js'], {
    cwd: directory,
    run: eolRunner({ 'lib-a.js': 'lf', 'lib-b.js': 'lf' }),
    signal: controller.signal,
  })

  assert.deepEqual(result, { rewritten: [], mixed: [] })
  assert.equal(await readFile(join(directory, 'lib-a.js'), 'utf8'), CRLF)
  assert.equal(await readFile(join(directory, 'lib-b.js'), 'utf8'), CRLF)
})
