import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import { BranchCleanupWorkflow } from "../src/workflows/branch-cleanup.js";
import {
  FirstmateCommitRecoveryRequiredError,
  FirstmateCommitWorkflow,
} from "../src/workflows/firstmate-commit.js";
import { GitHubDraftPullRequestWorkflow } from "../src/workflows/github-draft-pr.js";
import { GitHubMergeWorkflow } from "../src/workflows/github-merge.js";
import { GitHubStatusWorkflow } from "../src/workflows/github-status.js";
import { ExactHeadPushWorkflow } from "../src/workflows/git-push.js";
import { LocalValidationWorkflow } from "../src/workflows/local-validation.js";
import { PostMergeAssuranceWorkflow } from "../src/workflows/post-merge-assurance.js";
import { TreehouseLedgerWorkflow } from "../src/workflows/treehouse-ledger.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);

test("records one controlled commit and advances the exact lease to validation", async (t) => {
  const store = await preparedStore(t, "commit-flow-001");
  await assert.rejects(
    store.transition({
      taskId: "commit-flow-001",
      from: "running",
      to: "validating",
      actor: "firstmate",
      eventId: "commit-flow-001:bypass-validation",
    }),
    /controlled commit before validation/u,
  );
  let creates = 0;
  const workflow = new FirstmateCommitWorkflow({
    store,
    commitAdapter: {
      create: async () => {
        creates += 1;
        return commitResult("commit-flow-001");
      },
      inspectCreated: async () => commitResult("commit-flow-001"),
    },
  });

  const first = await workflow.run({ taskId: "commit-flow-001" });
  const second = await workflow.run({ taskId: "commit-flow-001" });

  assert.equal(first.snapshot.state, "validating");
  assert.equal(first.snapshot.worktree.headSha, HEAD);
  assert.equal(first.snapshot.gitCommits[0].status, "completed");
  assert.equal(second.reused, true);
  assert.equal(creates, 1);
});

test("reconciles a completed commit after the mutation/result crash window", async (t) => {
  const store = await preparedStore(t, "commit-flow-002");
  let creates = 0;
  let inspections = 0;
  const workflow = new FirstmateCommitWorkflow({
    store,
    commitAdapter: {
      create: async () => {
        creates += 1;
        throw new Error("lost result after commit");
      },
      inspectCreated: async () => {
        inspections += 1;
        return commitResult("commit-flow-002");
      },
    },
  });

  await assert.rejects(
    workflow.run({ taskId: "commit-flow-002" }),
    FirstmateCommitRecoveryRequiredError,
  );
  assert.equal((await store.getSnapshot("commit-flow-002")).gitCommits[0].status, "requested");

  const recovered = await workflow.reconcile({ taskId: "commit-flow-002" });

  assert.equal(recovered.snapshot.state, "validating");
  assert.equal(recovered.commit.headSha, HEAD);
  assert.equal(creates, 1);
  assert.equal(inspections, 1);
});

