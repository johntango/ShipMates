import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import {
  FirstmateRunUncertainError,
  FirstmateShell,
  FirstmateShellError,
} from "../src/workflows/firstmate.js";

test("records a tool-free typed Firstmate classification and clarifies the task", async (t) => {
  const store = new TaskStore({ rootDir: await temporaryState(t) });
  const calls = [];
  const shell = new FirstmateShell({
    store,
    runAgent: async (agent, input, options) => {
      calls.push({ agent, input, options });
      return successfulResult();
    },
    attemptIdFactory: () => "attempt-001",
  });

  const result = await shell.classify(intake());

  assert.equal(result.reused, false);
  assert.equal(result.classification.taskType, "code_change");
  assert.deepEqual(result.usage, {
    requests: 1,
    inputTokens: 40,
    outputTokens: 20,
    totalTokens: 60,
  });
  assert.equal(result.snapshot.state, "clarified");
  assert.deepEqual(
    (await store.readEvents("firstmate-test-001")).map(({ type }) => type),
    [
      "task.created",
      "firstmate.run.requested",
      "firstmate.run.classified",
      "task.transitioned",
    ],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent.tools.length, 0);
  assert.equal(calls[0].agent.handoffs.length, 0);
  assert.match(calls[0].input, /Please add a status command/u);
  assert.deepEqual(calls[0].options, {
    maxTurns: 1,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: "ShipMates Firstmate intake",
    groupId: "firstmate-test-001",
  });
});

test("returns a durable classification without repeating the model call", async (t) => {
  const store = new TaskStore({ rootDir: await temporaryState(t) });
  let calls = 0;
  const shell = new FirstmateShell({
    store,
    runAgent: async () => {
      calls += 1;
      return successfulResult();
    },
    attemptIdFactory: () => "attempt-001",
  });

  await shell.classify(intake());
  const repeated = await shell.classify(intake());

  assert.equal(repeated.reused, true);
  assert.equal(calls, 1);
  assert.equal((await store.readEvents("firstmate-test-001")).length, 4);
});

test("allows only one concurrent caller to claim a model request", async (t) => {
  const store = new TaskStore({ rootDir: await temporaryState(t) });
  await store.createTask({
    taskId: "firstmate-test-001",
    kind: "firstmate-intake",
    repo: "johntango/Shipmates-Practice",
    baseSha: "abc123",
    actor: "firstmate",
    eventId: "created",
  });
  let calls = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const makeShell = (attemptId) =>
    new FirstmateShell({
      store,
      attemptIdFactory: () => attemptId,
      runAgent: async () => {
        calls += 1;
        await barrier;
        return successfulResult();
      },
    });

  const first = makeShell("attempt-001").classify(intake());
  const second = makeShell("attempt-002").classify(intake());
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.allSettled([first, second]);

  assert.equal(calls, 1);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
});

test("fails closed when durable intent has no model result", async (t) => {
  const store = new TaskStore({ rootDir: await temporaryState(t) });
  await store.createTask({
    taskId: "firstmate-test-001",
    kind: "firstmate-intake",
    repo: "johntango/Shipmates-Practice",
    baseSha: "abc123",
    actor: "firstmate",
    eventId: "created",
  });
  await store.requestFirstmateRun({
    taskId: "firstmate-test-001",
    actor: "firstmate",
    requestId: "request-001",
    attemptId: "attempt-001",
    requestSha256: sha256ForMessage(),
    model: "gpt-5.6-luna",
    maxTurns: 1,
    tracingEnabled: false,
    storeResponse: false,
    eventId: "requested",
  });
  const shell = new FirstmateShell({
    store,
    runAgent: async () => assert.fail("uncertain run must not be repeated"),
    attemptIdFactory: () => "attempt-002",
  });

  await assert.rejects(shell.classify(intake()), FirstmateRunUncertainError);
  assert.equal((await store.readEvents("firstmate-test-001")).length, 2);
});

test("records a sanitized terminal failure for malformed model output", async (t) => {
  const store = new TaskStore({ rootDir: await temporaryState(t) });
  const shell = new FirstmateShell({
    store,
    runAgent: async () => ({
      finalOutput: { taskType: "invented", secret: "must-not-land" },
      state: { usage: usage() },
    }),
    attemptIdFactory: () => "attempt-001",
  });

  await assert.rejects(shell.classify(intake()), FirstmateShellError);
  const snapshot = await store.getSnapshot("firstmate-test-001");
  assert.equal(snapshot.state, "proposed");
  assert.equal(snapshot.firstmateRuns[0].status, "failed");
  assert.equal(
    snapshot.firstmateRuns[0].failure.message,
    "Agents SDK run failed before a classification was recorded",
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-land/u);
});

test("rejects changed input and mismatched existing task identity", async (t) => {
  const store = new TaskStore({ rootDir: await temporaryState(t) });
  const shell = new FirstmateShell({
    store,
    runAgent: async () => successfulResult(),
    attemptIdFactory: () => "attempt-001",
  });
  await shell.classify(intake());

  await assert.rejects(
    shell.classify({ ...intake(), message: "A different request" }),
    /reused with different input/u,
  );
  await assert.rejects(
    shell.classify({ ...intake(), repo: "someone/else" }),
    /does not match this Firstmate intake/u,
  );
});

function intake() {
  return {
    taskId: "firstmate-test-001",
    requestId: "request-001",
    repo: "johntango/Shipmates-Practice",
    baseSha: "abc123",
    message: "Please add a status command",
  };
}

function successfulResult() {
  return {
    finalOutput: {
      schemaVersion: 1,
      summary: "Add a local status command.",
      taskType: "code_change",
      requiredAuthority: "local_write",
      approvalBoundary: "none",
      recommendedNextStep: "Plan and implement the bounded local change.",
      requiresHumanApproval: false,
    },
    state: { usage: usage() },
  };
}

function usage() {
  return {
    requests: 1,
    inputTokens: 40,
    outputTokens: 20,
    totalTokens: 60,
  };
}

function sha256ForMessage() {
  return "a1c6d26ef802bd1f07b6a24af13d7995aba9309516e3dc6b6382a4876e2ef3c0";
}

async function temporaryState(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "shipmates-firstmate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
