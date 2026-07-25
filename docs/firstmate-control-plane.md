# Deterministic Firstmate control plane

Natural language can select a command, but it cannot name or perform a lifecycle
transition. `FirstmateControlPlane` accepts only the closed typed vocabulary for
project creation, approval and advancement; task inspection and reconciliation;
validation approval; delivery retry; archive; and repository purge.

Each command validates its required bounded string inputs before invoking a
deterministic handler. The handler owns stable-identifier validation,
authoritative reads, invariant checks, reconciliation, and any durable operation
protocol. Unknown commands, missing inputs, and absent handlers fail closed. A
refusal always identifies the failed invariant, its reason, and the next
operator action as structured data suitable for the shell, dashboard, and Herdr.

`selectFirstmateCommand` is deliberately only a selector. It may map prose to a
typed command and extract an identifier; it cannot request arbitrary states or
execute a transition. The remaining conversational command branches should be
migrated behind injected handlers before their legacy parsers are removed.
`ProjectOrchestrator` already exposes typed task inspection and reconciliation
through this control plane; those handlers share the central reconciliation
engine used by startup and monitoring.
