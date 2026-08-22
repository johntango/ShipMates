import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifact, capabilityPack, packDigest, parseCapabilityIntent, prepareCapabilityBundle,
} from "../src/workflow-run/capability-pack.js";
import { WorkflowRunController } from "../src/workflow-run/controller.js";
import { SimpleWorkflowConversation } from "../src/workflow-run/interactive.js";
import { reduceWorkflowRun } from "../src/workflow-run/reducer.js";
import { WorkflowRunStore } from "../src/workflow-run/store.js";

const HEAD = "a".repeat(40);

test("versioned capability packs are schema-validated and content-addressed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-capability-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await mkdir(path.join(root, "src"));
  const bundle = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD },
    request: "Add status page token=top-secret",
  });
  assert.equal(bundle.pack.name, "brownfield");
  assert.equal(bundle.pack.schemaVersion, 1);
  assert.equal(bundle.pack.digest, packDigest(bundle.pack));
  assert.equal(bundle.context.content.mode, "brownfield");
  assert.match(bundle.context.content.modeReason, /existing/iu);
  assert.doesNotMatch(JSON.stringify(bundle), /top-secret/u);
  assert.match(bundle.context.content.constraints.join(" "), /untrusted data/iu);
  assert.equal(bundle.slice.content.validationPolicy.baselineAtBase, true);
  assert.equal(bundle.slice.content.validationPolicy.remoteDelivery, false);
  assert.throws(() => artifact("spec.proposed", { schemaVersion: 1, goal: "x" }));
});

test("greenfield detection and pre-approval override are explicit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-greenfield-"));
  const automatic = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Create a tiny web page",
  });
  assert.equal(automatic.pack.name, "greenfield");
  assert.equal(automatic.context.content.mode, "greenfield");
  const overridden = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Adopt an existing convention",
    modeOverride: "brownfield",
  });
  assert.equal(overridden.context.content.mode, "brownfield");
  assert.match(overridden.context.content.modeReason, /user selected/iu);
});

test("command and natural-language routing is bounded to high-level intents", () => {
  for (const command of ["spec", "plan", "build", "test", "review", "ship", "status", "details", "clean", "wipe-clean"]) {
    assert.equal(parseCapabilityIntent(`/${command}`).command, command);
  }
  assert.equal(parseCapabilityIntent("show the current status").command, "status");
  assert.equal(parseCapabilityIntent("review the quality").command, "review");
  assert.equal(parseCapabilityIntent("preview a delivery request").command, "ship");
  assert.equal(parseCapabilityIntent("show technical evidence").command, "details");
  assert.equal(parseCapabilityIntent("show task evidence").command, "details");
  assert.equal(parseCapabilityIntent("build a page"), null);
});

test("typed artifacts share one WorkflowRun and survive restart idempotently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-capability-store-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "capability" });
  const bundle = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Add a bounded status view",
  });
  const run = await store.create({
    request: "Add a bounded status view", plan: "1. Build\n2. Validate", repoPath: root,
    baseHeadSha: HEAD, capabilityBundle: bundle,
  });
  assert.equal(run.capability.pack.name, "brownfield");
  assert.deepEqual((await new WorkflowRunStore({ rootDir: root }).get(run.id)).capability, run.capability);
  const events = await store.events(run.id);
  const context = events.find(({ type }) => type === "context.captured");
  assert.throws(() => reduceWorkflowRun(events.map((event) => event === context
    ? { ...event, data: { artifact: { ...event.data.artifact, content: {
        ...event.data.artifact.content, modeReason: "tampered",
      } } } }
    : event)), /digest/iu);
});

