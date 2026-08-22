import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexWorkerRuntime } from "../src/adapters/codex-worker.js";
import { ControlledGitCommitAdapter } from "../src/adapters/git-commit.js";
import { resolvePinnedTreehouseBinary, TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { implementationPrompt } from "../src/workflow-run/worker-contract.js";

const requestPath = path.resolve(process.argv[2] || "");
const directory = path.dirname(requestPath);
try {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const manager = new TreehouseWorktreeManager({
    binary: await resolvePinnedTreehouseBinary({ explicitPath: process.env.TREEHOUSE_BIN || null }),
  });
  await manager.prepareRepository({ repoPath: request.repoPath });
  const lease = await manager.lease({ repoPath: request.repoPath, taskId: request.runId });
  await writeAtomic(path.join(directory, "workspace.json"), {
    schemaVersion: 1, runId: request.runId, repoPath: path.resolve(request.repoPath),
    worktreePath: path.resolve(lease.worktreePath), baseHeadSha: request.baseHeadSha,
  });
  await manager.alignLeaseBase({ worktreePath: lease.worktreePath, expectedHeadSha: request.baseHeadSha });
  const branch = `agent/${request.runId.slice(0, 48)}`;
  await manager.prepareTaskBranch({
    worktreePath: lease.worktreePath, expectedHeadSha: request.baseHeadSha,
    branch, expectedChangedPaths: [],
  });
  const runtime = new CodexWorkerRuntime();
  const worker = await runtime.run({
    taskId: request.runId,
    workingDirectory: lease.worktreePath,
    prompt: implementationPrompt(request),
    schemaPath: fileURLToPath(new URL("../schemas/codex-worker-report.schema.json", import.meta.url)),
    artifactDirectory: request.artifactDirectory,
    sandbox: "workspace-write",
  });
  if (worker.report.status !== "completed") throw new Error("Implementer did not report completion");
  const paths = await manager.inspectChangedPaths({ worktreePath: lease.worktreePath });
  const changedPaths = [...paths.all].sort();
  const reportedPaths = [...worker.report.files].sort();
  if (paths.staged.length || paths.ignored.length || changedPaths.length === 0 ||
    JSON.stringify(changedPaths) !== JSON.stringify(reportedPaths)) {
    throw new Error("Implementer changes do not match its report");
  }
  const committed = await new ControlledGitCommitAdapter().create({
    worktreePath: lease.worktreePath, baseHeadSha: request.baseHeadSha, branch,
    changedPaths, message: "feat: implement approved First Mate request",
  });
  await writeAtomic(path.join(directory, "result.json"), {
    schemaVersion: 1, workspacePath: lease.worktreePath, headSha: committed.headSha,
    clean: committed.clean, commitCreated: committed.commitCreated,
    report: worker.report,
  });
} catch (error) {
  await writeAtomic(path.join(directory, "failure.json"), {
    schemaVersion: 1,
    name: typeof error?.name === "string" ? error.name : "WorkerError",
    message: "Implementer stopped before producing a verified candidate commit",
  });
  process.exitCode = 1;
}

async function writeAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
