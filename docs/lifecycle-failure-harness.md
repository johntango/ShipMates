# Lifecycle failure harness

The lifecycle failure harness exercises a complete disposable local Project:

```text
register → plan → approve → dispatch → report → commit → validate
         → approve validation → deliver → complete
```

Each operation records durable intent, performs or independently observes its
external action, then records an observation receipt. Clone, artifact, commit,
fetch, and merge effects use the production
[durable operation protocol](durable-operation-protocol.md). The test injector
can terminate immediately before or after intent, action, and receipt
boundaries. On restart, the harness reads the same Project registry, task event
ledger, Git repositories, and external artifacts. It observes uncertain actions
before repetition and finishes the existing attempt.

The exhaustive boundary test creates a fresh disposable Git destination and
source for every termination point. Completion asserts exactly one Project task
attempt, worker report, implementation commit, validation result, approval, and
delivery, with the destination at the exact validated source commit. It also
requires every operation and external action to retain both intent and receipt
after recovery.

This is the failure-harness skeleton for the reliability milestone. Its stable
boundary vocabulary accepts further production workflow adapters; it does not
grant the harness authority over live `.shipmates` state.
