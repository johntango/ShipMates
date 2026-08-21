import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkflowRunController } from "../src/workflow-run/controller.js";
import { workflowRunEnabled } from "../src/workflow-run/feature.js";
import {
  projectWorkflowRun, renderWorkflowRun, validationEvidenceSummary,
} from "../src/workflow-run/projection.js";
import { reduceWorkflowRun } from "../src/workflow-run/reducer.js";
import { WorkflowRunStore } from "../src/workflow-run/store.js";

const HEAD = "a".repeat(40);

test("feature flag is explicit and off by default", () => {
  assert.equal(workflowRunEnabled({}), false);
  assert.equal(workflowRunEnabled({ SHIPMATES_SIMPLE_WORKFLOW: "1" }), true);
  assert.equal(workflowRunEnabled({ SHIPMATES_SIMPLE_WORKFLOW: "true" }), true);
});

test("pure reducer enforces one approval and exact-head validation", () => {
  const events = fixtureEvents();
  assert.equal(reduceWorkflowRun(events).phase, "completed");
  assert.throws(() => reduceWorkflowRun(events.map((event) =>
    event.type === "validation.observed"
      ? { ...event, data: { ...event.data, headSha: "b".repeat(40) } }
      : event)), /does not match/u);
  assert.throws(() => reduceWorkflowRun(events.filter(({ type }) => type !== "workflow.approved")), /requires phase approved/u);
});

test("approval to completion uses one worker and one exact-head validator", async () => {
  const { store, run } = await createRun();
  const calls = { launches: 0, validations: 0 };
  const worker = {
    observe: async () => null,
    launch: async () => {
      calls.launches += 1;
      return { receipt: { pid: 42 }, completed: {
        workspacePath: "/tmp/workflow-worktree", headSha: HEAD,
        report: { status: "completed", summary: "Built it" },
      } };
    },
  };
  const validator = {
    observe: async () => null,
    start: async ({ headSha }) => {
      calls.validations += 1;
      return { status: "passed", headSha, report: { tool: "no-mistakes", outcome: "passed" } };
    },
  };
  const controller = new WorkflowRunController({ store, worker, validator });
  const completed = await controller.approve(run.id);
  assert.equal(completed.phase, "completed");
  assert.deepEqual(calls, { launches: 1, validations: 1 });
  const eventTypes = (await store.events(run.id)).map(({ type }) => type);
  assert.equal(eventTypes.filter((type) => type === "workflow.approved").length, 1);
  assert.equal(eventTypes.filter((type) => type === "worker.launch_requested").length, 1);
  assert.equal(eventTypes.filter((type) => type === "validation.requested").length, 1);
  assert.equal(eventTypes.filter((type) => type === "workflow.completed").length, 1);
  assert.doesNotMatch(eventTypes.join(" "), /dispatch|reconcile|task/iu);
  assert.deepEqual(projectWorkflowRun(completed), {
    outcome: "Passed", nextAction: "Review the isolated candidate. Sharing it remains a separate explicit decision.",
    why: "The Implementer created the code, and no-mistakes tested and validated that exact isolated candidate.",
    phase: "Passed",
    details: [
      "Created by: The Implementer created the code in this candidate.",
      "Validated by: No-mistakes tested and validated this exact isolated candidate.",
      "Delivery: The candidate is preserved in its isolated workspace; it has not been copied or merged into the shared checkout.",
      "Candidate workspace: /tmp/workflow-worktree",
      "No generated project tests were recorded by no-mistakes.",
      "No individual test-case count was recorded.",
    ],
  });
  const rendered = renderWorkflowRun(completed);
  assert.match(rendered, /^Status: Passed/u);
  assert.match(rendered, /Implementer created the code/iu);
  assert.match(rendered, /No-mistakes tested and validated this exact isolated candidate/iu);
  assert.doesNotMatch(rendered, /workflow-test|operation id|task id/iu);
});

