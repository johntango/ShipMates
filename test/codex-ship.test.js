import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { projectHerdrSnapshot } from "../src/projections/herdr.js";
import { TaskStore } from "../src/storage/task-store.js";
import {
  CodexShipAuthorityError,
  CodexShipWorkflow,
} from "../src/workflows/codex-ship.js";

const taskId = "ship-worker-task-001";
const headSha = "a".repeat(40);
const worktreePath = "/tmp/treehouse/ship-worker/repo";
const brief = "Add a bounded watch rotation API.";

test("records an exact independently verified workspace mutation", async (t) => {
  const store = await runningTask(t);
  const manager = new FakeWorktreeManager();
  const observed = [];
  let runs = 0;
  const workflow = new CodexShipWorkflow({
    store,
    worktreeManager: manager,
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run(input) {
        runs += 1;
        assert.equal(input.sandbox, "workspace-write");
        assert.equal(input.workingDirectory, worktreePath);
        await input.onEvent?.({ type: "item.started", item: { type: "file_change" } });
        manager.mutate(["src/watch.js", "test/watch.test.js"]);
        return completedResult();
      },
      async loadCompleted() {
        throw new Error("must not reconcile a normal run");
      },
    },
    observer: {
      async workerStarted({ workerId }) { observed.push(`${workerId}:started`); },
      async workerEvent({ workerId }) { observed.push(`${workerId}:event`); },
      async workerFinished({ workerId }) { observed.push(`${workerId}:finished`); },
    },
  });

  const first = await workflow.run({ taskId, brief });
  assert.equal(first.reused, false);
  assert.equal(first.snapshot.state, "running");
  assert.equal(first.worker.status, "reported");
  assert.equal(first.worker.mode, "ship");
  assert.equal(first.worker.verification.kind, "workspace-write");
  assert.equal(first.worker.verification.noMutation, false);
  assert.equal(first.worker.verification.commitCreated, false);
  assert.deepEqual(first.worker.verification.changedPaths, [
    "src/watch.js",
    "test/watch.test.js",
  ]);
  const projection = projectHerdrSnapshot(first.snapshot);
  assert.equal(projection.workers[0].verificationKind, "workspace-write");
  assert.equal(projection.workers[0].changedPaths, 2);
  assert.deepEqual(observed, [
    "implementer:started",
    "implementer:event",
    "implementer:finished",
  ]);

  const second = await workflow.run({ taskId, brief });
  assert.equal(second.reused, true);
  assert.equal(runs, 1);
});

test("reconciles completed artifacts without dispatching the worker again", async (t) => {
  const store = await runningTask(t);
  const manager = new FakeWorktreeManager();
  await store.requestWorkerDispatch({
    taskId,
    actor: "firstmate",
    workerId: "implementer",
    backend: "codex-cli",
    mode: "ship",
    worktreePath,
    sandbox: "workspace-write",
    brief,
    briefSha256: digest(brief),
    eventId: `${taskId}:worker:implementer:dispatch:v1`,
  });
  await store.transition({
    taskId,
    from: "running",
    to: "awaiting_worker",
    actor: "firstmate",
    eventId: `${taskId}:worker:implementer:awaiting-worker:v1`,
  });
  const workflow = new CodexShipWorkflow({
    store,
    worktreeManager: manager,
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run() { throw new Error("must not dispatch again"); },
      async loadCompleted() {
        manager.mutate(["src/watch.js", "test/watch.test.js"]);
        return completedResult();
      },
    },
  });

  const result = await workflow.reconcile({ taskId });
  assert.equal(result.worker.status, "reported");
  assert.equal(result.snapshot.state, "running");
  assert.equal(result.worker.threadId, "thread-implementer");
});

test("fails closed when changed paths differ from the worker report", async (t) => {
  const store = await runningTask(t);
  const manager = new FakeWorktreeManager();
  const workflow = new CodexShipWorkflow({
    store,
    worktreeManager: manager,
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run() {
        manager.mutate(["src/watch.js", "unexpected.txt"]);
        return completedResult();
      },
      async loadCompleted() { throw new Error("not used"); },
    },
  });

  await assert.rejects(workflow.run({ taskId, brief }), CodexShipAuthorityError);
  const snapshot = await store.getSnapshot(taskId);
  assert.equal(snapshot.state, "awaiting_worker");
  assert.equal(snapshot.workers[0].status, "started");
  assert.equal(snapshot.workers[0].verification, null);
});

test("records a blocked workspace-write attempt that made no changes", async (t) => {
  const store = await runningTask(t);
  const manager = new FakeWorktreeManager();
  const workflow = new CodexShipWorkflow({
    store,
    worktreeManager: manager,
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run() {
        const result = completedResult();
        result.report.status = "blocked";
        result.report.summary = "Required interface is unspecified.";
        result.report.files = [];
        return result;
      },
      async loadCompleted() { throw new Error("not used"); },
    },
  });

  const result = await workflow.run({ taskId, brief });
  assert.equal(result.worker.report.status, "blocked");
  assert.equal(result.worker.verification.noMutation, true);
  assert.equal(result.worker.verification.dirty, false);
  assert.deepEqual(result.worker.verification.changedPaths, []);
});

