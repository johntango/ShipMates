import path from "node:path";

import {
  NoMistakesGateError,
  NoMistakesLocalGate,
  resolvePinnedNoMistakesBinary,
} from "../adapters/no-mistakes.js";
import { LocalDeliveryWorkflow } from "../workflows/local-delivery.js";
import {
  LocalValidationRecoveryRequiredError,
  LocalValidationWorkflow,
} from "../workflows/local-validation.js";

export async function handleValidationApproval(message, {
  store,
  projectStore,
  orchestrator,
  advanceProject,
  binaryPath = null,
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

  binaryPath ||= await resolvePinnedNoMistakesBinary({
    explicitPath: process.env.NO_MISTAKES_BIN || null,
  });

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
    try {
      await createValidationWorkflow({
        store, gate, actor: "firstmate",
      }).approve({ taskId, intent });
    } catch (error) {
      if (!(error instanceof NoMistakesGateError) &&
        !(error instanceof LocalValidationRecoveryRequiredError)) throw error;
      const current = await store.getSnapshot(taskId);
      if (current.state === "awaiting_human") {
        await store.transition({
          taskId,
          from: "awaiting_human",
          to: "recovery_required",
          actor: "firstmate",
          reason: `Validation approval could not be reconciled safely: ${error.message}`,
          eventId: `${taskId}:validation:approval-recovery-required:v1`,
        });
      }
      if (current.state === "awaiting_human" || current.state === "recovery_required") {
        await orchestrator.reconcileTask(taskId);
      }
      throw new Error(
        `Validation approval for ${taskId} requires reconciliation; it is no longer waiting for human input. ${error.message}`,
        { cause: error },
      );
    }
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

export async function reconcileCompletedValidationApproval(taskId, {
  store,
  projectStore,
  orchestrator,
  advanceProject,
  binaryPath = null,
  createGate = (options) => new NoMistakesLocalGate(options),
  createValidationWorkflow = (options) => new LocalValidationWorkflow(options),
  createDeliveryWorkflow = (options) => new LocalDeliveryWorkflow(options),
  schedule = setImmediate,
  onProgress = (value) => console.error(`[no-mistakes] ${value}`),
} = {}) {
  const snapshot = await store.getSnapshot(taskId);
  const prior = snapshot.validationRuns?.at(-1);
  const intentIndex = prior?.command?.args?.indexOf("--intent") ?? -1;
  const intent = intentIndex >= 0 ? prior.command.args[intentIndex + 1] : null;
  if (!intent || snapshot.state !== "awaiting_human") return null;
  binaryPath ||= await resolvePinnedNoMistakesBinary({
    explicitPath: process.env.NO_MISTAKES_BIN || null,
  });
  const gate = createGate({
    binaryPath,
    stateRoot: path.join(store.rootDir, "no-mistakes"),
    onProgress,
  });
  const result = await createValidationWorkflow({
    store, gate, actor: "firstmate",
  }).reconcileCompletedApproval({ taskId, intent });
  if (!result.reconciled) return null;

  const registered = await projectStore.describeAttempt(taskId);
  const registeredProject = registered
    ? await projectStore.get(registered.projectId) : null;
  await createDeliveryWorkflow({ store, actor: "firstmate" }).deliver({
    taskId, destinationRepoPath: registeredProject?.repoPath,
  });
  const reconciled = await orchestrator.reconcileTask(taskId);
  const project = await projectStore.get(reconciled.context.projectId);
  if (project.executionPolicy?.autoAdvance !== false) {
    schedule(() => void advanceProject(project.id, {
      reason: "completed validation reconciled and delivered",
    }));
  }
  return { taskId, project, context: reconciled.context };
}
