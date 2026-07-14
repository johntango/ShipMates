import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ExactHeadGitPushAdapter,
  ExactHeadGitPushError,
} from "../src/adapters/git-push.js";

const exec = promisify(execFile);

test("pushes one exact commit to one new remote task branch", async (t) => {
  const fixture = await repository(t);
  const adapter = new ExactHeadGitPushAdapter({ runner: fixture.runner });
  const input = target(fixture);

  const result = await adapter.pushExact(input);
  const remote = await git(fixture.repo, "ls-remote", "--heads", "origin", result.remoteRef);

  assert.equal(result.evidenceKind, "push-confirmation");
  assert.equal(result.previousHeadSha, null);
  assert.equal(result.remoteHeadSha, fixture.headSha);
  assert.match(result.transportOutputSha256, /^[a-f0-9]{64}$/u);
  assert.equal(remote, `${fixture.headSha}\t${result.remoteRef}`);

  const reconciled = await adapter.reconcile(input);
  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.evidence.evidenceKind, "remote-reconciliation");
  assert.equal(reconciled.evidence.transportOutputSha256, null);
});

test("refuses an existing remote branch and a dirty local lease", async (t) => {
  const fixture = await repository(t);
  const adapter = new ExactHeadGitPushAdapter({ runner: fixture.runner });
  const input = target(fixture);
  await adapter.pushExact(input);

  await assert.rejects(adapter.pushExact(input), /new remote task branch/u);

  const second = await repository(t);
  await writeFile(path.join(second.repo, "dirty.txt"), "dirty\n");
  await assert.rejects(
    new ExactHeadGitPushAdapter({ runner: second.runner }).pushExact(target(second)),
    ExactHeadGitPushError,
  );
  assert.equal(
    await git(second.repo, "ls-remote", "--heads", "origin", "refs/heads/task-branch"),
    "",
  );
});

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), "shipmates-push-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  await exec("git", ["init", "-q", "--bare", remote]);
  await exec("git", ["init", "-q", repo]);
  await exec("git", ["checkout", "-q", "-b", "task-branch"], { cwd: repo });
  await writeFile(path.join(repo, "file.txt"), "content\n");
  await exec("git", ["add", "file.txt"], { cwd: repo });
  await exec("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "-q", "-m", "task",
  ], { cwd: repo });
  await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
  const headSha = await git(repo, "rev-parse", "HEAD");
  const runner = async (file, args, options) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return { stdout: "https://github.com/owner/repo.git\n", stderr: "" };
    }
    return exec(file, args, options);
  };
  return { root, repo, remote, headSha, runner };
}

function target({ repo, headSha }) {
  return {
    worktreePath: repo,
    repository: "owner/repo",
    branch: "task-branch",
    headSha,
  };
}

async function git(repo, ...args) {
  return (await exec("git", args, { cwd: repo, encoding: "utf8" })).stdout.trim();
}
