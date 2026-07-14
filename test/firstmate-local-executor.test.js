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

function classification(requiredAuthority) {
  return {
    requiredAuthority,
    requiresHumanApproval: false,
    approvalBoundary: "none",
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
