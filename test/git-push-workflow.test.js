import assert from "node:assert/strict";
import test from "node:test";

import {
  ExactHeadPushRecoveryRequiredError,
  ExactHeadPushWorkflow,
} from "../src/workflows/git-push.js";

const HEAD = "a".repeat(40);
const target = {
  taskId: "push-flow-001",
  repository: "owner/repo",
  branch: "task-branch",
  headSha: HEAD,
};

test("pushes once after exact human approval and reuses the terminal result", async () => {
  const store = new MemoryStore();
  const calls = [];
  const workflow = workflowFor({ store, calls });
  await workflow.approve({
    ...target,
    approvalId: "approval-001",
    humanActor: "john",
  });
  await workflow.approve({
    ...target,
    approvalId: "approval-001",
    humanActor: "john",
  });

  const first = await workflow.push({
    ...target,
    operationId: "push-001",
    approvalId: "approval-001",
  });
  const second = await workflow.push({
    ...target,
    operationId: "push-001",
    approvalId: "approval-001",
  });

  assert.equal(first.gitPushes[0].status, "completed");
  assert.equal(second.gitPushes[0].result.remoteHeadSha, HEAD);
  assert.equal(calls.filter((item) => item === "push").length, 1);
});

test("reconciles an uncertain push without issuing a second push", async () => {
  const store = new MemoryStore();
  const calls = [];
  const workflow = workflowFor({ store, calls, pushFailure: true });
  await workflow.approve({
    ...target,
    approvalId: "approval-001",
    humanActor: "john",
  });
  await assert.rejects(
    workflow.push({
      ...target,
      operationId: "push-001",
      approvalId: "approval-001",
    }),
    ExactHeadPushRecoveryRequiredError,
  );
  assert.equal(store.snapshot.gitPushes[0].status, "requested");

  const restarted = workflowFor({ store, calls, reconcileStatus: "completed" });
  const result = await restarted.reconcile({
    taskId: target.taskId,
    operationId: "push-001",
  });

  assert.equal(result.gitPushes[0].status, "completed");
  assert.equal(calls.filter((item) => item === "push").length, 1);
});

test("records a proven absent remote as failed and requires new approval", async () => {
  const store = new MemoryStore();
  const calls = [];
  const workflow = workflowFor({ store, calls, pushFailure: true });
  await workflow.approve({
    ...target,
    approvalId: "approval-001",
    humanActor: "john",
  });
  await assert.rejects(
    workflow.push({
      ...target,
      operationId: "push-001",
      approvalId: "approval-001",
    }),
    ExactHeadPushRecoveryRequiredError,
  );

  const restarted = workflowFor({ store, calls, reconcileStatus: "absent" });
  const result = await restarted.reconcile({
    taskId: target.taskId,
    operationId: "push-001",
  });

  assert.equal(result.gitPushes[0].status, "failed");
  assert.equal(result.gitPushes[0].failure, "remote_branch_absent");
});

test("refuses the default branch and a push without approval", async () => {
  const store = new MemoryStore();
  const calls = [];
  const workflow = workflowFor({ store, calls, defaultBranch: "task-branch" });
  await assert.rejects(
    workflow.push({
      ...target,
      operationId: "push-001",
      approvalId: "approval-001",
    }),
    /matching unused human approval/u,
  );
  await workflow.approve({
    ...target,
    approvalId: "approval-001",
    humanActor: "john",
  });
  await assert.rejects(
    workflow.push({
      ...target,
      operationId: "push-001",
      approvalId: "approval-001",
    }),
    /non-default task branch/u,
  );
  assert.equal(calls.includes("push"), false);
});

function workflowFor({
  store, calls, pushFailure = false, reconcileStatus = "completed",
  defaultBranch = "main",
}) {
  return new ExactHeadPushWorkflow({
    store,
    pushAdapter: {
      async inspect() {
        calls.push("inspect");
        return {
          localHeadSha: HEAD,
          localBranch: target.branch,
          clean: true,
          remoteHeadSha: null,
        };
      },
      async pushExact() {
        calls.push("push");
        if (pushFailure) throw new Error("uncertain transport");
        return pushEvidence("push-confirmation");
      },
      async reconcile() {
        calls.push("reconcile");
        if (reconcileStatus === "absent") {
          return { status: "absent", observation: { remoteHeadSha: null } };
        }
        return {
          status: reconcileStatus,
          observation: { remoteHeadSha: HEAD },
          evidence: pushEvidence("remote-reconciliation"),
        };
      },
    },
    readGateway: {
      async readRepository() {
        return {
          nameWithOwner: target.repository,
          defaultBranch,
          archived: false,
          disabled: false,
        };
      },
      async readBranchHead() {
        calls.push("confirm");
        return {
          repository: target.repository,
          branch: target.branch,
          sha: HEAD,
        };
      },
    },
    idFactory: () => "attempt-001",
  });
}

class MemoryStore {
  constructor() {
    this.snapshot = {
      id: target.taskId,
      repo: target.repository,
      state: "validating",
      worktree: {
        status: "leased",
        worktreePath: "/tmp/worktree",
        branch: target.branch,
        headSha: HEAD,
      },
      gitCommits: [{
        status: "completed",
        result: { headSha: HEAD },
      }],
      validationRuns: [{ passed: true, finalHeadSha: HEAD }],
      gitPushApprovals: [],
      gitPushes: [],
    };
  }

  async getSnapshot() {
    return structuredClone(this.snapshot);
  }

  async recordGitPushApproval({ approval, eventId, actor }) {
    this.snapshot.gitPushApprovals.push({
      ...approval,
      eventId,
      actor,
      consumedBy: null,
    });
    return this.getSnapshot();
  }

  async requestGitPush({ request, eventId }) {
    const approval = this.snapshot.gitPushApprovals.find(({ approvalId }) =>
      approvalId === request.approvalId);
    approval.consumedBy = request.operationId;
    this.snapshot.gitPushes.push({
      ...request,
      status: "requested",
      requestEventId: eventId,
      result: null,
      failure: null,
    });
    return this.getSnapshot();
  }

  async recordGitPushCompleted({ operationId, result }) {
    const operation = this.snapshot.gitPushes.find(({ operationId: id }) =>
      id === operationId);
    operation.status = "completed";
    operation.result = result;
    return this.getSnapshot();
  }

  async recordGitPushFailure({ operationId, code }) {
    const operation = this.snapshot.gitPushes.find(({ operationId: id }) =>
      id === operationId);
    operation.status = "failed";
    operation.failure = code;
    return this.getSnapshot();
  }
}

function pushEvidence(evidenceKind) {
  return {
    evidenceKind,
    repository: target.repository,
    remoteName: "origin",
    branch: target.branch,
    remoteRef: `refs/heads/${target.branch}`,
    headSha: HEAD,
    previousHeadSha: null,
    remoteHeadSha: HEAD,
    transportOutputSha256: evidenceKind === "push-confirmation"
      ? "b".repeat(64)
      : null,
    pushed: true,
  };
}
