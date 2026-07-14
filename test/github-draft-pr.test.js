import assert from "node:assert/strict";
import test from "node:test";

import { GitHubDraftPullRequestGateway } from "../src/adapters/github-draft-pr.js";
import {
  GitHubDraftPullRequestRecoveryRequiredError,
  GitHubDraftPullRequestWorkflow,
} from "../src/workflows/github-draft-pr.js";

const repository = "johntango/Shipmates-Practice";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const now = "2026-07-13T22:00:00.000Z";
const target = {
  taskId: "draft-pr-001",
  repository,
  headBranch: "shipmates/task-001",
  headSha,
  baseBranch: "main",
  title: "Practice draft",
  body: "Validated practice change.",
};

test("write gateway can only create a draft with fixed safe fields", async () => {
  const calls = [];
  const gateway = new GitHubDraftPullRequestGateway({
    clock: () => new Date(now),
    client: {
      async post(input) {
        calls.push(input);
        return rawPullRequest();
      },
    },
  });

  const result = await gateway.create({
    owner: "johntango",
    repo: "Shipmates-Practice",
    title: target.title,
    body: target.body,
    headBranch: target.headBranch,
    headSha,
    baseBranch: target.baseBranch,
  });

  assert.equal(result.draft, true);
  assert.equal(result.head.sha, headSha);
  assert.deepEqual(calls[0], {
    endpoint: "repos/johntango/Shipmates-Practice/pulls",
    body: {
      title: target.title,
      body: target.body,
      head: target.headBranch,
      base: target.baseBranch,
      draft: true,
      maintainer_can_modify: false,
    },
  });
  assert.deepEqual(
    Object.getOwnPropertyNames(GitHubDraftPullRequestGateway.prototype),
    ["constructor", "create"],
  );
});

test("creates once after exact human approval and then observes CI read-only", async () => {
  const store = new MemoryStore();
  const writeCalls = [];
  const statusCalls = [];
  const workflow = workflowFor({ store, writeCalls, statusCalls });
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
  assert.equal(store.snapshot.githubDraftPrApprovals.length, 1);

  const created = await workflow.create({
    ...target,
    approvalId: "approval-001",
    operationId: "create-001",
  });
  assert.equal(created.githubDraftPullRequests[0].status, "completed");
  assert.equal(created.githubDraftPullRequests[0].pullRequest.number, 3);
  assert.equal(writeCalls.length, 1);
  assert.equal(JSON.stringify(created).includes(target.body), false);

  const reused = await workflow.create({
    ...target,
    approvalId: "approval-001",
    operationId: "create-001",
  });
  assert.equal(reused.githubDraftPullRequests[0].pullRequest.number, 3);
  assert.equal(writeCalls.length, 1);

  await workflow.observeCi({
    taskId: target.taskId,
    operationId: "create-001",
    requiredChecks: ["test"],
  });
  assert.deepEqual(statusCalls, [{
    taskId: target.taskId,
    repository,
    prNumber: 3,
    requiredChecks: ["test"],
  }]);
});

test("requires approval and reconciles an interrupted write without repeating it", async () => {
  const store = new MemoryStore();
  const writeCalls = [];
  const workflow = workflowFor({ store, writeCalls, writeFailure: true });

  await assert.rejects(
    workflow.create({
      ...target,
      approvalId: "approval-001",
      operationId: "create-001",
    }),
    /matching unused human approval/u,
  );
  assert.equal(writeCalls.length, 0);

  await workflow.approve({
    ...target,
    approvalId: "approval-001",
    humanActor: "john",
  });
  await assert.rejects(
    workflow.create({
      ...target,
      approvalId: "approval-001",
      operationId: "create-001",
    }),
    GitHubDraftPullRequestRecoveryRequiredError,
  );
  assert.equal(store.snapshot.githubDraftPullRequests[0].status, "requested");
  assert.equal(writeCalls.length, 1);

  const restarted = workflowFor({ store, writeCalls });
  await assert.rejects(
    restarted.create({
      ...target,
      approvalId: "approval-001",
      operationId: "create-001",
    }),
    GitHubDraftPullRequestRecoveryRequiredError,
  );
  const reconciled = await restarted.reconcile({
    taskId: target.taskId,
    operationId: "create-001",
  });
  assert.equal(reconciled.githubDraftPullRequests[0].status, "completed");
  assert.equal(writeCalls.length, 1);
});

