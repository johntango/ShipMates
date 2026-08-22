import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SimpleWorkflowConversation } from "../src/workflow-run/interactive.js";
import { WorkflowRunStore } from "../src/workflow-run/store.js";
import {
  renderCleanReport, renderWipeManifest, renderWipeResult, renderWorkspaceInventory,
  WorkflowWorkspaceMaintenance,
} from "../src/workflow-run/workspace-maintenance.js";

const BASE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const NOW = new Date("2026-08-22T12:00:00.000Z");
const OLD = new Date("2026-08-01T12:00:00.000Z");

test("clean reclaims only old terminal clean base leases and records an idempotent return", async () => {
  const fixture = await maintenanceFixture();
  const run = await terminalRun(fixture.store, "safe", "/repo", "/worktrees/safe");
  const manager = fakeManager({
    [run.id]: observation("/worktrees/safe", BASE),
  });
  const maintenance = new WorkflowWorkspaceMaintenance({
    store: fixture.store, manager, clock: () => NOW, isProcessAlive: () => false,
  });

  const preview = await maintenance.clean({ repoPath: "/repo", dryRun: true });
  assert.equal(preview.before.items[0].status, "safely reclaimable");
  assert.equal(manager.returns.length, 0);
  const result = await maintenance.clean({ repoPath: "/repo" });
  assert.equal(result.reclaimedCount, 1);
  assert.equal(manager.returns.length, 1);
  assert.equal((await fixture.store.get(run.id)).workspace.status, "returned");
  assert.equal((await maintenance.clean({ repoPath: "/repo" })).reclaimedCount, 0);
  assert.equal(manager.returns.length, 1);
});

test("inventory preserves active, dirty, advanced, candidate, unknown, and young leases", async () => {
  const fixture = await maintenanceFixture();
  const active = await activeRun(fixture.store, "active", "/repo", "/worktrees/active", 44);
  const dirty = await terminalRun(fixture.store, "dirty", "/repo", "/worktrees/dirty");
  const advanced = await terminalRun(fixture.store, "advanced", "/repo", "/worktrees/advanced");
  const candidate = await completedRun(fixture.store, "candidate", "/repo", "/worktrees/candidate");
  const unknown = await terminalRun(fixture.store, "unknown", "/repo", "/worktrees/unknown");
  const youngStore = new WorkflowRunStore({ rootDir: fixture.root, clock: () => NOW, idFactory: ids("young") });
  const young = await terminalRun(youngStore, "young", "/repo", "/worktrees/young");
  const manager = fakeManager({
    [active.id]: observation("/worktrees/active", BASE),
    [dirty.id]: observation("/worktrees/dirty", BASE, { dirty: true }),
    [advanced.id]: observation("/worktrees/advanced", "c".repeat(40)),
    [candidate.id]: observation("/worktrees/candidate", CANDIDATE),
    [unknown.id]: observation("/worktrees/unknown", BASE, { unknown: true }),
    [young.id]: observation("/worktrees/young", BASE),
  });
  const maintenance = new WorkflowWorkspaceMaintenance({
    store: fixture.store, manager, clock: () => NOW, isProcessAlive: (pid) => pid === 44,
  });
  const inventory = await maintenance.inventory({ repoPath: "/repo" });
  const byPath = new Map(inventory.items.map((item) => [item.worktreePath, item]));
  assert.equal(byPath.get("/worktrees/active").status, "active");
  assert.equal(byPath.get("/worktrees/dirty").status, "preserved for review");
  assert.equal(byPath.get("/worktrees/advanced").status, "retained candidate");
  assert.equal(byPath.get("/worktrees/candidate").status, "retained candidate");
  assert.equal(byPath.get("/worktrees/unknown").status, "preserved for review");
  assert.equal(byPath.get("/worktrees/young").status, "preserved for review");
  assert.equal((await maintenance.clean({ repoPath: "/repo" })).reclaimedCount, 0);
});

test("restart observes a completed return intent without returning twice", async () => {
  const fixture = await maintenanceFixture();
  const run = await terminalRun(fixture.store, "interrupted", "/repo", "/worktrees/interrupted");
  const binding = (await fixture.store.get(run.id)).workspace.binding;
  const proof = { kind: "no-mutation", verified: true, worktreePath: binding.worktreePath, headSha: BASE };
  await fixture.store.append(run.id, "workspace.return_requested", {
    binding, reason: "safe cleanup", proof,
  }, "workspace-return-requested");
  const manager = fakeManager({
    [run.id]: observation("/worktrees/interrupted", BASE, { state: "available" }),
  });
  const maintenance = new WorkflowWorkspaceMaintenance({
    store: fixture.store, manager, clock: () => NOW, isProcessAlive: () => false,
  });
  const inventory = await maintenance.inventory({ repoPath: "/repo" });
  assert.equal(inventory.items[0].status, "safely reclaimed");
  assert.equal((await fixture.store.get(run.id)).workspace.status, "returning");
  await maintenance.clean({ repoPath: "/repo", dryRun: true });
  assert.equal((await fixture.store.get(run.id)).workspace.status, "returning");
  await maintenance.clean({ repoPath: "/repo" });
  assert.equal((await fixture.store.get(run.id)).workspace.status, "returned");
  assert.equal(manager.returns.length, 0);
});

