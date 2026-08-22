import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkflowRunController } from "../src/workflow-run/controller.js";
import { workflowRunEnabled } from "../src/workflow-run/feature.js";
import {
  baselineEvidenceSummary, projectWorkflowRun, renderWorkflowRun, validationEvidenceSummary,
  workflowExecutionMilestones, workflowTechnicalEvidence,
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
      "Created: The Implementer created the code in the isolated candidate — Built it.",
      "Checked: No-mistakes tested this exact isolated candidate, and it passed.",
      "Delivery: The candidate is preserved in its isolated workspace; it has not been copied or merged into the shared checkout.",
      "Candidate workspace: /tmp/workflow-worktree",
    ],
  });
  const rendered = renderWorkflowRun(completed);
  assert.match(rendered, /^Status: Passed/u);
  assert.match(rendered, /Implementer created the code/iu);
  assert.match(rendered, /No-mistakes tested this exact isolated candidate, and it passed/iu);
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

test("normal output is friendly while technical details preserve exact evidence", () => {
  const run = {
    phase: "blocked",
    blocker: "The isolated workspace has an unrecognized validation remote, so First Mate preserved it without running no-mistakes.",
    retries: [], validation: { status: "requested" },
    worker: {
      status: "completed", workspacePath: "/tmp/candidate", headSha: HEAD,
      report: {
        status: "completed", files: ["page.html"],
        tests: [
          { command: "node --test test/page.test.js", result: "Passed: 2 tests." },
          { command: "node --test test/page.test.js test/dashboard.test.js", result: "22 passed, 1 baseline/environment failure." },
        ],
      },
    },
  };
  const rendered = renderWorkflowRun(run);
  assert.match(rendered, /Inspect or repair.*managed validator binding/iu);
  assert.match(rendered, /Baseline\/environment: pre-existing issues.*candidate regressions/iu);
  assert.doesNotMatch(rendered, /node --test|Implementer verification|skipped|No individual test-case count/iu);
  assert.doesNotMatch(rendered, /Validated by:|No-mistakes tested and validated/iu);
  const technical = renderWorkflowRun(run, { technical: true });
  assert.match(technical, /Technical evidence:/u);
  assert.match(technical, /Implementer verification.*node --test.*Passed: 2 tests/iu);
  assert.deepEqual(workflowTechnicalEvidence(run).slice(-2), [
    "Implementer verification — node --test test/page.test.js: Passed: 2 tests.",
    "Implementer verification — node --test test/page.test.js test/dashboard.test.js: 22 passed, 1 baseline/environment failure.",
  ]);
});

test("completed output reports compact checks, truthful metrics, and baseline separation", () => {
  const rendered = renderWorkflowRun({
    phase: "completed", retries: [],
    worker: {
      status: "completed", workspacePath: "/tmp/candidate", headSha: HEAD,
      report: { status: "completed", summary: "Built the accessible page", files: ["balls.html"] },
    },
    validation: { status: "passed", headSha: HEAD, report: {
      baseline: { failures: 3 }, candidate: { introducedFailures: 0 },
      steps: [
        { step: "test", status: "completed" }, { step: "lint", status: "completed" },
        { step: "review", status: "skipped" },
      ],
    } },
  });
  assert.match(rendered, /^Status: Passed\nNext:/u);
  assert.match(rendered, /Created: The Implementer created.*accessible page/iu);
  assert.match(rendered, /Checked: No-mistakes tested.*passed/iu);
  assert.match(rendered, /completed 2 checks: tests and lint/iu);
  assert.match(rendered, /Pre-existing baseline issues: 3 existing failures/iu);
  assert.match(rendered, /Candidate regressions: 0 introduced regressions/iu);
  assert.match(rendered, /Candidate page: file:\/\/\/tmp\/candidate\/balls\.html/iu);
  assert.doesNotMatch(rendered, /skipped|No generated|No individual/iu);
});