test("one approval executes one capability slice and exact-head validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-capability-flow-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "flow" });
  const bundle = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Add one status page",
  });
  const run = await store.create({
    request: "Add one status page", plan: "1. Build\n2. Validate", repoPath: root,
    baseHeadSha: HEAD, capabilityBundle: bundle,
  });
  const calls = { workers: 0, validators: 0 };
  const controller = new WorkflowRunController({
    store,
    worker: {
      observe: async () => null,
      launch: async ({ run: launched }) => {
        calls.workers += 1;
        assert.equal(launched.capability.slice.content.validationPolicy.baselineAtBase, true);
        return { receipt: { pid: 1 }, completed: {
          workspacePath: "/tmp/candidate", headSha: HEAD,
          report: { status: "completed", files: ["index.html"] },
        } };
      },
    },
    validator: {
      observe: async () => null,
      start: async ({ headSha }) => {
        calls.validators += 1;
        return { status: "passed", headSha, report: {
          outcome: "passed", baseline: { status: "recorded", failures: 2 },
          candidate: { failures: 2, introducedFailures: 0 },
        } };
      },
    },
  });
  const complete = await controller.approve(run.id);
  assert.equal(complete.phase, "completed");
  assert.deepEqual(calls, { workers: 1, validators: 1 });
  assert.equal(complete.validation.headSha, complete.worker.headSha);
  assert.equal((await store.events(run.id)).filter(({ type }) => type === "spec.approved").length, 1);
});

test("review and ship are advisory evidence and never launch work or delivery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-capability-command-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "commands" });
  const controller = {
    approve: async () => { throw new Error("must not approve"); },
    advance: async () => { throw new Error("must not dispatch"); },
    approveValidation: async () => { throw new Error("must not validate"); },
  };
  const conversation = new SimpleWorkflowConversation({
    store, controller, context: async () => ({ repoPath: root, baseSha: HEAD }),
    planner: async () => ({ action: "dispatch", requiredAuthority: "local_write" }),
  });
  await conversation.handle("/spec Create a tiny page");
  const before = await store.list();
  assert.match(await conversation.handle("/review"), /advisory.*did not modify/isu);
  assert.match(await conversation.handle("/ship"), /No push, pull request, merge, publication/iu);
  const after = await store.list();
  assert.equal(after[0].phase, "awaiting_approval");
  assert.equal(after[0].worker, null);
  assert.equal(after[0].validation, null);
  assert.equal(before.length, after.length);
  assert.deepEqual(after[0].capability.artifacts.slice(-2).map(({ kind }) => kind), [
    "review.recorded", "ship.previewed",
  ]);
  assert.doesNotMatch(await conversation.handle("/status"), /workflow-|operation id|task id/iu);
});

test("details exposes technical evidence on request without launching or changing workflow state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-capability-details-"));
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "details" });
  const run = await store.create({
    request: "Build a page", plan: "Build and validate", repoPath: root, baseHeadSha: HEAD,
  });
  await store.append(run.id, "workflow.approved", {}, "approved");
  await store.append(run.id, "worker.launch_requested", { operationId: "worker" }, "worker-request");
  await store.append(run.id, "worker.launched", { operationId: "worker", receipt: {} }, "worker-launched");
  await store.append(run.id, "worker.completed", {
    operationId: "worker", workspacePath: root, headSha: HEAD,
    report: { status: "completed", files: ["balls.html"], tests: [
      { command: "node --test test/balls.test.js", result: "3 tests passed" },
    ] },
  }, "worker-completed");
  await store.append(run.id, "validation.requested", {
    operationId: "validator", headSha: HEAD, intent: "Build a page",
  }, "validation-requested");
  await store.append(run.id, "validation.observed", {
    operationId: "validator", headSha: HEAD, status: "passed",
    report: { steps: [{ step: "test", status: "completed" }] },
  }, "validation-observed");
  await store.append(run.id, "workflow.completed", {}, "completed");
  const conversation = new SimpleWorkflowConversation({
    store,
    controller: { advance: async () => { throw new Error("must not launch"); } },
    context: async () => ({ repoPath: root, baseSha: HEAD }),
    planner: async () => { throw new Error("must not plan"); },
  });
  const before = await store.events(run.id);
  const normal = await conversation.handle("/status");
  assert.doesNotMatch(normal, /node --test|No individual test-case count/iu);
  const details = await conversation.handle("/details");
  assert.match(details, /Technical evidence:.*node --test test\/balls\.test\.js.*3 tests passed/isu);
  assert.match(await conversation.handle("show technical evidence"), /Technical evidence:/u);
  assert.deepEqual(await store.events(run.id), before);
});

