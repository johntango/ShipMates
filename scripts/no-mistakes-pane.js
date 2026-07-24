import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import {
  parseAxiRunId,
  matchesExpectedAxiRun,
  projectNoMistakesHerdrStatus,
} from "../src/adapters/herdr-no-mistakes.js";
import { HerdrPaneClient } from "../src/adapters/herdr-pane.js";

const execFileAsync = promisify(execFile);
const [
  binaryPath, runtimeHome, worktreePath, paneId, source, agent, expectedHeadSha,
] = process.argv.slice(2);
if (!binaryPath || !runtimeHome || !worktreePath || !paneId || !source || !agent ||
    !expectedHeadSha) {
  throw new Error(
    "Usage: no-mistakes-pane.js BINARY NM_HOME WORKTREE PANE SOURCE AGENT EXPECTED_HEAD",
  );
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
const startedAt = Date.now();
const client = new HerdrPaneClient({ env });
let sequence = startedAt;
let runId = null;
let lastProjection = null;
async function inspectAndReport() {
  const args = runId ? ["axi", "status", "--run", runId] : ["axi", "status"];
  const { stdout } = await execFileAsync(binaryPath, args, {
    cwd: worktreePath,
    env,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (!runId && matchesExpectedAxiRun(stdout, expectedHeadSha)) {
    runId = parseAxiRunId(stdout);
  }
  const projection = projectNoMistakesHerdrStatus(stdout, { elapsedMs: Date.now() - startedAt });
  if (!lastProjection || projection.customStatus !== lastProjection.customStatus ||
      projection.state !== lastProjection.state) {
    await client.reportAgent({
      paneId, source, agent,
      state: projection.state,
      message: projection.message,
      customStatus: projection.customStatus,
      seq: ++sequence,
      agentSessionId: runId || undefined,
      agentSessionPath: worktreePath,
    });
    lastProjection = projection;
  }
  return projection;
}
while (!runId && Date.now() <= deadline) {
  try {
    await inspectAndReport();
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
const reporter = setInterval(() => {
  inspectAndReport().catch(() => {});
}, 1_000);
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
clearInterval(reporter);
await inspectAndReport().catch(() => {});
