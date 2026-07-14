import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import {
  FirstmateCommitRecoveryRequiredError,
  FirstmateCommitWorkflow,
} from "../src/workflows/firstmate-commit.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

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

async function preparedStore(t, taskId) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "shipmates-commit-flow-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
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
