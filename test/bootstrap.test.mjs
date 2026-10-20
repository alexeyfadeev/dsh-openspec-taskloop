// Tests for the OpenSpec root check and initialisation (task 3.2).
//
// The spec states two halves and both are pinned here: initialisation runs only
// after an explicit confirmation, and a refusal leaves the project untouched.
// "Untouched" is asserted structurally — the fake CLI records every call — so a
// refusal that secretly spawned `openspec init` would fail the test instead of
// being hidden behind the wording of the result.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BOOTSTRAP, BOOTSTRAP_ERROR, BootstrapError, buildInitQuestion, ensureRoot,
  INIT_ARGS, INIT_ANSWER, INIT_LABEL, INIT_QUESTION_ID, LIST_ARGS,
  readInitAnswer, requestInitialization,
} from '../lib/bootstrap.js'
import { LISTING_ERROR } from '../lib/changes.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'listing')

/**
 * Read one captured listing fixture.
 *
 * @param {string} name - file name inside the fixture directory.
 * @returns {string} raw document text.
 */
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8')

const CWD = 'C:\\projects\\demo'

/**
 * Build the exit facts of one CLI call.
 *
 * @param {string} stdout - collected stdout.
 * @param {number} [exitCode] - process exit code.
 * @param {string} [stderr] - retained stderr.
 * @returns {object} a settled CLI result.
 */
const cliResult = (stdout, exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr, truncated: false })

/**
 * A fake CLI that answers each call from a script and records the calls.
 *
 * @param {object[]} responses - settled results, consumed in call order.
 * @returns {object} the fake wrapper with a `calls` log.
 */
