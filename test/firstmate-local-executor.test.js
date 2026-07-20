import assert from "node:assert/strict";
import test from "node:test";

import { FirstmateLocalExecutor } from "../src/workflows/firstmate-local-executor.js";

test("runs two independent scouts before a local implementation", async () => {
  const calls = [];
  const observed = [];
  const executor = new FirstmateLocalExecutor({
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run(input) {
        calls.push(input);
        const workerId = input.artifactDirectory.split("/").at(-1);
        await input.onEvent?.({ type: "thread.started" });
        return {
          threadId: `thread-${workerId}`,
          report: report(input.taskId, workerId),
        };
      },
    },
    observer: {
      async begin() { observed.push("begin"); },
      async workerStarted({ workerId }) { observed.push(`${workerId}:started`); },
      async workerEvent({ workerId }) { observed.push(`${workerId}:event`); },
      async workerFinished({ workerId }) { observed.push(`${workerId}:finished`); },
      async prepareImplementer() { observed.push("prepare-implementer"); },
      async end({ status }) { observed.push(`end:${status}`); },
    },
  });

  const result = await executor.execute({
    taskId: "task-001",
    requestId: "request-001",
    repoPath: "/tmp/repo",
    message: "Add a watch rotation API",
    classification: classification("local_write"),
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ sandbox }) => sandbox), [
    "read-only",
    "read-only",
    "workspace-write",
  ]);
  assert.match(calls[0].prompt, /Do not inspect \.shipmates/u);
  assert.match(calls[0].prompt, /no more than six tool calls/u);
  assert.match(calls[0].prompt, /Inspect architecture and APIs/u);
  assert.doesNotMatch(calls[0].prompt, /Inspect tests and regression risks/u);
  assert.match(calls[1].prompt, /Inspect tests and regression risks/u);
  assert.match(calls[2].prompt, /Independent scout reports/u);
  assert.equal(result.status, "completed");
  assert.equal(result.scouts.length, 2);
  assert.equal(result.implementation.workerId, "implementer");
  assert.equal(observed.includes("scout-1:event"), true);
  assert.equal(observed.includes("implementer:event"), true);
  assert.equal(observed.at(-1), "end:completed");
});

