# Durable external-operation protocol

Every external mutation must use the same lifecycle: persist exact intent,
observe the target, perform the action only when observation proves it absent,
observe again, and persist a receipt. Operation IDs are immutable bindings to
their target and inputs; reusing an ID with different intent fails closed.

`DurableOperationProtocol` implements this policy against an atomic journal
interface. A workflow supplies four idempotent journal methods plus operation-
specific `observe` and `act` functions. Existing receipts return immediately.
An intent without a receipt is always observed before action, and an action that
cannot be independently observed never receives a success receipt.

The lifecycle failure harness now uses this production protocol for its clone,
artifact, commit, fetch, and merge effects and injects termination on both sides
of every boundary. Task-ledger workflows should expose their existing typed
request/result events through the same journal interface as they are migrated;
their current explicit reconciliation commands remain the safe compatibility
path until that adapter is installed.
