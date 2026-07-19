import path from "node:path";

export class FirstmateLocalExecutor {
  constructor({
    runtime, schemaPath, store = null, actor = "firstmate", observer = null,
    implementationWorkflow = null, scoutLimit = 2,
  } = {}) {
    if (!runtime || typeof runtime.run !== "function" || !schemaPath) {
      throw new TypeError("FirstmateLocalExecutor requires runtime and schemaPath");
    }
    this.runtime = runtime;
    this.schemaPath = path.resolve(schemaPath);
    this.store = store;
    this.actor = actor;
    this.observer = observer;
    this.implementationWorkflow = implementationWorkflow;
    if (!Number.isInteger(scoutLimit) || scoutLimit < 1 || scoutLimit > 2) {
      throw new TypeError("scoutLimit must be 1 or 2");
    }
    this.scoutLimit = scoutLimit;
  }

  async execute({ taskId, requestId, repoPath, message, classification }) {
    requireInputs({ taskId, requestId, repoPath, message, classification });
    if (classification.requiresHumanApproval) {
      await this.observer?.end?.({ status: "awaiting-human" });
      return {
        status: "awaiting_human",
        taskId,
        requestId,
        reason: `Firstmate stopped at ${classification.approvalBoundary}`,
        scouts: [],
        implementation: null,
      };
    }

    const workItems = normalizedWorkItems(classification, message, this.scoutLimit);
    await this.observer?.begin?.({ taskId, repoPath, workerCount: workItems.length });
    let scouts = [];
    let implementation = null;
    let status = "inspected";
    try {
      scouts = await Promise.all(workItems.map((workItem, index) =>
        this.#runWorker({
          taskId,
          repoPath,
          workerId: `scout-${index + 1}`,
          sandbox: "read-only",
          prompt: buildScoutPrompt({ taskId, message, workItem }),
        })));

      if (classification.requiredAuthority === "local_write") {
        await this.observer?.prepareImplementer?.();
        implementation = this.implementationWorkflow
          ? await this.#runDurableImplementation({ taskId, message, scouts })
          : await this.#runWorker({
              taskId,
              repoPath,
              workerId: "implementer",
              sandbox: "workspace-write",
              prompt: buildImplementationPrompt({ taskId, message, scouts }),
            });
        status = implementation.report.status;
      }
    } catch (error) {
      await this.observer?.end?.({ status: "failed" });
      const result = {
        status: "failed",
        taskId,
        requestId,
        workspacePath: repoPath,
        scouts: scouts.map(publicWorkerResult),
        implementation: null,
        failure: {
          name: safeErrorName(error),
          message: safeErrorMessage(error),
        },
      };
      await this.#recordResult(result);
      return result;
    }

    const result = {
      status,
      taskId,
      requestId,
      workspacePath: repoPath,
      scouts: scouts.map(publicWorkerResult),
      implementation: implementation ? publicWorkerResult(implementation) : null,
    };
    await this.#recordResult(result);
    await this.observer?.end?.({ status });
    return result;
  }

  async #runWorker({ taskId, repoPath, workerId, sandbox, prompt }) {
    const artifactDirectory = path.join(
      this.store?.rootDir || path.join(repoPath, ".shipmates"),
      "tasks",
      taskId,
      "local-execution",
      workerId,
    );
    await this.observer?.workerStarted?.({ workerId, sandbox });
    try {
      const result = await this.runtime.run({
        taskId,
        workerId,
        workingDirectory: repoPath,
        prompt,
        schemaPath: this.schemaPath,
        artifactDirectory,
        sandbox,
        onEvent: (event) => this.observer?.workerEvent?.({ workerId, event }),
      });
      await this.observer?.workerFinished?.({ workerId, report: result.report });
      return { workerId, ...result };
    } catch (error) {
      await this.observer?.workerFailed?.({ workerId, error });
      throw error;
    }
  }

  async #runDurableImplementation({ taskId, message, scouts }) {
    const result = await this.implementationWorkflow.run({
      taskId,
      workerId: "implementer",
      brief: buildImplementationPrompt({ taskId, message, scouts }),
    });
    return {
      workerId: result.worker.id,
      threadId: result.worker.threadId,
      report: result.worker.report,
    };
  }

  async #recordResult(result) {
    if (!this.store) return;
    await this.store.recordEvidence({
      taskId: result.taskId,
      actor: this.actor,
      kind: "firstmate-local-execution",
      value: JSON.stringify({
        requestId: result.requestId,
        status: result.status,
        workspacePath: result.workspacePath,
        scouts: result.scouts.map(({ workerId, threadId, report }) => ({
          workerId,
          threadId,
          status: report.status,
        })),
        implementation: result.implementation
          ? {
              workerId: result.implementation.workerId,
              threadId: result.implementation.threadId,
              report: result.implementation.report,
            }
          : null,
        failure: result.failure || null,
      }),
      eventId: `firstmate-${result.requestId}-local-execution`,
    });
  }
}

function buildScoutPrompt({ taskId, message, workItem }) {
  return [
    `You are an independent read-only ShipMates scout for task ${taskId}.`,
    "Do not edit files, commit, push, use GitHub, or address the human.",
    "Do not inspect .shipmates, prior task artifacts, worker logs, or other orchestration state.",
    "An empty repository is valid evidence. Do not claim that named conventions exist when they are absent.",
    "Stay focused on repository evidence directly relevant to the user request.",
    "Use no more than six tool calls. Stop as soon as you have enough evidence for the structured report.",
    "This work item is assigned only to you. Do not investigate another scout's work item.",
    `Assigned work item: ${workItem}`,
    `User request: ${message}`,
    `Return the required structured worker report with taskId exactly "${taskId}".`,
  ].join("\n");
}

function normalizedWorkItems(classification, message, scoutLimit) {
  const values = Array.isArray(classification.workItems)
    ? classification.workItems.map((value) => String(value).trim()).filter(Boolean)
    : [message];
  return [...new Set(values)].slice(0, scoutLimit);
}

function buildImplementationPrompt({ taskId, message, scouts }) {
  return [
    `You are the bounded local implementation worker for ShipMates task ${taskId}.`,
    "Implement the user's request in the current workspace and run relevant tests.",
    "Do not commit, push, open a pull request, access GitHub, or perform destructive cleanup.",
    "Do not inspect or modify .shipmates or prior task artifacts.",
    "Preserve unrelated existing changes. Make the smallest compatible production-quality change.",
    "An empty repository is a valid starting point; create the requested files when the user asked for a new project.",
    `Return the required structured worker report with taskId exactly "${taskId}".`,
    `User request: ${message}`,
    "Independent scout reports:",
    JSON.stringify(scouts.map(({ workerId, report }) => ({ workerId, report }))),
    "Inspect the repository yourself; scout claims are advisory. Return the required structured worker report with exact files, tests, and unresolved risks.",
  ].join("\n");
}

function publicWorkerResult({ workerId, threadId, report }) {
  return { workerId, threadId, report };
}

function requireInputs(values) {
  for (const [name, value] of Object.entries(values)) {
    if (name === "classification") {
      if (!value || typeof value !== "object") {
        throw new TypeError("classification is required");
      }
    } else if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`${name} must be a non-empty string`);
    }
  }
}

function safeErrorName(error) {
  return typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : "UnknownError";
}

function safeErrorMessage(error) {
  const message = typeof error?.message === "string" ? error.message : "Worker failed";
  return message.replaceAll(/\s+/gu, " ").trim().slice(0, 500) || "Worker failed";
}
