import assert from "node:assert/strict";
import test from "node:test";

import {
  PostMergeAssuranceError,
  PostMergeAssuranceWorkflow,
  PostMergeChecksPendingError,
} from "../src/workflows/post-merge-assurance.js";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

test("refuses cleanup while a required merge-commit check is pending", async () => {
  const store = fakeStore();
  let cleanupCalls = 0;
  const workflow = new PostMergeAssuranceWorkflow({
    store,
    readGateway: gateway({ checkConclusion: null }),
    treehouseWorkflow: {
      async completeExactTreeLanding() { cleanupCalls += 1; },
      async reconcileReturn() {},
    },
    idFactory: () => "observation-001",
  });

  await assert.rejects(
    workflow.complete({ taskId: "post-merge-001", operationId: "assurance-001" }),
    PostMergeChecksPendingError,
  );
  assert.equal(store.snapshot.postMergeAssurances.length, 0);
  assert.equal(cleanupCalls, 0);
});

test("refuses an advanced default branch before recording landed-work evidence", async () => {
  const store = fakeStore();
  const workflow = new PostMergeAssuranceWorkflow({
    store,
    readGateway: gateway({ branchSha: "c".repeat(40) }),
    treehouseWorkflow: {
      async completeExactTreeLanding() {
        throw new Error("must not clean up");
      },
      async reconcileReturn() {},
    },
    idFactory: () => "observation-001",
  });

  await assert.rejects(
    workflow.complete({ taskId: "post-merge-001", operationId: "assurance-001" }),
    PostMergeAssuranceError,
  );
  assert.equal(store.snapshot.postMergeAssurances.length, 0);
});

function fakeStore() {
  const snapshot = {
    id: "post-merge-001",
    state: "landed",
    repo: "johntango/ShipMates",
    worktree: { status: "leased", headSha: HEAD },
    githubMerges: [{
      operationId: "merge-001",
      status: "completed",
      repository: "johntango/ShipMates",
      prNumber: 7,
      headSha: HEAD,
      preMergeStatusEventId: "status-001",
      result: {
        baseBranch: "main",
        mergeCommitSha: MERGE,
      },
    }],
    githubObservations: [{
      eventId: "status-001",
      requiredChecks: {
        names: ["test"], missing: [], unsuccessful: [], satisfied: true,
      },
    }],
    postMergeAssurances: [],
  };
  return {
    snapshot,
    async getSnapshot() { return snapshot; },
    async recordPostMergeAssurance({ report }) {
      snapshot.postMergeAssurances.push({ ...report, eventId: "assurance-event" });
      return snapshot;
    },
  };
}

function gateway({ checkConclusion = "success", branchSha = MERGE } = {}) {
  const source = { kind: "github-rest", endpoint: "fixture" };
  const observed = (value) => ({
    ...value,
    observedAt: "2026-07-14T16:00:00.000Z",
    source,
  });
  return {
    async readRepository() {
      return observed({
        nameWithOwner: "johntango/ShipMates",
        defaultBranch: "main",
      });
    },
    async readPullRequest() {
      return observed({
        number: 7,
        merged: true,
        head: { sha: HEAD },
        base: { branch: "main" },
        mergeCommitSha: MERGE,
      });
    },
    async readBranchHead() {
      return observed({ branch: "main", sha: branchSha });
    },
    async readBranchProtection() {
      return observed({
        branch: "main",
        requiredStatusChecks: { contexts: ["test"], checks: [] },
      });
    },
    async listCheckRuns() {
      return [observed({
        id: 1,
        name: "test",
        headSha: MERGE,
        status: checkConclusion === null ? "in_progress" : "completed",
        conclusion: checkConclusion,
      })];
    },
    async listWorkflowRuns() { return []; },
  };
}
