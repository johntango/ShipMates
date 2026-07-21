# Firstmate orchestration boundaries

Firstmate keeps one durable task lifecycle while allowing different execution
backends and policies. The interactive shell accepts input and reports results;
workflow modules own state changes and recovery decisions.

## Planned dispatch

`PlannedTaskDispatcher` is the only planned-task dispatch boundary. It selects
the target project, claims one dependency-ready plan item, invokes the governed
dispatcher, and verifies that a durable task ID was attached before reporting
success. A dispatch that returns without attachment is recorded as blocked.

Blocked retries use the same boundary. `retryBlocked` preserves the previous
attempt, resets exactly the requested plan item, claims that item, and requires
a new durable task ID. Dashboard, automatic, and conversational planned work
must not reimplement this sequence.

## Status and reconciliation

The task ledger is authoritative execution state. Project task status is a
human-facing projection maintained by `ProjectOrchestrator.reconcileTask` and
`reconcileProject`. Process exits and restart monitoring reconcile ledger
evidence rather than independently guessing completion from exit codes.

## Progress

`TaskProgressRecorder` writes bounded `task-progress` evidence with a common
shape:

```json
{
  "phase": "validation",
  "step": "test",
  "message": "Running tests",
  "status": "running",
  "sequence": 3,
  "operationId": "optional-operation-binding"
}
```

The dashboard orders progress by sequence and retains only the latest bounded
window in its projection. Progress is informational; terminal workflow events
remain the authority for success, failure, and approval gates.

## Execution backends

`ProjectExecutionBackendRouter` exposes one `dispatch(input)` contract.
Standard tasks launch the ordinary Firstmate worker process. Persistent projects
launch through their Project Agent pane when available, otherwise through the
persistent worker process. Backend selection does not change planned-task
claiming, durable attachment, status reconciliation, or progress semantics.

## Dashboard acknowledgement

Project actions wait for their workflow result. A successful dispatch or retry
includes a durable task ID and `dispatched` status. Accepting an HTTP request is
not evidence that a task was created.
