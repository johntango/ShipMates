# Human-selected scout follow-ups

`ScoutFollowUpWorkflow` binds one human-selected check from a durable two-scout
synthesis to one existing verified scout thread. It continues that thread only
through the crash-safe, read-only Codex MCP reply path and records the verified
result without granting edit or GitHub authority.

## Selection boundary

Selection requires `SHIPMATES_HUMAN_ACTOR`; Firstmate cannot silently choose a
check on the human's behalf. The selected ledger event binds:

- the synthesis event and artifact SHA-256;
- the exact leased repository SHA;
- the zero-based check index and canonical check digest;
- one worker from the synthesis and its immutable reply ID;
- the canonical follow-up prompt digest.

The raw target, prompt, and reply report remain in their existing protected
artifacts. Herdr receives only binding, lifecycle, outcome, and count metadata.

## Read-only execution and recovery

The task must still be `running` with the matching active, clean Treehouse
lease. The selected worker must be a terminal, independently verified,
read-only source of the synthesis. Its continuation fixes the existing thread,
worktree, `read-only` sandbox, and `never` approval policy.

Selection is recorded before the MCP call. The existing worker-reply protocol
then records its own intent before invoking `codex-reply`. A completed reply is
accepted only after an independent no-mutation inspection at the selected SHA.
The final follow-up event binds the reply event and report digest.

If execution is interrupted after reply intent, do not run the selection again
blindly. Reconcile the durable reply artifact:

```sh
npm run scout:follow-up -- reconcile TASK_ID FOLLOW_UP_ID
```

If selection was recorded but reply intent was not, repeating `run` with the
identical binding is safe. Reusing an ID with different input is rejected.

## Command

List the synthesis artifact's zero-based `followUpChecks` entries, choose one,
and continue either source worker:

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run scout:follow-up -- run \
  TASK_ID SYNTHESIS_ID FOLLOW_UP_ID CHECK_INDEX WORKER_ID REPLY_ID
```

The command reports sanitized durable metadata. It does not print the selected
target, prompt, or worker-report prose.