test("validation evidence distinguishes generated tests, test cases, and checks", () => {
  assert.deepEqual(validationEvidenceSummary({
    generatedTestCount: 0,
    executedTestCaseCount: 12,
    steps: [
      { step: "intent", status: "completed" },
      { step: "test", status: "completed" },
      { step: "lint", status: "completed" },
      { step: "review", status: "skipped" },
    ],
  }), [
    "No-mistakes generated 0 project tests.",
    "No-mistakes executed 12 test cases.",
    "No-mistakes completed 2 validation checks: test, lint.",
  ]);
  assert.deepEqual(validationEvidenceSummary({
    steps: [{ step: "test", status: "completed" }],
  }), [
    "No generated project tests were recorded by no-mistakes.",
    "No individual test-case count was recorded.",
    "No-mistakes completed 1 validation check: test.",
  ]);
});

test("restart after launch intent observes the operation without a duplicate worker", async () => {
  const { store, run } = await createRun();
  await store.append(run.id, "workflow.approved", {}, "approved");
  await store.append(run.id, "worker.launch_requested", { operationId: "worker-op" }, "worker-launch-requested");
  let launches = 0;
  const controller = new WorkflowRunController({
    store,
    worker: {
      observe: async () => ({ receipt: { pid: 9 }, completed: {
        workspacePath: "/tmp/recovered", headSha: HEAD, report: { status: "completed" },
      } }),
      launch: async () => { launches += 1; throw new Error("must not launch"); },
    },
    validator: passingValidator(),
  });
  assert.equal((await controller.advance(run.id)).phase, "completed");
  assert.equal(launches, 0);
});

test("restart reattaches a live Implementer before adopting its terminal report", async () => {
  const { store, run } = await createRun();
  await store.append(run.id, "workflow.approved", {}, "approved");
  await store.append(run.id, "worker.launch_requested", { operationId: "worker-live" }, "worker-launch-requested");
  await store.append(run.id, "worker.launched", {
    operationId: "worker-live", receipt: { pid: 91 },
  }, "worker-launched");
  let observations = 0;
  const worker = {
    launch: async () => { throw new Error("must not launch"); },
    observe: async ({ receipt }) => {
      observations += 1;
      assert.deepEqual(receipt, { pid: 91 });
      return observations === 1 ? { receipt } : { receipt, completed: {
        workspacePath: "/tmp/reattached", headSha: HEAD,
        report: { status: "completed" },
      } };
    },
  };
  const controller = new WorkflowRunController({ store, worker, validator: passingValidator() });
  const live = await controller.advance(run.id);
  assert.equal(live.phase, "implementing");
  assert.equal(projectWorkflowRun(live).phase, "Working");
  assert.equal((await controller.advance(run.id)).phase, "completed");
  assert.equal(observations, 2);
  assert.equal((await store.events(run.id)).filter(({ type }) => type === "worker.launched").length, 1);
});

test("restart after worker report starts validation once", async () => {
  const { store, run } = await createRun();
  await seedWorkerComplete(store, run.id);
  let starts = 0;
  const controller = new WorkflowRunController({
    store, worker: unusedWorker(),
    validator: {
      observe: async () => null,
      start: async ({ headSha }) => {
        starts += 1;
        return { status: "passed", headSha, report: { outcome: "passed" } };
      },
    },
  });
  assert.equal((await controller.advance(run.id)).phase, "completed");
  assert.equal(starts, 1);
});

test("restart while validator is running only observes the pinned run", async () => {
  const { store, run } = await createRun();
  await seedWorkerComplete(store, run.id);
  await store.append(run.id, "validation.requested", {
    operationId: "validator-op", headSha: HEAD, intent: "Build a small page",
  }, "validation-requested");
  let starts = 0;
  const controller = new WorkflowRunController({
    store, worker: unusedWorker(),
    validator: {
      observe: async ({ headSha }) => ({ status: "passed", headSha, report: { outcome: "passed" } }),
      start: async () => { starts += 1; throw new Error("must not start"); },
    },
  });
  const completed = await controller.advance(run.id);
  assert.equal(completed.phase, "completed");
  assert.equal(starts, 0);
  assert.equal((await store.events(run.id)).filter(({ type }) => type === "workflow.completed").length, 1);
  assert.equal((await controller.advance(run.id)).eventCount, completed.eventCount);
});

