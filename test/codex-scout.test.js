import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import {
  CodexScoutRecoveryRequiredError,
  CodexScoutWorkflow,
} from "../src/workflows/codex-scout.js";

const taskId = "codex-scout-001";
const workerId = "scout-001";
const repoPath = "/repos/practice";
const worktreePath = "/tmp/treehouse/practice/1/repo";
const headSha = "abc123";

test("records a verified read-only Codex report", async (t) => {
  const store = await runningLeasedTask(t);
  const runtimeCalls = [];
  const workflow = workflowFor({ store, runtimeCalls });

  const snapshot = await workflow.run({
    taskId,
    workerId,
    brief: "Identify the exported message function.",
  });

  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.workers[0].status, "reported");
  assert.equal(snapshot.workers[0].threadId, "thread-123");
  assert.equal(snapshot.workers[0].verification.noMutation, true);
  assert.equal(runtimeCalls.length, 1);
  assert.equal(runtimeCalls[0].sandbox, "read-only");
  assert.equal(snapshot.workers[0].backend, "codex-mcp");
});

test("does not dispatch an existing uncertain worker twice", async (t) => {
  const store = await runningLeasedTask(t);
  await requestWorker(store);
  await store.transition({
    taskId,
    from: "running",
    to: "awaiting_worker",
    actor: "firstmate",
    eventId: "awaiting",
  });
  const runtimeCalls = [];
  const workflow = workflowFor({ store, runtimeCalls });

  await assert.rejects(
    workflow.run({ taskId, workerId, brief: "Inspect exports" }),
    CodexScoutRecoveryRequiredError,
  );
  assert.equal(runtimeCalls.length, 0);

  const snapshot = await workflow.reconcile({ taskId, workerId });
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.workers[0].status, "reported");
});

test("refuses a report if the worktree changed during the scout", async (t) => {
  const store = await runningLeasedTask(t);
  let inspections = 0;
  const workflow = workflowFor({
    store,
    runtimeCalls: [],
    inspect: async () => {
      inspections += 1;
      return inspection({ dirty: inspections > 1 });
    },
  });

  await assert.rejects(
    workflow.run({ taskId, workerId, brief: "Inspect exports" }),
    /dirty or no longer matches/u,
  );
  const snapshot = await store.getSnapshot(taskId);
  assert.equal(snapshot.state, "awaiting_worker");
  assert.equal(snapshot.workers[0].status, "started");
  assert.equal(snapshot.workers[0].report, null);
});

test("stores only a sanitized worker failure", async (t) => {
  const store = await runningLeasedTask(t);
  const workflow = new CodexScoutWorkflow({
    store,
    schemaPath: path.resolve("schemas/codex-worker-report.schema.json"),
    worktreeManager: { inspect: async () => inspection() },
    runtime: {
      backend: "codex-mcp",
      async run() {
        throw new Error("secret raw MCP response");
      },
    },
  });

  await assert.rejects(
    workflow.run({ taskId, workerId, brief: "Inspect exports" }),
    /secret raw MCP response/u,
  );
  const snapshot = await store.getSnapshot(taskId);
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.workers[0].status, "failed");
  assert.equal(snapshot.workers[0].failure, "Codex scout failed (Error)");
  assert.doesNotMatch(JSON.stringify(snapshot), /secret raw MCP response/u);
});

test("records and reuses a verified crash-safe scout reply", async (t) => {
  const store = await runningLeasedTask(t);
  const runtimeCalls = [];
  const workflow = workflowFor({ store, runtimeCalls });
  await workflow.run({ taskId, workerId, brief: "Inspect exports" });

  const first = await workflow.reply({
    taskId,
    workerId,
    replyId: "reply-001",
    prompt: "Clarify the risk",
  });
  const reply = first.workers[0].replies[0];
  assert.equal(reply.status, "completed");
  assert.equal(reply.threadId, "thread-123");
  assert.equal(reply.leaseHeadSha, headSha);
  assert.equal(reply.sandbox, "read-only");
  assert.equal(reply.verification.noMutation, true);
  assert.equal(runtimeCalls.filter(({ operation }) => operation === "reply").length, 1);

  const reused = await workflow.reply({
    taskId,
    workerId,
    replyId: "reply-001",
    prompt: "Clarify the risk",
  });
  assert.equal(reused.eventsCount, first.eventsCount);
  assert.equal(runtimeCalls.filter(({ operation }) => operation === "reply").length, 1);
  await assert.rejects(
    workflow.reply({
      taskId,
      workerId,
      replyId: "reply-001",
      prompt: "A different prompt",
    }),
    /different prompt digest/u,
  );
});

