# Firstmate orchestration boundaries

Firstmate keeps one durable task lifecycle while allowing different execution
backends and policies. The interactive shell accepts input and reports results;
workflow modules own state changes and recovery decisions.

## Authority-aware dispatch

Conversational dispatch carries one explicit authority classification. A
bounded `read_only` inspection needs no plan approval and always uses the
standard worker backend, including when a persistent project is selected. It
does not create a project-plan attempt.

Before launch, Firstmate records a durable inspection task and dispatch intent
under the global read-only dispatch lock. It records the exact process receipt
after launch and refuses another read-only inspection while an earlier intent
has no terminal evidence. On restart, Firstmate reconciles that intent against
durable execution evidence and the identity-bound live-process receipt. A live
worker is monitored rather than relaunched; a stopped worker is terminalized so
an explicit retry can create a new request. Process disappearance alone never
claims successful inspection.

`local_write` dispatch remains restricted to an approved project and its
governed, claimed plan item. `external_write`, `destructive`, missing, and
unrecognized authority classifications are refused at this boundary and must
use their separate approval workflows. The child worker verifies that its
classification matches the authority Firstmate authorized, so a read-only
request cannot be reclassified into implementation after launch.

## Planned dispatch

`PlannedTaskDispatcher` is the only planned-task dispatch boundary. It selects
the target project, claims one dependency-ready plan item, invokes the governed
dispatcher, and verifies that a durable task ID was attached before reporting
success. A dispatch that returns without attachment is recorded as blocked.

Blocked retries use the same boundary. `retryBlocked` preserves the previous
attempt, resets exactly the requested plan item, claims that item, and requires
a new durable task ID. Dashboard, automatic, and conversational planned work
must not reimplement this sequence.

Approved standard tasks cross the process boundary through a durable typed
governed-execution envelope. The envelope binds the project, planned task,
durable task and request IDs, repository revision, exact instruction, and
authority. The child verifies that binding against the approved project and
current dispatched attempt before doing any work. It does not re-enter the
interactive command parser or ask a second model to classify already-approved
work. Child stderr is retained beside the envelope for diagnostics rather than
streamed into the normal human summary.

Simple governed implementation tasks start one bounded Implementer directly;
the Implementer must inspect before editing. Independent Scouts remain the
execution path for read-only work and remain available where a workflow
explicitly requests separate preflight perspectives.

Each planned task records whether it is a read-only inspection or a local
implementation. Approved read-only plan items are claimed and launch as tracked
Scout attempts without acquiring a write-capable Treehouse lease. Local-write
items retain the approved-plan and isolated-worktree requirements.

## Status and reconciliation

The task ledger is authoritative execution state. Project task status is a
human-facing projection maintained by `ProjectOrchestrator.reconcileTask` and
`reconcileProject`. The [central reconciliation engine](reconciliation-engine.md)
owns the bounded decisions shared by commands, project reconciliation,
monitoring, and dashboard projections. Process exits remain observations, not
independent evidence of completion.

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
Read-only inspections always use the standard backend and the durable tracking
contract above rather than a persistent project worktree.

## Dashboard acknowledgement

Project actions wait for their workflow result. A successful dispatch or retry
includes a durable task ID and `dispatched` status. Accepting an HTTP request is
not evidence that a task was created.