test("clean durably expires and returns only a proven abandoned unchanged lease", async () => {
  const fixture = await maintenanceFixture();
  const run = await activeRun(fixture.store, "abandoned", "/repo", "/worktrees/abandoned", 55);
  const manager = fakeManager({ [run.id]: observation("/worktrees/abandoned", BASE) });
  const maintenance = new WorkflowWorkspaceMaintenance({
    store: fixture.store, manager, clock: () => NOW, abandonmentMs: 24 * 60 * 60 * 1_000,
    isProcessAlive: () => false,
  });
  const preview = await maintenance.clean({ repoPath: "/repo", dryRun: true });
  assert.equal(preview.before.items[0].status, "safely reclaimable");
  assert.equal((await fixture.store.get(run.id)).phase, "implementing");
  await maintenance.clean({ repoPath: "/repo" });
  const reclaimed = await fixture.store.get(run.id);
  assert.equal(reclaimed.phase, "blocked");
  assert.equal(reclaimed.workspace.status, "returned");
  assert.match(reclaimed.blocker, /expired.*safely reclaimed/iu);
  assert.equal(manager.returns.length, 1);
});

test("clean reports a blocked-safe return and preserves its durable intent", async () => {
  const fixture = await maintenanceFixture();
  const run = await terminalRun(fixture.store, "return-failure", "/repo", "/worktrees/return-failure");
  const manager = fakeManager({ [run.id]: observation("/worktrees/return-failure", BASE) });
  manager.returnLease = async () => { throw new Error("private Treehouse detail"); };
  const maintenance = new WorkflowWorkspaceMaintenance({
    store: fixture.store, manager, clock: () => NOW, isProcessAlive: () => false,
  });
  const result = await maintenance.clean({ repoPath: "/repo" });
  assert.equal(result.reclaimedCount, 0);
  assert.equal(result.blockedCount, 1);
  assert.equal((await fixture.store.get(run.id)).workspace.status, "returning");
  const rendered = renderCleanReport(result);
  assert.match(rendered, /1 return was blocked safely/u);
  assert.doesNotMatch(rendered, /private Treehouse detail/u);
});

test("wipe-clean requires an exact fresh manifest and archives only managed state", async () => {
  const fixture = await maintenanceFixture();
  const repo = path.join(fixture.root, "source-repo");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "keep me\n");
  const created = await fixture.store.create({ request: "Inspect", plan: "No work", repoPath: repo,
    baseHeadSha: BASE, authority: "local_write" });
  await fixture.store.append(created.id, "workflow.blocked", { reason: "No work started" }, "blocked");
  const maintenance = new WorkflowWorkspaceMaintenance({
    store: fixture.store, manager: fakeManager({}), clock: () => NOW,
  });
  const manifest = await maintenance.previewWipe({ projectName: "Demo Project", repoPath: repo });
  assert.equal(manifest.canWipe, true);
  assert.match(renderWipeManifest(manifest), /dry run.*Risk:.*enter: WIPE-CLEAN Demo Project/isu);
  await assert.rejects(() => maintenance.wipe({
    projectName: "Demo Project", repoPath: repo, confirmation: "yes",
  }), /enter exactly/u);
  assert.equal((await fixture.store.list()).length, 1);
  const result = await maintenance.wipe({
    projectName: "Demo Project", repoPath: repo, confirmation: manifest.confirmation,
  });
  assert.equal(result.archived, 1);
  assert.equal((await fixture.store.list()).length, 0);
  await access(path.join(repo, "README.md"));
  await access(path.join(repo, ".git"));
  await access(result.archivePath);
});

