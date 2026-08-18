import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validationContract, WorkflowRunValidatorAdapter, WorkflowRunWorkerAdapter,
} from "../src/workflow-run/adapters.js";
import { WorkflowRunController } from "../src/workflow-run/controller.js";
import { SimpleWorkflowConversation } from "../src/workflow-run/interactive.js";
import { WorkflowRunStore } from "../src/workflow-run/store.js";

const OPERATION = "a".repeat(24);
const HEAD = "b".repeat(40);

test("production worker bridge launches once and adopts a durable clean result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-adapter-"));
  let launches = 0;
  const adapter = new WorkflowRunWorkerAdapter({
    stateRoot: root, workerScript: "/scripts/worker.js",
    spawnProcess: () => { launches += 1; return { pid: 1234 }; },
    isProcessAlive: () => true,
  });
  const run = runFixture();
  const launched = await adapter.launch({ operationId: OPERATION, run });
  assert.equal(launched.receipt.pid, 1234);
  assert.equal(await adapter.launch({ operationId: OPERATION, run }), null);
  assert.equal(launches, 1);
  assert.equal((await adapter.observe({ operationId: OPERATION })).receipt.pid, 1234);

  const operationRoot = path.join(root, "workflow-run-operations", OPERATION);
  await writeFile(path.join(operationRoot, "result.json"), JSON.stringify({
    workspacePath: "/isolated/worktree", headSha: HEAD, clean: true, commitCreated: true,
    report: { status: "completed", files: ["index.html"] },
  }));
  const restarted = new WorkflowRunWorkerAdapter({
    stateRoot: root, workerScript: "/scripts/worker.js",
    spawnProcess: () => { throw new Error("must not relaunch"); },
  });
  assert.equal((await restarted.observe({ operationId: OPERATION })).completed.headSha, HEAD);
});

test("validator bridge confines no-mistakes to one isolated exact head", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-validator-"));
  let input;
  const adapter = new WorkflowRunValidatorAdapter({
    stateRoot: root,
    gate: { run: async (value) => {
      input = value;
      return {
        initialHeadSha: HEAD, finalHeadSha: HEAD, headChanged: false,
        passed: true, outcome: "passed", gate: null,
      };
    } },
  });
  const result = await adapter.start({
    operationId: OPERATION, workspacePath: "/isolated/worktree", headSha: HEAD,
    intent: "Build a page",
  });
  assert.equal(result.status, "passed");
  assert.equal(input.worktreePath, "/isolated/worktree");
  assert.equal(input.expectedHeadSha, HEAD);
  assert.match(input.intent, /Do not inspect or follow \.shipmates/u);
  assert.match(input.intent, /Do not implement or modify code/u);
  assert.match(input.intent, /Do not.*push.*pull request.*merge/u);
  assert.doesNotMatch(input.intent, /Build a page/u);
  assert.match(input.intent, /SHA-256 [a-f0-9]{64}/u);
  assert.equal((await adapter.observe({
    operationId: OPERATION, workspacePath: "/isolated/worktree", headSha: HEAD,
    intent: "Build a page",
  })).status, "passed");
});

test("validator mismatch and ambiguous outcomes fail closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-validator-block-"));
  const adapter = new WorkflowRunValidatorAdapter({
    stateRoot: root,
    gate: { run: async () => ({
      initialHeadSha: HEAD, finalHeadSha: "c".repeat(40), headChanged: true,
      passed: true, outcome: "passed", gate: null,
    }) },
  });
  await assert.rejects(() => adapter.start({
    operationId: OPERATION, workspacePath: "/isolated/worktree", headSha: HEAD, intent: "Build",
  }), /exact Implementer head/u);
  assert.match(validationContract("Build"), /Do not.*publish/u);
});

