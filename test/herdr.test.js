import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HerdrProjection,
  projectHerdrSnapshot,
  renderHerdrView,
} from "../src/projections/herdr.js";
import { TaskStore } from "../src/storage/task-store.js";

test("projects deterministic monitoring state without prompt or report content", () => {
  const source = richSnapshot();
  const before = structuredClone(source);

  const first = projectHerdrSnapshot(source);
  const second = projectHerdrSnapshot(source);

  assert.deepEqual(first, second);
  assert.deepEqual(source, before);
  assert.equal(first.task.displayState, "working");
  assert.equal(first.summary.pendingReplies, 1);
  assert.equal(first.summary.pendingDraftPullRequests, 1);
  assert.deepEqual(first.attention.map(({ code }) => code), [
    "reply_reconciliation",
    "draft_pr_reconciliation",
    "validation_not_passing",
    "ci_not_satisfied",
    "recovery_required",
  ]);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /SECRET BRIEF|SECRET REPORT|SECRET BODY/u);
  assert.equal(first.workers[0].threadId, "thread-001");
  assert.equal(first.workers[0].paneId, "w1:p2");
  assert.equal(first.commits[0].headSha, "a".repeat(40));
  assert.equal(first.commits[0].changedPaths, 1);
});

test("reads a real task without changing authoritative or snapshot bytes", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "herdr-readonly-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({
    taskId: "herdr-readonly-001",
    kind: "status",
    repo: "johntango/Shipmates-Practice",
    baseSha: "a".repeat(40),
    actor: "firstmate",
    eventId: "created",
    at: "2026-07-13T23:00:00.000Z",
  });
  const taskDirectory = path.join(rootDir, "tasks", "herdr-readonly-001");
  const eventsPath = path.join(taskDirectory, "events.jsonl");
  const snapshotPath = path.join(taskDirectory, "snapshot.json");
  const beforeEvents = await readFile(eventsPath);
  const beforeSnapshot = await readFile(snapshotPath);

  const projection = await new HerdrProjection({ store }).read({
    taskId: "herdr-readonly-001",
  });

  assert.equal(projection.task.state, "proposed");
  assert.deepEqual(await readFile(eventsPath), beforeEvents);
  assert.deepEqual(await readFile(snapshotPath), beforeSnapshot);
});

