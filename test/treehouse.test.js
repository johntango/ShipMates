import assert from "node:assert/strict";
import test from "node:test";

import {
  TreehouseAdapterError,
  TreehouseWorktreeManager,
} from "../src/adapters/treehouse.js";

test("leases a worktree with a durable task holder", async () => {
  const calls = [];
  const manager = new TreehouseWorktreeManager({
    binary: "/opt/treehouse",
    executeFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "/tmp/treehouse/practice/1/repo\n", stderr: "" };
    },
  });

  const lease = await manager.lease({
    repoPath: "/repos/practice",
    taskId: "ship-practice-001",
  });

  assert.equal(lease.worktreePath, "/tmp/treehouse/practice/1/repo");
  assert.deepEqual(calls[0].args, [
    "get",
    "--lease",
    "--lease-holder",
    "ship-practice-001",
  ]);
  assert.equal(calls[0].options.cwd, "/repos/practice");
});

test("rejects noisy or ambiguous lease output", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: async () => ({
      stdout: "banner text\n/tmp/treehouse/practice/1/repo\n",
      stderr: "",
    }),
  });

  await assert.rejects(
    manager.lease({ repoPath: "/repos/practice", taskId: "task-1" }),
    /exactly one absolute path/u,
  );
});

test("parses Treehouse status into structured lease records", async () => {
  const manager = new TreehouseWorktreeManager({
    homeDirectory: "/tmp/treehouse-home",
    executeFile: async () => ({
      stdout:
        "1     leased       ~/.treehouse/repo/1/repo  (held by task-001)\n" +
        "2     available    ~/.treehouse/repo/2/repo\n",
      stderr: "",
    }),
  });

  assert.deepEqual(await manager.list({ repoPath: "/repos/practice" }), [
    {
      slot: 1,
      state: "leased",
      worktreePath: "/tmp/treehouse-home/.treehouse/repo/1/repo",
      leaseHolder: "task-001",
    },
    {
      slot: 2,
      state: "available",
      worktreePath: "/tmp/treehouse-home/.treehouse/repo/2/repo",
      leaseHolder: null,
    },
  ]);
});

test("requires an exact task holder when reconciling a lease", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: async () => ({
      stdout: "1 leased /tmp/worktree  (held by different-task)\n",
      stderr: "",
    }),
  });

  await assert.rejects(
    manager.findLease({
      repoPath: "/repos/practice",
      taskId: "task-001",
      worktreePath: "/tmp/worktree",
    }),
    /not leased to task-001/u,
  );
});

test("prepares origin HEAD for detached-worktree compatibility", async () => {
  const calls = [];
  const manager = new TreehouseWorktreeManager({
    executeFile: async (file, args, options) => {
      calls.push({ file, args, options });
      const stdout =
        args[0] === "symbolic-ref"
          ? "refs/remotes/origin/main\n"
          : args[0] === "rev-parse"
            ? "/repos/practice/.git\n"
            : "";
      return { stdout, stderr: "" };
    },
  });

  const remoteHead = await manager.prepareRepository({
    repoPath: "/repos/practice",
  });

  assert.equal(remoteHead, "refs/remotes/origin/main");
  assert.deepEqual(
    calls.map(({ file, args }) => ({ file, args })),
    [
      {
        file: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      },
      { file: "git", args: ["remote", "get-url", "origin"] },
      { file: "git", args: ["remote", "set-head", "origin", "--auto"] },
      {
        file: "git",
        args: ["symbolic-ref", "refs/remotes/origin/HEAD"],
      },
    ],
  );
});

test("rejects Git versions that misparse the required path-format option", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: async () => ({
      stdout: "--path-format=absolute\n/repos/practice/.git\n",
      stderr: "",
    }),
  });

  await assert.rejects(
    manager.prepareRepository({ repoPath: "/repos/practice" }),
    /Git version that supports/u,
  );
});

test("creates a no-mutation proof from a clean expected HEAD", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: gitInspection({ headSha: "abc123", status: "" }),
  });

  const proof = await manager.proveNoMutation({
    worktreePath: "/tmp/worktree",
    expectedHeadSha: "abc123",
  });

  assert.deepEqual(proof, {
    kind: "no-mutation",
    verified: true,
    worktreePath: "/tmp/worktree",
    headSha: "abc123",
  });
});

test("lists staged, unstaged, and untracked paths without duplicates", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: async (file, args) => {
      assert.equal(file, "git");
      if (args[0] === "diff" && args.includes("--cached")) {
        return { stdout: "src/staged.js\0src/shared.js\0", stderr: "" };
      }
      if (args[0] === "diff") {
        return { stdout: "src/unstaged.js\0src/shared.js\0", stderr: "" };
      }
      if (args[0] === "ls-files") {
        return {
          stdout: args.includes("--ignored") ? ".env\0" : "test/new.test.js\0",
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
  });

  assert.deepEqual(
    await manager.inspectChangedPaths({ worktreePath: "/tmp/worktree" }),
    {
      staged: ["src/shared.js", "src/staged.js"],
      unstaged: ["src/shared.js", "src/unstaged.js"],
      untracked: ["test/new.test.js"],
      ignored: [".env"],
      all: [
        "src/shared.js",
        "src/staged.js",
        "src/unstaged.js",
        "test/new.test.js",
      ],
    },
  );
});

