import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";

const execFileAsync = promisify(execFile);

if (!process.argv[2] || !process.argv[3]) {
  throw new Error(
    "Usage: node scripts/treehouse-recover-no-mutation.js <repo-path> <worktree-path>",
  );
}

const repoPath = path.resolve(process.argv[2]);
const worktreePath = path.resolve(process.argv[3]);
const manager = new TreehouseWorktreeManager();

const remoteHead = await manager.prepareRepository({ repoPath });
const { stdout: expectedHead } = await execFileAsync(
  "git",
  ["rev-parse", remoteHead],
  { cwd: repoPath, encoding: "utf8" },
);
const proof = await manager.proveNoMutation({
  worktreePath,
  expectedHeadSha: expectedHead.trim(),
});

await manager.returnLease({ worktreePath, proof });

console.log(
  JSON.stringify(
    {
      recovered: true,
      remoteHead,
      worktreePath,
      proof,
      statusAfterReturn: await manager.status({ repoPath }),
    },
    null,
    2,
  ),
);
