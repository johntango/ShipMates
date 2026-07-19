import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const jobPath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: project-agent-pane-worker.js JOB.json");
const job = JSON.parse(await readFile(jobPath, "utf8"));
validateJob(job);
console.error(`[ShipMates ${job.projectName}] Project Agent started: ${job.planTaskId}`);
let exitCode = 1;
let signal = null;
try {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./persistent-project-task.js", import.meta.url)),
    job.projectId, job.planTaskId, job.baseSha,
  ], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, SHIPMATES_STATE_DIR: job.stateRoot },
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(`${job.instruction}\n`);
  ({ exitCode, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, childSignal) => resolve({ exitCode: code ?? 1, signal: childSignal }));
  }));
} finally {
  const marker = {
    schemaVersion: 1, projectId: job.projectId, planTaskId: job.planTaskId,
    taskId: job.taskId, exitCode, signal, completedAt: new Date().toISOString(),
  };
  const temporary = `${job.terminalPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, job.terminalPath);
  console.error(`[ShipMates ${job.projectName}] Project Agent ${exitCode === 0 ? "completed" : "failed"}: ${job.planTaskId}`);
}
process.exitCode = exitCode;

function validateJob(job) {
  for (const field of ["projectId", "projectName", "planTaskId", "taskId", "baseSha", "instruction", "stateRoot", "terminalPath"]) {
    if (typeof job?.[field] !== "string" || !job[field]) throw new Error(`Invalid Project Agent job field ${field}`);
  }
  if (job.schemaVersion !== 1 || !path.isAbsolute(job.stateRoot) || !path.isAbsolute(job.terminalPath)) {
    throw new Error("Invalid Project Agent job");
  }
}
