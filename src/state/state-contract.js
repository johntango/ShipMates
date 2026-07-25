export const STATE_CONTRACT = Object.freeze({
  schemaVersion: 1,
  authorities: Object.freeze({
    taskLedger: "task execution history and external-operation evidence",
    projectRegistry: "plan structure, repository identity, task-attempt relationships, and Project status",
    externalSystems: "process existence, Git state, worktree leases, validation service state, and GitHub state",
  }),
  projections: Object.freeze([
    "tasks/*/snapshot.json", "active-project.json", "dashboard HTML/JSON", "Herdr metadata",
  ]),
  projectRegistry: Object.freeze({
    schemaVersion: 1,
    documentFields: Object.freeze(["schemaVersion", "activeProjectId", "projects", "repositoryDeletionReceipts"]),
    projectFields: Object.freeze([
      "id", "name", "repo", "repoPath", "baseSha", "objective", "status", "tasks",
      "executionPolicy", "demoMode", "protected", "archiveReceipt", "createdAt", "updatedAt",
    ]),
    taskFields: Object.freeze([
      "id", "title", "description", "status", "dependsOn", "taskId", "previousTaskIds",
      "attempts", "blockingReason",
    ]),
    attemptFields: Object.freeze([
      "taskId", "status", "startedAt", "completedAt", "blockingReason", "launchReceipt",
    ]),
    launchReceiptFields: Object.freeze(["kind", "pid", "paneId", "launchedAt"]),
  }),
  taskLedger: Object.freeze({
    eventEnvelopeFields: Object.freeze(["id", "taskId", "type", "at", "actor", "data"]),
    snapshotSchemaVersion: 1,
    snapshotFields: Object.freeze([
      "schemaVersion", "id", "kind", "state", "repo", "baseSha", "worktree", "workers",
      "eventsCount", "lastEventId", "lastEventAt", "evidence", "approvals", "githubObservations",
      "githubDraftPrApprovals", "githubDraftPullRequests", "githubMergeApprovals", "githubMerges",
      "postMergeAssurances", "gitCommits", "gitPushApprovals", "gitPushes",
      "branchCleanupApprovals", "branchCleanups", "validationRequests", "validationRuns",
      "recoveryAudits", "firstmateRuns", "scoutSyntheses", "scoutFollowUps",
    ]),
    eventTypes: Object.freeze([
      "task.created", "task.transitioned", "task.evidence.recorded", "task.approval.recorded",
      "github.status.recorded", "github.merge.approved", "github.merge.requested",
      "github.merge.completed", "github.post_merge.verified", "github.merge.failed",
      "github.draft_pr.approved", "github.draft_pr.create.requested",
      "github.draft_pr.create.completed", "github.draft_pr.create.failed", "git.push.approved",
      "git.push.requested", "git.push.completed", "git.push.failed", "git.branch_cleanup.approved",
      "git.branch_cleanup.requested", "git.branch_cleanup.completed", "git.branch_cleanup.failed",
      "git.commit.requested", "git.commit.completed", "validation.local.requested",
      "validation.local.recorded", "validation.local.reconciled", "recovery.audit.recorded",
      "firstmate.run.requested", "firstmate.run.classified", "firstmate.run.failed",
      "worktree.lease.requested", "worktree.branch.requested", "worktree.branch.prepared",
      "worktree.leased", "worktree.proof.recorded", "worktree.return.requested", "worktree.returned",
      "worker.dispatch.requested", "worker.started", "worker.report.recorded", "worker.failed",
      "scout.synthesis.recorded", "scout.follow_up.selected", "worker.reply.requested",
      "worker.reply.completed", "worker.reply.failed", "scout.follow_up.resolved",
    ]),
  }),
  activePointer: Object.freeze({
    schemaVersion: 1, fields: Object.freeze(["schemaVersion", "taskId", "updatedAt"]),
  }),
  migrations: Object.freeze([
    "Project tasks without attempts[] migrate previousTaskIds and taskId into attempt history during registry read.",
    "Missing repositoryDeletionReceipts migrates to an empty array during registry read.",
    "Task snapshots are disposable and rebuild from the complete JSONL event ledger.",
    "Invalid, missing, stale, or completed active pointers derive to no active task; they never restore authority.",
  ]),
});
