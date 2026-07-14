import assert from "node:assert/strict";
import test from "node:test";

import { RestartReconciler } from "../src/workflows/restart-reconciliation.js";

const HEAD = "a".repeat(40);
const NOW = new Date("2026-07-13T20:00:00.000Z");

test("records a safe audit when applicable durable and live state agree", async () => {
  const store = new MemoryStore(baseSnapshot());
  const reconciler = new RestartReconciler({
    store,
    actor: "firstmate",
    clock: () => NOW,
  });

  const result = await reconciler.audit({ taskId: "recovery-001", auditId: "restart-001" });

  assert.equal(result.report.safeToResume, true);
  assert.deepEqual(result.report.recommendedActions, []);
  assert.deepEqual(
    result.report.checks.map(({ kind, status }) => ({ kind, status })),
    [
      { kind: "ledger", status: "pass" },
      { kind: "worktree", status: "not_applicable" },
      { kind: "task-branch", status: "not_applicable" },
      { kind: "workers", status: "not_applicable" },
      { kind: "scout-follow-ups", status: "not_applicable" },
      { kind: "git-commit", status: "not_applicable" },
      { kind: "git-push", status: "not_applicable" },
      { kind: "validation", status: "not_applicable" },
      { kind: "github-draft-pr", status: "not_applicable" },
    { kind: "github-merge", status: "not_applicable" },
    { kind: "post-merge", status: "not_applicable" },
    { kind: "branch-cleanup", status: "not_applicable" },
    { kind: "github", status: "not_applicable" },
    ],
  );
});

test("requires read-only reconciliation for uncertain task-branch preparation", async () => {
  const snapshot = baseSnapshot();
  snapshot.kind = "firstmate-intake";
  snapshot.state = "running";
  snapshot.worktree = {
    status: "leased",
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/worktree",
    headSha: HEAD,
    branch: null,
    branchPreparation: {
      status: "requested",
      branch: "agent/recovery-001",
      expectedHeadSha: HEAD,
      expectedChangedPaths: [],
      requestEventId: "branch-request",
    },
  };
  const reconciler = new RestartReconciler({
    store: new MemoryStore(snapshot),
    treehouseManager: {
      async findWorktree() {
        return { state: "leased", leaseHolder: "recovery-001" };
      },
      async inspect() {
        return { headSha: HEAD, branch: "agent/recovery-001", dirty: false };
      },
    },
    clock: () => NOW,
  });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-task-branch",
  });

  assert.equal(result.report.safeToResume, false);
  assert.equal(
    result.report.checks.find(({ kind }) => kind === "task-branch").action,
    "reconcile_task_branch",
  );
});

test("repeating an audit id returns durable evidence without observing again", async () => {
  const snapshot = baseSnapshot();
  snapshot.recoveryAudits.push({ auditId: "restart-001" });
  const store = new MemoryStore(snapshot);
  const treehouseManager = {
    list: async () => {
      throw new Error("must not observe Treehouse again");
    },
  };
  const reconciler = new RestartReconciler({ store, treehouseManager });

  const result = await reconciler.audit({ taskId: "recovery-001", auditId: "restart-001" });

  assert.equal(result, snapshot);
  assert.equal(store.records.length, 0);
});

test("detects an unrecorded Treehouse lease without repeating acquisition", async () => {
  const snapshot = baseSnapshot();
  snapshot.worktree = {
    status: "lease_requested",
    repoPath: "/tmp/repo",
    worktreePath: null,
  };
  const store = new MemoryStore(snapshot);
  const treehouseManager = {
    list: async () => [{
      state: "leased",
      leaseHolder: "recovery-001",
      worktreePath: "/tmp/worktree",
    }],
  };
  const reconciler = new RestartReconciler({ store, treehouseManager, clock: () => NOW });

  const result = await reconciler.audit({ taskId: "recovery-001", auditId: "restart-lease" });

  assert.equal(result.report.safeToResume, false);
  assert.deepEqual(result.report.recommendedActions, ["reconcile_treehouse_acquisition"]);
});

test("detects a dirty leased worktree", async () => {
  const snapshot = baseSnapshot();
  snapshot.worktree = {
    status: "leased",
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/worktree",
    headSha: HEAD,
  };
  const store = new MemoryStore(snapshot);
  const treehouseManager = {
    findWorktree: async () => ({ state: "leased", leaseHolder: "recovery-001" }),
    inspect: async () => ({
      worktreePath: "/tmp/worktree",
      headSha: HEAD,
      dirty: true,
      changes: [" M src/file.js"],
    }),
  };
  const reconciler = new RestartReconciler({ store, treehouseManager, clock: () => NOW });

  const result = await reconciler.audit({ taskId: "recovery-001", auditId: "restart-dirty" });

  assert.equal(result.report.safeToResume, false);
  assert.match(
    result.report.checks.find(({ kind }) => kind === "git-worktree").detail,
    /dirty/u,
  );
});

