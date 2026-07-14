import assert from "node:assert/strict";
import test from "node:test";

import {
  BranchCleanupRecoveryRequiredError,
  BranchCleanupWorkflow,
  BranchCleanupWorkflowError,
} from "../src/workflows/branch-cleanup.js";

const HEAD = "a".repeat(40);

test("reconciles uncertain deletion without issuing a second delete", async () => {
  const store = new MemoryStore();
  let remoteHead = HEAD;
  let deletes = 0;
  const workflow = new BranchCleanupWorkflow({
    store,
    readGateway: repositoryReader(),
    deleteAdapter: {
      inspect: async () => ({ remoteHeadSha: remoteHead }),
      deleteExact: async () => {
        deletes += 1;
        remoteHead = null;
        throw new Error("transport result lost");
      },
      reconcile: async () => ({
        status: "completed",
        evidence: result("remote-reconciliation"),
      }),
    },
    idFactory: () => "attempt-001",
  });
  await workflow.approve({
    taskId: "cleanup-task-001",
    approvalId: "approval-001",
    humanActor: "john",
    repository: "johntango/ShipMates",
    branch: "task-branch",
    headSha: HEAD,
  });

  await assert.rejects(
    workflow.delete({
      taskId: "cleanup-task-001",
      operationId: "cleanup-001",
      approvalId: "approval-001",
    }),
    BranchCleanupRecoveryRequiredError,
  );
  await assert.rejects(
    workflow.delete({
      taskId: "cleanup-task-001",
      operationId: "cleanup-001",
      approvalId: "approval-001",
    }),
    BranchCleanupRecoveryRequiredError,
  );
  await assert.rejects(workflow.approve({
    taskId: "cleanup-task-001",
    approvalId: "approval-002",
    humanActor: "john",
    repository: "johntango/ShipMates",
    branch: "task-branch",
    headSha: HEAD,
  }), BranchCleanupWorkflowError);
  const reconciled = await workflow.reconcile({
    taskId: "cleanup-task-001",
    operationId: "cleanup-001",
  });

  assert.equal(deletes, 1);
  assert.equal(reconciled.branchCleanups[0].status, "completed");
});

test("refuses cleanup approval when the remote branch moved", async () => {
  const store = new MemoryStore();
  const workflow = new BranchCleanupWorkflow({
    store,
    readGateway: repositoryReader(),
    deleteAdapter: {
      inspect: async () => ({ remoteHeadSha: "b".repeat(40) }),
      async deleteExact() { throw new Error("must not delete"); },
      async reconcile() { throw new Error("must not reconcile"); },
    },
  });

  await assert.rejects(workflow.approve({
    taskId: "cleanup-task-001",
    approvalId: "approval-001",
    humanActor: "john",
    repository: "johntango/ShipMates",
    branch: "task-branch",
    headSha: HEAD,
  }), BranchCleanupWorkflowError);
  assert.equal(store.snapshot.branchCleanupApprovals.length, 0);
});

class MemoryStore {
  constructor() {
    this.snapshot = completedSnapshot();
  }

  async getSnapshot() { return this.snapshot; }

  async recordBranchCleanupApproval({ actor, approval, eventId }) {
    this.snapshot.branchCleanupApprovals.push({
      ...approval, actor, eventId, consumedBy: null,
    });
    return this.snapshot;
  }

  async requestBranchCleanup({ request, eventId }) {
    this.snapshot.branchCleanupApprovals[0].consumedBy = request.operationId;
    this.snapshot.branchCleanups.push({
      ...request,
      requestEventId: eventId,
      status: "requested",
      result: null,
      failure: null,
    });
    return this.snapshot;
  }

  async recordBranchCleanupCompleted({ operationId, result, eventId }) {
    const operation = this.snapshot.branchCleanups.find(
      ({ operationId: id }) => id === operationId,
    );
    operation.status = "completed";
    operation.result = result;
    operation.completedEventId = eventId;
    return this.snapshot;
  }

  async recordBranchCleanupFailure() {
    throw new Error("unexpected cleanup failure");
  }
}

function completedSnapshot() {
  const assurance = {
    eventId: "assurance-event",
    approvedHeadSha: HEAD,
    requiredChecks: { satisfied: true },
  };
  return {
    id: "cleanup-task-001",
    state: "complete",
    repo: "johntango/ShipMates",
    worktree: {
      status: "returned",
      repoPath: "/tmp/repository",
      branch: "task-branch",
      headSha: HEAD,
      returnedEventId: "returned-event",
      proof: {
        kind: "exact-tree-landing",
        eventId: "proof-event",
        assuranceEventId: assurance.eventId,
      },
    },
    gitPushes: [{
      status: "completed",
      repository: "johntango/ShipMates",
      branch: "task-branch",
      headSha: HEAD,
    }],
    postMergeAssurances: [assurance],
    branchCleanupApprovals: [],
    branchCleanups: [],
  };
}

function repositoryReader() {
  return {
    readRepository: async () => ({
      nameWithOwner: "johntango/ShipMates",
      defaultBranch: "main",
      archived: false,
      disabled: false,
    }),
  };
}

function result(evidenceKind) {
  return {
    evidenceKind,
    repository: "johntango/ShipMates",
    remoteName: "origin",
    branch: "task-branch",
    remoteRef: "refs/heads/task-branch",
    deletedHeadSha: HEAD,
    remoteHeadSha: null,
    transportOutputSha256: evidenceKind === "delete-confirmation"
      ? "c".repeat(64)
      : null,
    deleted: true,
  };
}
