# Central reconciliation engine

ShipMates uses one deterministic reconciliation planner for startup, periodic
monitoring, operator commands, and dashboard projections. Every caller supplies
the same authoritative task snapshot plus any fresh external observations. The
planner compares that evidence without performing an external mutation and
returns exactly one bounded decision:

`no_action`, `record_observed_completion`, `resume_existing_validation`,
`retry_delivery`, `mark_worker_lost`, `return_verified_lease`,
`request_human_approval`, or `require_manual_repair`.

Each result includes its reason, whether it is safe to apply, the caller surface,
and the exact task-ledger watermark that was observed. A missing process
observation never becomes permission to relaunch a worker. A lease is returned
only after Treehouse state independently proves it available, and pending
delivery intent resumes the existing operation rather than creating a second
one.

`ProjectOrchestrator` applies the planner's registry and approval decisions.
Startup audits, the serialized monitor, and task reconciliation commands already
enter through that orchestrator. The dashboard calls the same planner read-only
and exposes its result with each task instead of deriving a separate recovery
policy.
