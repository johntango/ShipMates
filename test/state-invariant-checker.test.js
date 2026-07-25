import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseInvariantArgs, renderInvariantReport } from "../src/cli/invariants.js";
import { ProjectStore } from "../src/projects/project-store.js";
import { STATE_CONTRACT } from "../src/state/state-contract.js";
import { StateInvariantChecker } from "../src/state/invariant-checker.js";
import { TaskStore } from "../src/storage/task-store.js";

test("publishes a versioned ownership contract for every persisted root field", () => {
  assert.equal(STATE_CONTRACT.schemaVersion, 1);
  assert.deepEqual(STATE_CONTRACT.projectRegistry.documentFields,
    ["schemaVersion", "activeProjectId", "projects", "repositoryDeletionReceipts"]);
  assert.equal(STATE_CONTRACT.taskLedger.eventTypes.includes("validation.local.requested"), true);
  assert.equal(STATE_CONTRACT.projections.includes("active-project.json"), true);
});

test("accepts event replay, its exact snapshot, and derived Herdr watermark", async (t) => {
  const fixture = await createFixture(t);
  const report = await fixture.checker.inspect();
  assert.equal(report.clean, true);
  assert.equal(report.readOnly, true);
});

test("detects a stale snapshot and completed-task active pointer without repairing", async (t) => {
  const fixture = await createFixture(t);
  const snapshotPath = path.join(fixture.root, "tasks", "task-one", "snapshot.json");
  const stale = JSON.parse(await readFile(snapshotPath, "utf8"));
  stale.lastEventId = "stale-event";
  await writeFile(snapshotPath, `${JSON.stringify(stale)}\n`);
  await writeFile(path.join(fixture.root, "active-project.json"), JSON.stringify({
    schemaVersion: 1, taskId: "task-one", updatedAt: "2026-07-25T12:00:00.000Z",
  }));

  const report = await fixture.checker.inspect();
  assert.equal(report.findings.some(({ code }) => code === "snapshot_stale_or_corrupt"), true);
  assert.equal(report.findings.some(({ code }) => code === "completed_task_active_pointer"), true);
  assert.equal(JSON.parse(await readFile(snapshotPath, "utf8")).lastEventId, "stale-event");
});

test("detects undocumented registry fields and cross-project attempt reuse", async () => {
  const projects = [{ id: "p1", status: "active", tasks: [{ id: "a", attempts: [{ taskId: "task-one" }] }], extra: true },
    { id: "p2", status: "active", tasks: [{ id: "b", attempts: [{ taskId: "task-one" }] }] }];
  const checker = new StateInvariantChecker({
    rootDir: "/state", limit: 20,
    projectStore: { list: async () => projects },
    taskStore: { listTaskIds: async () => [] },
    read: async (target) => {
      if (target.endsWith("projects.json")) return JSON.stringify({ schemaVersion: 1, activeProjectId: null, projects: [], repositoryDeletionReceipts: [] });
      const error = new Error("missing"); error.code = "ENOENT"; throw error;
    },
  });
  const report = await checker.inspect();
  assert.equal(report.findings.some(({ code }) => code === "undocumented_persisted_field"), true);
  assert.equal(report.findings.some(({ code }) => code === "attempt_owned_by_multiple_projects"), true);
});

test("detects raw nested fields, corrupt snapshots, payload drift, and Herdr drift", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.root, "projects.json"), JSON.stringify({
    schemaVersion: 1, activeProjectId: null, repositoryDeletionReceipts: [],
    projects: [{ id: "p1", name: "P", repo: "owner/repo", repoPath: "/repo", baseSha: "abc",
      status: "active", tasks: [{ id: "plan-1", title: "T", attempts: [], hidden: true }] }],
  }));
  const eventsPath = path.join(fixture.root, "tasks", "task-one", "events.jsonl");
  const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  events[0].data.hidden = true;
  await writeFile(eventsPath, `${events.map(JSON.stringify).join("\n")}\n`);
  await writeFile(path.join(fixture.root, "tasks", "task-one", "snapshot.json"), "{broken");
  const checker = new StateInvariantChecker({ rootDir: fixture.root,
    projectStore: fixture.projectStore, taskStore: fixture.taskStore,
    herdrProjection: { read: async () => ({ source: { lastEventId: "old", eventsCount: 1 } }) } });
  const report = await checker.inspect();
  for (const code of ["undocumented_persisted_field", "snapshot_corrupt",
    "herdr_projection_watermark_mismatch"]) {
    assert.equal(report.findings.some((finding) => finding.code === code), true);
  }
});

test("parses and renders the invariant CLI", () => {
  assert.deepEqual(parseInvariantArgs([]), { json: false });
  assert.deepEqual(parseInvariantArgs(["--json"]), { json: true });
  assert.throws(() => parseInvariantArgs(["--write"]), /Usage/u);
  assert.match(renderInvariantReport({ clean: false, summary: { findings: 1, truncated: false },
    findings: [{ code: "broken", target: "task:x", message: "No proof." }] }), /broken/u);
});

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipmates-invariants-"));
  t.after(async () => {});
  const taskStore = new TaskStore({ rootDir: root });
  await taskStore.createTask({ taskId: "task-one", kind: "test", repo: "owner/repo", baseSha: "abc", actor: "test", eventId: "create", at: "2026-07-25T12:00:00.000Z" });
  let state = "proposed";
  let second = 1;
  for (const next of ["clarified", "approved_for_dispatch", "preparing", "running", "validating", "cleaning", "complete"]) {
    await taskStore.transition({ taskId: "task-one", from: state, to: next, actor: "test", eventId: `to-${next}`, at: `2026-07-25T12:00:0${second}.000Z` });
    state = next;
    second += 1;
  }
  const projectStore = new ProjectStore({ rootDir: root });
  return { root, taskStore, projectStore,
    checker: new StateInvariantChecker({ rootDir: root, projectStore, taskStore }) };
}
