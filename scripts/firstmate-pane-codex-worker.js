import { readFile, unlink } from "node:fs/promises";

import { CodexWorkerRuntime } from "../src/adapters/codex-worker.js";
import { writePaneTerminalMarker } from "../src/adapters/herdr-codex-worker.js";

const [jobPath] = process.argv.slice(2);
if (!jobPath || process.argv.length !== 3) {
  throw new Error("Usage: firstmate-pane-codex-worker.js JOB_FILE");
}

let job;
try {
  job = JSON.parse(await readFile(jobPath, "utf8"));
  validateJob(job);
  if (process.env.HERDR_PANE_ID !== job.paneId) throw new PaneWorkerAuthorityError();
  console.log(`[ShipMates ${job.workerId}] Codex started (${job.sandbox})`);
  const runtime = new CodexWorkerRuntime();
  const result = await runtime.run({
    taskId: job.taskId,
    workingDirectory: job.workingDirectory,
    prompt: job.prompt,
    schemaPath: job.schemaPath,
    artifactDirectory: job.artifactDirectory,
    sandbox: job.sandbox,
    onEvent: (event) => {
      const activity = describeEvent(event);
      if (activity) console.log(`[ShipMates ${job.workerId}] ${activity}`);
    },
  });
  await writePaneTerminalMarker(job.artifactDirectory, {
    schemaVersion: 1,
    taskId: job.taskId,
    workerId: job.workerId,
    paneId: job.paneId,
    status: "completed",
    errorName: null,
    threadId: result.threadId,
    completedAt: new Date().toISOString(),
  });
  console.log(`[ShipMates ${job.workerId}] Codex completed`);
} catch (error) {
  if (job?.artifactDirectory && job?.taskId && job?.workerId && job?.paneId) {
    await writePaneTerminalMarker(job.artifactDirectory, {
      schemaVersion: 1,
      taskId: job.taskId,
      workerId: job.workerId,
      paneId: job.paneId,
      status: "failed",
      errorName: safeErrorName(error),
      completedAt: new Date().toISOString(),
    }).catch(() => {});
  }
  console.error(`[ShipMates worker] failed (${safeErrorName(error)})`);
  process.exitCode = 1;
} finally {
  await unlink(jobPath).catch(() => {});
}

function validateJob(value) {
  if (!value || value.schemaVersion !== 1) throw new PaneWorkerAuthorityError();
  for (const key of [
    "taskId", "workerId", "paneId", "workingDirectory", "prompt",
    "schemaPath", "artifactDirectory", "sandbox",
  ]) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new PaneWorkerAuthorityError();
    }
  }
  if (!new Set(["read-only", "workspace-write"]).has(value.sandbox)) {
    throw new PaneWorkerAuthorityError();
  }
}

function describeEvent(event) {
  if (event?.type === "thread.started") return "thread started";
  if (!new Set(["item.started", "item.completed"]).has(event?.type)) return null;
  const phase = event.type === "item.started" ? "started" : "completed";
  const type = {
    command_execution: "shell",
    file_change: "file edit",
    mcp_tool_call: "MCP tool",
    web_search: "web search",
  }[event.item?.type];
  return type ? `${type} ${phase}` : null;
}

function safeErrorName(error) {
  return typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : "UnknownError";
}

class PaneWorkerAuthorityError extends Error {
  constructor() {
    super("Pane worker job does not match its Herdr execution authority");
    this.name = "PaneWorkerAuthorityError";
  }
}
