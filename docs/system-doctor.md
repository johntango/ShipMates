# Read-only system doctor

`shipmates doctor` observes ShipMates' split durable and external state without
repairing, reconciling, dispatching, retrying, or writing anything. It compares
the Project registry and task event ledgers with process existence, Treehouse
leases, Git HEADs, validation records, and registered destination repositories.

Run it from the ShipMates checkout after installing the package, or through the
repository script:

```sh
shipmates doctor
npm run doctor
shipmates doctor --project TestA
shipmates doctor --task task-abc123 --json
```

`--project` accepts one exact Project ID, name, repository identity, or
registered path. `--task` accepts one exact plan-task ID, title, current task ID,
or historical attempt ID. The filters may be combined. `--json` emits the
versioned structured report; the default view is bounded operator text. Ledgers
that are not attached to a Project attempt are outside a Project-scoped doctor
audit and are not assumed to be erroneous merely because they are standalone.

The report always includes `readOnly: true`, the applied filters, a summary,
bounded Project/task observations, and findings. Findings are classified as:

- `violation`: durable or observed facts contradict an invariant;
- `uncertainty`: an external action or fact cannot be proven safely;
- `stale_projection`: derived Project state has not caught up with authoritative
  ledger or destination evidence.

Every finding includes one recommended operation and either an executable,
read-only inspection command or a concrete manual-repair instruction naming the
affected path, task, and safety constraints. Doctor never invokes recovery
operations.

Exit status is `0` for a clean report, `1` when findings exist, and `2` for
invalid filters, malformed options, or an inspection setup failure. A nonzero
status never means doctor attempted a repair.

The structured report deliberately excludes raw worker briefs, model prose,
and full event histories. Durable ledgers remain authoritative; doctor exposes
only bounded state, HEAD, validation, process, and lease facts needed to explain
the finding and recovery operation. Arrays for projects, tasks, attempts,
Treehouse entries, Git changes, workers, and findings have deterministic limits.
Their adjacent `truncation` metadata reports the limit, total, omitted count, and
whether truncation occurred; a report with an incomplete inspection is not clean.
Worktree records on completed tasks are retained as authoritative history, not
treated as active leases to compare with current Treehouse or Git state.