test("stops before external or destructive authority", async () => {
  let calls = 0;
  const executor = new FirstmateLocalExecutor({
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: { async run() { calls += 1; } },
  });
  const result = await executor.execute({
    taskId: "task-001",
    requestId: "request-001",
    repoPath: "/tmp/repo",
    message: "Push the changes",
    classification: {
      ...classification("external_write"),
      requiresHumanApproval: true,
      approvalBoundary: "before_external_write",
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "awaiting_human");
});

test("returns a structured failure instead of throwing when a pane worker fails", async () => {
  const recorded = [];
  const executor = new FirstmateLocalExecutor({
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: { async run() { throw new Error("report task mismatch"); } },
    store: {
      rootDir: "/tmp/shipmates",
      async recordEvidence(input) { recorded.push(JSON.parse(input.value)); },
    },
  });
  const result = await executor.execute({
    taskId: "task-001", requestId: "request-001", repoPath: "/tmp/repo",
    message: "Build the demo", classification: classification("local_write"),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.message, "report task mismatch");
  assert.equal(recorded.find(({ failure }) => failure)?.failure.message, "report task mismatch");
  assert.equal(recorded.some(({ step, status }) => step === "worker" && status === "failed"), true);
});

test("assigns an indivisible work item to only one scout", async () => {
  const calls = [];
  let workerCount;
  const executor = new FirstmateLocalExecutor({
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run(input) {
        calls.push(input);
        return { threadId: "thread-scout-1", report: report(input.taskId, "scout-1") };
      },
    },
    observer: {
      async begin(input) { workerCount = input.workerCount; },
      async end() {},
    },
  });

  const result = await executor.execute({
    taskId: "task-001",
    requestId: "request-001",
    repoPath: "/tmp/repo",
    message: "Explain package.json",
    classification: {
      ...classification("read_only"),
      workItems: ["Inspect package.json and summarize it"],
    },
  });

  assert.equal(workerCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(result.scouts.length, 1);
  assert.match(calls[0].prompt, /Inspect package\.json and summarize it/u);
});

test("limits demo execution to one scout when classification returns two work items", async () => {
  const calls = [];
  const executor = new FirstmateLocalExecutor({
    schemaPath: "schemas/codex-worker-report.schema.json",
    scoutLimit: 1,
    runtime: {
      async run(input) {
        calls.push(input);
        const workerId = input.artifactDirectory.split("/").at(-1);
        return { threadId: `thread-${workerId}`, report: report(input.taskId, workerId) };
      },
    },
  });
  const result = await executor.execute({
    taskId: "task-demo", requestId: "request-demo", repoPath: "/tmp/repo",
    message: "Build the demo", classification: classification("local_write"),
  });
  assert.deepEqual(calls.map(({ workerId }) => workerId), ["scout-1", "implementer"]);
  assert.equal(result.scouts.length, 1);
  assert.match(calls[0].prompt, /Inspect architecture and APIs/u);
  assert.doesNotMatch(calls[0].prompt, /Inspect tests and regression risks/u);
});

test("delegates local writes to the durable implementation workflow", async () => {
  const runtimeCalls = [];
  const implementationCalls = [];
  const executor = new FirstmateLocalExecutor({
    schemaPath: "schemas/codex-worker-report.schema.json",
    runtime: {
      async run(input) {
        runtimeCalls.push(input);
        const workerId = input.artifactDirectory.split("/").at(-1);
        return {
          threadId: `thread-${workerId}`,
          report: report(input.taskId, workerId),
        };
      },
    },
    implementationWorkflow: {
      async run(input) {
        implementationCalls.push(input);
        return {
          worker: {
            id: "implementer",
            threadId: "thread-durable-implementer",
            report: report(input.taskId, "implementer"),
          },
        };
      },
    },
  });

  const result = await executor.execute({
    taskId: "task-001",
    requestId: "request-001",
    repoPath: "/tmp/treehouse/task/repo",
    message: "Add a watch rotation API",
    classification: classification("local_write"),
  });

  assert.equal(runtimeCalls.length, 2);
  assert.equal(implementationCalls.length, 1);
  assert.match(implementationCalls[0].brief, /Independent scout reports/u);
  assert.equal(result.implementation.threadId, "thread-durable-implementer");
  assert.equal(result.workspacePath, "/tmp/treehouse/task/repo");
});

test("records periodic heartbeat progress while worker execution is active", async () => {
  const recorded = [];
  const executor = new FirstmateLocalExecutor({
    schemaPath: "schemas/codex-worker-report.schema.json",
    heartbeatMs: 5,
    store: {
      rootDir: "/tmp/shipmates",
      async recordEvidence(input) {
        if (input.kind === "task-progress") recorded.push(JSON.parse(input.value));
      },
    },
    runtime: {
      async run(input) {
        await new Promise((resolve) => setTimeout(resolve, 18));
        return { threadId: "thread-scout", report: report(input.taskId, input.workerId) };
      },
    },
  });
  await executor.execute({
    taskId: "task-heartbeat", requestId: "request-heartbeat", repoPath: "/tmp/repo",
    message: "Inspect it", classification: classification("read_only"),
  });
  assert.equal(recorded.some(({ step, status }) => step === "heartbeat" && status === "running"), true);
  assert.equal(recorded.at(-1).status, "completed");
});

function classification(requiredAuthority) {
  return {
    requiredAuthority,
    requiresHumanApproval: false,
    approvalBoundary: "none",
    workItems: [
      "Inspect architecture and APIs",
      "Inspect tests and regression risks",
    ],
  };
}

function report(taskId, workerId) {
  return {
    taskId,
    status: "completed",
    summary: `${workerId} completed`,
    branch: null,
    commit: null,
    files: [],
    tests: [],
    risks: [],
  };
}