test("wipe-clean blocks candidate or uncertain work and conversation exposes no internal ids", async () => {
  const fixture = await maintenanceFixture();
  const run = await completedRun(fixture.store, "candidate-wipe", "/repo", "/worktrees/candidate-wipe");
  const maintenance = new WorkflowWorkspaceMaintenance({
    store: fixture.store,
    manager: fakeManager({ [run.id]: observation("/worktrees/candidate-wipe", CANDIDATE) }),
    clock: () => NOW, isProcessAlive: () => false,
  });
  const facade = {
    inventory: (input) => maintenance.inventory(input), clean: (input) => maintenance.clean(input),
    previewWipe: (input) => maintenance.previewWipe(input), wipe: (input) => maintenance.wipe(input),
    render: renderWorkspaceInventory, renderClean: renderCleanReport,
    renderWipe: renderWipeManifest, renderWipeResult,
  };
  const conversation = new SimpleWorkflowConversation({
    store: fixture.store, controller: {}, maintenance: facade,
    planner: async () => { throw new Error("must not plan"); },
    context: async () => ({ repoPath: "/repo", baseSha: BASE }),
  });
  const status = await conversation.handle("show workspace status");
  assert.match(status, /retained candidate: 1.*Clean is safe maintenance.*Wipe-clean/isu);
  assert.doesNotMatch(status, /workflow-|candidate-wipe/u);
  const wipe = await conversation.handle("wipe-clean project Demo");
  assert.match(wipe, /blocked.*preserve/isu);
  const manifest = await maintenance.previewWipe({ projectName: "Demo", repoPath: "/repo" });
  await assert.rejects(() => maintenance.wipe({
    projectName: "Demo", repoPath: "/repo", confirmation: manifest.confirmation,
  }), /blocked/u);
});

async function maintenanceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-maintenance-"));
  return { root, store: new WorkflowRunStore({ rootDir: root, clock: () => OLD, idFactory: ids("run") }) };
}

function ids(prefix) { let value = 0; return () => `${prefix}-${value += 1}`; }

async function terminalRun(store, name, repoPath, worktreePath) {
  const run = await store.create({ request: name, plan: name, repoPath, baseHeadSha: BASE, authority: "local_write" });
  await store.append(run.id, "workspace.lease_bound", binding(run.id, repoPath, worktreePath), "workspace-lease-bound");
  return store.append(run.id, "workflow.blocked", { reason: "Stopped safely" }, "blocked");
}

async function activeRun(store, name, repoPath, worktreePath, pid) {
  const run = await store.create({ request: name, plan: name, repoPath, baseHeadSha: BASE, authority: "local_write" });
  await store.append(run.id, "workflow.approved", {}, "approved");
  await store.append(run.id, "worker.launch_requested", { operationId: `${name}-worker` }, "worker-launch-requested");
  await store.append(run.id, "worker.launched", { operationId: `${name}-worker`, receipt: { pid } }, "worker-launched");
  return store.append(run.id, "workspace.lease_bound", binding(run.id, repoPath, worktreePath), "workspace-lease-bound");
}

async function completedRun(store, name, repoPath, worktreePath) {
  let run = await activeRun(store, name, repoPath, worktreePath, 999);
  await store.append(run.id, "worker.completed", { operationId: `${name}-worker`,
    workspacePath: worktreePath, headSha: CANDIDATE,
    report: { status: "completed", files: ["index.html"] } }, "worker-completed");
  await store.append(run.id, "validation.requested", { operationId: `${name}-validator`,
    headSha: CANDIDATE, intent: name }, "validation-requested");
  await store.append(run.id, "validation.observed", { operationId: `${name}-validator`,
    headSha: CANDIDATE, status: "passed", report: { outcome: "passed" } }, "validation-observed");
  await store.append(run.id, "workflow.completed", {}, "completed");
  return store.get(run.id);
}

function binding(runId, repoPath, worktreePath) {
  return { runId, repoPath: path.resolve(repoPath), worktreePath: path.resolve(worktreePath), baseHeadSha: BASE };
}
function observation(worktreePath, headSha, options = {}) {
  return { worktreePath, headSha, dirty: false, state: "leased", ...options };
}
function fakeManager(entries) {
  const returns = [];
  return {
    returns,
    async findLease({ taskId, worktreePath }) {
      const entry = entries[taskId];
      if (!entry || entry.unknown || entry.state !== "leased") throw new Error("unknown");
      return { ...entry, leaseHolder: taskId, worktreePath };
    },
    async findWorktree({ taskId }) { const entry = entries[taskId]; if (!entry) throw new Error("unknown"); return entry; },
    async inspect({ worktreePath }) {
      const entry = Object.values(entries).find((candidate) => candidate.worktreePath === worktreePath);
      if (!entry || entry.unknown) throw new Error("unknown");
      return { worktreePath, headSha: entry.headSha, dirty: entry.dirty, changes: entry.dirty ? [" M file"] : [] };
    },
    async proveNoMutation({ worktreePath, expectedHeadSha }) {
      return { kind: "no-mutation", verified: true, worktreePath, headSha: expectedHeadSha };
    },
    async returnLease({ worktreePath }) {
      returns.push(worktreePath);
      const entry = Object.values(entries).find((candidate) => candidate.worktreePath === worktreePath);
      entry.state = "available";
    },
  };
}
