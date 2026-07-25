# Derived observability

Herdr and the dashboard consume the same `projectOperationalState` view. It is
rebuilt from the authoritative task ledger, optional fresh observations, and the
central reconciliation engine. The view includes the exact ledger watermark,
lifecycle state, sanitized live observations, precise blocker, recovery
decision, validated commit, and delivery destination.

The projector has no write capability and cannot turn process state, pane
metadata, dashboard selection, report prose, or a stale snapshot field into
lifecycle truth. Unknown observation fields are discarded. Prompts, tokens, and
raw reports are never copied. An unchanged ledger and unchanged observations
produce the same operational fields.

UI-only selection remains a compatibility hint for navigation while clients are
migrated; it is not consulted by the operational projector, reconciliation
engine, supervisor, or typed command handlers and may be deleted and rebuilt
without changing lifecycle behavior.
