import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubMergeRecoveryRequiredError,
  GitHubMergeWorkflow,
} from "../src/workflows/github-merge.js";

const REPOSITORY = "johntango/Shipmates-Practice";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);

test("records separate human approval and lands one exact-head squash merge", async () => {
  const fixture = createFixture();
  const workflow = fixture.workflow();

  await workflow.approve({
    taskId: "merge-001",
    approvalId: "merge-approval-001",
    humanActor: "john",
    repository: REPOSITORY,
    prNumber: 7,
    headSha: HEAD,
  });
  assert.equal(fixture.store.snapshot.state, "ready_to_merge");
  assert.equal(fixture.store.snapshot.githubMergeApprovals[0].consumedBy, null);

  const completed = await workflow.merge({
    taskId: "merge-001",
    operationId: "merge-operation-001",
    approvalId: "merge-approval-001",
  });

  assert.equal(completed.state, "landed");
  assert.equal(completed.githubMerges[0].result.mergeCommitSha, MERGE);
  assert.equal(fixture.mergeCalls, 1);
  assert.equal(completed.githubMergeApprovals[0].consumedBy, "merge-operation-001");
});

test("reconciles an uncertain merge by reads without issuing a second merge", async () => {
  const fixture = createFixture({ uncertainMerge: true });
  const workflow = fixture.workflow();
  await workflow.approve({
    taskId: "merge-001",
    approvalId: "merge-approval-001",
    humanActor: "john",
    repository: REPOSITORY,
    prNumber: 7,
    headSha: HEAD,
  });

  await assert.rejects(
    workflow.merge({
      taskId: "merge-001",
      operationId: "merge-operation-001",
      approvalId: "merge-approval-001",
    }),
    GitHubMergeRecoveryRequiredError,
  );
  assert.equal(fixture.store.snapshot.state, "merging");
  fixture.merged = true;

  const recovered = await fixture.workflow().reconcile({
    taskId: "merge-001",
    operationId: "merge-operation-001",
  });

  assert.equal(recovered.state, "landed");
  assert.equal(recovered.githubMerges[0].result.evidenceKind, "remote-reconciliation");
  assert.equal(fixture.mergeCalls, 1);
});

test("fails closed for unresolved conversations and draft pull requests", async () => {
  const unresolved = createFixture({ unresolved: true });
  await assert.rejects(
    unresolved.workflow().approve({
      taskId: "merge-001",
      approvalId: "merge-approval-001",
      humanActor: "john",
      repository: REPOSITORY,
      prNumber: 7,
      headSha: HEAD,
    }),
    /unresolved review threads/u,
  );
  assert.equal(unresolved.store.snapshot.githubMergeApprovals.length, 0);

  const draft = createFixture({ draft: true });
  await assert.rejects(
    draft.workflow().approve({
      taskId: "merge-001",
      approvalId: "merge-approval-001",
      humanActor: "john",
      repository: REPOSITORY,
      prNumber: 7,
      headSha: HEAD,
    }),
    /non-draft/u,
  );
  assert.equal(draft.mergeCalls, 0);
});

function createFixture({ uncertainMerge = false, unresolved = false, draft = false } = {}) {
  const store = new MemoryStore();
  const fixture = {
    store,
    mergeCalls: 0,
    merged: false,
    workflow() {
      return new GitHubMergeWorkflow({
        store,
        statusWorkflow: {
          inspectPullRequest: async () => store.recordStatus(statusReport({ draft })),
        },
        readGateway: {
          listReviewThreads: async () => [{ resolved: !unresolved, outdated: false }],
          readRepository: async () => ({
            nameWithOwner: REPOSITORY,
            defaultBranch: "main",
            archived: false,
            disabled: false,
          }),
          readPullRequest: async () => pullRequest({ merged: fixture.merged }),
          readBranchHead: async () => ({
            repository: REPOSITORY,
            branch: "main",
            sha: MERGE,
          }),
        },
        mergeGateway: {
          mergeSquash: async () => {
            fixture.mergeCalls += 1;
            if (uncertainMerge) throw new Error("connection lost");
            fixture.merged = true;
            return { mergeCommitSha: MERGE };
          },
        },
        idFactory: () => "merge-attempt-001",
      });
    },
  };
  return fixture;
}

