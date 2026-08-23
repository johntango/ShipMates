import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FirstMateApplicationError,
  FirstMateApplicationService,
  validateFirstMateApplicationRequest,
  workflowRunRevision,
} from "../src/firstmate/application-service.js";
import { buildDashboardState } from "../src/dashboard/server.js";
import { artifact, prepareCapabilityBundle } from "../src/workflow-run/capability-pack.js";
import { renderWorkflowRun } from "../src/workflow-run/projection.js";
import { WorkflowRunStore } from "../src/workflow-run/store.js";

const HEAD = "a".repeat(40);

test("validates a bounded versioned read-only application contract", () => {
  const valid = request("firstmate_status", "plugin");
  assert.deepEqual(validateFirstMateApplicationRequest(valid), valid);
  assert.throws(() => validateFirstMateApplicationRequest({
    ...valid, intent: "firstmate_shell",
  }), FirstMateApplicationError);
  assert.throws(() => validateFirstMateApplicationRequest({
    ...valid, channel: "unknown",
  }), FirstMateApplicationError);
  assert.throws(() => validateFirstMateApplicationRequest({
    ...valid, extraAuthority: "publish",
  }), FirstMateApplicationError);
  assert.throws(() => validateFirstMateApplicationRequest({
    ...valid, idempotencyKey: "short",
  }), FirstMateApplicationError);
});

test("keeps transcript fixtures model-free and mutation intents unavailable", async () => {
  const fixtures = JSON.parse(await readFile(new URL(
    "./fixtures/firstmate-application-transcripts.json", import.meta.url,
  ), "utf8"));
  let reads = 0;
  const service = new FirstMateApplicationService({
    workflowRunStore: { list: async () => { reads += 1; return []; } },
  });
  for (const fixture of fixtures) {
    assert.equal(typeof fixture.transcript, "string", fixture.name);
    if (!fixture.request) {
      assert.equal(fixture.availableReadOnly, false, fixture.name);
      continue;
    }
    assert.deepEqual(validateFirstMateApplicationRequest(fixture.request), fixture.request,
      fixture.name);
    if (fixture.availableReadOnly) {
      await service.execute(fixture.request);
    } else {
      await assert.rejects(() => service.execute(fixture.request),
        /defined but unavailable.*read-only/iu, fixture.name);
    }
  }
  assert.equal(reads, fixtures.filter(({ availableReadOnly }) => availableReadOnly).length);
});

test("returns safe empty read projections without planning or mutation", async () => {
  let reads = 0;
  const service = new FirstMateApplicationService({
    workflowRunStore: { list: async () => { reads += 1; return []; } },
  });
  const status = await service.execute(request("firstmate_status", "voice"));
  assert.deepEqual(status, {
    schemaVersion: 1,
    intent: "firstmate_status",
    channel: "voice",
    revision: null,
    confirmationRequired: false,
    text: "No simple local workflow has been recorded yet.",
    data: null,
  });
  assert.equal(reads, 1);
  assert.equal(Object.isFrozen(status), true);
});

