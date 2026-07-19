import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectStore } from "../src/projects/project-store.js";
import { commitBoundaryOnly, PersistentProjectExecutor } from "../src/workflows/persistent-project-executor.js";

test("runs one Implementer in a persistent project branch and reconciles its commit", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "persistent-project-"));
  const projectStore = new ProjectStore({ rootDir });
  let project = await projectStore.create({
    name: "BallsA", repo: "owner/balls", repoPath: "/repos/balls", baseSha: "a".repeat(40),
  });
  await projectStore.savePlan({ projectId: project.id, objective: "Bouncing balls", tasks: [{
    id: "interface", title: "Build interface", description: "UI", dependsOn: [],
  }] });
  await projectStore.attachTask({
    projectId: project.id, planTaskId: "interface", taskId: "task-interface", title: "Build interface",
  });
  await projectStore.updateTaskStatus({ projectId: project.id, planTaskId: "interface", status: "claimed" });
  await projectStore.setExecutionPolicy({ projectId: project.id, policy: {
    mode: "persistent_project", scouts: "none", validation: "milestone",
    branch: "shipmates/ballsa", worktreePath: path.join(rootDir, "worktree"),
  } });
  const git = fakeGit();
  const prompts = [];
  const executor = new PersistentProjectExecutor({
    projectStore, stateRoot: rootDir, schemaPath: "schema.json", runner: git.run,
    runtime: { run: async (input) => {
      prompts.push(input.prompt); git.dirty = true;
      return { threadId: "thread-1", report: {
        taskId: "interface", status: "completed", summary: "Built it", branch: null,
        commit: null, files: ["index.html"], tests: [{ command: "node check", result: "passed" }], risks: [],
      } };
    } },
  });

  const result = await executor.run({
    projectId: project.id, planTaskId: "interface", instruction: "Build it", baseSha: "a".repeat(40),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.commit.headSha, "b".repeat(40));
  assert.match(prompts[0], /sole Implementer/u);
  assert.match(prompts[0], /Do not launch scouts/u);
  assert.match(prompts[0], /Uncommitted verified edits are successful work/u);
  assert.equal((await projectStore.get(project.id)).tasks[0].status, "completed");
  assert.equal((await executor.reconcile({ projectId: project.id, planTaskId: "interface" })).reused, true);
  assert.equal(prompts.length, 1);
});

test("recognizes a verified report blocked only at the executor-owned commit boundary", () => {
  assert.equal(commitBoundaryOnly({
    status: "blocked", summary: "Checks passed, but the commit could not be created.",
    files: ["script.js"], tests: [{ command: "node test", result: "Passed." }],
    risks: ["Git metadata was outside the writable sandbox."],
  }), true);
  assert.equal(commitBoundaryOnly({
    status: "blocked", summary: "The commit could not be created.",
    files: ["script.js"], tests: [{ command: "node test", result: "Failed." }], risks: [],
  }), false);
});

function fakeGit() {
  const state = { exists: false, dirty: false, head: "a".repeat(40) };
  return {
    get dirty() { return state.dirty; }, set dirty(value) { state.dirty = value; },
    async run(_file, args) {
      const command = args.join(" ");
      if (command.includes("branch --show-current")) {
        if (!state.exists) throw new Error("missing");
        return { stdout: "shipmates/ballsa\n", stderr: "" };
      }
      if (command.includes("worktree add")) { state.exists = true; return { stdout: "", stderr: "" }; }
      if (command.endsWith("rev-parse HEAD")) return { stdout: `${state.head}\n`, stderr: "" };
      if (command.includes("status --porcelain")) {
        return { stdout: state.dirty ? "?? index.html\n" : "", stderr: "" };
      }
      if (command.includes(" add -- ")) return { stdout: "", stderr: "" };
      if (command.includes(" commit -m ")) {
        state.head = "b".repeat(40); state.dirty = false; return { stdout: "committed", stderr: "" };
      }
      throw new Error(`Unexpected Git command: ${command}`);
    },
  };
}
