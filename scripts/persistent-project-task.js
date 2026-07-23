import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexWorkerRuntime } from "../src/adapters/codex-worker.js";
import { NoMistakesLocalGate } from "../src/adapters/no-mistakes.js";
import { HerdrPaneClient } from "../src/adapters/herdr-pane.js";
import { HerdrProjectAgentObserver } from "../src/adapters/herdr-project-agent.js";
import { HerdrNoMistakesObserver } from "../src/adapters/herdr-no-mistakes.js";
import { ProjectAgentController } from "../src/agents/project-agent.js";
import { ProjectStore } from "../src/projects/project-store.js";
import { PersistentProjectExecutor } from "../src/workflows/persistent-project-executor.js";

const [projectId, planTaskId, baseSha] = process.argv.slice(2);
const instruction = (await readStdin()).trim();
if (!projectId || !planTaskId || !baseSha || !instruction) {
  throw new Error("Usage: persistent-project-task.js PROJECT PLAN_TASK BASE_SHA < instruction");
}
const stateRoot = path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates");
const projectStore = new ProjectStore({ rootDir: stateRoot });
const executor = new PersistentProjectExecutor({
  projectStore,
  runtime: new CodexWorkerRuntime(),
  schemaPath: fileURLToPath(new URL("../schemas/codex-worker-report.schema.json", import.meta.url)),
  stateRoot,
});
const project = await projectStore.get(projectId);
const task = project.tasks.find(({ id }) => id === planTaskId);
const terminalMilestone = !project.tasks.some(({ dependsOn }) => dependsOn.includes(planTaskId));
const observer = new HerdrProjectAgentObserver({
  client: new HerdrPaneClient(), onWarning: (message) => console.error(message),
});
await observer.ensure(project);
let implementation = null;
let validation = null;
const operations = {
  inspect: async () => ({
    project: project.name, projectStatus: (await projectStore.get(projectId)).status,
    task: task.title, taskStatus: (await projectStore.get(projectId)).tasks.find(({ id }) => id === planTaskId).status,
    terminalMilestone, branch: project.executionPolicy.branch,
  }),
  dispatchImplementer: async (boundedInstruction) => {
    implementation = await executor.run({ projectId, planTaskId, instruction: boundedInstruction, baseSha });
    return implementation;
  },
  reconcileImplementer: async () => {
    implementation = await executor.reconcile({ projectId, planTaskId });
    return implementation || { status: "not_found" };
  },
  validateMilestone: async (intent) => {
    if (!terminalMilestone) throw new Error("Full validation is reserved for a terminal project milestone");
    implementation ||= await executor.reconcile({ projectId, planTaskId });
    if (implementation?.status !== "completed") throw new Error("Milestone validation requires completed implementation");
  const binaryPath = process.env.NO_MISTAKES_BIN || "/private/tmp/shipmates-no-mistakes-v1.37.0/no-mistakes";
  validation = await new NoMistakesLocalGate({
    binaryPath, stateRoot: path.join(stateRoot, "no-mistakes"),
    onProgress: (message) => console.error(`[no-mistakes] ${message}`),
    observer: new HerdrNoMistakesObserver({
      client: observer.client,
      watcherScript: fileURLToPath(new URL("./no-mistakes-pane.js", import.meta.url)),
    }),
  }).run({
    taskId: project.tasks.find(({ id }) => id === planTaskId).taskId,
    worktreePath: project.executionPolicy.worktreePath,
      expectedHeadSha: implementation.commit.headSha,
      intent,
  });
  const directory = path.join(stateRoot, "persistent-project-runs", projectId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${planTaskId}-milestone-validation.json`),
    `${JSON.stringify(validation, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (!validation.passed) await projectStore.updateTaskStatus({ projectId, planTaskId, status: "blocked" });
    return validation;
  },
  requestAttention: async (reason) => {
    await observer.stage(project, { state: "blocked", status: "awaiting-human", message: reason });
    return { referredTo: "Firstmate and human", reason };
  },
};
const result = await new ProjectAgentController({
  project, task, operations, observer,
  model: process.env.SHIPMATES_PROJECT_AGENT_MODEL || process.env.SHIPMATES_FIRSTMATE_MODEL || "gpt-5.6-luna",
}).execute(instruction);
console.log(JSON.stringify({ project: project.name, task: planTaskId, result, implementation, validation }, null, 2));

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.once("end", () => resolve(value));
    process.stdin.once("error", reject);
  });
}