test("candidate projection links a single safe non-index HTML entry", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "shipmates-page-link-"));
  await mkdir(path.join(workspace, "public"));
  const rendered = renderWorkflowRun({
    phase: "blocked", blocker: "Validation stopped safely.", retries: [],
    worker: {
      status: "completed", workspacePath: workspace, headSha: HEAD,
      report: { status: "completed", files: ["public/balls.html", "public/balls.js"] },
    },
    validation: { status: "requested" },
  });
  assert.match(rendered, new RegExp(`Candidate page: file://${workspace.replaceAll("/", "\\/")}/public/balls\\.html`, "u"));
  assert.doesNotMatch(rendered, /localhost/iu);
});

test("brownfield evidence separates base failures from candidate regressions", () => {
  assert.deepEqual(baselineEvidenceSummary({
    baseline: { failures: 3 }, candidate: { failures: 3, introducedFailures: 0 },
  }), [
    "Base-head baseline recorded 3 existing failures.",
    "Candidate validation recorded 0 introduced regressions.",
  ]);
  assert.deepEqual(baselineEvidenceSummary({ outcome: "passed" }), []);
});

test("derives actual execution milestones from durable evidence, not plan prose", () => {
  const waiting = {
    phase: "awaiting_approval", plan: "1. Inspect\n2. Build", worker: null, validation: null,
  };
  assert.deepEqual(workflowExecutionMilestones(waiting).map(({ label, status }) =>
    [label, status]), [
    ["Plan", "Awaiting your approval"], ["Implementer", "Queued"], ["No-mistakes", "Queued"],
  ]);
  const working = {
    ...waiting, phase: "implementing", worker: { status: "launched", receipt: { pid: 1 } },
  };
  assert.equal(workflowExecutionMilestones(working)[1].status, "Working");
  assert.equal(workflowExecutionMilestones({ ...working, phase: "blocked" })[1].status,
    "Blocked safely");
  const completed = {
    ...working, phase: "completed",
    worker: { status: "completed", headSha: HEAD, report: {
      status: "completed", files: ["site/index.html", "site/app.js"],
    } },
    validation: { status: "passed", headSha: HEAD, report: {
      executedTestCaseCount: 4,
      steps: [{ step: "test", status: "completed" }, { step: "lint", status: "completed" }],
    } },
  };
  const milestones = workflowExecutionMilestones(completed);
  assert.equal(milestones[0].status, "Approved");
  assert.match(milestones[1].summary, /site\/index\.html, site\/app\.js/u);
  assert.equal(milestones[2].status, "Passed");
  assert.match(milestones[2].summary, /2 checks: tests and lint.*ran 4 recorded test cases/isu);
  assert.doesNotMatch(JSON.stringify(milestones), /workflow-|task id|operation/iu);
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

test("restart durably binds the known workspace without launching a duplicate worker", async () => {
  const { store, run } = await createRun();
  await store.append(run.id, "workflow.approved", {}, "approved");
  await store.append(run.id, "worker.launch_requested", { operationId: "worker-bound" }, "worker-launch-requested");
  await store.append(run.id, "worker.launched", {
    operationId: "worker-bound", receipt: { pid: 91 },
  }, "worker-launched");
  let launches = 0;
  const binding = {
    runId: run.id, repoPath: run.repoPath,
    worktreePath: "/tmp/known-worktree", baseHeadSha: run.baseHeadSha,
  };
  const controller = new WorkflowRunController({
    store,
    worker: {
      launch: async () => { launches += 1; throw new Error("must not launch"); },
      observe: async () => ({ receipt: { pid: 91 }, workspace: binding }),
    },
    validator: passingValidator(),
  });
  const current = await controller.advance(run.id);
  assert.equal(current.phase, "implementing");
  assert.equal(current.workspace.status, "leased");
  assert.deepEqual(current.workspace.binding, binding);
  assert.equal(launches, 0);
  assert.equal((await store.events(run.id)).filter(({ type }) => type === "workspace.lease_bound").length, 1);
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
  assert.match(projectWorkflowRun(blocked).nextAction, /Review the stated cause/iu);
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
