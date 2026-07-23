import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { parseAxiRunId } from "../src/adapters/herdr-no-mistakes.js";

const execFileAsync = promisify(execFile);
const [binaryPath, runtimeHome, worktreePath] = process.argv.slice(2);
if (!binaryPath || !runtimeHome || !worktreePath) {
  throw new Error("Usage: no-mistakes-pane.js BINARY NM_HOME WORKTREE");
}

const env = {
  ...process.env,
  NM_HOME: runtimeHome,
  NO_MISTAKES_TELEMETRY: "0",
  NO_MISTAKES_NO_UPDATE_CHECK: "1",
};
for (const name of [
  "GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "GLAB_TOKEN",
  "NO_MISTAKES_BITBUCKET_API_TOKEN", "AZURE_DEVOPS_EXT_PAT", "OPENAI_API_KEY",
]) delete env[name];
const deadline = Date.now() + 30_000;
let runId = null;
while (!runId && Date.now() <= deadline) {
  try {
    const { stdout } = await execFileAsync(binaryPath, ["axi", "status"], {
      cwd: worktreePath,
      env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    runId = parseAxiRunId(stdout);
  } catch {
    // The AXI process and daemon may still be registering the run.
  }
  if (!runId) await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!runId) throw new Error("Timed out waiting for the no-mistakes run");

const child = spawn(binaryPath, ["attach", "--run", runId], {
  cwd: worktreePath,
  env,
  stdio: "inherit",
});
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