function scriptedCli(responses) {
  const calls = []
  return {
    calls,
    async run(args, options) {
      calls.push({ args, options })
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`)
      if (next instanceof Error) throw next
      return next
    },
  }
}

/** A confirmation channel that must not be reached. */
const neverAsked = () => {
  throw new Error('the confirmation channel must not be used here')
}

/**
 * The one question's answer, in the shape `ctx.userQuestions.ask` resolves.
 *
 * @param {string[]} selected - selected option labels.
 * @param {string} [custom] - free-text "Other" answer.
 * @returns {object} an answer batch.
 */
const answerWith = (selected, custom) => ({
  answers: [{ id: INIT_QUESTION_ID, selected, ...(custom === undefined ? {} : { custom }) }],
})

test('an initialized project is ready without asking anything', async () => {
  const cli = scriptedCli([cliResult(fixture('repo.json'))])

  const outcome = await ensureRoot({
    cli,
    cwd: CWD,
    signal: new AbortController().signal,
    confirm: neverAsked,
  })

  assert.equal(outcome.kind, BOOTSTRAP.ready)
  assert.ok(outcome.root.path.endsWith('dsh-openspec-taskloop'), `unexpected root: ${outcome.root.path}`)
  assert.equal(outcome.listing.changes.length, 1)
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(cli.calls[0].args, LIST_ARGS)
  assert.equal(cli.calls[0].options.cwd, CWD)
})

test('a refusal asks once and never runs `openspec init`', async () => {
  // An uninitialized project exits nonzero and still prints its document.
  const cli = scriptedCli([cliResult(fixture('no-root.json'), 1)])
  const asked = []

  const outcome = await ensureRoot({
    cli,
    cwd: CWD,
    signal: new AbortController().signal,
    confirm: async (request) => {
      asked.push(request)
      return INIT_ANSWER.cancel
    },
  })

  assert.equal(outcome.kind, BOOTSTRAP.declined)
  assert.deepEqual(asked, [{ cwd: CWD }])
  // Only the listing ran: the refusal produced no write of any kind.
  assert.equal(cli.calls.length, 1)
  assert.ok(!cli.calls.some((call) => call.args[0] === 'init'))
})

test('a confirmation runs `openspec init --tools dsh` and re-reads the root', async () => {
  const cli = scriptedCli([
    cliResult(fixture('no-root.json'), 1),
    cliResult('OpenSpec Setup Complete'),
    cliResult(fixture('empty.json')),
  ])

  const outcome = await ensureRoot({
    cli,
    cwd: CWD,
    signal: new AbortController().signal,
    confirm: async () => INIT_ANSWER.initialize,
  })

  assert.equal(outcome.kind, BOOTSTRAP.created)
  assert.equal(outcome.root.path, 'C:\\projects\\empty-project')
  assert.equal(cli.calls.length, 3)
  assert.deepEqual(cli.calls[1].args, INIT_ARGS)
  assert.deepEqual([...INIT_ARGS], ['init', '--tools', 'dsh'])
  assert.deepEqual(cli.calls[2].args, LIST_ARGS)
  assert.equal(cli.calls[1].options.cwd, CWD)
})

test('the question names the directory and the command it would run', () => {
  const question = buildInitQuestion('/work/demo')

  assert.equal(question.id, INIT_QUESTION_ID)
  assert.equal(question.header, 'OpenSpec')
  assert.match(question.question, /\/work\/demo/)
  assert.match(question.detail, /openspec init --tools dsh/)
  assert.deepEqual(
    question.options.map((option) => option.label),
    [INIT_LABEL.initialize, INIT_LABEL.cancel],
  )
})

test('only an explicit Initialize selection is consent', () => {
  assert.equal(readInitAnswer(answerWith([INIT_LABEL.initialize])), INIT_ANSWER.initialize)
  assert.equal(readInitAnswer(answerWith([INIT_LABEL.cancel])), INIT_ANSWER.cancel)
  assert.equal(readInitAnswer(answerWith([])), INIT_ANSWER.cancel)
  // "Other" text is not an option label, so it cannot be a confirmation.
  assert.equal(readInitAnswer(answerWith([], 'yes, go ahead')), INIT_ANSWER.cancel)
  assert.equal(readInitAnswer(answerWith([INIT_LABEL.initialize, INIT_LABEL.cancel])), INIT_ANSWER.cancel)
  assert.equal(readInitAnswer({ answers: [] }), INIT_ANSWER.cancel)
  assert.equal(readInitAnswer({ answers: [{ id: 'other', selected: [INIT_LABEL.initialize] }] }), INIT_ANSWER.cancel)
  assert.equal(readInitAnswer(undefined), INIT_ANSWER.cancel)
})

test('a failed init surfaces the exit code and the CLI message', async () => {
  const cli = scriptedCli([
    cliResult(fixture('no-root.json'), 1),
    cliResult('Creating OpenSpec structure...', 1, '\nError: EPERM: operation not permitted, mkdir\n'),
  ])

  await assert.rejects(
    ensureRoot({ cli, cwd: CWD, signal: new AbortController().signal, confirm: async () => INIT_ANSWER.initialize }),
    (error) => {
      assert.ok(error instanceof BootstrapError)
      assert.equal(error.code, BOOTSTRAP_ERROR.init)
      assert.match(error.message, /exit code 1/)
      assert.match(error.message, /EPERM/)
      return true
    },
  )
  // The root is not read again after a failed init: there is nothing to report.
  assert.equal(cli.calls.length, 2)
})

test('init that leaves no root behind is a failure, not a green light', async () => {
  const cli = scriptedCli([
    cliResult(fixture('no-root.json'), 1),
    cliResult('OpenSpec Setup Complete'),
    cliResult(fixture('no-root.json'), 1),
  ])

  await assert.rejects(
    ensureRoot({ cli, cwd: CWD, signal: new AbortController().signal, confirm: async () => INIT_ANSWER.initialize }),
    (error) => {
      assert.ok(error instanceof BootstrapError)
      assert.equal(error.code, BOOTSTRAP_ERROR.initRoot)
      assert.match(error.message, /still not an OpenSpec root/)
      return true
    },
  )
})

test('a listing that is not a listing is an error, not a missing root', async () => {
  const cli = scriptedCli([cliResult('openspec: crashed before printing json')])

  await assert.rejects(
    ensureRoot({ cli, cwd: CWD, signal: new AbortController().signal, confirm: neverAsked }),
    (error) => {
      assert.equal(error.code, LISTING_ERROR.malformed)
      return true
    },
  )
  assert.equal(cli.calls.length, 1)
})

test('a session that cannot ask refuses instead of writing', async () => {
  const cli = scriptedCli([cliResult(fixture('no-root.json'), 1)])

  await assert.rejects(
    ensureRoot({ cli, cwd: CWD, signal: new AbortController().signal, confirm: async () => INIT_ANSWER.unavailable }),
    (error) => {
      assert.ok(error instanceof BootstrapError)
      assert.equal(error.code, BOOTSTRAP_ERROR.noChannel)
      assert.match(error.message, /openspec init --tools dsh/)
      return true
    },
  )
  assert.equal(cli.calls.length, 1)
})

test('the confirmation goes to the user-questions service with the agent and the signal', async () => {
  const asked = []
  const questions = {
    async ask(request) {
      asked.push(request)
      return answerWith([INIT_LABEL.initialize])
    },
  }
  const agent = { id: 'agent-1' }
  const signal = new AbortController().signal

  const decision = await requestInitialization({ questions, agent, cwd: CWD, signal })

  assert.equal(decision, INIT_ANSWER.initialize)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].agent, agent)
  assert.equal(asked[0].signal, signal)
  assert.equal(asked[0].questions.length, 1)
  assert.equal(asked[0].questions[0].id, INIT_QUESTION_ID)
  assert.match(asked[0].questions[0].question, /C:\\projects\\demo/)
})

test('a dismissed or aborted question is a refusal', async () => {
  for (const code of ['ASK_CANCELLED', 'ASK_ABORTED']) {
    const questions = {
      async ask() {
        throw Object.assign(new Error('the user cancelled ask_user_question'), { code })
      },
    }
    assert.equal(await requestInitialization({ questions, cwd: CWD }), INIT_ANSWER.cancel)
  }
})

test('a service with no answerer is unavailable, never consent', async () => {
  const questions = {
    async ask() {
      throw Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' })
    },
  }

  assert.equal(await requestInitialization({ questions, cwd: CWD }), INIT_ANSWER.unavailable)
})

test('no user-questions service at all is unavailable', async () => {
  assert.equal(await requestInitialization({ questions: undefined, cwd: CWD }), INIT_ANSWER.unavailable)
  assert.equal(await requestInitialization({ questions: null, cwd: CWD }), INIT_ANSWER.unavailable)
})

test('an unexpected question failure is reported instead of becoming consent', async () => {
  const questions = {
    async ask() {
      throw Object.assign(new Error('a reply is already queued for this question'), { code: 'REPLY_QUEUED' })
    },
  }

  await assert.rejects(requestInitialization({ questions, cwd: CWD }), /reply is already queued/)
})
