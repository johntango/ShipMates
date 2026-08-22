import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { artifact, prepareCapabilityBundle } from "../src/workflow-run/capability-pack.js";
import { WorkflowRunController } from "../src/workflow-run/controller.js";
import { SimpleWorkflowConversation } from "../src/workflow-run/interactive.js";
import {
  projectCycleArtifact, projectCyclePack, renderProjectRoadmap,
} from "../src/workflow-run/project-cycle-pack.js";
import { reduceWorkflowRun } from "../src/workflow-run/reducer.js";
import { WorkflowRunStore } from "../src/workflow-run/store.js";

const HEAD = "a".repeat(40);

for (const mode of ["greenfield", "brownfield"]) {
  test(`${mode} Project Cycle selects a safe first cycle and survives restart`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `project-cycle-${mode}-`));
    if (mode === "brownfield") {
      await writeFile(path.join(root, "package.json"), "{}\n");
      await mkdir(path.join(root, "src"));
    }
    const bundle = await prepareCapabilityBundle({
      repository: { repoPath: root, baseSha: HEAD }, request: "Build a small accessible page",
    });
    assert.equal(bundle.projectCycle.pack.name, mode);
    const roadmap = bundle.projectCycle.roadmap.content;
    assert.match(roadmap.currentCycle.name, mode === "greenfield" ? /Walking skeleton/iu : /Characterize/iu);
    assert.equal(Object.hasOwn(roadmap, "nextSlice"), true);
    assert.equal(Array.isArray(roadmap.nextSlice), false);
    assert.match(roadmap.currentCycle.whyNow, mode === "greenfield" ? /before security, datastore, or scale/iu : /context.*behavior/iu);
    const store = new WorkflowRunStore({ rootDir: root, idFactory: () => mode });
    const created = await store.create({
      request: "Build a small accessible page", plan: "Build and validate", repoPath: root,
      baseHeadSha: HEAD, capabilityBundle: bundle,
    });
    const restarted = await new WorkflowRunStore({ rootDir: root }).get(created.id);
    assert.equal(restarted.projectCycle.roadmap.digest, bundle.projectCycle.roadmap.digest);
    assert.match(renderProjectRoadmap(restarted), /Current project cycle:.*Next bounded slice:.*Exit criteria:/su);
  });
}

test("Project Cycle schema and digest tampering fail closed", async () => {
  assert.throws(() => projectCycleArtifact("roadmap.proposed", {
    schemaVersion: 1, mode: "greenfield", currentCycle: {}, nextSlice: [],
  }));
  const root = await mkdtemp(path.join(tmpdir(), "project-cycle-tamper-"));
  const bundle = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Build a page",
  });
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "tamper" });
  const run = await store.create({
    request: "Build a page", plan: "Build", repoPath: root, baseHeadSha: HEAD,
    capabilityBundle: bundle,
  });
  const events = await store.events(run.id);
  assert.throws(() => reduceWorkflowRun(events.map((event) => event.type === "roadmap.proposed"
    ? { ...event, data: { artifact: { ...event.data.artifact, content: {
        ...event.data.artifact.content, mode: "brownfield",
      } } } }
    : event)), /Project cycle artifact is invalid/iu);
  assert.equal(projectCyclePack("greenfield").schemaVersion, 1);
});

test("completion records evidence and one next proposal without scheduling work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-cycle-complete-"));
  const bundle = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Build a page",
  });
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "complete" });
  const run = await store.create({
    request: "Build a page", plan: "Build", repoPath: root, baseHeadSha: HEAD,
    capabilityBundle: bundle,
  });
  let launches = 0;
  const controller = new WorkflowRunController({
    store,
    worker: { observe: async () => null, launch: async () => {
      launches += 1;
      return { receipt: {}, completed: {
        workspacePath: root, headSha: HEAD,
        report: { status: "completed", files: ["page.html"] },
      } };
    } },
    validator: { observe: async () => null, start: async () => ({
      status: "passed", headSha: HEAD, report: { outcome: "passed" },
    }) },
  });
  const completed = await controller.approve(run.id);
  assert.equal(completed.phase, "completed");
  assert.equal(launches, 1);
  assert.equal(completed.projectCycle.completion.content.changedFiles[0], "page.html");
  assert.match(completed.projectCycle.nextRoadmap.content.nextSlice.title, /Strengthen/iu);
  assert.match(renderProjectRoadmap(completed), /Proposed next cycle:.*not approved or scheduled/isu);
  assert.equal((await store.events(run.id)).filter(({ type }) => type === "worker.launch_requested").length, 1);
  assert.equal((await controller.advance(run.id)).phase, "completed");
  assert.equal(launches, 1);
});

test("restart after terminal completion adopts cycle evidence without rerunning work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-cycle-terminal-restart-"));
  const bundle = await prepareCapabilityBundle({
    repository: { repoPath: root, baseSha: HEAD }, request: "Build a page",
  });
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "terminal" });
  const run = await store.create({
    request: "Build a page", plan: "Build", repoPath: root, baseHeadSha: HEAD,
    capabilityBundle: bundle,
  });
  await store.append(run.id, "spec.approved", {
    artifact: artifact("spec.approved", bundle.spec.content),
  }, "approved-spec");
  await store.append(run.id, "workflow.approved", {}, "approved");
  await store.append(run.id, "worker.launch_requested", { operationId: "worker" }, "worker-request");
  await store.append(run.id, "worker.launched", { operationId: "worker", receipt: {} }, "worker-launched");
  await store.append(run.id, "worker.completed", {
    operationId: "worker", workspacePath: root, headSha: HEAD,
    report: { status: "completed", files: ["page.html"] },
  }, "worker-completed");
  await store.append(run.id, "validation.requested", {
    operationId: "validator", headSha: HEAD, intent: "Build",
  }, "validation-requested");
  await store.append(run.id, "validation.observed", {
    operationId: "validator", status: "passed", headSha: HEAD, report: {},
  }, "validation-observed");
  await store.append(run.id, "workflow.completed", {}, "completed");
  let launches = 0;
  const controller = new WorkflowRunController({
    store: new WorkflowRunStore({ rootDir: root }),
    worker: { launch: async () => { launches += 1; } }, validator: {},
  });
  const recovered = await controller.advance(run.id);
  assert.equal(recovered.projectCycle.completion.content.outcome, "passed");
  assert.ok(recovered.projectCycle.nextRoadmap);
  assert.equal(launches, 0);
});

test("roadmap commands select mode before approval and never bypass one approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-cycle-command-"));
  const store = new WorkflowRunStore({ rootDir: root, idFactory: () => "command" });
  let approvals = 0;
  const conversation = new SimpleWorkflowConversation({
    store,
    controller: { approve: async () => { approvals += 1; return store.get("workflow-command"); } },
    context: async () => ({ repoPath: root, baseSha: HEAD }),
    planner: async () => ({ action: "dispatch", requiredAuthority: "local_write" }),
  });
  const proposed = await conversation.handle("/cycle brownfield Improve the existing page");
  assert.match(proposed, /Awaiting your approval/iu);
  assert.match(proposed, /Project cycle: Characterize.*Current bounded slice:.*Exit criteria:/isu);
  assert.equal((await store.list())[0].projectCycle.pack.name, "brownfield");
  assert.match(await conversation.handle("show the current project cycle"), /Current project cycle: Characterize/iu);
  assert.match(await conversation.handle("/roadmap"), /later slice is never scheduled automatically/iu);
  assert.equal(approvals, 0);
});
