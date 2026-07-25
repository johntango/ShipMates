# Lifecycle v2 migration

Lifecycle v2 separates three concepts that legacy snapshots mix together:

- one lifecycle state with an explicit owner and terminal flag;
- an ordered attempt history, where retries create attempts rather than new
  lifecycle meanings;
- independent external operations with their own status and terminal flag.

The only terminal lifecycle states are `complete`, `failed`, and `cancelled`;
they have no owner. Active states belong to the supervisor, human, or delivery
boundary. Blocked and recovery-required work belongs to a human until an
explicit typed command changes the authoritative ledger.

`migrateLifecycleRecords` replays every authoritative task event ledger and
reads its Project attempt history at the resulting exact event ID and event-count
watermark. It creates a schema-version 2 record and passes it to an injected
durable writer. Unknown lifecycle states fail closed. Only allowlisted
lifecycle, attempt, and operation fields are emitted, so legacy compatibility
and UI fields are not copied. Migration is deterministic and can be rerun before
consumers switch; removal of old snapshot fields occurs only after all consumers
read v2 and the invariant checker confirms equivalent live records.
