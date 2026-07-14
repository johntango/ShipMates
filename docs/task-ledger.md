# Durable task ledger

ShipMates now stores task history as append-only JSONL and derives current state
by replaying that history. The event log is authoritative; `snapshot.json` is a
replaceable projection for humans and future status adapters.

## Storage layout

Run commands from the ShipMates repository root. Operational data is written
under the ignored `.shipmates/` directory:

```text
.shipmates/
  tasks/
    <task-id>/
      events.jsonl     authoritative event history
      snapshot.json    replayable current-state projection
      write.lock       present only while a writer owns the task
```

Each append takes an exclusive per-task filesystem lock, validates the proposed
history, atomically replaces the event log, and atomically replaces the
snapshot. Independent processes can write different events to one task without
losing updates.

The store never guesses through uncertainty:

- a malformed event log stops replay;
- an illegal or stale transition is rejected before writing;
- an existing lock is never stolen automatically;
- reusing an event ID with different content is rejected;
- retrying the same event ID and content is idempotent;
- a missing or damaged snapshot can be rebuilt from the event log.

## State machine

The normal path is:

```text
proposed -> clarified -> approved_for_dispatch -> preparing -> running
  -> awaiting_worker -> validating -> awaiting_human -> ready_to_merge
  -> merging -> landed -> cleaning -> complete
```

Some work can return from `awaiting_worker`, `validating`,
`awaiting_human`, or `ready_to_merge` to `running`. Any non-terminal state can
enter `blocked`, `failed`, `cancelled`, or `recovery_required`. Terminal and
exceptional states cannot be exited by an ordinary transition.

A verified no-mutation exercise uses the shorter cleanup branch
`running -> validating -> cleaning -> complete`; it has no pull request or
merge approval to await.

Every transition includes its expected `from` state. This optimistic check
prevents a delayed process from advancing a task whose state changed while it
was working.

## Operator exercise

From `/Users/johnwilliams/MIT/Courses/ShipMates`, create and inspect a practice
task:

```sh
node scripts/task-ledger.js create \
  ledger-practice-001 \
  code-change \
  johntango/Shipmates-Practice \
  4894811cf35e6e7b6559d4d75f2da78d24791c92

node scripts/task-ledger.js transition \
  ledger-practice-001 proposed clarified \
  "scope and acceptance criteria recorded"

node scripts/task-ledger.js evidence \
  ledger-practice-001 requirement \
  "exercise the durable ledger before worker integration"

node scripts/task-ledger.js show ledger-practice-001
node scripts/task-ledger.js events ledger-practice-001
```

Record an exact-SHA merge approval only after the human has supplied it:

```sh
node scripts/task-ledger.js approve-merge \
  ledger-practice-001 \
  johntango/Shipmates-Practice \
  3 \
  APPROVED_HEAD_SHA \
  squash
```

For isolated exercises or tests, redirect state outside the repository:

```sh
SHIPMATES_STATE_DIR=/tmp/shipmates-state \
  node scripts/task-ledger.js create task-001 code-change owner/repo BASE_SHA
```

## Recovery

If `snapshot.json` is absent or damaged but `events.jsonl` is valid, run:

```sh
node scripts/task-ledger.js rebuild TASK_ID
```

If `events.jsonl` is malformed, do not edit forward or run another mutating
command. Preserve the task directory and investigate the last durable file
operation; the ledger intentionally fails closed.

If a process dies while holding `write.lock`, subsequent writers time out. Check
the PID and acquisition time stored in the lock, prove that process no longer
exists, preserve a copy of the task directory, and only then remove the stale
lock manually. Automatic stale-lock reclamation is intentionally deferred until
we have a recovery protocol with stronger process-identity evidence.

## Current boundary

The Treehouse workflow appends typed lease request, lease result, proof, return
request, and return result events automatically. The Codex scout workflow adds
dispatch, thread, report, reply, and independent-verification events. Scout
follow-ups add a human selection bound to a synthesis artifact and a resolution
bound to one verified read-only reply. The approved draft-PR workflow adds human
approval, pre-write intent, confirmed result, and recovery events; CI
observations remain read-only. `.shipmates/` is local operational state and must
not contain credentials or replace GitHub as the authority for remote
repository facts.

The Herdr adapter reads the replaceable task snapshot and creates an ephemeral
operator projection. It never writes a status event back into the ledger; see
the [Herdr status guide](herdr-status.md).
