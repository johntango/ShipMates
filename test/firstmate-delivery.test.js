import assert from "node:assert/strict";
import test from "node:test";

import { FirstmateDeliveryWorkflow } from "../src/workflows/firstmate-delivery.js";

const HEAD = "a".repeat(40);
const REPOSITORY = "johntango/Shipmates-Practice";
const BRANCH = "shipmates/task-001";

test("continues one validated task through separate push and draft approvals into exact-head CI", async () => {
  const store = new MemoryStore();
  const calls = [];
  const workflow = new FirstmateDeliveryWorkflow({
    store,
    pushWorkflow: {
      async approve(input) {
        calls.push(["approve-push", input]);
        store.snapshot.gitPushApprovals.push({
          ...input,
          decision: "approved",
          consumedBy: null,
        });
      },
      async push(input) {
        calls.push(["push", input]);
        store.snapshot.gitPushApprovals[0].consumedBy = input.operationId;
        store.snapshot.gitPushes.push({
          ...input,
          status: "completed",
          result: { remoteHeadSha: HEAD },
          failure: null,
        });
      },
      async reconcile() {},
    },
    draftWorkflow: {
      async approve(input) {
        calls.push(["approve-pr", input]);
        store.snapshot.githubDraftPrApprovals.push({
          ...input,
          decision: "approved",
          consumedBy: null,
        });
      },
      async create(input) {
        calls.push(["create-pr", input]);
        store.snapshot.githubDraftPrApprovals[0].consumedBy = input.operationId;
        store.snapshot.githubDraftPullRequests.push({
          ...input,
          status: "completed",
          pullRequest: {
            number: 7,
            url: "https://github.com/johntango/Shipmates-Practice/pull/7",
          },
          failure: null,
        });
      },
      async observeCi(input) {
        calls.push(["ci", input]);
        store.snapshot.githubObservations.push({
          observedAt: "2026-07-14T15:00:00.000Z",
          pullRequest: { number: 7, head: { sha: HEAD } },
          requiredChecks: {
            names: ["test"],
            missing: [],
            unsuccessful: [],
            satisfied: true,
          },
        });
      },
      async reconcile() {},
    },
  });

  assert.equal((await workflow.status({ taskId: "delivery-001" })).stage,
    "awaiting_push_approval");
  assert.equal((await workflow.approvePush({
    taskId: "delivery-001",
    approvalId: "push-approval-001",
    humanActor: "john",
  })).stage, "ready_to_push");
  assert.equal((await workflow.push({
    taskId: "delivery-001",
    operationId: "push-operation-001",
    approvalId: "push-approval-001",
  })).stage, "awaiting_draft_pr_approval");
  assert.equal((await workflow.approveDraftPullRequest({
    taskId: "delivery-001",
    approvalId: "draft-approval-001",
    humanActor: "john",
    baseBranch: "main",
    title: "Validated delivery",
    body: "Exact-head task delivery.",
  })).stage, "ready_to_create_draft_pr");
  const delivered = await workflow.createDraftPullRequestAndObserveCi({
    taskId: "delivery-001",
    operationId: "draft-operation-001",
    approvalId: "draft-approval-001",
    baseBranch: "main",
    title: "Validated delivery",
    body: "Exact-head task delivery.",
    requiredChecks: ["test"],
  });

  assert.equal(delivered.stage, "ci_passed");
  assert.equal(delivered.target.headSha, HEAD);
  assert.equal(delivered.draftPullRequest.number, 7);
  assert.deepEqual(calls.map(([name]) => name), [
    "approve-push", "push", "approve-pr", "create-pr", "ci",
  ]);
  for (const [, input] of calls.slice(0, 4)) {
    assert.equal(input.repository, REPOSITORY);
    assert.equal(input.headSha, HEAD);
  }
});

test("projects uncertain mutations as reconciliation stages", async () => {
  const store = new MemoryStore();
  store.snapshot.gitPushes.push({
    operationId: "push-operation-001",
    approvalId: "push-approval-001",
    repository: REPOSITORY,
    branch: BRANCH,
    headSha: HEAD,
    status: "requested",
    result: null,
    failure: null,
  });
  const workflow = new FirstmateDeliveryWorkflow({
    store,
    pushWorkflow: { approve() {}, push() {}, reconcile() {} },
    draftWorkflow: { approve() {}, create() {}, observeCi() {}, reconcile() {} },
  });

  assert.equal((await workflow.status({ taskId: "delivery-001" })).stage,
    "push_reconciliation_required");

  store.snapshot.gitPushes[0].status = "completed";
  store.snapshot.gitPushes[0].result = { remoteHeadSha: HEAD };
  store.snapshot.githubDraftPullRequests.push({
    operationId: "draft-operation-001",
    approvalId: "draft-approval-001",
    repository: REPOSITORY,
    headBranch: BRANCH,
    headSha: HEAD,
    baseBranch: "main",
    status: "requested",
    pullRequest: null,
    failure: null,
  });

  assert.equal((await workflow.status({ taskId: "delivery-001" })).stage,
    "draft_pr_reconciliation_required");
});

class MemoryStore {
  constructor() {
    this.snapshot = {
      id: "delivery-001",
      repo: REPOSITORY,
      state: "validating",
      eventsCount: 10,
      lastEventId: "validation-completed",
      worktree: {
        status: "leased",
        branch: BRANCH,
        headSha: HEAD,
      },
      gitCommits: [{ status: "completed", result: { headSha: HEAD } }],
      validationRuns: [{ passed: true, finalHeadSha: HEAD }],
      gitPushApprovals: [],
      gitPushes: [],
      githubDraftPrApprovals: [],
      githubDraftPullRequests: [],
      githubObservations: [],
    };
  }

  async getSnapshot() {
    return structuredClone(this.snapshot);
  }
}