test("capability responses avoid duplicate summaries and render a readable plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-capability-readable-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "readable" });
  const conversation = new SimpleWorkflowConversation({
    store, controller: {}, context: async () => ({ repoPath: root, baseSha: HEAD }),
    planner: async () => ({ action: "dispatch", requiredAuthority: "local_write" }),
  });

  const proposed = await conversation.handle("/spec Build an accessible static page");
  assert.equal(proposed.match(/Mode: Brownfield/gu)?.length, 1);
  assert.equal(proposed.match(/Approved scope:/gu)?.length, 1);
  const status = await conversation.handle("/status");
  assert.equal(status.match(/Mode: Brownfield/gu)?.length, 1);
  const plan = await conversation.handle("/plan");
  assert.match(plan, /Selected slice:.*Objective:.*Non-goals:.*Acceptance checks:.*Validation:.*Next:/su);
  assert.doesNotMatch(plan, /^\s*\{|"schemaVersion"|"validationPolicy"/mu);
  assert.match(plan, /Detailed typed artifact remains available/iu);
});

test("spec refuses expanded authority without persisting a plan", async () => {
  for (const requiredAuthority of ["external_write", "destructive"]) {
    const root = await mkdtemp(path.join(tmpdir(), `shipmates-capability-${requiredAuthority}-`));
    const store = new WorkflowRunStore({ rootDir: root, idFactory: () => requiredAuthority });
    const conversation = new SimpleWorkflowConversation({
      store, controller: {}, context: async () => ({ repoPath: root, baseSha: HEAD }),
      planner: async () => ({
        action: "dispatch", requiredAuthority,
        instruction: "Unsafe request", tasks: [],
      }),
    });

    const response = await conversation.handle("/spec Publish and delete the project");
    assert.match(response, /requires publication, destructive work, or authority beyond local implementation/iu);
    assert.equal((await store.list()).length, 0);
  }
});

test("spec reports planner routing failure separately from authority refusal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-capability-routing-"));
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "routing" });
  const conversation = new SimpleWorkflowConversation({
    store, controller: {}, context: async () => ({ repoPath: root, baseSha: HEAD }),
    planner: async () => ({ action: "answer", response: "Legacy state is stale", tasks: [] }),
  });

  const response = await conversation.handle("/spec Build a local page");
  assert.match(response, /could not produce a local implementation specification/iu);
  assert.doesNotMatch(response, /publication, destructive work, or authority beyond/iu);
  assert.equal((await store.list()).length, 0);
});

test("review credits the controller-preserved candidate commit without repeating worker no-commit wording", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-review-candidate-"));
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "review-candidate" });
  const run = await store.create({
    request: "Build a page", plan: "Build and validate", repoPath: root,
    baseHeadSha: HEAD,
  });
  await store.append(run.id, "workflow.approved", {}, "approved");
  await store.append(run.id, "worker.launch_requested", { operationId: "worker" }, "worker-request");
  await store.append(run.id, "worker.launched", { operationId: "worker", receipt: {} }, "worker-launched");
  await store.append(run.id, "worker.completed", {
    operationId: "worker", workspacePath: root, headSha: HEAD,
    report: { status: "completed", summary: "Built the page. No commit, publication, or shared-checkout change occurred." },
  }, "worker-completed");
  const conversation = new SimpleWorkflowConversation({
    store, controller: {}, context: async () => ({ repoPath: root, baseSha: HEAD }),
    planner: async () => { throw new Error("must not plan"); },
  });
  const review = await conversation.handle("/review");
  assert.match(review, /First Mate preserved the result as the isolated candidate commit/iu);
  assert.doesNotMatch(review, /No commit/iu);
});

test("later slice is proposed as typed evidence and remains unapproved", async () => {
  const pack = capabilityPack("greenfield");
  assert.equal(pack.phases.plan.includes("smallest-vertical-slice"), true);
  const followup = artifact("slice.followup_proposed", {
    schemaVersion: 1, title: "Second bounded slice", objective: "Add keyboard controls",
    acceptanceChecks: ["Keyboard controls work"],
    validationPolicy: {
      exactHead: true, baselineAtBase: false,
      distinguishBaselineFailures: true, remoteDelivery: false,
    },
  });
  assert.equal(followup.kind, "slice.followup_proposed");
  assert.match(followup.digest, /^[0-9a-f]{64}$/u);
});

