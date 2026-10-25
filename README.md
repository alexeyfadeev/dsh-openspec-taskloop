# dsh-openspec-taskloop

A DeepSeek Harness plugin that turns an OpenSpec change into a running task loop: `/taskloop` sends one task per
turn, reads completion from `tasks.md` instead of from the model's answer, bounds the context it grows, and hands
the work to a fresh session when a run crosses into the next group of tasks.

## Install

```sh
dsh plugin --profile <profile> add <path-to-this-repo>
dsh web
```

[`cordis.patch.yml`](./cordis.patch.yml) is the layer the install applies: one row, `openspec-taskloop`. The same
id is the config target in the profile's own `cordis.patch.yml`, the namespace the Settings page edits, and the
key of this plugin's configuration block.

## `/taskloop`

```
/taskloop             the next task of the configured change, or of the change with the latest lastModified
/taskloop <change>    the next task of that change
/taskloop stop        stop the active run
/taskloop status      report the active run
```

One task per turn. The plugin sends the task message, waits for the turn it started to finish and then re-reads
`tasks.md`: a task that came back checked continues the run, one that did not stops it with a report naming the
task and the file. Nothing else moves the run forward — an argument the command does not understand answers with
the usage text and sends nothing.

Task ids of the form `N.M` form **groups**. When the last task of a group is verified, the run continues in a
session it opens itself, and the report in the original session says which one. A flat list (no `N.M` ids) has no
groups and stays in one session.

A finished group is reviewed before the next one starts. A session of its own — not the one the next group will
run in — receives exactly one instruction to review the group's uncommitted changes, and the run waits for that
one turn before it sends anything else; the report names the review session. The review is unattended: the instruction
forbids questions, and the session's approval policy is `never`, so a request for confirmation is rejected instead
of waiting for an answer nobody will give. The reviewer fixes only defects it can fix one way, in the same
uncommitted changes the commit then picks up; with nothing to fix it lists what it checked. Stopping the run during
the review stops the review too, and no further task is sent. A flat list is reviewed once, at the end of the run,
and its instruction names the whole task list instead of a task range. The **Code review after each task group**
setting turns the whole step off.

A finished group is then committed — by the plugin, not by the model, through the tool in the **Commit tool**
setting. `Git` stages the whole working tree (`git add -A`) and then runs `git commit -m`; `GitButler` runs
`but commit -m`. Before either, the run checks `git status --porcelain`, so a tree with no changes is not an error:
nothing is committed and the report says there was nothing to commit, which is also the answer when you committed
by hand first. The message is passed as one argv element rather than a command line, so quotes, spaces and line
breaks inside it stay part of the message and can never add a command. Committing the tree whole means everything
uncommitted goes in, including leftovers that are not this run's work — accepted deliberately, hence a report that
says which group was committed rather than guessing what the run wrote. Each commit the run made is a sentence of
the report, quoting the tool's own line because that line is where the commit id is, and the moment the tool
commits the run also appends `commit <id>` to the transcript of the session the group ran in — so the id is
readable before the next group starts, rather than only in the report at the end. A commit the tool refuses
stops the run: the group is already ticked off in `tasks.md`, so the report names the tool, its exit code and the
reason it gave, and no further task is sent. The next `/taskloop` continues with the next task; the commit itself
can be redone by hand with the same message — your text plus the range of the group.

The message those commits carry is yours, and the run asks for it once — at the start, before the first task, as
a free-form question with no suggestions to pick from, because a commit message is a sentence about the work and
not a choice off a list. Each commit then passes it with the range of its group appended:
`Добавить эндпоинт. Tasks 2.1 - 2.4`. A text that already ends with a sentence break keeps it as it is — one
full stop, not two: `Change badge.` becomes `Change badge. Tasks 2.1 - 2.7`. A flat list has no numbers to append,
so it commits your text alone; line
breaks inside the text are kept, and the whole message reaches the tool as one argument. With **Commit after each
task group** off the question is not asked: there is no commit to put the text in.