test("reconciles a reply after restart without repeating codex-reply", async (t) => {
  const store = await runningLeasedTask(t);
  const initialCalls = [];
  const initial = workflowFor({ store, runtimeCalls: initialCalls });
  await initial.run({ taskId, workerId, brief: "Inspect exports" });
  const prompt = "Clarify after restart";
  await store.requestWorkerReply({
    taskId,
    actor: "firstmate",
    workerId,
    replyId: "reply-restart",
    threadId: "thread-123",
    leaseHeadSha: headSha,
    sandbox: "read-only",
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    eventId: `${taskId}:worker:${workerId}:reply:reply-restart:requested:v1`,
  });
  await store.transition({
    taskId,
    from: "running",
    to: "awaiting_worker",
    actor: "firstmate",
    eventId: `${taskId}:worker:${workerId}:reply:reply-restart:awaiting-worker:v1`,
  });

  const calls = [];
  const restarted = workflowFor({ store, runtimeCalls: calls });
  await assert.rejects(
    restarted.reply({ taskId, workerId, replyId: "reply-restart", prompt }),
    CodexScoutRecoveryRequiredError,
  );
  const snapshot = await restarted.reconcileReply({
    taskId,
    workerId,
    replyId: "reply-restart",
  });
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.workers[0].replies[0].status, "completed");
  assert.deepEqual(calls.map(({ operation }) => operation), ["load-reply"]);
});

function workflowFor({ store, runtimeCalls, inspect = async () => inspection() }) {
  const result = completedResult();
  return new CodexScoutWorkflow({
    store,
    schemaPath: path.resolve("schemas/codex-worker-report.schema.json"),
    worktreeManager: { inspect },
    runtime: {
      backend: "codex-mcp",
      async run(options) {
        runtimeCalls.push({ operation: "run", ...options });
        return result;
      },
      async loadCompleted() {
        return result;
      },
      async reply(options) {
        runtimeCalls.push({ operation: "reply", ...options });
        return result;
      },
      async loadCompletedReply(options) {
        runtimeCalls.push({ operation: "load-reply", ...options });
        return result;
      },
    },
  });
}

async function runningLeasedTask(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "codex-scout-workflow-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({
    taskId,
    kind: "scout",
    repo: "johntango/Shipmates-Practice",
    baseSha: headSha,
    actor: "firstmate",
    eventId: "created",
  });
  await store.transition({
    taskId,
    from: "proposed",
    to: "clarified",
    actor: "firstmate",
    eventId: "clarified",
  });
  await store.transition({
    taskId,
    from: "clarified",
    to: "approved_for_dispatch",
    actor: "firstmate",
    eventId: "approved",
  });
  await store.transition({
    taskId,
    from: "approved_for_dispatch",
    to: "preparing",
    actor: "firstmate",
    eventId: "preparing",
  });
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
    eventId: "running",
  });
  return store;
}

async function requestWorker(store) {
  return store.requestWorkerDispatch({
    taskId,
    actor: "firstmate",
    workerId,
    backend: "codex-cli",
    mode: "scout",
    worktreePath,
    sandbox: "read-only",
    brief: "Inspect exports",
    briefSha256: "digest",
    eventId: "dispatch",
  });
}

function completedResult() {
  return {
    threadId: "thread-123",
    eventCount: 4,
    report: {
      taskId,
      status: "completed",
      summary: "Found the exported function",
      branch: null,
      commit: null,
      files: ["index.js"],
      tests: [],
      risks: [],
    },
  };
}

function inspection({ dirty = false } = {}) {
  return {
    worktreePath,
    headSha,
    branch: null,
    dirty,
    changes: dirty ? [" M index.js"] : [],
  };
}
