import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexWorkerRuntime } from "../src/adapters/codex-worker.js";
import { HerdrExecutionObserver } from "../src/adapters/herdr-execution.js";
import { HerdrPaneClient, HerdrPanePool } from "../src/adapters/herdr-pane.js";
import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import {
  createFirstmateId,
  discoverFirstmateContext,
} from "../src/cli/firstmate-context.js";
import { readFirstmateMessage } from "../src/cli/firstmate-message.js";
import { TaskStore } from "../src/storage/task-store.js";
import { FirstmateShell } from "../src/workflows/firstmate.js";
import { FirstmateLocalExecutor } from "../src/workflows/firstmate-local-executor.js";
import { prepareFirstmateLocalWrite } from "../src/workflows/firstmate-local-write.js";
import { CodexShipWorkflow } from "../src/workflows/codex-ship.js";

const rawArgs = process.argv.slice(2);
const classifyOnlyIndex = rawArgs.indexOf("--classify-only");
const classifyOnly = classifyOnlyIndex !== -1;
if (classifyOnly) rawArgs.splice(classifyOnlyIndex, 1);

let taskId;
let requestId;
let repo;
let baseSha;
let repoPath = process.cwd();
let messageParts;
if (rawArgs.length === 0) {
  const context = await discoverFirstmateContext({ cwd: repoPath });
  taskId = createFirstmateId("task");
  requestId = createFirstmateId("request");
  ({ repo, baseSha, repoPath } = context);
  messageParts = [];
  console.error(`Firstmate task: ${taskId}`);
} else if (rawArgs.length >= 4) {
  [taskId, requestId, repo, baseSha, ...messageParts] = rawArgs;
} else {
  throw new Error(
    "Usage: firstmate.js [--classify-only] [<task-id> <request-id> <owner/repo> <base-sha> [message...]]",
  );
}

const message = await readFirstmateMessage({ messageParts });

const rootDir = path.resolve(
  process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"),
);
const model = process.env.SHIPMATES_FIRSTMATE_MODEL || "gpt-5.6-luna";
const tracingEnabled = parseBoolean(
  "SHIPMATES_FIRSTMATE_TRACING",
  process.env.SHIPMATES_FIRSTMATE_TRACING,
);
const store = new TaskStore({ rootDir });
const herdrObserver = createHerdrObserver({ store });
await herdrObserver?.firstmateStage({
  taskId,
  repoPath,
  message: "Classifying request",
  customStatus: "classifying",
});
const shell = new FirstmateShell({ store, model, tracingEnabled });
const result = await shell.classify({
  taskId,
  requestId,
  repo,
  baseSha,
  message,
});

let execution = null;
if (!classifyOnly) {
  const executionContext = await discoverFirstmateContext({ cwd: repoPath });
  if (executionContext.repo !== repo || executionContext.baseSha !== baseSha) {
    throw new Error(
      "Firstmate execution requires the current checkout to match the supplied owner/repo and base SHA; use --classify-only for detached intake",
    );
  }
  repoPath = executionContext.repoPath;
  const runtime = new CodexWorkerRuntime();
  const schemaPath = fileURLToPath(
    new URL("../schemas/codex-worker-report.schema.json", import.meta.url),
  );
  let implementationWorkflow = null;
  if (result.classification.requiredAuthority === "local_write") {
    const manager = new TreehouseWorktreeManager();
    const prepared = await prepareFirstmateLocalWrite({
      store,
      manager,
      taskId,
      requestId,
      repoPath,
    });
    repoPath = prepared.worktree.worktreePath;
    implementationWorkflow = new CodexShipWorkflow({
      store,
      runtime,
      worktreeManager: manager,
      schemaPath,
      actor: "firstmate",
      observer: herdrObserver,
    });
  }
  console.error(
    result.classification.requiresHumanApproval
      ? `Firstmate stopped at ${result.classification.approvalBoundary}.`
      : "Firstmate is dispatching two independent scouts.",
  );
  const executor = new FirstmateLocalExecutor({
    runtime,
    schemaPath,
    store,
    actor: "firstmate",
    observer: herdrObserver,
    implementationWorkflow,
  });
  execution = await executor.execute({
    taskId,
    requestId,
    repoPath,
    message,
    classification: result.classification,
  });
}
if (classifyOnly) {
  await herdrObserver?.firstmateStage({
    taskId,
    repoPath,
    state: "idle",
    message: "Classification completed",
    customStatus: "classified",
  });
}
const finalSnapshot = execution ? await store.getSnapshot(taskId) : result.snapshot;

console.log(
  JSON.stringify(
    {
      taskId,
      requestId,
      reused: result.reused,
      classification: result.classification,
      usage: result.usage,
      ledger: {
        state: finalSnapshot.state,
        eventsCount: finalSnapshot.eventsCount,
        lastEventId: finalSnapshot.lastEventId,
      },
      execution,
    },
    null,
    2,
  ),
);

function parseBoolean(name, value) {
  if (value === undefined || value === "" || value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") return true;
  throw new TypeError(`${name} must be true, false, 1, or 0`);
}

function createHerdrObserver({ store }) {
  const currentPaneId = process.env.HERDR_PANE_ID;
  if (!currentPaneId) return null;
  const client = new HerdrPaneClient();
  return new HerdrExecutionObserver({
    client,
    panePool: new HerdrPanePool({ client, store, currentPaneId }),
    currentPaneId,
    onWarning: (message) => console.error(message),
  });
}