test("prepares an exact deterministic task branch without changing workspace paths", async () => {
  const calls = [];
  let branch = null;
  const headSha = "a".repeat(40);
  const manager = new TreehouseWorktreeManager({
    executeFile: async (file, args) => {
      assert.equal(file, "git");
      calls.push(args);
      if (args[0] === "status") {
        return { stdout: " M src/message.js\n", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { stdout: `${headSha}\n`, stderr: "" };
      }
      if (args[0] === "branch") {
        return { stdout: branch ? `${branch}\n` : "\n", stderr: "" };
      }
      if (args[0] === "diff") {
        return {
          stdout: args.includes("--cached") ? "" : "src/message.js\0",
          stderr: "",
        };
      }
      if (args[0] === "ls-files") return { stdout: "", stderr: "" };
      if (args[0] === "check-ref-format") return { stdout: "", stderr: "" };
      if (args[0] === "switch") {
        branch = args[2];
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
  });

  const result = await manager.prepareTaskBranch({
    worktreePath: "/tmp/worktree",
    expectedHeadSha: headSha,
    branch: "agent/task-live-001",
    expectedChangedPaths: ["src/message.js"],
  });

  assert.deepEqual(result, {
    branch: "agent/task-live-001",
    headSha,
    dirty: true,
    changedPaths: ["src/message.js"],
  });
  assert.deepEqual(
    calls.find(([command]) => command === "switch"),
    ["switch", "--create", "agent/task-live-001", "--no-track"],
  );
});

test("refuses to return a lease without matching proof", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: async () => {
      throw new Error("should not execute");
    },
  });

  await assert.rejects(
    manager.returnLease({ worktreePath: "/tmp/worktree", proof: null }),
    TreehouseAdapterError,
  );
});

test("proves a squash landing when approved and merged trees match", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: async (file, args) => {
      assert.equal(file, "git");
      if (args[0] === "status") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "branch") {
        return { stdout: "agent/task\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: "approved123\n", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { stdout: "tree456\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
  });

  const proof = await manager.proveExactTreeLanding({
    worktreePath: "/tmp/worktree",
    approvedHeadSha: "approved123",
    mergedCommitSha: "merged789",
    remoteMainSha: "merged789",
  });

  assert.equal(proof.kind, "exact-tree-landing");
  assert.equal(proof.treeSha, "tree456");
  assert.equal(proof.mergedCommitSha, "merged789");
});

test("fetches only the confirmed full merge commit before landed-tree proof", async () => {
  const calls = [];
  const commitSha = "c".repeat(40);
  const manager = new TreehouseWorktreeManager({
    executeFile: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      return { stdout: "", stderr: "" };
    },
  });

  const result = await manager.fetchExactCommit({
    worktreePath: "/tmp/worktree",
    commitSha,
  });

  assert.deepEqual(result, { commitSha, remote: "origin" });
  assert.deepEqual(calls, [
    {
      file: "git",
      args: ["fetch", "--no-tags", "--no-recurse-submodules", "origin", commitSha],
      cwd: "/tmp/worktree",
    },
    {
      file: "git",
      args: ["cat-file", "-e", `${commitSha}^{commit}`],
      cwd: "/tmp/worktree",
    },
  ]);
});

test("rejects a squash landing whose trees differ", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: async (file, args) => {
      assert.equal(file, "git");
      if (args[0] === "status" || args[0] === "branch") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: "approved123\n", stderr: "" };
      }
      const tree = args[1].startsWith("approved123")
        ? "approved-tree"
        : "merged-tree";
      return { stdout: `${tree}\n`, stderr: "" };
    },
  });

  await assert.rejects(
    manager.proveExactTreeLanding({
      worktreePath: "/tmp/worktree",
      approvedHeadSha: "approved123",
      mergedCommitSha: "merged789",
      remoteMainSha: "merged789",
    }),
    /does not match/u,
  );
});

test("revalidates a proof immediately before returning a lease", async () => {
  const calls = [];
  const manager = new TreehouseWorktreeManager({
    binary: "/opt/treehouse",
    executeFile: async (file, args) => {
      calls.push({ file, args });
      if (file === "git" && args[0] === "status") {
        return { stdout: "", stderr: "" };
      }
      if (file === "git" && args[0] === "rev-parse") {
        return { stdout: "abc123\n", stderr: "" };
      }
      if (file === "git" && args[0] === "branch") {
        return { stdout: "\n", stderr: "" };
      }
      return { stdout: "", stderr: "returned" };
    },
  });

  await manager.returnLease({
    worktreePath: "/tmp/worktree",
    proof: {
      kind: "no-mutation",
      verified: true,
      worktreePath: "/tmp/worktree",
      headSha: "abc123",
    },
  });

  assert.deepEqual(calls.at(-1), {
    file: "/opt/treehouse",
    args: ["return", "/tmp/worktree"],
  });
});

test("refuses return when the worktree changed after proof", async () => {
  const manager = new TreehouseWorktreeManager({
    executeFile: gitInspection({ headSha: "changed", status: " M file.js\n" }),
  });

  await assert.rejects(
    manager.returnLease({
      worktreePath: "/tmp/worktree",
      proof: {
        kind: "no-mutation",
        verified: true,
        worktreePath: "/tmp/worktree",
        headSha: "abc123",
      },
    }),
    /changed after proof/u,
  );
});

function gitInspection({ headSha, status }) {
  return async (file, args) => {
    assert.equal(file, "git");
    if (args[0] === "status") {
      return { stdout: status, stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return { stdout: `${headSha}\n`, stderr: "" };
    }
    if (args[0] === "branch") {
      return { stdout: "\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
}
