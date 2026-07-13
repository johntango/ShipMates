import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import {
  TreehouseLedgerWorkflow,
  TreehouseRecoveryRequiredError,
} from "../src/workflows/treehouse-ledger.js";

const repoPath = "/repos/practice";
const worktreePath = "/tmp/treehouse/practice/1/repo";
const baseSha = "abc123";

test("records a complete no-mutation Treehouse lifecycle", async (t) => {
  const store = await approvedTask(t);
  const calls = [];
  const manager = fakeManager(calls);
  const workflow = new TreehouseLedgerWorkflow({ store, manager });

  let snapshot = await workflow.acquire({
    taskId: "treehouse-ledger-001",
    repoPath,
  });
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.worktree.status, "leased");

  snapshot = await workflow.completeNoMutation({
    taskId: "treehouse-ledger-001",
  });

  assert.equal(snapshot.state, "complete");
  assert.equal(snapshot.worktree.status, "returned");
  assert.equal(snapshot.worktree.proof.kind, "no-mutation");
  assert.deepEqual(calls, [
    "prepare",
    "lease",
    "inspect",
    "prove-no-mutation",
    "return",
  ]);
});

test("does not repeat an uncertain external lease acquisition", async (t) => {
  const store = await approvedTask(t);
  await store.transition({
    taskId: "treehouse-ledger-001",
    from: "approved_for_dispatch",
    to: "preparing",
    actor: "firstmate",
    eventId: "preparing",
  });
  await store.requestWorktreeLease({
    taskId: "treehouse-ledger-001",
    actor: "firstmate",
    repoPath,
    baseSha,
    eventId: "lease-request",
  });
  const calls = [];
  const workflow = new TreehouseLedgerWorkflow({
    store,
    manager: fakeManager(calls),
  });

  await assert.rejects(
    workflow.acquire({ taskId: "treehouse-ledger-001", repoPath }),
    TreehouseRecoveryRequiredError,
  );
  assert.deepEqual(calls, []);

  const snapshot = await workflow.reconcileAcquisition({
    taskId: "treehouse-ledger-001",
    repoPath,
    worktreePath,
  });
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.worktree.status, "leased");
  assert.deepEqual(calls, ["find-lease", "inspect"]);
});

test("reconciles an uncertain return without returning twice", async (t) => {
  const store = await approvedTask(t);
  const setupManager = fakeManager([]);
  const setupWorkflow = new TreehouseLedgerWorkflow({
    store,
    manager: setupManager,
  });
  await setupWorkflow.acquire({
    taskId: "treehouse-ledger-001",
    repoPath,
  });
  await store.transition({
    taskId: "treehouse-ledger-001",
    from: "running",
    to: "validating",
    actor: "firstmate",
    eventId: "validating",
  });
  await store.recordWorktreeProof({
    taskId: "treehouse-ledger-001",
    actor: "firstmate",
    eventId: "proof",
    proof: {
      kind: "no-mutation",
      verified: true,
      worktreePath,
      headSha: baseSha,
    },
  });
  await store.transition({
    taskId: "treehouse-ledger-001",
    from: "validating",
    to: "cleaning",
    actor: "firstmate",
    eventId: "cleaning",
  });
  await store.requestWorktreeReturn({
    taskId: "treehouse-ledger-001",
    actor: "firstmate",
    worktreePath,
    proofEventId: "proof",
    eventId: "return-request",
  });

  const calls = [];
  const workflow = new TreehouseLedgerWorkflow({
    store,
    manager: fakeManager(calls),
  });
  await assert.rejects(
    workflow.completeNoMutation({ taskId: "treehouse-ledger-001" }),
    TreehouseRecoveryRequiredError,
  );
  assert.deepEqual(calls, []);

  const snapshot = await workflow.reconcileReturn({
    taskId: "treehouse-ledger-001",
  });
  assert.equal(snapshot.state, "complete");
  assert.equal(snapshot.worktree.status, "returned");
  assert.deepEqual(calls, ["find-worktree"]);
});

async function approvedTask(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "shipmates-workflow-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({
    taskId: "treehouse-ledger-001",
    kind: "no-mutation-exercise",
    repo: "johntango/Shipmates-Practice",
    baseSha,
    actor: "firstmate",
    eventId: "created",
  });
  await store.transition({
    taskId: "treehouse-ledger-001",
    from: "proposed",
    to: "clarified",
    actor: "firstmate",
    eventId: "clarified",
  });
  await store.transition({
    taskId: "treehouse-ledger-001",
    from: "clarified",
    to: "approved_for_dispatch",
    actor: "firstmate",
    eventId: "approved",
  });
  return store;
}

function fakeManager(calls) {
  return {
    async prepareRepository() {
      calls.push("prepare");
      return "refs/remotes/origin/main";
    },
    async lease() {
      calls.push("lease");
      return { worktreePath };
    },
    async inspect() {
      calls.push("inspect");
      return {
        worktreePath,
        headSha: baseSha,
        branch: null,
        dirty: false,
        changes: [],
      };
    },
    async proveNoMutation() {
      calls.push("prove-no-mutation");
      return {
        kind: "no-mutation",
        verified: true,
        worktreePath,
        headSha: baseSha,
      };
    },
    async returnLease() {
      calls.push("return");
    },
    async findLease() {
      calls.push("find-lease");
      return {
        state: "leased",
        leaseHolder: "treehouse-ledger-001",
        worktreePath,
      };
    },
    async findWorktree() {
      calls.push("find-worktree");
      return {
        state: "available",
        leaseHolder: null,
        worktreePath,
      };
    },
  };
}