test("nonterminal validation remains observable without requesting a human gate response", async () => {
  const { store, run } = await createRun();
  await seedWorkerComplete(store, run.id);
  const validator = {
    observe: async () => null,
    start: async () => ({ status: "running" }),
    respond: async () => { throw new Error("controller must not respond to validator gates"); },
  };
  const current = await new WorkflowRunController({ store, worker: unusedWorker(), validator }).advance(run.id);
  assert.equal(current.phase, "validating");
});

test("adapter failures stop safely without exposing raw diagnostics", async () => {
  const { store, run } = await createRun();
  const controller = new WorkflowRunController({
    store,
    worker: { observe: async () => null, launch: async () => { throw new Error("secret path"); } },
    validator: passingValidator(),
  });
  const blocked = await controller.approve(run.id);
  assert.equal(blocked.phase, "blocked");
  assert.equal(projectWorkflowRun(blocked).outcome, "Blocked safely");
  assert.doesNotMatch(blocked.blocker, /secret path/u);
  assert.match(projectWorkflowRun(blocked).nextAction, /Resolve the stated issue/iu);
});

test("one transient setup failure is retried durably without duplicate work", async () => {
  const { store, run } = await createRun();
  let launches = 0;
  const temporary = Object.assign(new Error("temporary private detail"), { code: "EBUSY" });
  const controller = new WorkflowRunController({
    store,
    worker: {
      observe: async () => null,
      launch: async () => {
        launches += 1;
        if (launches === 1) throw temporary;
        return { receipt: { pid: 8 }, completed: {
          workspacePath: "/tmp/retried", headSha: HEAD,
          report: { status: "completed" },
        } };
      },
    },
    validator: passingValidator(),
  });
  const completed = await controller.approve(run.id);
  assert.equal(completed.phase, "completed");
  assert.equal(launches, 2);
  assert.equal(completed.retries.length, 1);
  assert.equal(completed.retries[0].component, "worker");
  assert.equal((await controller.advance(run.id)).eventCount, completed.eventCount);
  assert.equal(launches, 2);
});

test("a repeated transient setup failure blocks safely with a sanitized explanation", async () => {
  const { store, run } = await createRun();
  let launches = 0;
  const controller = new WorkflowRunController({
    store,
    worker: {
      observe: async () => null,
      launch: async () => {
        launches += 1;
        throw Object.assign(new Error("/private/secret/runtime"), { code: "ETIMEDOUT" });
      },
    },
    validator: passingValidator(),
  });
  const blocked = await controller.approve(run.id);
  assert.equal(blocked.phase, "blocked");
  assert.equal(launches, 2);
  assert.equal(blocked.retries.length, 1);
  assert.doesNotMatch(renderWorkflowRun(blocked), /private\/secret|ETIMEDOUT|operation/iu);
  assert.match(renderWorkflowRun(blocked), /^Status: Blocked safely/u);
});

test("human phase projection follows durable evidence instead of a stale planned label", () => {
  const base = { phase: "awaiting_approval", worker: null, validation: null, retries: [] };
  assert.equal(projectWorkflowRun({ ...base, phase: "planning" }).phase, "Planning");
  assert.equal(projectWorkflowRun(base).phase, "Awaiting your approval");
  assert.equal(projectWorkflowRun({
    ...base, worker: { status: "launched", receipt: { pid: 1 } },
  }).phase, "Working");
  assert.equal(projectWorkflowRun({
    ...base, worker: { status: "completed", headSha: HEAD },
  }).phase, "Validating");
  assert.equal(projectWorkflowRun({
    ...base, phase: "completed",
    worker: { status: "completed", headSha: HEAD },
    validation: { status: "passed", headSha: HEAD },
  }).phase, "Passed");
  assert.equal(projectWorkflowRun({ ...base, phase: "blocked", blocker: "Stopped safely." }).phase,
    "Blocked safely");
});