test("accepts an exact independently verified uncommitted mutation", async () => {
  const snapshot = baseSnapshot();
  snapshot.state = "running";
  snapshot.worktree = {
    status: "leased",
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/worktree",
    headSha: HEAD,
  };
  snapshot.workers = [{
    id: "implementer",
    mode: "ship",
    status: "reported",
    threadId: "thread-ship",
    replies: [],
    verification: {
      kind: "workspace-write",
      headSha: HEAD,
      dirty: true,
      changedPaths: ["src/watch.js"],
    },
  }];
  const store = new MemoryStore(snapshot);
  const treehouseManager = {
    findWorktree: async () => ({ state: "leased", leaseHolder: "recovery-001" }),
    inspect: async () => ({
      worktreePath: "/tmp/worktree",
      headSha: HEAD,
      dirty: true,
      changes: [" M src/watch.js"],
    }),
    listChangedPaths: async () => ["src/watch.js"],
  };
  const reconciler = new RestartReconciler({
    store,
    treehouseManager,
    clock: () => NOW,
  });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-verified-mutation",
  });

  assert.equal(result.report.safeToResume, true);
  assert.equal(
    result.report.checks.find(({ kind }) => kind === "git-worktree").status,
    "pass",
  );
});

test("detects a moved GitHub PR head and does not read stale-head checks", async () => {
  const snapshot = baseSnapshot();
  snapshot.githubObservations = [githubObservation()];
  const store = new MemoryStore(snapshot);
  let checkReads = 0;
  const githubGateway = {
    readRepository: async () => ({
      nameWithOwner: "johntango/Shipmates-Practice",
      source: { kind: "github-rest", endpoint: "repo" },
    }),
    readPullRequest: async () => ({
      number: 2,
      state: "open",
      head: { sha: "b".repeat(40) },
      source: { kind: "github-rest", endpoint: "pr" },
    }),
    listCheckRuns: async () => {
      checkReads += 1;
      return [];
    },
  };
  const reconciler = new RestartReconciler({ store, githubGateway, clock: () => NOW });

  const result = await reconciler.audit({ taskId: "recovery-001", auditId: "restart-moved" });

  assert.equal(result.report.safeToResume, false);
  assert.equal(checkReads, 0);
  assert.deepEqual(result.report.recommendedActions, ["refresh_github_evidence_before_resuming"]);
});

test("accepts exact GitHub head, state, and successful required checks", async () => {
  const snapshot = baseSnapshot();
  snapshot.githubObservations = [githubObservation()];
  const store = new MemoryStore(snapshot);
  const githubGateway = exactGitHubGateway();
  const reconciler = new RestartReconciler({ store, githubGateway, clock: () => NOW });

  const result = await reconciler.audit({ taskId: "recovery-001", auditId: "restart-github" });

  assert.equal(result.report.safeToResume, true);
  assert.equal(
    result.report.checks.find(({ kind }) => kind === "github-pull-request").status,
    "pass",
  );
});

test("requires reconciliation for a worker with uncertain artifacts", async () => {
  const snapshot = baseSnapshot();
  snapshot.workers = [{ id: "scout-001", status: "started", threadId: "thread-1" }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({ taskId: "recovery-001", auditId: "restart-worker" });

  assert.equal(result.report.safeToResume, false);
  assert.deepEqual(result.report.recommendedActions, ["reconcile_worker_artifacts"]);
});

test("requires artifact reconciliation for an interrupted worker reply", async () => {
  const snapshot = baseSnapshot();
  snapshot.workers = [{
    id: "scout-001",
    status: "reported",
    threadId: "thread-1",
    replies: [{ id: "reply-001", status: "requested", threadId: "thread-1" }],
  }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-reply",
  });

  assert.equal(result.report.safeToResume, false);
  assert.deepEqual(result.report.recommendedActions, ["reconcile_worker_replies"]);
});

test("distinguishes a selected follow-up before reply intent", async () => {
  const snapshot = baseSnapshot();
  snapshot.scoutFollowUps = [{
    followUpId: "follow-up-001",
    status: "selected",
    workerId: "scout-001",
    replyId: "reply-001",
  }];
  snapshot.workers = [{
    id: "scout-001",
    status: "reported",
    threadId: "thread-1",
    replies: [],
  }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-follow-up",
  });

  assert.equal(result.report.safeToResume, false);
  assert.deepEqual(result.report.recommendedActions, ["resume_scout_follow_ups"]);
});

test("requires GitHub reconciliation for an interrupted draft PR write", async () => {
  const snapshot = baseSnapshot();
  snapshot.githubDraftPullRequests = [{
    operationId: "create-001",
    status: "requested",
    repository: "johntango/Shipmates-Practice",
    headBranch: "shipmates/task-001",
    headSha: "a".repeat(40),
  }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-draft-pr",
  });

  assert.equal(result.report.safeToResume, false);
  assert.deepEqual(result.report.recommendedActions, ["reconcile_draft_pr_create"]);
});

