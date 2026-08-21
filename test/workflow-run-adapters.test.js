import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readWorkflowRunVisibility, validationContract, WorkflowRunValidatorAdapter, WorkflowRunWorkerAdapter,
} from "../src/workflow-run/adapters.js";
import { WorkflowRunController } from "../src/workflow-run/controller.js";
import { SimpleWorkflowConversation } from "../src/workflow-run/interactive.js";
import { WorkflowRunStore } from "../src/workflow-run/store.js";

const OPERATION = "a".repeat(24);
const HEAD = "b".repeat(40);

test("corrupt visibility evidence is ignored and cannot gate workflow execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-visibility-"));
  const directory = path.join(root, "workflow-run-operations", OPERATION);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "herdr-visibility.json"), "not json");
  assert.equal(await readWorkflowRunVisibility({ stateRoot: root, operationId: OPERATION }), null);
});

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

test("worker launch does not wait for or depend on Herdr visibility", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-visibility-"));
  let observed = false;
  const adapter = new WorkflowRunWorkerAdapter({
    stateRoot: root, workerScript: "/scripts/worker.js",
    spawnProcess: () => ({ pid: 4321 }),
    observer: { started: async () => { observed = true; throw new Error("Herdr offline"); } },
  });

  assert.equal((await adapter.launch({ operationId: OPERATION, run: runFixture() })).receipt.pid, 4321);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed, true);
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
      return responses === 1 ? {
        initialHeadSha: HEAD, finalHeadSha: HEAD, headChanged: false,
        runId: "run-pinned", runStatus: "running", outcome: null,
        passed: false, gate: null,
      } : {
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
  const running = await adapter.decide({
    ...input, validatorRunId: "run-pinned", decision: "approve",
  });
  assert.equal(running.status, "running");
  const passed = await adapter.decide({
    ...input, validatorRunId: "run-pinned", decision: "approve",
  });
  assert.equal(passed.status, "passed");
  assert.equal(responses, 2);
  assert.equal((await adapter.decide({
    ...input, validatorRunId: "run-pinned", decision: "approve",
  })).status, "passed");
  assert.equal(responses, 2);
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
  assert.match(completed, /Status: Passed/u);
  assert.match(completed, /Implementer created the code/iu);
  assert.match(completed, /No-mistakes tested and validated this exact isolated candidate/iu);
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
  assert.match(completed, /Status: Passed/u);
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

test("terminal result follow-ups use durable simple-workflow evidence without planning or mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-follow-up-"));
  let generatedIds = 0;
  const store = new WorkflowRunStore({
    rootDir: root, idFactory: () => `private-result-${generatedIds += 1}`,
  });
  let plannerCalls = 0;
  const conversation = new SimpleWorkflowConversation({
    store,
    controller: new WorkflowRunController({
      store,
      worker: {
        observe: async () => null,
        launch: async () => ({ receipt: {}, completed: {
          workspacePath: "/isolated/candidate", headSha: HEAD,
          report: {
            status: "completed", files: ["site/index.html", "site/app.js"],
            artifacts: [
              { url: "http://localhost:8000" },
              { path: "/evidence/page.png" },
            ],
          },
        } }),
      },
      validator: {
        observe: async () => null,
        start: async ({ headSha }) => ({ status: "passed", headSha, report: {
          outcome: "passed", headChanged: false,
          steps: [
            { step: "test", status: "completed" },
            { step: "lint", status: "completed" },
            { step: "review", status: "skipped" },
          ],
        } }),
      },
    }),
    context: async () => ({ repoPath: "/repo", baseSha: "0".repeat(40) }),
    planner: async () => {
      plannerCalls += 1;
      return { action: "dispatch", requiredAuthority: "local_write", tasks: [] };
    },
  });
  await conversation.handle("Build a page");
  await conversation.handle("I approve the plan");
  const newer = await store.create({
    request: "Build another page", plan: "Build and validate", repoPath: "/repo",
    baseHeadSha: "0".repeat(40), authority: "local_write",
  });
  await store.append(newer.id, "workflow.blocked", {
    reason: "A separate newer attempt stopped safely.",
  }, "blocked");
  const before = (await store.list())[0].eventCount;
  const callsBefore = plannerCalls;

  for (const question of [
    "where is the page?", "what is the URL?", "what happened?",
    "what files did it create?", "show me the preview artifacts", "what tests ran?",
  ]) {
    const answer = await conversation.handle(question);
    assert.match(answer, /Status: Passed/u);
    assert.match(answer, /isolated workspace.*not been copied or merged/iu);
    assert.match(answer, /file:\/\/\/isolated\/candidate\/site\/index\.html/u);
    assert.match(answer, /site\/index\.html, site\/app\.js/u);
    assert.match(answer, /Durable preview evidence: \/evidence\/page\.png/u);
    assert.doesNotMatch(answer, /localhost:8000|private-result|workflow-|task id/iu);
    assert.match(answer, /No generated project tests were recorded/u);
    assert.match(answer, /No individual test-case count was recorded/u);
    assert.match(answer, /completed 2 validation checks: test, lint/u);
    assert.match(answer, /Implementer created the code/iu);
    assert.match(answer, /No-mistakes tested and validated this exact isolated candidate/iu);
    assert.match(answer, /newer workflow is blocked safely/iu);
  }
  const current = await conversation.handle("show status");
  assert.match(current, /Status: Blocked safely/u);
  assert.doesNotMatch(current, /private-result|workflow-|task id/iu);
  assert.equal(plannerCalls, callsBefore);
  assert.equal((await store.list())[0].eventCount, before);
});

function runFixture() {
  return {
    id: "workflow-test", repoPath: "/repo", baseHeadSha: "0".repeat(40),
    request: "Build a page", plan: "Build and validate",
  };
}