test("serves status, design, plan, artifacts, and evidence from one durable run", async () => {
  const { store, completed } = await completedFixture();
  const before = await store.events(completed.id);
  const service = new FirstMateApplicationService({ workflowRunStore: store });

  const status = await service.execute(request("firstmate_status", "terminal"));
  assert.equal(status.text, renderWorkflowRun(completed));
  assert.equal(status.data.phase, "Passed");
  assert.equal(status.data.candidate.pageUrl, pathToFileUrl(completed.worker.workspacePath, "site/index.html"));
  assert.doesNotMatch(JSON.stringify(status), /workflow-|operationId|validator-op|worker-op/iu);

  const design = await service.execute(request("firstmate_current_design", "plugin"));
  assert.match(design.text, /^Specification:\n\{/u);
  assert.match(design.text, /Build a bounded page/iu);
  const plan = await service.execute(request("firstmate_current_plan", "dashboard"));
  assert.match(plan.text, /Selected slice:.*Objective:.*Acceptance checks:/su);
  assert.doesNotMatch(plan.text, /"schemaVersion"/u);
  const artifacts = await service.execute(request("firstmate_artifacts", "voice"));
  assert.match(artifacts.text, /Status: Passed.*Candidate page:/su);
  const technical = await service.execute(request("firstmate_technical_evidence", "terminal"));
  assert.match(technical.text, /Technical evidence:.*No-mistakes completed 2 validation checks/isu);
  assert.equal(technical.confirmationRequired, false);
  assert.deepEqual(await store.events(completed.id), before);
});

test("repeated reads are deterministic and stale expected revisions fail closed", async () => {
  const { store, completed } = await completedFixture();
  const service = new FirstMateApplicationService({ workflowRunStore: store });
  const input = request("firstmate_status", "plugin");
  const first = await service.execute(input);
  const second = await service.execute(input);
  assert.deepEqual(second, first);
  assert.equal(first.revision, workflowRunRevision(completed));
  await assert.rejects(() => service.execute({
    ...input, expectedRevision: "f".repeat(64),
  }), /durable workflow changed/iu);
});

test("artifact questions select the newest completed result and disclose a newer blocker", async () => {
  const { store, completed } = await completedFixture();
  const blocked = await store.create({
    request: "A later request", plan: "Later plan", repoPath: completed.repoPath,
    baseHeadSha: HEAD,
  });
  await store.append(blocked.id, "workflow.blocked", {
    reason: "The later request stopped safely.",
  }, "blocked");
  const service = new FirstMateApplicationService({ workflowRunStore: store });

  const status = await service.execute(request("firstmate_status", "voice"));
  assert.match(status.text, /Status: Blocked safely/iu);
  const artifacts = await service.execute(request("firstmate_artifacts", "voice"));
  assert.match(artifacts.text, /Status: Passed/iu);
  assert.match(artifacts.text, /newer workflow is blocked safely/iu);
  assert.equal(artifacts.data.current, false);
});

test("dashboard consumes the same bounded application projections", async () => {
  const { store } = await completedFixture();
  const service = new FirstMateApplicationService({ workflowRunStore: store });
  const projected = await service.listWorkflowRuns({ historyOffset: 0, historyLimit: 10 });
  const dashboard = await buildDashboardState({
    store: { listTaskIds: async () => [] },
    projectContext: { load: async () => null },
    workflowRunStore: store,
    firstMateApplicationService: service,
  });
  assert.deepEqual(dashboard.workflowRuns, projected.workflowRuns);
  assert.deepEqual(dashboard.workflowHistory, projected.workflowHistory);
  assert.deepEqual(dashboard.tasks, []);
  assert.deepEqual(dashboard.projects, []);
});

async function completedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "firstmate-application-service-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  const store = new WorkflowRunStore({ rootDir: root });
  const bundle = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Build a bounded page",
  });
  let run = await store.create({
    request: "Build a bounded page", plan: "Build and validate", repoPath: root,
    baseHeadSha: HEAD, capabilityBundle: bundle,
  });
  run = await store.append(run.id, "spec.approved", {
    artifact: artifact("spec.approved", bundle.spec.content),
  }, "spec-approved");
  run = await store.append(run.id, "workflow.approved", {}, "approved");
  run = await store.append(run.id, "worker.launch_requested", {
    operationId: "worker-op",
  }, "worker-requested");
  run = await store.append(run.id, "worker.launched", {
    operationId: "worker-op", receipt: { pid: 42 },
  }, "worker-launched");
  run = await store.append(run.id, "worker.completed", {
    operationId: "worker-op", workspacePath: root, headSha: HEAD,
    report: {
      status: "completed", summary: "Built the page", files: ["site/index.html"],
      tests: [{ command: "node --test test/page.test.js", result: "2 tests passed" }],
    },
  }, "worker-completed");
  run = await store.append(run.id, "validation.requested", {
    operationId: "validator-op", headSha: HEAD, intent: "Build a bounded page",
  }, "validation-requested");
  run = await store.append(run.id, "validation.observed", {
    operationId: "validator-op", headSha: HEAD, status: "passed",
    report: {
      outcome: "passed", executedTestCaseCount: 2,
      steps: [
        { step: "test", status: "completed" },
        { step: "lint", status: "completed" },
      ],
    },
  }, "validation-observed");
  run = await store.append(run.id, "workflow.completed", {}, "completed");
  return { store, completed: run };
}

function request(intent, channel) {
  return {
    schemaVersion: 1,
    intent,
    channel,
    idempotencyKey: `${channel}:${intent}:test`,
  };
}

function pathToFileUrl(root, relative) {
  return `file://${path.join(root, relative)}`;
}