test("requires only getSnapshot and renders a compact control-safe view", async () => {
  let reads = 0;
  const source = richSnapshot();
  source.repo = "owner/repo\nforged-line";
  const store = new Proxy({
    async getSnapshot() {
      reads += 1;
      return source;
    },
  }, {
    get(target, property, receiver) {
      if (property !== "getSnapshot") {
        throw new Error(`unexpected store capability: ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const projection = await new HerdrProjection({ store }).read({ taskId: source.id });
  const view = renderHerdrView(projection);

  assert.equal(reads, 1);
  assert.match(view, /workers: 1 \(0 active, 1 replies pending\)/u);
  assert.match(view, /reply reply-001: requested/u);
  assert.doesNotMatch(view, /repo\nforged/u);
  assert.match(view, /owner\/repo\?forged-line/u);
});

test("projects synthesis metadata without report prose", () => {
  const snapshot = richSnapshot();
  snapshot.scoutSyntheses = [{
    synthesisId: "pair-review-v1",
    eventId: "synthesis-event",
    workerIds: ["worker-reported", "worker-active"],
    leaseHeadSha: "a".repeat(40),
    artifactSha256: "b".repeat(64),
    artifactPath: "tasks/herdr-task-001/syntheses/pair-review-v1.json",
    sourceReportEventIds: ["report-a", "report-b"],
    outcome: "review_required",
    counts: {
      agreements: 3,
      disagreements: 1,
      unsupportedClaims: 2,
      followUpChecks: 3,
    },
    actor: "firstmate",
    at: "2026-07-13T10:00:00.000Z",
  }];

  const projection = projectHerdrSnapshot(snapshot);
  const rendered = renderHerdrView(projection);

  assert.equal(projection.summary.syntheses, 1);
  assert.equal(projection.syntheses[0].outcome, "review_required");
  assert.equal(projection.attention.some(({ code }) =>
    code === "scout_synthesis_review"), true);
  assert.match(rendered, /pair-review-v1: review_required/u);
  assert.doesNotMatch(JSON.stringify(projection), /secret report prose/u);
});

test("marks a prior safe recovery audit stale after new evidence", () => {
  const snapshot = richSnapshot();
  snapshot.recoveryAudits[0].safeToResume = true;
  snapshot.recoveryAudits[0].recommendedActions = [];
  snapshot.recoveryAudits[0].eventId = "event-019";

  const projection = projectHerdrSnapshot(snapshot);

  assert.equal(projection.recovery.current, false);
  assert.equal(projection.attention.some(({ code }) =>
    code === "recovery_audit_stale"), true);
  assert.match(renderHerdrView(projection), /recovery: stale/u);
});

test("shows exact-head push approval and remote reconciliation states", () => {
  const awaitingApproval = richSnapshot();
  awaitingApproval.validationRuns[0].passed = true;
  awaitingApproval.validationRuns[0].outcome = "passed";
  awaitingApproval.githubDraftPullRequests = [];
  awaitingApproval.githubObservations = [];
  awaitingApproval.gitPushApprovals = [{
    approvalId: "push-approval-001",
    actor: "john",
    repository: awaitingApproval.repo,
    branch: awaitingApproval.worktree.branch,
    headSha: awaitingApproval.worktree.headSha,
    decision: "approved",
    consumedBy: null,
  }];
  awaitingApproval.gitPushes = [];

  const approvalProjection = projectHerdrSnapshot(awaitingApproval);
  assert.equal(
    approvalProjection.attention.some(({ code }) => code === "git_push_approval"),
    true,
  );
  assert.equal(approvalProjection.approvals.push[0].consumedBy, null);

  awaitingApproval.gitPushApprovals[0].consumedBy = "push-001";
  awaitingApproval.gitPushes = [{
    operationId: "push-001",
    approvalId: "push-approval-001",
    status: "requested",
    repository: awaitingApproval.repo,
    branch: awaitingApproval.worktree.branch,
    headSha: awaitingApproval.worktree.headSha,
    result: null,
    failure: null,
    requestEventId: "push-request",
  }];
  const recoveryProjection = projectHerdrSnapshot(awaitingApproval);

  assert.equal(recoveryProjection.summary.pendingPushes, 1);
  assert.equal(
    recoveryProjection.attention.some(
      ({ code }) => code === "git_push_reconciliation",
    ),
    true,
  );
  assert.match(renderHerdrView(recoveryProjection), /push-001: requested/u);
});

test("shows the separate draft approval and exact-head CI delivery stages", () => {
  const snapshot = richSnapshot();
  snapshot.validationRuns[0].passed = true;
  snapshot.validationRuns[0].outcome = "passed";
  snapshot.gitPushes = [{
    operationId: "push-001",
    approvalId: "push-approval-001",
    status: "completed",
    repository: snapshot.repo,
    branch: snapshot.worktree.branch,
    headSha: snapshot.worktree.headSha,
    result: { remoteHeadSha: snapshot.worktree.headSha },
    failure: null,
    requestEventId: "push-request",
    completedEventId: "push-completed",
  }];
  snapshot.githubDraftPullRequests = [];
  snapshot.githubObservations = [];

  const awaitingApproval = projectHerdrSnapshot(snapshot);
  assert.equal(
    awaitingApproval.attention.some(({ code }) => code === "draft_pr_approval"),
    true,
  );

  snapshot.githubDraftPullRequests = [{
    operationId: "draft-001",
    approvalId: "draft-approval-001",
    status: "completed",
    repository: snapshot.repo,
    headBranch: snapshot.worktree.branch,
    headSha: snapshot.worktree.headSha,
    baseBranch: "main",
    failure: null,
    pullRequest: {
      number: 7,
      url: "https://github.com/johntango/Shipmates-Practice/pull/7",
      state: "open",
      draft: true,
      head: { sha: snapshot.worktree.headSha },
    },
  }];
  const awaitingCi = projectHerdrSnapshot(snapshot);
  assert.equal(
    awaitingCi.attention.some(({ code }) => code === "ci_observation_required"),
    true,
  );
});

test("shows merge approval, uncertain merge, and landed verification stages", () => {
  const snapshot = richSnapshot();
  const headSha = snapshot.worktree.headSha;
  snapshot.validationRuns[0] = {
    ...snapshot.validationRuns[0], passed: true, outcome: "passed",
  };
  snapshot.gitPushes = [{
    operationId: "push-001", approvalId: "push-approval-001", status: "completed",
    repository: snapshot.repo, branch: snapshot.worktree.branch, headSha,
    result: { remoteHeadSha: headSha }, failure: null,
    requestEventId: "push-request", completedEventId: "push-completed",
  }];
  snapshot.githubDraftPullRequests = [{
    operationId: "draft-001", approvalId: "draft-approval-001", status: "completed",
    repository: snapshot.repo, headBranch: snapshot.worktree.branch, headSha,
    baseBranch: "main", failure: null,
    pullRequest: {
      number: 7,
      url: "https://github.com/johntango/Shipmates-Practice/pull/7",
      state: "open",
      draft: false,
      head: { sha: headSha },
    },
  }];
  snapshot.githubObservations = [{
    observedAt: "2026-07-13T23:02:00.000Z",
    pullRequest: { number: 7, draft: false, head: { sha: headSha } },
    requiredChecks: {
      names: ["test"], missing: [], unsuccessful: [], satisfied: true,
    },
    checks: [],
  }];
  snapshot.githubMergeApprovals = [];
  snapshot.githubMerges = [];

  assert.equal(
    projectHerdrSnapshot(snapshot).attention.some(({ code }) => code === "merge_approval"),
    true,
  );

  snapshot.githubMerges = [{
    operationId: "merge-001", approvalId: "merge-approval-001", status: "requested",
    repository: snapshot.repo, prNumber: 7, headSha, mergeMethod: "squash",
    failure: null, result: null, requestEventId: "merge-request",
  }];
  const uncertain = projectHerdrSnapshot(snapshot);
  assert.equal(
    uncertain.attention.some(({ code }) => code === "merge_reconciliation"),
    true,
  );
  assert.match(renderHerdrView(uncertain), /merge-001: requested/u);

  snapshot.githubMerges[0] = {
    ...snapshot.githubMerges[0],
    status: "completed",
    result: { mergeCommitSha: "c".repeat(40) },
    completedEventId: "merge-completed",
  };
  assert.equal(
    projectHerdrSnapshot(snapshot).attention.some(
      ({ code }) => code === "post_merge_verification",
    ),
    true,
  );

  snapshot.postMergeAssurances = [{
    operationId: "assurance-001",
    mergeOperationId: "merge-001",
    mergeCommitSha: "c".repeat(40),
    observedAt: "2026-07-14T00:00:00.000Z",
    requiredChecks: {
      names: ["test"], missing: [], unsuccessful: [], satisfied: true,
    },
  }];
  assert.equal(
    projectHerdrSnapshot(snapshot).attention.some(
      ({ code }) => code === "exact_tree_verification",
    ),
    true,
  );
  snapshot.worktree.proof = {
    kind: "exact-tree-landing",
    eventId: "tree-proof",
  };
  snapshot.worktree.status = "returned";
  snapshot.state = "complete";
  const complete = projectHerdrSnapshot(snapshot);
  assert.equal(complete.attention.some(({ code }) =>
    new Set(["post_merge_verification", "exact_tree_verification", "treehouse_return"])
      .has(code)), false);
  assert.equal(complete.attention.some(
    ({ code }) => code === "branch_cleanup_approval",
  ), true);
  assert.match(renderHerdrView(complete), /assurance-001: checks=passing/u);

  snapshot.branchCleanups = [{
    operationId: "cleanup-001",
    approvalId: "cleanup-approval-001",
    status: "requested",
    repository: snapshot.repo,
    branch: snapshot.worktree.branch,
    headSha,
    requestEventId: "cleanup-request",
    result: null,
    failure: null,
  }];
  assert.equal(projectHerdrSnapshot(snapshot).attention.some(
    ({ code }) => code === "branch_cleanup_reconciliation",
  ), true);
  snapshot.branchCleanups[0] = {
    ...snapshot.branchCleanups[0],
    status: "completed",
    result: { deletedHeadSha: headSha },
    completedEventId: "cleanup-completed",
  };
  const cleaned = projectHerdrSnapshot(snapshot);
  assert.equal(cleaned.attention.some(({ code }) =>
    code.startsWith("branch_cleanup")), false);
  assert.match(renderHerdrView(cleaned), /cleanup-001: completed/u);
});

function richSnapshot() {
  const headSha = "a".repeat(40);
  return {
    schemaVersion: 1,
    id: "herdr-rich-001",
    kind: "code-change",
    state: "validating",
    repo: "johntango/Shipmates-Practice",
    baseSha: "b".repeat(40),
    worktree: {
      status: "leased",
      worktreePath: "/tmp/treehouse/task",
      headSha,
      branch: "shipmates/task-001",
    },
    workers: [{
      id: "scout-001",
      backend: "codex-mcp",
      mode: "scout",
      sandbox: "read-only",
      paneId: "w1:p2",
      status: "reported",
      threadId: "thread-001",
      brief: "SECRET BRIEF",
      report: { status: "completed", summary: "SECRET REPORT" },
      verification: { noMutation: true },
      failure: null,
      replies: [{
        id: "reply-001",
        status: "requested",
        threadId: "thread-001",
        report: null,
        verification: null,
        failure: null,
      }],
    }],
    gitCommits: [{
      operationId: "commit-v1",
      status: "completed",
      baseHeadSha: "b".repeat(40),
      branch: "shipmates/task-001",
      changedPaths: ["src/change.js"],
      requestEventId: "commit-request",
      completedEventId: "commit-completed",
      result: {
        headSha,
        treeSha: "c".repeat(40),
      },
    }],
    validationRequests: [],
    validationRuns: [{
      runId: "validation-001",
      passed: false,
      outcome: "failed",
      finalHeadSha: headSha,
      completedAt: "2026-07-13T23:01:00.000Z",
    }],
    githubDraftPrApprovals: [{
      approvalId: "approval-001",
      actor: "john",
      repository: "johntango/Shipmates-Practice",
      headBranch: "shipmates/task-001",
      headSha,
      decision: "approved",
      consumedBy: "create-001",
      body: "SECRET BODY",
    }],
    githubDraftPullRequests: [{
      operationId: "create-001",
      approvalId: "approval-001",
      status: "requested",
      repository: "johntango/Shipmates-Practice",
      headBranch: "shipmates/task-001",
      headSha,
      baseBranch: "main",
      failure: null,
      pullRequest: null,
    }],
    githubObservations: [{
      observedAt: "2026-07-13T23:02:00.000Z",
      pullRequest: { number: 3, head: { sha: headSha } },
      requiredChecks: {
        names: ["test"],
        missing: [],
        unsuccessful: ["test"],
        satisfied: false,
      },
      checks: [{ name: "test", status: "completed", conclusion: "failure" }],
    }],
    approvals: [],
    recoveryAudits: [{
      auditId: "restart-001",
      safeToResume: false,
      recommendedActions: ["reconcile_worker_replies"],
      auditedEventId: "event-019",
      eventId: "event-020",
    }],
    firstmateRuns: [],
    evidence: [],
    eventsCount: 20,
    lastEventId: "event-020",
    lastEventAt: "2026-07-13T23:03:00.000Z",
  };
}
