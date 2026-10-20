# Proposal

## Why

OpenSpec already produces a deterministic work list (`tasks.md` and `openspec instructions apply --json`), but executing it is left entirely to the model. The apply skill tells the agent to loop over every pending task in one turn, so context grows without limit, there is no control point between tasks, and nothing guarantees the model stops after the task it was given. A plugin that owns this loop turns an open-ended instruction into a process with a single conductor.

## What Changes

- New DeepSeek Harness host plugin `dsh-openspec-taskloop`, developed in this repository and installed into a profile through a local `link:` dependency plus a loader patch entry.
- `/taskloop [change]` command: starts an orchestrated OpenSpec apply run, or performs the bootstrap when the project is not initialized or no change exists yet.
- `/taskloop stop` and `/taskloop status` for control and inspection.
- Bootstrap path: verify the OpenSpec root, offer `openspec init --tools dsh` through a structured question, ask the user for a task description, then hand the description to the model with an explore-mode instruction.
- Apply loop: read the first undone task, drive exactly that task through one `followup` turn, re-read authoritative state after the turn, compact between tasks of the same group, and create a new session at a group boundary.
- Completion detection is state-based: the model marks `- [x]` in `tasks.md`, the plugin only reads `openspec instructions apply --json`. A turn that ends without the task marked is a stop condition, not a retry.
- Configurable compaction: retry with backoff for transient `compactNow` failures, an explicit `continue`/`break` policy when retries are exhausted, and an off-by-default mid-task pressure gate.
- Exactly one active run per process; run state is in memory and the loop is idempotent, re-deriving its position from `tasks.md` on every entry.

## Capabilities

### New Capabilities

- `openspec-taskloop`: orchestration of an OpenSpec apply run — command lifecycle and bootstrap, per-task turn driving, state-based completion detection, compaction policy, session handoff across task groups, and single-run guarding.

### Modified Capabilities

None. This repository has no existing specs; the capability is introduced by this change.

## Impact

- New package in this repository: `package.json`, `lib/` sources, `cordis.patch.yml` loader entry, README, tests.
- Consumes Host services: `commands`, `agents`, `sessionController`, `compaction`, `subprocess`, `systemPrompt`, `userQuestions`, `workspaceRegistry`, `tokenMeter`.
- Requires the `openspec` CLI (>= 1.14) on `PATH` in the session's working directory tree.
- Profile-level change on installation: a `link:` dependency and an `insert:` entry in the profile's `cordis.patch.yml`.
- No change to existing Harness packages, and no breaking changes.
