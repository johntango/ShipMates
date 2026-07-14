import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ControlledGitCommitAdapter,
  ControlledGitCommitError,
  FIRSTMATE_GIT_IDENTITY,
} from "../src/adapters/git-commit.js";

const run = promisify(execFile);

test("creates one clean exact-path commit with the fixed Firstmate identity", async (t) => {
  const repo = await repository(t);
  const baseHeadSha = await git(repo, "rev-parse", "HEAD");
  const branch = await git(repo, "branch", "--show-current");
  await writeFile(path.join(repo, "alpha.txt"), "changed\n");
  await writeFile(path.join(repo, "new.txt"), "new\n");
  const adapter = new ControlledGitCommitAdapter();

  const result = await adapter.create({
    worktreePath: repo,
    baseHeadSha,
    branch,
    changedPaths: ["alpha.txt", "new.txt"],
    message: "ShipMates task commit-test-001",
  });

  assert.equal(result.parentSha, baseHeadSha);
  assert.equal(result.clean, true);
  assert.equal(result.commitCreated, true);
  assert.deepEqual(result.changedPaths, ["alpha.txt", "new.txt"]);
  assert.deepEqual(result.author, FIRSTMATE_GIT_IDENTITY);
  assert.equal(await git(repo, "status", "--porcelain=v1"), "");
  assert.equal(await readFile(path.join(repo, "new.txt"), "utf8"), "new\n");
});

test("recovers exact commit evidence without creating a second commit", async (t) => {
  const repo = await repository(t);
  const baseHeadSha = await git(repo, "rev-parse", "HEAD");
  const branch = await git(repo, "branch", "--show-current");
  await writeFile(path.join(repo, "alpha.txt"), "changed\n");
  const input = {
    worktreePath: repo,
    baseHeadSha,
    branch,
    changedPaths: ["alpha.txt"],
    message: "ShipMates task commit-test-002",
  };
  const adapter = new ControlledGitCommitAdapter();
  const created = await adapter.create(input);

  const recovered = await adapter.inspectCreated(input);

  assert.deepEqual(recovered, created);
  assert.equal(await git(repo, "rev-list", "--count", `${baseHeadSha}..HEAD`), "1");
});

test("refuses a changed-path authority mismatch before staging", async (t) => {
  const repo = await repository(t);
  const baseHeadSha = await git(repo, "rev-parse", "HEAD");
  const branch = await git(repo, "branch", "--show-current");
  await writeFile(path.join(repo, "alpha.txt"), "changed\n");
  const adapter = new ControlledGitCommitAdapter();

  await assert.rejects(
    adapter.create({
      worktreePath: repo,
      baseHeadSha,
      branch,
      changedPaths: ["other.txt"],
      message: "ShipMates task commit-test-003",
    }),
    ControlledGitCommitError,
  );
  assert.equal(await git(repo, "diff", "--cached", "--name-only"), "");
  assert.equal(await git(repo, "rev-parse", "HEAD"), baseHeadSha);
});

async function repository(t) {
  const repo = await mkdtemp(path.join(tmpdir(), "shipmates-commit-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(repo, { recursive: true, force: true });
  });
  await run("git", ["init", "-q"], { cwd: repo });
  await run("git", ["checkout", "-q", "-b", "task-branch"], { cwd: repo });
  await writeFile(path.join(repo, "alpha.txt"), "base\n");
  await run("git", ["add", "alpha.txt"], { cwd: repo });
  await run("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "-q", "-m", "base",
  ], { cwd: repo });
  return repo;
}

async function git(repo, ...args) {
  return (await run("git", args, { cwd: repo, encoding: "utf8" })).stdout.trim();
}