test("requires read-only reconciliation for an interrupted GitHub merge", async () => {
  const snapshot = baseSnapshot();
  snapshot.githubMerges = [{
    operationId: "merge-001",
    status: "requested",
    requestEventId: "merge-request",
  }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-merge",
  });

  assert.deepEqual(result.report.recommendedActions, ["reconcile_github_merge"]);
});

test("requires post-merge assurance after a confirmed landed merge", async () => {
  const snapshot = baseSnapshot();
  snapshot.state = "landed";
  snapshot.githubMerges = [{
    operationId: "merge-001",
    status: "completed",
    prNumber: 7,
    headSha: HEAD,
    completedEventId: "merge-completed",
    result: {
      mergeCommitSha: "c".repeat(40),
      baseHeadSha: "c".repeat(40),
    },
  }];
  const reconciler = new RestartReconciler({
    store: new MemoryStore(snapshot),
    clock: () => NOW,
  });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-post-merge",
  });

  assert.equal(result.report.safeToResume, false);
  assert.equal(
    result.report.checks.find(({ kind }) => kind === "post-merge").action,
    "complete_post_merge_assurance",
  );
});

test("requires read-only reconciliation for uncertain branch cleanup", async () => {
  const snapshot = baseSnapshot();
  snapshot.branchCleanups = [{
    operationId: "cleanup-001",
    status: "requested",
    branch: "task-branch",
    headSha: HEAD,
    requestEventId: "cleanup-request",
    result: null,
  }];
  const reconciler = new RestartReconciler({
    store: new MemoryStore(snapshot),
    clock: () => NOW,
  });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-cleanup",
  });

  assert.equal(result.report.safeToResume, false);
  assert.equal(
    result.report.checks.find(({ kind }) => kind === "branch-cleanup").action,
    "reconcile_branch_cleanup",
  );
});

test("requires read-only reconciliation for an interrupted controlled commit", async () => {
  const snapshot = baseSnapshot();
  snapshot.gitCommits = [{
    operationId: "commit-v1",
    status: "requested",
    requestEventId: "commit-request",
  }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-commit",
  });

  assert.deepEqual(result.report.recommendedActions, ["reconcile_git_commit"]);
});

test("requires read-only remote reconciliation for an interrupted exact-head push", async () => {
  const snapshot = baseSnapshot();
  snapshot.gitPushes = [{
    operationId: "push-001",
    status: "requested",
    requestEventId: "push-request",
  }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-push",
  });

  assert.deepEqual(result.report.recommendedActions, ["reconcile_git_push"]);
});

test("requires a new human approval after a proven absent push", async () => {
  const snapshot = baseSnapshot();
  snapshot.gitPushes = [{
    operationId: "push-001",
    status: "failed",
    failedEventId: "push-failed",
  }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-failed-push",
  });

  assert.deepEqual(
    result.report.recommendedActions,
    ["request_new_git_push_approval"],
  );
});

test("refuses to repeat local validation with durable intent and no result", async () => {
  const snapshot = baseSnapshot();
  snapshot.validationRequests = [{
    operationId: "validation-v1",
    status: "requested",
    requestEventId: "validation-request",
  }];
  const store = new MemoryStore(snapshot);
  const reconciler = new RestartReconciler({ store, clock: () => NOW });

  const result = await reconciler.audit({
    taskId: "recovery-001",
    auditId: "restart-validation",
  });

  assert.deepEqual(
    result.report.recommendedActions,
    ["reconcile_local_validation_manually"],
  );
});

class MemoryStore {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.records = [];
  }

  async getSnapshot() {
    return this.snapshot;
  }

  async recordRecoveryAudit(record) {
    this.records.push(record);
    return { report: record.report };
  }
}

function baseSnapshot() {
  return {
    id: "recovery-001",
    repo: "johntango/Shipmates-Practice",
    state: "proposed",
    eventsCount: 1,
    lastEventId: "created-1",
    worktree: null,
    workers: [],
    validationRuns: [],
    githubObservations: [],
    recoveryAudits: [],
  };
}

function githubObservation() {
  return {
    pullRequest: {
      number: 2,
      state: "open",
      head: { sha: HEAD },
    },
    requiredChecks: { names: ["test"] },
  };
}

function exactGitHubGateway() {
  return {
    readRepository: async () => ({
      nameWithOwner: "johntango/Shipmates-Practice",
      source: { kind: "github-rest", endpoint: "repo" },
    }),
    readPullRequest: async () => ({
      number: 2,
      state: "open",
      head: { sha: HEAD },
      source: { kind: "github-rest", endpoint: "pr" },
    }),
    listCheckRuns: async () => [{
      name: "test",
      status: "completed",
      conclusion: "success",
    }],
  };
}