test("records a tested completed no-op when the requested behavior already exists", async (t) => {
  const store = await runningTask(t);
  const manager = new FakeWorktreeManager();
  const workflow = new CodexShipWorkflow({
    store,
    worktreeManager: manager,
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run() {
        const result = completedResult();
        result.report.files = [];
        return result;
      },
      async loadCompleted() { throw new Error("not used"); },
    },
  });

  const result = await workflow.run({ taskId, brief });
  assert.equal(result.worker.report.status, "completed");
  assert.equal(result.worker.verification.noMutation, true);
  assert.deepEqual(result.worker.verification.changedPaths, []);
});

test("rejects a worker that staged repository changes", async (t) => {
  const store = await runningTask(t);
  const manager = new FakeWorktreeManager();
  const workflow = new CodexShipWorkflow({
    store,
    worktreeManager: manager,
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run() {
        manager.stage(["src/watch.js", "test/watch.test.js"]);
        return completedResult();
      },
      async loadCompleted() { throw new Error("not used"); },
    },
  });

  await assert.rejects(workflow.run({ taskId, brief }), CodexShipAuthorityError);
});

test("rejects ignored files created by a worker", async (t) => {
  const store = await runningTask(t);
  const manager = new FakeWorktreeManager();
  const workflow = new CodexShipWorkflow({
    store,
    worktreeManager: manager,
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run() {
        manager.mutate(["src/watch.js", "test/watch.test.js"]);
        manager.ignoredPaths = [".env"];
        return completedResult();
      },
      async loadCompleted() { throw new Error("not used"); },
    },
  });

  await assert.rejects(workflow.run({ taskId, brief }), CodexShipAuthorityError);
});

test("moves an ordinary mutating-worker failure to recovery required", async (t) => {
  const store = await runningTask(t);
  const manager = new FakeWorktreeManager();
  const workflow = new CodexShipWorkflow({
    store,
    worktreeManager: manager,
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run() {
        manager.mutate(["partial.txt"]);
        throw new Error("worker process failed");
      },
      async loadCompleted() { throw new Error("not used"); },
    },
  });

  await assert.rejects(workflow.run({ taskId, brief }), /worker process failed/u);
  const snapshot = await store.getSnapshot(taskId);
  assert.equal(snapshot.state, "recovery_required");
  assert.equal(snapshot.workers[0].status, "failed");
});

class FakeWorktreeManager {
  constructor() {
    this.dirty = false;
    this.changedPaths = [];
    this.stagedPaths = [];
    this.ignoredPaths = [];
  }

  mutate(changedPaths) {
    this.changedPaths = [...changedPaths].sort();
    this.stagedPaths = [];
    this.dirty = this.changedPaths.length > 0;
  }

  stage(changedPaths) {
    this.changedPaths = [...changedPaths].sort();
    this.stagedPaths = [...this.changedPaths];
    this.dirty = this.changedPaths.length > 0;
  }

  async inspect() {
    return {
      worktreePath,
      headSha,
      branch: null,
      dirty: this.dirty,
      changes: this.changedPaths.map((value) => ` M ${value}`),
    };
  }

  async listChangedPaths() {
    return [...this.changedPaths];
  }

  async inspectChangedPaths() {
    return {
      staged: [...this.stagedPaths],
      unstaged: this.stagedPaths.length > 0 ? [] : [...this.changedPaths],
      untracked: [],
      ignored: [...this.ignoredPaths],
      all: [...this.changedPaths],
    };
  }
}

async function runningTask(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "codex-ship-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({
    taskId,
    kind: "code-change",
    repo: "johntango/Shipmates-Practice",
    baseSha: headSha,
    actor: "firstmate",
    eventId: "created",
  });
  for (const [from, to] of [
    ["proposed", "clarified"],
    ["clarified", "approved_for_dispatch"],
    ["approved_for_dispatch", "preparing"],
  ]) await store.transition({ taskId, from, to, actor: "firstmate", eventId: to });
  await store.requestWorktreeLease({
    taskId,
    actor: "firstmate",
    repoPath: "/repos/practice",
    baseSha: headSha,
    eventId: "lease-request",
  });
  await store.recordWorktreeLease({
    taskId,
    actor: "firstmate",
    requestEventId: "lease-request",
    repoPath: "/repos/practice",
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
    eventId: "running",
  });
  return store;
}

function completedResult() {
  return {
    threadId: "thread-implementer",
    eventCount: 5,
    report: {
      taskId,
      status: "completed",
      summary: "Added the watch rotation API.",
      branch: null,
      commit: null,
      files: ["src/watch.js", "test/watch.test.js"],
      tests: [{ command: "node --test", result: "passed" }],
      risks: [],
    },
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
