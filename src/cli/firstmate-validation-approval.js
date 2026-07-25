import path from "node:path";

import { NoMistakesLocalGate } from "../adapters/no-mistakes.js";
import { LocalDeliveryWorkflow } from "../workflows/local-delivery.js";
import { LocalValidationWorkflow } from "../workflows/local-validation.js";

export async function handleValidationApproval(message, {
  store,
  projectStore,
  orchestrator,
  advanceProject,
  binaryPath = process.env.NO_MISTAKES_BIN ||
    "/private/tmp/shipmates-no-mistakes-v1.41.1/no-mistakes",
  createGate = (options) => new NoMistakesLocalGate(options),
  createValidationWorkflow = (options) => new LocalValidationWorkflow(options),
  createDeliveryWorkflow = (options) => new LocalDeliveryWorkflow(options),
  schedule = setImmediate,
  onProgress = (value) => console.error(`[no-mistakes] ${value}`),
} = {}) {
  const match = message.match(
    /^approve validation for task ([a-z0-9][a-z0-9._-]{2,63})$/iu,
  );
  if (!match) return null;

  const taskId = match[1].toLowerCase();
  const snapshot = await store.getSnapshot(taskId);
  const prior = snapshot.validationRuns?.at(-1);
  if (prior?.passed !== true) {
    const intentIndex = prior?.command?.args?.indexOf("--intent") ?? -1;
    const intent = intentIndex >= 0 ? prior.command.args[intentIndex + 1] : null;
    if (!intent) throw new Error(`Task ${taskId} has no durable validation intent`);

    const gate = createGate({
      binaryPath,
      stateRoot: path.join(store.rootDir, "no-mistakes"),
      onProgress,
    });
    await createValidationWorkflow({
      store, gate, actor: "firstmate",
    }).approve({ taskId, intent });
  }

  const registered = await projectStore.describeAttempt(taskId);
  const registeredProject = registered
    ? await projectStore.get(registered.projectId) : null;
  await createDeliveryWorkflow({
    store, actor: "firstmate",
  }).deliver({
    taskId,
    destinationRepoPath: registeredProject?.repoPath,
  });

  const reconciled = await orchestrator.reconcileTask(taskId);
  const project = await projectStore.get(reconciled.context.projectId);
  if (project.executionPolicy?.autoAdvance !== false) {
    schedule(() => void advanceProject(project.id, {
      reason: "validation approved and delivered",
    }));
  }
  return { taskId, project, context: reconciled.context };
}