test("allows only one concurrent caller to claim controlled commit execution", async (t) => {
  const durableStore = await preparedStore(t, "commit-flow-003");
  let waiting = 0;
  let releaseReads;
  const readsReleased = new Promise((resolve) => {
    releaseReads = resolve;
  });
  const store = new Proxy(durableStore, {
    get(target, property) {
      if (property === "getSnapshot") {
        return async (...args) => {
          const snapshot = await target.getSnapshot(...args);
          if (snapshot.gitCommits.length === 0 && waiting < 2) {
            waiting += 1;
            if (waiting === 2) releaseReads();
            await readsReleased;
          }
          return snapshot;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let creates = 0;
  const adapter = {
    create: async () => {
      creates += 1;
      return commitResult("commit-flow-003");
    },
    inspectCreated: async () => commitResult("commit-flow-003"),
  };
  const first = new FirstmateCommitWorkflow({
    store, commitAdapter: adapter, idFactory: () => "attempt-001",
  });
  const second = new FirstmateCommitWorkflow({
    store, commitAdapter: adapter, idFactory: () => "attempt-002",
  });

  const results = await Promise.allSettled([
    first.run({ taskId: "commit-flow-003" }),
    second.run({ taskId: "commit-flow-003" }),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  assert.equal(creates, 1);
  assert.equal((await durableStore.getSnapshot("commit-flow-003")).gitCommits.length, 1);
});

test("records exact delivery approvals through merge assurance and lease return", async (t) => {
  const taskId = "commit-flow-004";
  const store = await preparedStore(t, taskId);
  await new FirstmateCommitWorkflow({
    store,
    commitAdapter: {
      create: async () => commitResult(taskId),
      inspectCreated: async () => commitResult(taskId),
    },
  }).run({ taskId });
  const intent = "Implement the exact task";
  await new LocalValidationWorkflow({
    store,
    gate: {
      pinEvidence,
      run: async () => validationReport(
        taskId,
        intent,
        store.clock().toISOString(),
      ),
    },
    idFactory: () => "validation-attempt-001",
  }).run({ taskId, intent });
  const push = new ExactHeadPushWorkflow({
    store,
    pushAdapter: {
      inspect: async () => ({
        localHeadSha: HEAD,
        localBranch: "task-branch",
        clean: true,
        remoteHeadSha: null,
      }),
      pushExact: async () => pushResult(),
      reconcile: async () => ({ status: "completed", evidence: pushResult() }),
    },
    readGateway: {
      readRepository: async () => ({
        nameWithOwner: "johntango/ShipMates",
        defaultBranch: "main",
        archived: false,
        disabled: false,
      }),
      readBranchHead: async () => ({
        repository: "johntango/ShipMates",
        branch: "task-branch",
        sha: HEAD,
      }),
    },
    idFactory: () => "push-attempt-001",
  });
  await push.approve({
    taskId,
    approvalId: "push-approval-001",
    humanActor: "john",
    repository: "johntango/ShipMates",
    branch: "task-branch",
    headSha: HEAD,
  });
  await push.push({
    taskId,
    operationId: "push-operation-001",
    approvalId: "push-approval-001",
    repository: "johntango/ShipMates",
    branch: "task-branch",
    headSha: HEAD,
  });
  const pull = draftPullRequest();
  const draft = new GitHubDraftPullRequestWorkflow({
    store,
    writeGateway: { create: async () => pull },
    readGateway: {
      readRepository: async () => ({
        nameWithOwner: "johntango/ShipMates",
        defaultBranch: "main",
        archived: false,
        disabled: false,
      }),
      readBranchHead: async () => ({ sha: HEAD }),
      readPullRequest: async () => pull,
      listPullRequests: async () => [pull],
    },
  });
  await draft.approve({
    taskId,
    approvalId: "draft-approval-001",
    humanActor: "john",
    repository: "johntango/ShipMates",
    headBranch: "task-branch",
    headSha: HEAD,
    baseBranch: "main",
    title: "Task draft",
    body: "Validated task.",
  });
  const snapshot = await draft.create({
    taskId,
    operationId: "draft-operation-001",
    approvalId: "draft-approval-001",
    repository: "johntango/ShipMates",
    headBranch: "task-branch",
    headSha: HEAD,
    baseBranch: "main",
    title: "Task draft",
    body: "Validated task.",
  });

  assert.equal(snapshot.gitPushes[0].status, "completed");
  assert.equal(snapshot.gitPushApprovals[0].consumedBy, "push-operation-001");
  assert.equal(snapshot.githubDraftPullRequests[0].status, "completed");

  let merged = false;
  let mergeCalls = 0;
  let timestamp = Date.parse("2026-07-14T02:00:00.000Z");
  store.clock = () => new Date(timestamp++);
  const observation = (value) => ({
    ...value,
    observedAt: "2026-07-14T02:00:00.000Z",
    source: { kind: "github-rest", endpoint: "merge-fixture" },
  });
  const readGateway = {
    readRepository: async () => observation({
      nameWithOwner: "johntango/ShipMates",
      defaultBranch: "main",
      archived: false,
      disabled: false,
      allowSquashMerge: true,
    }),
    readPullRequest: async () => observation(mergePullRequest({ merged })),
    readBranchProtection: async () => observation({
      repository: "johntango/ShipMates",
      branch: "main",
      requiredStatusChecks: { contexts: ["test"], checks: [] },
      requiredPullRequestReviews: null,
      requiredConversationResolution: true,
    }),
    listCheckRuns: async ({ headSha = HEAD } = {}) => [observation({
      id: 1,
      name: "test",
      headSha,
      status: "completed",
      conclusion: "success",
    })],
    listReviews: async () => [],
    listWorkflowRuns: async () => [],
    listReviewThreads: async () => [observation({
      id: "thread-001",
      resolved: true,
      outdated: false,
    })],
    readBranchHead: async () => observation({
      repository: "johntango/ShipMates",
      branch: "main",
      sha: MERGE,
    }),
  };
  const merge = new GitHubMergeWorkflow({
    store,
    readGateway,
    statusWorkflow: new GitHubStatusWorkflow({
      store,
      gateway: readGateway,
      clock: store.clock,
      idFactory: () => `status-${store.snapshotSequence || 0}-${timestamp}`,
    }),
    mergeGateway: {
      mergeSquash: async () => {
        mergeCalls += 1;
        merged = true;
        return { mergeCommitSha: MERGE };
      },
    },
    idFactory: () => "merge-attempt-001",
  });
  await merge.approve({
    taskId,
    approvalId: "merge-approval-001",
    humanActor: "john",
    repository: "johntango/ShipMates",
    prNumber: 7,
    headSha: HEAD,
  });
  const mergeResults = await Promise.allSettled([
    merge.merge({
      taskId,
      operationId: "merge-operation-001",
      approvalId: "merge-approval-001",
    }),
    merge.merge({
      taskId,
      operationId: "merge-operation-002",
      approvalId: "merge-approval-001",
    }),
  ]);
  const landed = mergeResults.find(({ status }) => status === "fulfilled").value;

  assert.deepEqual(mergeResults.map(({ status }) => status).sort(), [
    "fulfilled", "rejected",
  ]);
  assert.equal(landed.state, "landed");
  assert.equal(landed.githubMerges[0].result.mergeCommitSha, MERGE);
  assert.equal(mergeCalls, 1);

  const treehouseCalls = [];
  const treehouseWorkflow = new TreehouseLedgerWorkflow({
    store,
    manager: {
      async fetchExactCommit(input) {
        treehouseCalls.push(["fetch", input]);
      },
      async proveExactTreeLanding(input) {
        treehouseCalls.push(["prove", input]);
        return {
          kind: "exact-tree-landing",
          verified: true,
          worktreePath: "/tmp/worktree",
          headSha: HEAD,
          mergedCommitSha: MERGE,
          remoteMainSha: MERGE,
          treeSha: "d".repeat(40),
        };
      },
      async returnLease(input) {
        treehouseCalls.push(["return", input]);
      },
    },
  });
  const postMerge = new PostMergeAssuranceWorkflow({
    store,
    readGateway,
    treehouseWorkflow,
    clock: store.clock,
    idFactory: () => "post-merge-observation-001",
  });
  const completed = await postMerge.complete({
    taskId,
    operationId: "post-merge-operation-001",
  });

  assert.equal(completed.state, "complete");
  assert.equal(completed.worktree.status, "returned");
  assert.equal(completed.worktree.proof.kind, "exact-tree-landing");
  assert.equal(completed.postMergeAssurances[0].mergeCommitSha, MERGE);
  assert.equal(completed.postMergeAssurances[0].requiredChecks.satisfied, true);
  assert.deepEqual(treehouseCalls.map(([name]) => name), ["fetch", "prove", "return"]);

  let remoteTaskHead = HEAD;
  let deleteCalls = 0;
  const cleanup = new BranchCleanupWorkflow({
    store,
    readGateway: {
      readRepository: async () => ({
        nameWithOwner: "johntango/ShipMates",
        defaultBranch: "main",
        archived: false,
        disabled: false,
      }),
    },
    deleteAdapter: {
      inspect: async () => ({ remoteHeadSha: remoteTaskHead }),
      deleteExact: async () => {
        deleteCalls += 1;
        remoteTaskHead = null;
        return cleanupResult("delete-confirmation");
      },
      reconcile: async () => ({
        status: remoteTaskHead === null ? "completed" : "not_deleted",
        evidence: remoteTaskHead === null
          ? cleanupResult("remote-reconciliation")
          : null,
      }),
    },
    idFactory: () => "cleanup-attempt-001",
  });
  await cleanup.approve({
    taskId,
    approvalId: "cleanup-approval-001",
    humanActor: "john",
    repository: "johntango/ShipMates",
    branch: "task-branch",
    headSha: HEAD,
  });
  const cleaned = await cleanup.delete({
    taskId,
    operationId: "cleanup-operation-001",
    approvalId: "cleanup-approval-001",
  });

  assert.equal(cleaned.state, "complete");
  assert.equal(cleaned.branchCleanups[0].status, "completed");
  assert.equal(cleaned.branchCleanups[0].result.deletedHeadSha, HEAD);
  assert.equal(cleaned.branchCleanupApprovals[0].consumedBy, "cleanup-operation-001");
  assert.equal(deleteCalls, 1);
});

function cleanupResult(evidenceKind) {
  return {
    evidenceKind,
    repository: "johntango/ShipMates",
    remoteName: "origin",
    branch: "task-branch",
    remoteRef: "refs/heads/task-branch",
    deletedHeadSha: HEAD,
    remoteHeadSha: null,
    transportOutputSha256: evidenceKind === "delete-confirmation"
      ? "e".repeat(64)
      : null,
    deleted: true,
  };
}

async function preparedStore(t, taskId) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "shipmates-commit-flow-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let timestamp = Date.parse("2026-07-14T00:00:00.000Z");
  const store = new TaskStore({
    rootDir,
    clock: () => new Date(timestamp++),
  });
  await store.createTask({
    taskId,
    kind: "firstmate-intake",
    repo: "johntango/ShipMates",
    baseSha: BASE,
    actor: "firstmate",
    eventId: `${taskId}:created`,
  });
  await transition(store, taskId, "proposed", "clarified");
  await transition(store, taskId, "clarified", "approved_for_dispatch");
  await transition(store, taskId, "approved_for_dispatch", "preparing");
  let snapshot = await store.requestWorktreeLease({
    taskId,
    actor: "firstmate",
    repoPath: "/tmp/repo",
    baseSha: BASE,
    eventId: `${taskId}:lease-request`,
  });
  snapshot = await store.recordWorktreeLease({
    taskId,
    actor: "firstmate",
    requestEventId: snapshot.worktree.leaseRequestEventId,
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/worktree",
    headSha: BASE,
    branch: "task-branch",
    eventId: `${taskId}:leased`,
  });
  await transition(store, taskId, "preparing", "running");
  snapshot = await store.requestWorkerDispatch({
    taskId,
    actor: "firstmate",
    workerId: "implementer",
    backend: "codex-cli",
    mode: "ship",
    worktreePath: "/tmp/worktree",
    sandbox: "workspace-write",
    brief: "Implement task",
    briefSha256: "c".repeat(64),
    eventId: `${taskId}:dispatch`,
  });
  await transition(store, taskId, "running", "awaiting_worker");
  snapshot = await store.recordWorkerStarted({
    taskId,
    actor: "firstmate",
    workerId: "implementer",
    requestEventId: snapshot.workers[0].dispatchEventId,
    threadId: "thread-implementer",
    eventId: `${taskId}:started`,
  });
  snapshot = await store.recordWorkerReport({
    taskId,
    actor: "firstmate",
    workerId: "implementer",
    threadId: "thread-implementer",
    report: {
      taskId,
      status: "completed",
      summary: "Implemented task",
      branch: null,
      commit: null,
      files: ["src/change.js"],
      tests: [],
      risks: [],
    },
    verification: mutationVerification(),
    eventId: `${taskId}:report`,
  });
  await transition(store, taskId, "awaiting_worker", "running");
  return store;
}

async function transition(store, taskId, from, to) {
  return store.transition({
    taskId,
    from,
    to,
    actor: "firstmate",
    eventId: `${taskId}:${from}-${to}`,
  });
}

function mutationVerification() {
  return {
    kind: "workspace-write",
    noMutation: false,
    baseHeadSha: BASE,
    headSha: BASE,
    branchBefore: "task-branch",
    branchAfter: "task-branch",
    commitCreated: false,
    dirty: true,
    changedPaths: ["src/change.js"],
    stagedPaths: [],
    unstagedPaths: ["src/change.js"],
    untrackedPaths: [],
    ignoredPaths: [],
    reportedPathsMatch: true,
  };
}

function commitResult(taskId) {
  return {
    baseHeadSha: BASE,
    headSha: HEAD,
    parentSha: BASE,
    treeSha: "d".repeat(40),
    branch: "task-branch",
    changedPaths: ["src/change.js"],
    messageSha256: createHash("sha256")
      .update(`ShipMates task ${taskId}`)
      .digest("hex"),
    author: {
      name: "ShipMates Firstmate",
      email: "firstmate@shipmates.local",
    },
    committer: {
      name: "ShipMates Firstmate",
      email: "firstmate@shipmates.local",
    },
    clean: true,
    commitCreated: true,
  };
}

function pinEvidence() {
  return {
    name: "no-mistakes",
    pinned: true,
    version: "v1.41.1",
    sourceCommit: "e".repeat(40),
    binarySha256: "f".repeat(64),
  };
}

function validationReport(taskId, intent, observedAt) {
  const names = [
    "intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci",
  ];
  const skipped = new Set(["rebase", "push", "pr", "ci"]);
  return {
    schemaVersion: 1,
    taskId,
    tool: { ...pinEvidence(), binary: "/private/tmp/no-mistakes" },
    mode: "local-only",
    remoteOperations: false,
    intentSha256: createHash("sha256").update(intent).digest("hex"),
    command: {
      args: ["axi", "run", "--intent", intent, "--skip", "rebase,push,pr,ci"],
      skipSteps: ["rebase", "push", "pr", "ci"],
    },
    startedAt: observedAt,
    completedAt: observedAt,
    branch: "task-branch",
    initialHeadSha: HEAD,
    finalHeadSha: HEAD,
    headChanged: false,
    runId: "validation-run-001",
    runStatus: "completed",
    outcome: "passed",
    passed: true,
    findings: 0,
    steps: names.map((step) => ({
      step,
      status: skipped.has(step) ? "skipped" : "completed",
      findings: 0,
      durationMs: 0,
    })),
    gate: null,
    process: {
      exitCode: 0,
      stdoutSha256: "1".repeat(64),
      stderrSha256: "2".repeat(64),
    },
  };
}

function pushResult() {
  return {
    evidenceKind: "push-confirmation",
    repository: "johntango/ShipMates",
    remoteName: "origin",
    branch: "task-branch",
    remoteRef: "refs/heads/task-branch",
    headSha: HEAD,
    previousHeadSha: null,
    remoteHeadSha: HEAD,
    transportOutputSha256: "3".repeat(64),
    pushed: true,
  };
}

function draftPullRequest() {
  const observedAt = "2026-07-14T01:00:00.000Z";
  return {
    repository: "johntango/ShipMates",
    number: 7,
    url: "https://github.com/johntango/ShipMates/pull/7",
    state: "open",
    draft: true,
    title: "Task draft",
    base: { repository: "johntango/ShipMates", branch: "main", sha: BASE },
    head: {
      repository: "johntango/ShipMates",
      owner: "johntango",
      branch: "task-branch",
      sha: HEAD,
    },
    updatedAt: observedAt,
    observedAt,
    source: {
      kind: "github-rest",
      endpoint: "repos/johntango/ShipMates/pulls/7",
    },
  };
}

function mergePullRequest({ merged }) {
  return {
    repository: "johntango/ShipMates",
    number: 7,
    url: "https://github.com/johntango/ShipMates/pull/7",
    state: merged ? "closed" : "open",
    draft: false,
    title: "Task draft",
    merged,
    mergeable: merged ? null : true,
    mergeableState: merged ? "unknown" : "clean",
    mergeCommitSha: merged ? MERGE : null,
    base: { repository: "johntango/ShipMates", branch: "main", sha: BASE },
    head: {
      repository: "johntango/ShipMates",
      owner: "johntango",
      branch: "task-branch",
      sha: HEAD,
    },
    updatedAt: "2026-07-14T02:00:00.000Z",
  };
}
