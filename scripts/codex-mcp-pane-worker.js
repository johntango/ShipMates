import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexMcpRuntime } from "../src/adapters/codex-mcp.js";
import { TaskStore } from "../src/storage/task-store.js";
import { buildScoutPrompt } from "../src/workflows/codex-scout.js";

const [rawStateDirectory, taskId, workerId] = process.argv.slice(2);
if (!rawStateDirectory || !taskId || !workerId || process.argv.length !== 5) {
  throw new Error("Usage: codex-mcp-pane-worker.js STATE_DIR TASK_ID WORKER_ID");
}
const stateDirectory = path.resolve(rawStateDirectory);
const artifactDirectory = path.join(
  stateDirectory,
  "tasks",
  taskId,
  "workers",
  workerId,
);
const paneId = process.env.HERDR_PANE_ID || null;

try {
  const store = new TaskStore({ rootDir: stateDirectory });
  const snapshot = await store.getSnapshot(taskId);
  const worker = snapshot.workers.find(({ id }) => id === workerId);
  if (
    snapshot.state !== "awaiting_worker" ||
    snapshot.worktree?.status !== "leased" ||
    worker?.status !== "dispatch_requested" ||
    worker.backend !== "codex-mcp" ||
    worker.sandbox !== "read-only" ||
    !worker.paneId ||
    paneId !== worker.paneId ||
    worker.worktreePath !== snapshot.worktree.worktreePath
  ) {
    throw new PaneWorkerAuthorityError();
  }

  const runtime = new CodexMcpRuntime();
  await runtime.run({
    taskId,
    workingDirectory: worker.worktreePath,
    prompt: buildScoutPrompt({ taskId, brief: worker.brief }),
    schemaPath: fileURLToPath(
      new URL("../schemas/codex-worker-report.schema.json", import.meta.url),
    ),
    artifactDirectory,
    sandbox: "read-only",
  });
  await writeTerminalMarker({
    schemaVersion: 1,
    taskId,
    workerId,
    paneId,
    status: "completed",
    errorName: null,
    completedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({ taskId, workerId, status: "artifact-recorded" }));
} catch (error) {
  const errorName = safeErrorName(error);
  await writeTerminalMarker({
    schemaVersion: 1,
    taskId,
    workerId,
    paneId,
    status: "failed",
    errorName,
    completedAt: new Date().toISOString(),
  });
  console.error(`ShipMates pane worker failed (${errorName})`);
  process.exitCode = 1;
}

async function writeTerminalMarker(value) {
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(artifactDirectory, "pane-terminal.json");
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, target);
}

function safeErrorName(error) {
  return typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : "UnknownError";
}

class PaneWorkerAuthorityError extends Error {
  constructor() {
    super("Pane worker authority does not match its durable dispatch");
    this.name = "PaneWorkerAuthorityError";
  }
}