function workflowFor({ store, writeCalls, statusCalls = [], writeFailure = false }) {
  const pull = pullRequest();
  return new GitHubDraftPullRequestWorkflow({
    store,
    writeGateway: {
      async create(input) {
        writeCalls.push(input);
        if (writeFailure) throw new Error("uncertain network response");
        return pull;
      },
    },
    readGateway: {
      async readBranchHead() {
        return { sha: headSha };
      },
      async readPullRequest() {
        return pull;
      },
      async listPullRequests() {
        return [pull];
      },
    },
    statusWorkflow: {
      async inspectPullRequest(input) {
        statusCalls.push(input);
        return { observed: true };
      },
    },
  });
}

class MemoryStore {
  constructor() {
    this.snapshot = {
      id: target.taskId,
      repo: repository,
      state: "validating",
      worktree: { status: "leased", headSha, worktreePath: "/tmp/worktree" },
      validationRuns: [{ passed: true, finalHeadSha: headSha }],
      gitPushes: [{
        status: "completed",
        repository,
        branch: target.headBranch,
        headSha,
        result: { remoteHeadSha: headSha },
      }],
      githubDraftPrApprovals: [],
      githubDraftPullRequests: [],
    };
  }

  async getSnapshot() {
    return structuredClone(this.snapshot);
  }

  async recordDraftPullRequestApproval({ approval, eventId, actor }) {
    this.snapshot.githubDraftPrApprovals.push({
      ...approval,
      eventId,
      actor,
      consumedBy: null,
    });
    return this.getSnapshot();
  }

  async requestDraftPullRequestCreate({ request, eventId }) {
    const approval = this.snapshot.githubDraftPrApprovals.find(
      ({ approvalId }) => approvalId === request.approvalId,
    );
    approval.consumedBy = request.operationId;
    this.snapshot.githubDraftPullRequests.push({
      ...request,
      status: "requested",
      requestEventId: eventId,
      pullRequest: null,
      failure: null,
    });
    return this.getSnapshot();
  }

  async recordDraftPullRequestCreated({ operationId, pullRequest }) {
    const operation = this.snapshot.githubDraftPullRequests.find(
      (candidate) => candidate.operationId === operationId,
    );
    operation.status = "completed";
    operation.pullRequest = pullRequest;
    return this.getSnapshot();
  }
}

function pullRequest() {
  return {
    repository,
    number: 3,
    url: "https://github.com/johntango/Shipmates-Practice/pull/3",
    state: "open",
    draft: true,
    title: target.title,
    base: { repository, branch: target.baseBranch, sha: baseSha },
    head: {
      repository,
      owner: "johntango",
      branch: target.headBranch,
      sha: headSha,
    },
    updatedAt: now,
    observedAt: now,
    source: {
      kind: "github-rest",
      endpoint: "repos/johntango/Shipmates-Practice/pulls/3",
    },
  };
}

function rawPullRequest() {
  return {
    number: 3,
    html_url: "https://github.com/johntango/Shipmates-Practice/pull/3",
    state: "open",
    draft: true,
    title: target.title,
    base: {
      repo: { full_name: repository },
      ref: target.baseBranch,
      sha: baseSha,
    },
    head: {
      repo: { full_name: repository, owner: { login: "johntango" } },
      ref: target.headBranch,
      sha: headSha,
    },
    updated_at: now,
  };
}
