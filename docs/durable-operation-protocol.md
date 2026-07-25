# Durable external-operation protocol

Every external mutation must use the same lifecycle: persist exact intent,
observe the target, perform the action only when observation proves it absent,
observe again, and persist a receipt. Operation IDs are immutable bindings to
their target and inputs; reusing an ID with different intent fails closed.

`DurableOperationProtocol` implements this policy against an atomic journal
interface. A workflow supplies `read`, `recordIntent`, `recordAttempt`, and
`recordReceipt` methods plus operation-specific `observe` and `act` functions.
Existing receipts return immediately. An intent without a receipt is always
observed before action. For that action to be safe, `completed: false` must
prove the exact intended effect is absent; `completed: true` must include
evidence for the exact result. An action that cannot provide that independent
observation never receives a success receipt.

The [lifecycle failure harness guide](lifecycle-failure-harness.md) describes the
exhaustive crash-boundary exercise. The [task ledger guide](task-ledger.md)
owns the compatibility path for existing typed workflow events.
