import path from "node:path";

const scoutPerspectives = Object.freeze([
  "Inspect the requested change from the perspective of existing architecture, public APIs, and compatibility. Identify the smallest coherent implementation and relevant files.",
  "Independently inspect the requested change from the perspective of tests, edge cases, documentation, and regression risk. Identify validation commands and likely pitfalls.",
]);

export class FirstmateLocalExecutor {
  constructor({
    runtime, schemaPath, store = null, actor = "firstmate", observer = null,
  } = {}) {
    if (!runtime || typeof runtime.run !== "function" || !schemaPath) {
      throw new TypeError("FirstmateLocalExecutor requires runtime and schemaPath");
    }
    this.runtime = runtime;
    this.schemaPath = path.resolve(schemaPath);
    this.store = store;
    this.actor = actor;
    this.observer = observer;
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

    await this.observer?.begin?.({ taskId, repoPath });
    let scouts;
    let implementation = null;
    let status = "inspected";
    try {
      scouts = await Promise.all(scoutPerspectives.map((perspective, index) =>
        this.#runWorker({
          taskId,
          repoPath,
          workerId: `scout-${index + 1}`,
          sandbox: "read-only",
          prompt: buildScoutPrompt({ taskId, message, perspective }),
        })));

      if (classification.requiredAuthority === "local_write") {
        await this.observer?.prepareImplementer?.();
        implementation = await this.#runWorker({
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
      throw error;
    }

    const result = {
      status,
      taskId,
      requestId,
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

  async #recordResult(result) {
    if (!this.store) return;
    await this.store.recordEvidence({
      taskId: result.taskId,
      actor: this.actor,
      kind: "firstmate-local-execution",
      value: JSON.stringify({
        requestId: result.requestId,
        status: result.status,
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
      }),
      eventId: `firstmate-${result.requestId}-local-execution`,
    });
  }
}

function buildScoutPrompt({ taskId, message, perspective }) {
  return [
    `You are an independent read-only ShipMates scout for task ${taskId}.`,
    "Do not edit files, commit, push, use GitHub, or address the human.",
    perspective,
    `User request: ${message}`,
    "Inspect the repository directly and return the required structured worker report.",
  ].join("\n");
}

function buildImplementationPrompt({ taskId, message, scouts }) {
  return [
    `You are the bounded local implementation worker for ShipMates task ${taskId}.`,
    "Implement the user's request in the current workspace and run relevant tests.",
    "Do not commit, push, open a pull request, access GitHub, or perform destructive cleanup.",
    "Preserve unrelated existing changes. Make the smallest compatible production-quality change.",
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
