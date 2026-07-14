import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import {
  TaskBranchRecoveryRequiredError,
  TaskBranchWorkflow,
} from "../src/workflows/task-branch.js";

const taskId = "task-branch-live-gap";
const headSha = "a".repeat(40);
const repoPath = "/repos/practice";
const worktreePath = "/tmp/treehouse/practice/1/repo";

test("records deterministic branch preparation before worker dispatch", async (t) => {
  const store = await detachedTask(t);
  const calls = [];
  const result = {
    branch: `agent/${taskId}`,
    headSha,
    dirty: false,
    changedPaths: [],
  };
  const workflow = new TaskBranchWorkflow({
    store,
    manager: {
      async prepareTaskBranch(input) {
        calls.push(["prepare", input]);
        return result;
      },
      async inspectPreparedTaskBranch(input) {
        calls.push(["inspect", input]);
        return result;
      },
    },
    idFactory: () => "branch-attempt-001",
  });

  const first = await workflow.prepare({ taskId });
  assert.equal(first.snapshot.worktree.branch, `agent/${taskId}`);
  assert.equal(first.snapshot.worktree.branchPreparation.status, "completed");
  assert.deepEqual(calls.map(([kind]) => kind), ["prepare"]);

  const second = await workflow.prepare({ taskId });
  assert.equal(second.reused, true);
  assert.equal(calls.length, 1);
});

test("reconciles uncertain branch preparation without a second mutation", async (t) => {
  const store = await detachedTask(t);
  let mutations = 0;
  const result = {
    branch: `agent/${taskId}`,
    headSha,
    dirty: false,
    changedPaths: [],
  };
  const workflow = new TaskBranchWorkflow({
    store,
    manager: {
      async prepareTaskBranch() {
        mutations += 1;
        throw new Error("transport result lost");
      },
      async inspectPreparedTaskBranch() {
        return result;
      },
    },
    idFactory: () => "branch-attempt-001",
  });

  await assert.rejects(
    workflow.prepare({ taskId }),
    TaskBranchRecoveryRequiredError,
  );
  await assert.rejects(
    workflow.prepare({ taskId }),
    TaskBranchRecoveryRequiredError,
  );
  assert.equal(mutations, 1);

  const recovered = await workflow.reconcile({ taskId });
  assert.equal(recovered.snapshot.worktree.branch, `agent/${taskId}`);
  assert.equal(mutations, 1);
});

async function detachedTask(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "task-branch-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({
    taskId,
    kind: "firstmate-intake",
    repo: "johntango/Shipmates-Practice",
    baseSha: headSha,
    actor: "firstmate",
    eventId: "created",
  });
  for (const [from, to] of [
    ["proposed", "clarified"],
    ["clarified", "approved_for_dispatch"],
    ["approved_for_dispatch", "preparing"],
  ]) {
    await store.transition({
      taskId, from, to, actor: "firstmate", eventId: `state-${to}`,
    });
  }
  await store.requestWorktreeLease({
    taskId,
    actor: "firstmate",
    repoPath,
    baseSha: headSha,
    eventId: "lease-request",
  });
  await store.recordWorktreeLease({
    taskId,
    actor: "firstmate",
    requestEventId: "lease-request",
    repoPath,
    worktreePath,
    headSha,
    branch: null,
    eventId: "leased",
  });
  await store.transition({
    taskId,
    from: "preparing",
    to: "running",
    actor: "firstmate",
    eventId: "state-running",
  });
  return store;
}