class MemoryStore {
  constructor() {
    this.statusId = 0;
    this.snapshot = {
      id: "merge-001",
      repo: REPOSITORY,
      state: "validating",
      worktree: { status: "leased", headSha: HEAD, branch: "shipmates/task-001" },
      githubDraftPullRequests: [{
        operationId: "draft-001",
        status: "completed",
        repository: REPOSITORY,
        headBranch: "shipmates/task-001",
        headSha: HEAD,
        baseBranch: "main",
        pullRequest: { number: 7 },
      }],
      githubObservations: [],
      githubMergeApprovals: [],
      githubMerges: [],
    };
  }

  async getSnapshot() {
    return structuredClone(this.snapshot);
  }

  async recordStatus(report) {
    this.snapshot.githubObservations.push({
      ...report,
      eventId: `status-${++this.statusId}`,
    });
    return this.getSnapshot();
  }

  async recordGitHubMergeApproval({ approval, eventId, actor }) {
    this.snapshot.githubMergeApprovals.push({
      ...approval, eventId, actor, consumedBy: null,
    });
    this.snapshot.state = "ready_to_merge";
    return this.getSnapshot();
  }

  async requestGitHubMerge({ request, eventId }) {
    const approval = this.snapshot.githubMergeApprovals.find(
      ({ approvalId }) => approvalId === request.approvalId,
    );
    approval.consumedBy = request.operationId;
    this.snapshot.githubMerges.push({
      ...request,
      status: "requested",
      requestEventId: eventId,
      result: null,
      failure: null,
    });
    this.snapshot.state = "merging";
    return this.getSnapshot();
  }

  async recordGitHubMergeCompleted({ operationId, result }) {
    const operation = this.snapshot.githubMerges.find(
      ({ operationId: id }) => id === operationId,
    );
    operation.status = "completed";
    operation.result = result;
    this.snapshot.state = "landed";
    return this.getSnapshot();
  }

  async recordGitHubMergeFailure({ operationId, code }) {
    const operation = this.snapshot.githubMerges.find(
      ({ operationId: id }) => id === operationId,
    );
    operation.status = "failed";
    operation.failure = code;
    this.snapshot.state = "awaiting_human";
    return this.getSnapshot();
  }
}

function statusReport({ draft }) {
  return {
    repository: {
      nameWithOwner: REPOSITORY,
      defaultBranch: "main",
      archived: false,
      disabled: false,
      allowSquashMerge: true,
    },
    pullRequest: pullRequest({ merged: false, draft }),
    branchProtection: {
      requiredPullRequestReviews: {
        approvals: 1,
        requireCodeOwnerReviews: false,
        requireLastPushApproval: false,
      },
      requiredConversationResolution: true,
    },
    reviews: [{
      actor: "reviewer",
      state: "APPROVED",
      commitSha: HEAD,
      submittedAt: "2026-07-14T15:00:00.000Z",
    }],
    requiredChecks: {
      names: ["test"], missing: [], unsuccessful: [], satisfied: true,
    },
  };
}

function pullRequest({ merged, draft = false }) {
  return {
    repository: REPOSITORY,
    number: 7,
    state: merged ? "closed" : "open",
    draft,
    merged,
    mergeable: merged ? null : true,
    mergeableState: merged ? "unknown" : "clean",
    mergeCommitSha: merged ? MERGE : null,
    base: { repository: REPOSITORY, branch: "main", sha: BASE },
    head: { repository: REPOSITORY, branch: "shipmates/task-001", sha: HEAD },
  };
}
