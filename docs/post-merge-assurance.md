# Post-merge assurance and Treehouse return

`landed` means GitHub confirmed the exact approved head was squash-merged and
the default branch pointed to the returned merge commit at that instant. It
does not yet authorize cleanup. The post-merge workflow independently proves
the merge commit is healthy and contains exactly the approved task tree before
returning the Treehouse lease.

## Complete the landed task

```sh
npm run firstmate:delivery -- \
  post-merge TASK_ID POST_MERGE_OPERATION_ID
```

The operation derives every target from the ledger. It accepts no repository,
branch, PR, SHA, check-name, worktree, or proof argument from the operator.

The workflow:

1. loads the completed exact-head merge and its bound pre-merge status event;
2. re-reads the repository, merged PR, current default branch, branch policy,
   check runs, and workflow runs;
3. requires the PR to retain the approved head and confirmed merge commit;
4. requires the default branch to still equal that merge commit;
5. unions current protected check names with the pre-merge required names and
   requires every one to pass on the merge commit itself;
6. records immutable post-merge evidence in the task ledger;
7. fetches only the confirmed full merge commit into the leased repository;
8. independently compares the approved commit tree with the squash-merge tree;
9. records the exact tree SHA and its assurance-event binding;
10. revalidates the unchanged clean leased worktree, records return intent,
    returns the Treehouse lease, and advances the task to `complete`.

An advanced default branch is refused deliberately, even if the approved work
may still be present. Patch-based or ancestry-aware reconciliation would be a
different, more permissive contract.

## Pending checks and safe retries

Pending, missing, failed, or ambiguous merge-commit checks do not write an
assurance event and do not start cleanup. The same command may be run later
with the same operation ID because GitHub observation and exact-commit fetch
are read-only or safely repeatable.

Once `worktree.return.requested` is durable, the return result is uncertain and
the post-merge command will not invoke Treehouse again. Reconcile by observation:

```sh
npm run firstmate:delivery -- reconcile-return TASK_ID
```

Reconciliation records success only when Treehouse reports the exact slot as
`available` with no holder. A still-leased or differently held slot remains a
manual recovery condition.

Branch deletion is not part of this workflow. Returning local execution
authority and deleting a remote task branch are intentionally separate
capabilities.

## Durable evidence

`github.post_merge.verified` binds the operation, completed merge operation,
repository, PR, approved head, merge commit, default branch/head, live policy,
merge-commit checks, and workflow runs. `worktree.proof.recorded` then binds its
`exact-tree-landing` proof to that assurance event. Existing
`worktree.return.requested` and `worktree.returned` events preserve the external
mutation crash boundary.