test("validator adapter responds only to its pinned exact-head review run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-validator-review-"));
  let responses = 0;
  const gate = {
    run: async () => ({
      initialHeadSha: HEAD, finalHeadSha: HEAD, headChanged: false,
      runId: "run-pinned", outcome: null, passed: false,
      gate: { status: "awaiting_approval" },
      findings: [{ description: "Browser evidence is unavailable." }],
    }),
    respond: async ({ expectedRunId, expectedHeadSha, action }) => {
      responses += 1;
      assert.equal(expectedRunId, "run-pinned");
      assert.equal(expectedHeadSha, HEAD);
      assert.equal(action, "approve");
      return {
        initialHeadSha: HEAD, finalHeadSha: HEAD, headChanged: false,
        runId: "run-pinned", outcome: "passed", passed: true, gate: null,
      };
    },
  };
  const adapter = new WorkflowRunValidatorAdapter({ stateRoot: root, gate });
  const input = { operationId: OPERATION, workspacePath: "/isolated/worktree", headSha: HEAD, intent: "Build" };
  const awaiting = await adapter.start(input);
  assert.equal(awaiting.status, "awaiting_decision");
  assert.equal(awaiting.validatorRunId, "run-pinned");
  assert.equal(awaiting.review.summary, "Browser evidence is unavailable.");
  const passed = await adapter.decide({
    ...input, validatorRunId: "run-pinned", decision: "approve",
  });
  assert.equal(passed.status, "passed");
  assert.equal(responses, 1);
  assert.equal((await adapter.decide({
    ...input, validatorRunId: "run-pinned", decision: "approve",
  })).status, "passed");
  assert.equal(responses, 1);
});

test("feature-flag conversation gives one plan approval and leaks no ids", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-interactive-"));
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "internal-secret" });
  const worker = {
    observe: async () => null,
    launch: async () => ({ receipt: {}, completed: {
      workspacePath: "/isolated/worktree", headSha: HEAD,
      report: { status: "completed", files: ["index.html"] },
    } }),
  };
  const validator = {
    observe: async () => null,
    start: async ({ headSha }) => ({ status: "passed", headSha, report: { outcome: "passed" } }),
  };
  const conversation = new SimpleWorkflowConversation({
    store, controller: new WorkflowRunController({ store, worker, validator }),
    context: async () => ({ repoPath: "/repo", baseSha: "0".repeat(40) }),
    planner: async () => ({
      action: "dispatch", requiredAuthority: "local_write", response: "I can do that.", tasks: [],
    }),
  });
  const proposed = await conversation.handle("Build a page");
  assert.match(proposed, /Proposed plan/u);
  assert.doesNotMatch(proposed, /workflow-|internal-secret|task id/iu);
  const completed = await conversation.handle("I approve the plan");
  assert.match(completed, /Outcome: Passed/u);
  assert.doesNotMatch(completed, /workflow-|internal-secret|task id/iu);
  assert.equal((await store.list()).length, 1);
});

test("queues an early natural approval until the short plan is durable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-early-approval-"));
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "early" });
  let finishPlanning;
  const plannerWait = new Promise((resolve) => { finishPlanning = resolve; });
  let launches = 0;
  const controller = new WorkflowRunController({
    store,
    worker: {
      observe: async () => null,
      launch: async () => { launches += 1; return { receipt: {}, completed: {
        workspacePath: "/isolated/worktree", headSha: HEAD,
        report: { status: "completed", files: ["index.html"] },
      } }; },
    },
    validator: {
      observe: async () => null,
      start: async ({ headSha }) => ({ status: "passed", headSha, report: { outcome: "passed" } }),
    },
  });
  const conversation = new SimpleWorkflowConversation({
    store, controller,
    context: async () => ({ repoPath: "/repo", baseSha: "0".repeat(40) }),
    planner: async () => plannerWait,
  });
  const planning = conversation.handle("Build a bouncing-balls page");
  const early = await conversation.handle("I approve the plan");
  assert.match(early, /still preparing.*approval is queued/iu);
  assert.equal((await store.list()).length, 0);
  finishPlanning({
    action: "plan", response: "Plan ready", requiredAuthority: null,
    tasks: [
      { title: "Inspect the web entry point", requiredAuthority: "read_only" },
      { title: "Build the page", requiredAuthority: "local_write" },
    ],
  });
  const completed = await planning;
  assert.match(completed, /approval.*applied/iu);
  assert.match(completed, /Outcome: Passed/u);
  assert.equal(launches, 1);
  assert.equal((await store.list())[0].phase, "completed");
});

test("explains safely when approval arrives before any request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-no-plan-"));
  const store = new WorkflowRunStore({ rootDir: root });
  const conversation = new SimpleWorkflowConversation({
    store,
    controller: {},
    context: async () => ({ repoPath: "/repo", baseSha: "0".repeat(40) }),
    planner: async () => { throw new Error("unused"); },
  });
  assert.match(await conversation.handle("I approve the plan"), /No plan is ready.*Send the development request/iu);
});

function runFixture() {
  return {
    id: "workflow-test", repoPath: "/repo", baseHeadSha: "0".repeat(40),
    request: "Build a page", plan: "Build and validate",
  };
}
