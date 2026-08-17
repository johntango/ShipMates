import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TaskStore } from "../src/storage/task-store.js";

import {
  authorizeFirstmateDispatch,
  isProcessReceiptLive,
  readProcessCommand,
  ReadOnlyInspectionTracker,
  verifyAuthorizedClassification,
} from "../src/workflows/firstmate-dispatch-policy.js";

test("rejects unauthorized work before any Scout can launch", () => {
  let launches = 0;
  assert.throws(() => {
    authorizeFirstmateDispatch({ requiredAuthority: "external_write", project: planningProject() });
    launches += 1;
  }, /separate approval workflow/u);
  assert.equal(launches, 0);
  assert.throws(() => {
    verifyAuthorizedClassification("read_only", "local_write");
    launches += 1;
  }, /authorized read_only work was classified as local_write/u);
  assert.equal(launches, 0);
});

test("authorizes durably tracked read-only inspection without project approval", async () => {
  const events = [];
  const tracker = new ReadOnlyInspectionTracker({ store: {
    async listTaskIds() { return []; },
    async withExclusiveLock(_lockId, operation) { return operation(); },
    async createTask(value) { events.push({ kind: "task", value }); },
    async recordEvidence(value) { events.push({ kind: value.kind, value }); },
  } });
  const result = authorizeFirstmateDispatch({
    requiredAuthority: "read_only", project: planningProject(), plannedTask: null,
  });
  assert.deepEqual(result, { mode: "read_only", trackProjectAttempt: false });
  await tracker.prepare({
    taskId: "task-read", requestId: "request-read", repo: "owner/repo",
    baseSha: "abc123", project: planningProject(),
  });
  await tracker.recordReceipt({
    taskId: "task-read", requestId: "request-read", receipt: { pid: 42 },
  });
  assert.deepEqual(events.map(({ kind }) => kind), [
    "task", "read-only-dispatch-intent", "read-only-launch-receipt",
  ]);
  assert.equal(events[0].value.kind, "firstmate-intake");
});

test("preserves the approved-plan requirement for implementation work", () => {
  assert.throws(() => authorizeFirstmateDispatch({
    requiredAuthority: "local_write", project: planningProject(), plannedTask: null,
  }), /approved project plan/u);
  assert.deepEqual(authorizeFirstmateDispatch({
    requiredAuthority: "local_write",
    project: { ...planningProject(), status: "approved" },
    plannedTask: { id: "plan-1", status: "claimed" },
  }), { mode: "implementation", trackProjectAttempt: true });
});

test("reconciles a completed fresh-state inspection without approval or duplicate launch", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-read-only-"));
  const store = new TaskStore({ rootDir });
  const tracker = new ReadOnlyInspectionTracker({ store });
  const input = {
    taskId: "task-read-only", requestId: "request-read-only",
    repo: "owner/repo", baseSha: "abc123", project: planningProject(),
  };
  await tracker.prepare(input);
  await tracker.recordReceipt({
    taskId: input.taskId, requestId: input.requestId,
    receipt: { kind: "process", pid: 42 },
  });
  await store.recordEvidence({
    taskId: input.taskId, actor: "firstmate", kind: "firstmate-local-execution",
    value: JSON.stringify({
      requestId: input.requestId, status: "inspected", scouts: [
        { workerId: "scout-1", status: "completed" },
        { workerId: "scout-2", status: "completed" },
      ], implementation: null, failure: null,
    }),
    eventId: "worker-completed",
  });

  const recovered = await new ReadOnlyInspectionTracker({ store }).reconcileInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].terminal.status, "completed");
  assert.equal((await tracker.reconcileInterrupted()).length, 0);
  const snapshot = await store.getSnapshot(input.taskId);
  assert.equal(snapshot.state, "proposed");
  assert.deepEqual(snapshot.evidence.map(({ kind }) => kind), [
    "read-only-dispatch-intent", "read-only-launch-receipt",
    "firstmate-local-execution", "read-only-inspection-terminal",
  ]);
});

test("refuses a replacement while an interrupted read-only inspection is outstanding", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-read-only-lock-"));
  const store = new TaskStore({ rootDir });
  const tracker = new ReadOnlyInspectionTracker({ store });
  await tracker.prepare({
    taskId: "task-original", requestId: "request-original",
    repo: "owner/repo", baseSha: "abc123", project: planningProject(),
  });
  await tracker.recordReceipt({
    taskId: "task-original", requestId: "request-original",
    receipt: { kind: "process", pid: 42 },
  });

  await assert.rejects(tracker.prepare({
    taskId: "task-replacement", requestId: "request-replacement",
    repo: "owner/repo", baseSha: "abc123", project: planningProject(),
  }), /task-original is still outstanding/u);
  assert.deepEqual(await store.listTaskIds(), ["task-original"]);
});

test("atomically permits only one concurrent read-only inspection", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-read-only-race-"));
  const store = new TaskStore({ rootDir });
  const tracker = new ReadOnlyInspectionTracker({ store });
  const attempts = ["one", "two"].map((suffix) => tracker.prepare({
    taskId: `task-${suffix}`, requestId: `request-${suffix}`,
    repo: "owner/repo", baseSha: "abc123", project: planningProject(),
  }));
  const results = await Promise.allSettled(attempts);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await store.listTaskIds()).length, 1);
});

test("terminates a missing interrupted worker and permits retry", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-read-only-retry-"));
  const store = new TaskStore({ rootDir });
  const tracker = new ReadOnlyInspectionTracker({ store, isReceiptLive: () => false });
  await tracker.prepare({
    taskId: "task-stopped", requestId: "request-stopped",
    repo: "owner/repo", baseSha: "abc123", project: planningProject(),
  });
  await tracker.recordReceipt({
    taskId: "task-stopped", requestId: "request-stopped",
    receipt: { kind: "process", pid: 42 },
  });
  const reconciled = await tracker.reconcileInterrupted();
  assert.equal(reconciled[0].terminal.status, "failed");
  await tracker.prepare({
    taskId: "task-retry", requestId: "request-retry",
    repo: "owner/repo", baseSha: "abc123", project: planningProject(),
  });
  assert.deepEqual(await store.listTaskIds(), ["task-retry", "task-stopped"]);
});

test("requires a matching command identity when recovering a process receipt", () => {
  const options = {
    signalProcess() {},
    readCommand: () => "/node /firstmate.js task-one request-original owner/repo abc",
  };
  assert.equal(isProcessReceiptLive({
    kind: "process", pid: 42, commandToken: "request-original",
  }, options), true);
  assert.equal(isProcessReceiptLive({
    kind: "process", pid: 42, commandToken: "request-reused",
  }, options), false);
});

test("reads an untruncated process command for recovery identity", () => {
  let invocation;
  const command = readProcessCommand(42, (...args) => {
    invocation = args;
    return "full worker command";
  });
  assert.equal(command, "full worker command");
  assert.deepEqual(invocation, [
    "ps", ["-ww", "-o", "command=", "-p", "42"], { encoding: "utf8" },
  ]);
});

function planningProject() {
  return { id: "project-1", status: "planning", tasks: [] };
}