test("one high-level validation decision reconciles the pinned run without rerunning", async () => {
  const { store, run } = await createRun();
  let starts = 0;
  let decisions = 0;
  const controller = new WorkflowRunController({
    store,
    worker: {
      observe: async () => null,
      launch: async () => ({ receipt: {}, completed: {
        workspacePath: "/tmp/review-work", headSha: HEAD,
        report: { status: "completed" },
      } }),
    },
    validator: {
      observe: async () => null,
      start: async ({ headSha }) => {
        starts += 1;
        return {
          status: "awaiting_decision", headSha, validatorRunId: "validator-pinned",
          review: { summary: "Browser evidence is unavailable." },
        };
      },
      decide: async ({ headSha, validatorRunId, decision }) => {
        decisions += 1;
        assert.equal(validatorRunId, "validator-pinned");
        assert.equal(decision, "approve");
        return decisions === 1
          ? { status: "running", headSha, validatorRunId, report: { runStatus: "running" } }
          : { status: "passed", headSha, report: { outcome: "passed" } };
      },
    },
  });
  const awaiting = await controller.approve(run.id);
  assert.equal(awaiting.phase, "awaiting_validation_decision");
  assert.equal(projectWorkflowRun(awaiting).nextAction,
    "Choose whether to accept this validation risk or stop safely.");
  assert.match(projectWorkflowRun(awaiting).details.join("\n"),
    /Decision needed:.*Choices:.*Default:/su);
  assert.doesNotMatch(renderWorkflowRun(awaiting), /validator-pinned|operation|task id/iu);
  const validating = await controller.approveValidation(run.id);
  assert.equal(validating.phase, "validating");
  const completed = await controller.advance(run.id);
  assert.equal(completed.phase, "completed");
  assert.equal(starts, 1);
  assert.equal(decisions, 2);
  assert.equal((await store.events(run.id)).filter(({ type }) =>
    type === "validation.review_approved").length, 1);
});

async function createRun() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "workflow-run-"));
  const store = new WorkflowRunStore({ rootDir, idFactory: () => "test" });
  const run = await store.create({
    request: "Build a small page", plan: "Build and validate the requested page",
    repoPath: "/repo", baseHeadSha: "0".repeat(40), authority: "local_write",
  });
  return { store, run };
}

async function seedWorkerComplete(store, runId) {
  await store.append(runId, "workflow.approved", {}, "approved");
  await store.append(runId, "worker.launch_requested", { operationId: "worker-op" }, "worker-launch-requested");
  await store.append(runId, "worker.launched", { operationId: "worker-op", receipt: { pid: 1 } }, "worker-launched");
  await store.append(runId, "worker.completed", {
    operationId: "worker-op", workspacePath: "/tmp/work", headSha: HEAD,
    report: { status: "completed" },
  }, "worker-completed");
}

function passingValidator() {
  return {
    observe: async () => null,
    start: async ({ headSha }) => ({ status: "passed", headSha, report: { outcome: "passed" } }),
  };
}

function unusedWorker() {
  return { observe: async () => { throw new Error("unused"); }, launch: async () => { throw new Error("unused"); } };
}

function fixtureEvents() {
  const base = (id, type, data = {}) => ({ id, runId: "workflow-test", type, at: "2026-08-18T12:00:00.000Z", data });
  return [
    base("1", "workflow.created", { request: "Build", plan: "Build and validate", repoPath: "/repo", baseHeadSha: "0".repeat(40), authority: "local_write" }),
    base("2", "workflow.approved"),
    base("3", "worker.launch_requested", { operationId: "worker-op" }),
    base("4", "worker.launched", { operationId: "worker-op", receipt: {} }),
    base("5", "worker.completed", { operationId: "worker-op", workspacePath: "/tmp/work", headSha: HEAD, report: { status: "completed" } }),
    base("6", "validation.requested", { operationId: "validation-op", headSha: HEAD, intent: "Build" }),
    base("7", "validation.observed", { operationId: "validation-op", status: "passed", headSha: HEAD, report: {} }),
    base("8", "workflow.completed"),
  ];
}