The text is stored in `~/.dsh/storages/openspec-taskloop.json`, keyed by the project directory and the change name
(`<cwd>#<change>`), and written down as soon as you give it — which is what makes a run survive an interruption: a
stop, a reloaded window or a crash ends the run, and the next `/taskloop` of that change continues with the same
message instead of asking again. The file sits outside the repository on purpose: `git add -A` commits the whole
tree, so a record kept there would land inside the very commit it describes. When every task of the change is done
the record is deleted, and the next `/taskloop` for that change asks for a sentence about the work ahead rather
than reusing the old one; a record the run cannot delete is reported as a warning instead of failing a finished
run. Cancelling the question starts nothing at all: no message goes to the model and no file is touched.

Between tasks of a group the run compacts its own context, retrying a transient failure up to the configured
budget. What happens when that budget is spent is the `compaction.onFailure` setting: `break` withholds the next
task, `continue` sends it and adds a warning to the report.

A run is not tied to the request that started it. Closing the tab, reloading it or losing the socket — the host
aborts that request — does not end the run; `/taskloop stop` is the only thing that does, and a report from a run
that outlived its request arrives in the session as a context notice. One run per process at a time: a second
`/taskloop` while one is active is refused, wherever it comes from.

In a project with no `openspec/` root the plugin asks before running `openspec init`. In a project with no
changes it asks what to work on and opens explore mode instead of starting a loop.

## Settings dsh

**Settings dsh → OpenSpec Taskloop**, the page that sits right behind General and Models and edits this plugin's
own configuration block. Six rows:

| What the page shows | Field | Default | What it turns on |
| --- | --- | --- | --- |
| Commit after each task group | `commit.enabled` | on | Commit the working tree once the last task of a group is verified, using the message given at the start of the run plus the task range of the group. |
| Commit tool | `commit.tool` | Git | `git` (`git add -A`, then `git commit -m`) or GitButler's `but commit -m`. Read at the moment of the commit, so the tool can be switched without restarting a run. |
| Code review after each task group | `review.enabled` | on | Review the finished group in a session of its own, before the next group starts and before the commit. |
| Compact inside a task | `compaction.midTask` | off | Ask for compaction by context pressure on a step boundary, not only between tasks. |
| When the compaction budget runs out | `compaction.onFailure` | Break | `Break` stops the run and reports the blocked task; `Continue` records a warning in the report and sends the next task anyway. |
| Protocol section | `protocol.systemSection` | off | Register the static protocol section on every agent the run drives. |

There is no Save button: every row writes as soon as it is used, through the same config form the built-in pages
use, so the value lands in the profile's `cordis.patch.yml` and the next run applies it — no Harness restart. A
refused write puts the deployment's values back on screen and says so, instead of leaving a draft that never
landed.

**Protocol section is meant to be switched on together with Compact inside a task.** The section exists to
survive a summary taken mid-task: on its own it describes a run that is bounded only between tasks, which is
already the case without it.

The page is the plugin's only place for these six values; the rest of the block below is a profile decision. And
because the page is this plugin's own, there is no second, generated copy of it under Settings → Plugins.

## Configuration

```yaml
- id: openspec-taskloop
  config:
    change: ''                     # empty: the change with the latest lastModified
    commit:
      enabled: true                # Commit after each task group
      tool: git                    # git | gitbutler
    review:
      enabled: true                # Code review after each task group
    compaction:
      midTask: false               # Compact inside a task
      onFailure: break             # continue | break
      retry:                       # the budget above: attempts counts the first call too
        attempts: 3
        delayMs: 1000
        factor: 2
        maxDelayMs: 10000
        codes: [summary, persistence, busy]
    protocol:
      systemSection: false         # Protocol section
    openspec:
      timeoutMs: 120000            # deadline of one openspec call
```

The six fields the page edits are volatile: they are read when they apply, so a change is picked up by the next
run. `change`, `compaction.retry.*` and `openspec.timeoutMs` are not, and are edited here or not at all — the
retry parameters only make sense together with the policy that spends them.

`onFailure` accepts `break` and `continue`, `tool` accepts `git` and `gitbutler`; anything else is rejected when
the profile is loaded, with the offending path. The retry codes are the transient `compactNow` failures only:
`summary`, `persistence` and `busy` are retried, a terminal outcome never is.

## Development

```sh
pnpm install
pnpm test
```

`test/` holds one file per module plus three plugin-wide ones: the manifest contract (`manifest.test.mjs`), the
Settings page, loaded the way the host loads it (`client.test.mjs`), and the mount and page policy
(`plugin.test.mjs`).
