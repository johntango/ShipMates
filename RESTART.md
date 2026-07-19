# ShipMates restart handoff

Updated: 2026-07-18 (America/New_York)

## Primary goal

Develop and stabilize ShipMates. Treat the ShipMates repository as protected: do not archive, clean, delete, prune, or remove its worktrees as housekeeping.

## Current repository state

- Repository: `johntango/ShipMates`
- Working directory: `/Users/johnwilliams/MIT/Courses/ShipMates`
- Current branch: `agent/herdr-execution-visibility`
- The worktree contains extensive pre-existing modified and untracked development work. Preserve it.
- ShipMates is persisted with `protected: true` in `.shipmates/projects.json`.
- Do not assume the current branch is disposable merely because PR #2 was merged; substantial later work is uncommitted.

## Lifecycle behavior implemented

FirstMate now supports guarded project and repository lifecycle commands:

```text
protect repository ShipMates
archive project PROJECT
cleanup repository REPOSITORY_OR_PROJECT
preview delete repository REPOSITORY_OR_PROJECT
confirm delete repository EXACT_PATH CONFIRMATION_ID
```

Repository deletion:

- groups every ShipMates project sharing the same Git directory;
- refuses protected repositories;
- refuses claimed or dispatched tasks;
- reports dirty files, unpushed commits, and missing remotes;
- requires the exact ID from a current preview;
- moves the local repository to Trash rather than erasing it;
- removes associated project/task records;
- preserves a recovery receipt;
- never deletes the GitHub repository.

## Blocked-task recovery implemented

The watchdog now terminalizes stale dispatched tasks only when no live FirstMate child or completed terminal artifact exists. It records a blocking reason containing the last durable activity and never launches a duplicate.

Failed FirstMate intake is also reconciled: a project task left `dispatched` while its task ledger is `proposed` with a failed classification is marked blocked on startup.

Deterministic commands:

```text
show task evidence TASK_ID
reconcile task TASK_ID
mark TASK_ID blocked because REASON
retry blocked task TASK_ID
mark PROJECT blocked because REASON
approve project PROJECT
```

Retry preserves the prior attempt ID before creating an explicitly approved new attempt.

## Planning safety implemented

Explicit planning requests fail closed if conversational planning is unavailable. FirstMate must not convert a request such as “Plan …”, “save a dependency-aware project plan”, or “do not dispatch” into one synthetic implementation task.

Project-completion announcements are edge-triggered so startup, task exit, and monitoring do not print the same completion message repeatedly.

## Deleted test repositories

DemoTest2 and BouncingBalls2 were intentionally removed from the ShipMates registry. The local repository was moved to:

`/Users/johnwilliams/.Trash/DemoTest2-2026-07-18T15-42-18-310Z-f587fc280c929073`

The GitHub repository was not changed. The deletion receipt is stored in `.shipmates/projects.json`.

The older DemoTest/TestA/TestB records and `/Users/johnwilliams/MIT/Courses/DemoTest` were not deleted during the latest operation.

## Validation

- Full suite after repository lifecycle and stale-task work: 312 tests passed.
- Subsequent focused tests for failed intake, planning fail-closed behavior, completion deduplication, and project controls passed.
- Run the current full suite after restart:

```bash
cd /Users/johnwilliams/MIT/Courses/ShipMates
npm test
```

## Restart commands

Start interactive FirstMate:

```bash
cd /Users/johnwilliams/MIT/Courses/ShipMates
npm run firstmate
```

If FirstMate needs the OpenAI API, ensure the environment has network access and the `.env` credentials remain available. A prior sandboxed run failed with DNS resolution for `api.openai.com`; that was an environment failure, not a worker implementation result.

## Recommended next milestone

Continue hardening crash-safe task execution. A blocked-task recovery skill may be useful as a conversational playbook, but all state transitions, evidence checks, retry authority, and destructive operations should remain deterministic workflows rather than model discretion.
