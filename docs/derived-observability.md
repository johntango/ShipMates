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

UI-only selection is in-memory reconnectable client state. The obsolete
`active-project.json` file is ignored and may be removed without changing
lifecycle behavior.
