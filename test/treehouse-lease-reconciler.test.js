import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import {
  TreehouseCapacityBlockedError,
  TreehouseLeaseReconciler,
} from "../src/workflows/treehouse-lease-reconciler.js";

const repoPath = "/repos/shipmates";
const baseSha = "a".repeat(40);

test("recycles only an abandoned clean lease with no live owner", async (t) => {
  const store = await leasedTask(t, "task-abandoned", { state: "running" });
  const calls = [];
  const manager = managerFor([{ holder: "task-abandoned", slot: 1 }], calls);
  const reconciler = new TreehouseLeaseReconciler({
    stores: [store], manager, isOwnerLive: async () => false,
    clock: () => new Date("2026-08-18T00:00:00.000Z"), abandonedAfterMs: 1,
  });

  const result = await reconciler.ensureCapacity({ repoPath });

  assert.equal(result.released.length, 1);
  const snapshot = await store.getSnapshot("task-abandoned");
  assert.equal(snapshot.state, "blocked");
  assert.equal(snapshot.worktree.status, "returned");
  assert.equal(snapshot.worktree.proof.kind, "no-mutation");
  assert.deepEqual(calls, ["list", "prove:task-abandoned", "return:task-abandoned"]);
});

test("allows an empty or available pool without attempting reconciliation", async () => {
  for (const entries of [[], [{ state: "available", leaseHolder: null, worktreePath: "/treehouse/free" }]]) {
    const calls = [];
    const result = await new TreehouseLeaseReconciler({
      stores: [{ async getSnapshot() { assert.fail("no owner lookup expected"); } }],
      manager: { async list() { calls.push("list"); return entries; } },
    }).ensureCapacity({ repoPath });
    assert.deepEqual(result.released, []);
    assert.deepEqual(calls, ["list"]);
  }
});

test("recycles a conclusively terminal clean lease without an age delay", async (t) => {
  const store = await leasedTask(t, "task-cancelled", { state: "cancelled" });
  const calls = [];
  const reconciler = new TreehouseLeaseReconciler({
    stores: [store], manager: managerFor([{ holder: "task-cancelled", slot: 1 }], calls),
    isOwnerLive: async () => false,
    clock: () => new Date("2026-08-16T00:00:00.001Z"),
    abandonedAfterMs: 60_000,
  });

  const result = await reconciler.reconcileEligible({ repoPath });

  assert.equal(result.released.length, 1);
  assert.equal((await store.getSnapshot("task-cancelled")).state, "cancelled");
  assert.equal((await store.getSnapshot("task-cancelled")).worktree.status, "returned");
});

test("preserves live, dirty, recent, and unknown leases and fails closed", async (t) => {
  const store = await leasedTask(t, "task-live", { state: "failed" });
  const entries = [
    { holder: "task-live", slot: 1 },
    { holder: "task-unknown", slot: 2 },
  ];
  const calls = [];
  const reconciler = new TreehouseLeaseReconciler({
    stores: [store], manager: managerFor(entries, calls),
    isOwnerLive: async (taskId) => taskId === "task-live",
  });

  await assert.rejects(
    reconciler.ensureCapacity({ repoPath }),
    TreehouseCapacityBlockedError,
  );
  assert.deepEqual(calls, ["list"]);
  assert.equal((await store.getSnapshot("task-live")).worktree.status, "leased");
});

test("reconciles a completed prior return without issuing it twice", async (t) => {
  const store = await leasedTask(t, "task-returning", { state: "failed" });
  const proof = {
    kind: "no-mutation", verified: true,
    worktreePath: worktree("task-returning"), headSha: baseSha,
  };
  let snapshot = await store.recordWorktreeProof({
    taskId: "task-returning", actor: "test", proof, eventId: "proof",
  });
  await store.requestWorktreeReturn({
    taskId: snapshot.id, actor: "test", worktreePath: proof.worktreePath,
    proofEventId: snapshot.worktree.proof.eventId, eventId: "return-request",
  });
  const calls = [];
  const manager = managerFor([{ holder: "task-returning", slot: 1 }], calls, {
    observedState: "available",
  });
  const reconciler = new TreehouseLeaseReconciler({
    stores: [store], manager, isOwnerLive: async () => false,
  });

  const result = await reconciler.ensureCapacity({ repoPath });

  assert.equal(result.released[0].reconciled, true);
  assert.equal((await store.getSnapshot("task-returning")).worktree.status, "returned");
  assert.deepEqual(calls, ["list", "find:task-returning"]);
});

async function leasedTask(t, taskId, { state }) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "shipmates-recycler-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({
    rootDir,
    clock: () => new Date("2026-08-16T00:00:00.000Z"),
  });
  await store.createTask({ taskId, kind: "test", repo: "owner/repo", baseSha, actor: "test", eventId: "created" });
  await store.transition({ taskId, from: "proposed", to: "clarified", actor: "test", eventId: "clarified" });
  await store.transition({ taskId, from: "clarified", to: "approved_for_dispatch", actor: "test", eventId: "approved" });
  await store.transition({ taskId, from: "approved_for_dispatch", to: "preparing", actor: "test", eventId: "preparing" });
  await store.requestWorktreeLease({ taskId, actor: "test", repoPath, baseSha, eventId: "lease-request" });
  await store.recordWorktreeLease({
    taskId, actor: "test", requestEventId: "lease-request", repoPath,
    worktreePath: worktree(taskId), headSha: baseSha, branch: null, eventId: "leased",
  });
  await store.transition({ taskId, from: "preparing", to: "running", actor: "test", eventId: "running" });
  if (state !== "running") {
    await store.transition({ taskId, from: "running", to: state, actor: "test", eventId: state });
  }
  return store;
}

function managerFor(entries, calls, { observedState = "leased" } = {}) {
  return {
    async list() {
      calls.push("list");
      return entries.map(({ holder, slot }) => ({
        state: "leased", leaseHolder: holder, worktreePath: worktree(holder), slot,
      }));
    },
    async proveNoMutation({ worktreePath: target }) {
      const taskId = path.basename(target);
      calls.push(`prove:${taskId}`);
      return { kind: "no-mutation", verified: true, worktreePath: target, headSha: baseSha };
    },
    async returnLease({ worktreePath: target }) {
      calls.push(`return:${path.basename(target)}`);
    },
    async findWorktree({ worktreePath: target }) {
      calls.push(`find:${path.basename(target)}`);
      return { state: observedState, leaseHolder: observedState === "available" ? null : path.basename(target), worktreePath: target };
    },
  };
}

function worktree(taskId) {
  return `/treehouse/${taskId}`;
}
