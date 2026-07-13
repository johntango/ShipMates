import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";

const execFileAsync = promisify(execFile);
const repoPath = path.resolve(process.argv[2] || "");
const taskId = process.argv[3] || "shipmates-treehouse-exercise";

if (!process.argv[2]) {
  throw new Error(
    "Usage: node scripts/treehouse-no-mutation-exercise.js <repo-path> [task-id]",
  );
}

const manager = new TreehouseWorktreeManager();
const remoteHead = await manager.prepareRepository({ repoPath });
const { stdout: expectedHead } = await execFileAsync(
  "git",
  ["rev-parse", "origin/main"],
  { cwd: repoPath, encoding: "utf8" },
);

const lease = await manager.lease({ repoPath, taskId });
const inspection = await manager.inspect({
  worktreePath: lease.worktreePath,
});
const statusWhileLeased = await manager.status({ repoPath });
const proof = await manager.proveNoMutation({
  worktreePath: lease.worktreePath,
  expectedHeadSha: expectedHead.trim(),
});

await manager.returnLease({ worktreePath: lease.worktreePath, proof });

const statusAfterReturn = await manager.status({ repoPath });

console.log(
  JSON.stringify(
    {
      taskId,
      remoteHead,
      lease,
      inspection,
      proof,
      statusWhileLeased,
      statusAfterReturn,
    },
    null,
    2,
  ),
);
