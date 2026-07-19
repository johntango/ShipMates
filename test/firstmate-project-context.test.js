import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FirstmateProjectContext } from "../src/cli/firstmate-project-context.js";

test("persists and reloads the human's active project", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-project-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const value = snapshot();
  const store = { rootDir, getSnapshot: async () => value };
  const context = new FirstmateProjectContext({ store });

  assert.equal(await context.load(), null);
  assert.equal(await context.save(value), "task-project");
  assert.equal(await context.load(), "task-project");
});

test("ignores a stale pointer whose task has no artifacts", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-project-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const context = new FirstmateProjectContext({
    store: { rootDir, getSnapshot: async () => ({ id: "task-empty", workers: [] }) },
  });
  await context.save(snapshot());

  assert.equal(await context.load(), null);
});

function snapshot() {
  return {
    id: "task-project",
    state: "validating",
    worktree: { worktreePath: "/treehouse/project" },
    workers: [{ id: "implementer", report: { files: ["index.html"] } }],
  };
}