test("completed workflow accepts a typed follow-up slice without scheduling it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-followup-slice-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "followup" });
  const bundle = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Build first slice",
  });
  const created = await store.create({
    request: "Build first slice", plan: "1. Build", repoPath: root,
    baseHeadSha: HEAD, capabilityBundle: bundle,
  });
  await store.append(created.id, "spec.approved", {
    artifact: artifact("spec.approved", bundle.spec.content),
  }, "approved-spec");
  await store.append(created.id, "workflow.approved", {}, "approved");
  await store.append(created.id, "worker.launch_requested", { operationId: "worker" }, "worker-request");
  await store.append(created.id, "worker.launched", { operationId: "worker", receipt: {} }, "worker-launched");
  await store.append(created.id, "worker.completed", {
    operationId: "worker", workspacePath: "/tmp/followup", headSha: HEAD,
    report: { status: "completed" },
  }, "worker-completed");
  await store.append(created.id, "validation.requested", {
    operationId: "validator", headSha: HEAD, intent: "Build first slice",
  }, "validation-requested");
  await store.append(created.id, "validation.observed", {
    operationId: "validator", headSha: HEAD, status: "passed", report: { outcome: "passed" },
  }, "validation-observed");
  await store.append(created.id, "workflow.completed", {}, "completed");
  const conversation = new SimpleWorkflowConversation({
    store, controller: {}, context: async () => ({ repoPath: root, baseSha: HEAD }),
    planner: async () => { throw new Error("must not plan through legacy"); },
  });
  const response = await conversation.handle("/plan Add keyboard support");
  assert.match(response, /requires its own scoped approval/iu);
  const run = await store.get(created.id);
  assert.equal(run.phase, "completed");
  assert.equal(run.capability.followupSlice.content.objective, "Add keyboard support");
  assert.equal((await store.events(created.id)).filter(({ type }) => type === "worker.launch_requested").length, 1);
});

for (const fixture of [
  { mode: "greenfield", configure: async () => {} },
  { mode: "brownfield", configure: async (root) => {
    await writeFile(path.join(root, "package.json"), "{}\n");
    await mkdir(path.join(root, "src"));
  } },
]) {
  test(`${fixture.mode} acceptance flow resumes after launch intent without duplicate execution`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `shipmates-${fixture.mode}-acceptance-`));
    await fixture.configure(root);
    const store = new WorkflowRunStore({ rootDir: root, idFactory: () => `${fixture.mode}-acceptance` });
    const bundle = await prepareCapabilityBundle({
      repository: { repoPath: root, baseSha: HEAD }, request: "Build one static page",
    });
    assert.equal(bundle.pack.name, fixture.mode);
    const run = await store.create({
      request: "Build one static page", plan: "1. Build one page\n2. Validate it",
      repoPath: root, baseHeadSha: HEAD, capabilityBundle: bundle,
    });
    const spec = artifact("spec.approved", bundle.spec.content);
    await store.append(run.id, "spec.approved", { artifact: spec }, `artifact:${spec.digest}`);
    await store.append(run.id, "workflow.approved", {}, "approved");
    await store.append(run.id, "worker.launch_requested", { operationId: "durable-worker" }, "worker-launch-requested");
    let launches = 0;
    let validations = 0;
    const restarted = new WorkflowRunController({
      store: new WorkflowRunStore({ rootDir: root }),
      worker: {
        launch: async () => { launches += 1; throw new Error("duplicate launch"); },
        observe: async () => ({ receipt: { pid: 42 }, completed: {
          workspacePath: `/tmp/${fixture.mode}-candidate`, headSha: HEAD,
          report: { status: "completed", files: ["index.html"] },
        } }),
      },
      validator: {
        observe: async () => null,
        start: async ({ headSha }) => {
          validations += 1;
          return { status: "passed", headSha, report: {
            outcome: "passed",
            ...(fixture.mode === "brownfield" ? {
              baseline: { failures: 1 }, candidate: { failures: 1, introducedFailures: 0 },
            } : {}),
          } };
        },
      },
    });
    const complete = await restarted.advance(run.id);
    assert.equal(complete.phase, "completed");
    assert.equal(launches, 0);
    assert.equal(validations, 1);
    assert.equal(complete.worker.headSha, complete.validation.headSha);
    assert.equal((await store.events(run.id)).filter(({ type }) => type === "worker.launch_requested").length, 1);
  });
}
