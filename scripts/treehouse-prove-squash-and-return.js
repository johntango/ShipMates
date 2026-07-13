import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";

const execFileAsync = promisify(execFile);

if (!process.argv[2] || !process.argv[3] || !process.argv[4] || !process.argv[5]) {
  throw new Error(
    "Usage: node scripts/treehouse-prove-squash-and-return.js <repo-path> <worktree-path> <approved-head-sha> <merged-commit-sha>",
  );
}

const repoPath = path.resolve(process.argv[2]);
const worktreePath = path.resolve(process.argv[3]);
const approvedHeadSha = process.argv[4];
const mergedCommitSha = process.argv[5];
const manager = new TreehouseWorktreeManager();

await execFileAsync("git", ["fetch", "origin", "main"], {
  cwd: repoPath,
  encoding: "utf8",
});
const { stdout: remoteMainOutput } = await execFileAsync(
  "git",
  ["rev-parse", "origin/main"],
  { cwd: repoPath, encoding: "utf8" },
);
const remoteMainSha = remoteMainOutput.trim();
const proof = await manager.proveExactTreeLanding({
  worktreePath,
  approvedHeadSha,
  mergedCommitSha,
  remoteMainSha,
});

await manager.returnLease({ worktreePath, proof });

console.log(
  JSON.stringify(
    {
      returned: true,
      proof,
      statusAfterReturn: await manager.status({ repoPath }),
    },
    null,
    2,
  ),
);
