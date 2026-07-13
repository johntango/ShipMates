import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexMcpRuntime } from "../src/adapters/codex-mcp.js";
import {
  HerdrPaneClient,
  HerdrPanePool,
  HerdrPaneWorkerLauncher,
} from "../src/adapters/herdr-pane.js";
import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { TaskStore } from "../src/storage/task-store.js";
import { ParallelCodexScoutsWorkflow } from "../src/workflows/parallel-codex-scouts.js";

const [command, ...args] = process.argv.slice(2);
const rootDir = path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates");
const store = new TaskStore({ rootDir });
const paneClient = new HerdrPaneClient();
const workflow = new ParallelCodexScoutsWorkflow({
  store,
  runtime: new CodexMcpRuntime(),
  worktreeManager: new TreehouseWorktreeManager(),
  panePool: new HerdrPanePool({ client: paneClient, store }),
  paneLauncher: new HerdrPaneWorkerLauncher({
    client: paneClient,
    workerScript: fileURLToPath(
      new URL("./codex-mcp-pane-worker.js", import.meta.url),
    ),
    stateDirectory: rootDir,
  }),
  paneCwd: process.cwd(),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});

let snapshot;
switch (command) {
  case "run": {
    if (args.length !== 5) usage();
    const [taskId, firstWorkerId, firstBriefFile, secondWorkerId, secondBriefFile] = args;
    snapshot = await workflow.run({
      taskId,
      scouts: [
        { workerId: firstWorkerId, brief: await readBrief(firstBriefFile) },
        { workerId: secondWorkerId, brief: await readBrief(secondBriefFile) },
      ],
    });
    break;
  }
  case "reconcile": {
    if (args.length !== 3) usage();
    snapshot = await workflow.reconcile({
      taskId: args[0],
      workerIds: args.slice(1),
    });
    break;
  }
  default:
    usage();
}

console.log(JSON.stringify(snapshot, null, 2));

async function readBrief(file) {
  const value = await readFile(path.resolve(file), "utf8");
  if (value.trim() === "") throw new Error(`Brief file is empty: ${file}`);
  return value;
}

function usage() {
  throw new Error(
    "Usage: codex-mcp-pair.js run TASK WORKER_A BRIEF_FILE_A WORKER_B BRIEF_FILE_B | reconcile TASK WORKER_A WORKER_B",
  );
}
