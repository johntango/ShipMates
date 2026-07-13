import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";

const execFileAsync = promisify(execFile);

if (!process.argv[2] || !process.argv[3]) {
  throw new Error(
    "Usage: node scripts/treehouse-lease-task.js <repo-path> <task-id>",
  );
}

const repoPath = path.resolve(process.argv[2]);
const taskId = process.argv[3];
const manager = new TreehouseWorktreeManager();
const remoteHead = await manager.prepareRepository({ repoPath });
const { stdout: baseShaOutput } = await execFileAsync(
  "git",
  ["rev-parse", remoteHead],
  { cwd: repoPath, encoding: "utf8" },
);
const baseSha = baseShaOutput.trim();
const lease = await manager.lease({ repoPath, taskId });
const inspection = await manager.inspect({
  worktreePath: lease.worktreePath,
});

if (inspection.dirty || inspection.headSha !== baseSha) {
  throw new Error(
    `Leased worktree failed preflight: expected clean ${baseSha}, got ${inspection.headSha}`,
  );
}

console.log(
  JSON.stringify(
    {
      taskId,
      remoteHead,
      baseSha,
      lease,
      inspection,
      status: await manager.status({ repoPath }),
    },
    null,
    2,
  ),
);
