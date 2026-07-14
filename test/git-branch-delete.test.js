import assert from "node:assert/strict";
import test from "node:test";

import {
  ExactRemoteBranchDeleteAdapter,
  ExactRemoteBranchDeleteError,
} from "../src/adapters/git-branch-delete.js";

const HEAD = "a".repeat(40);

test("deletes only the exact remote branch through an atomic lease", async () => {
  let remoteHead = HEAD;
  const calls = [];
  const adapter = new ExactRemoteBranchDeleteAdapter({
    runner: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      if (args[0] === "remote") {
        return { stdout: "https://github.com/johntango/ShipMates.git\n", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return {
          stdout: remoteHead === null ? "" : `${remoteHead}\trefs/heads/task-branch\n`,
          stderr: "",
        };
      }
      if (args[0] === "push") {
        assert.deepEqual(args, [
          "push",
          "--porcelain",
          "--no-verify",
          `--force-with-lease=refs/heads/task-branch:${HEAD}`,
          "origin",
          ":refs/heads/task-branch",
        ]);
        remoteHead = null;
        return { stdout: "deleted\n", stderr: "" };
      }
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    },
  });

  const result = await adapter.deleteExact(target());

  assert.equal(result.deleted, true);
  assert.equal(result.deletedHeadSha, HEAD);
  assert.equal(result.remoteHeadSha, null);
  assert.match(result.transportOutputSha256, /^[a-f0-9]{64}$/u);
  assert.equal(calls.filter(({ args }) => args[0] === "push").length, 1);
});

test("refuses deletion when the remote branch moved", async () => {
  let pushes = 0;
  const adapter = new ExactRemoteBranchDeleteAdapter({
    runner: async (_file, args) => {
      if (args[0] === "remote") {
        return { stdout: "git@github.com:johntango/ShipMates.git\n", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return {
          stdout: `${"b".repeat(40)}\trefs/heads/task-branch\n`,
          stderr: "",
        };
      }
      if (args[0] === "push") pushes += 1;
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(adapter.deleteExact(target()), ExactRemoteBranchDeleteError);
  assert.equal(pushes, 0);
});

function target() {
  return {
    repoPath: "/tmp/repository",
    repository: "johntango/ShipMates",
    branch: "task-branch",
    headSha: HEAD,
  };
}
