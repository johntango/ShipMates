import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectStore } from "../src/projects/project-store.js";
import { RepositoryDeleteWorkflow } from "../src/workflows/repository-delete.js";

test("previews and moves a shared repository to Trash after exact confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repository-delete-"));
  const stateRoot = path.join(root, "state");
  const repoPath = path.join(root, "DemoTest");
  const trashRoot = path.join(root, "Trash");
  await mkdir(repoPath);
  await writeFile(path.join(repoPath, "README.md"), "demo\n");
  const store = new ProjectStore({ rootDir: stateRoot, clock: () => new Date("2026-07-18T12:00:00Z") });
  await store.create({ name: "TestA", repo: "owner/demo", repoPath, baseSha: "abc123" });
  await store.create({ name: "TestB", repo: "owner/demo", repoPath, baseSha: "abc123" });
  const workflow = new RepositoryDeleteWorkflow({
    projectStore: store, stateRoot, trashRoot,
    clock: () => new Date("2026-07-18T12:00:00Z"),
    inspectRepository: async () => ({
      exists: true, isGitRepository: true, clean: false, headSha: "abc123",
      hasRemote: true, unpushedCommitCount: 2,
    }),
  });

  const preview = await workflow.preview("TestA");
  assert.equal(preview.eligible, true);
  assert.deepEqual(preview.projects.map(({ name }) => name), ["TestA", "TestB"]);
  assert.equal(preview.warnings.length, 2);
  await assert.rejects(() => workflow.delete({ query: "TestA", confirmationId: "wrong" }), /exact current preview/u);

  const receipt = await workflow.delete({ query: "TestA", confirmationId: preview.confirmationId });
  assert.equal((await store.list({ includeArchived: true })).length, 0);
  assert.equal(await readFile(path.join(receipt.trashPath, "README.md"), "utf8"), "demo\n");
  assert.equal(receipt.recoverable, true);
  assert.deepEqual(receipt.warningsAccepted, preview.warnings);
});

test("refuses protected repositories and repositories with active tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repository-refusal-"));
  const store = new ProjectStore({ rootDir: path.join(root, "state") });
  const repoPath = path.join(root, "ShipMates");
  await mkdir(repoPath);
  const project = await store.create({
    name: "ShipMates", repo: "owner/shipmates", repoPath, baseSha: "abc123",
  });
  await store.setRepositoryProtected({ query: "ShipMates" });
  const workflow = new RepositoryDeleteWorkflow({
    projectStore: store, stateRoot: path.join(root, "state"), trashRoot: path.join(root, "Trash"),
    inspectRepository: async () => ({
      exists: true, isGitRepository: true, clean: true, headSha: "abc123",
      hasRemote: true, unpushedCommitCount: 0,
    }),
  });
  let preview = await workflow.preview(project.id);
  assert.equal(preview.eligible, false);
  assert.match(preview.blockers.join(" "), /protected/u);

  await store.setRepositoryProtected({ query: project.id, protected: false });
  await store.attachTask({ projectId: project.id, taskId: "task-live", title: "Still working" });
  preview = await workflow.preview(project.id);
  assert.equal(preview.eligible, false);
  assert.match(preview.blockers.join(" "), /active project tasks/u);
});
