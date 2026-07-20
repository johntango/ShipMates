import { createHash, randomUUID } from "node:crypto";
import { TaskProgressRecorder } from "./task-progress.js";

export class LocalValidationWorkflow {
  constructor({ store, gate, actor = "firstmate", idFactory = randomUUID } = {}) {
    if (!store || !gate) {
      throw new TypeError("LocalValidationWorkflow requires store and gate");
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
    this.store = store;
    this.gate = gate;
    this.actor = actor;
    this.idFactory = idFactory;
  }

  async run({ taskId, intent }) {
    if (typeof intent !== "string" || intent.trim() === "") {
      throw new TypeError("intent must be a non-empty string");
    }
    let snapshot = await this.store.getSnapshot(taskId);
    if (snapshot.state !== "validating" || snapshot.worktree?.status !== "leased") {
      throw new LocalValidationWorkflowError(
        "Local validation requires a validating task with an active lease",
      );
    }
    const completed = snapshot.validationRequests?.at(-1);
    if (completed?.status === "completed") {
      if (completed.intentSha256 !== digest(intent)) {
        throw new LocalValidationWorkflowError(
          "Completed local validation is bound to different intent",
        );
      }
      return { snapshot, report: snapshot.validationRuns.at(-1), reused: true };
    }
    if (completed?.status === "requested") {
      throw new LocalValidationRecoveryRequiredError(
        "Local validation has durable intent but no result; do not repeat it automatically",
      );
    }
    const operationId = "validation-v1";
    snapshot = await this.store.requestLocalValidation({
      taskId,
      actor: this.actor,
      request: {
        operationId,
        attemptId: this.idFactory(),
        headSha: snapshot.worktree.headSha,
        branch: snapshot.worktree.branch,
        intentSha256: digest(intent),
        tool: this.gate.pinEvidence(),
      },
      eventId: `${taskId}:validation:requested:v1`,
    });
    const request = snapshot.validationRequests.at(-1);
    const report = await this.gate.run({
      taskId,
      worktreePath: snapshot.worktree.worktreePath,
      expectedHeadSha: snapshot.worktree.headSha,
      intent,
      onProgress: validationProgressRecorder({
        store: this.store, taskId, actor: this.actor, attemptId: request.attemptId,
        idFactory: this.idFactory,
      }),
    });
    const recorded = await this.store.recordLocalValidation({
      taskId,
      actor: this.actor,
      report,
      operationId,
      requestEventId: request.requestEventId,
      eventId: `${taskId}:validation:${report.runId}:v1`,
      at: report.completedAt,
    });
    const reviewed = await transitionForApprovalGate({
      store: this.store, snapshot: recorded, report, taskId, actor: this.actor,
    });
    return { snapshot: reviewed, report, reused: false };
  }

  async reconcile({ taskId, intent }) {
    if (typeof intent !== "string" || intent.trim() === "") {
      throw new TypeError("intent must be a non-empty string");
    }
    let snapshot = await this.store.getSnapshot(taskId);
    const request = snapshot.validationRequests?.at(-1);
    if (request?.status === "completed") {
      if (request.intentSha256 !== digest(intent)) {
        throw new LocalValidationWorkflowError(
          "Completed local validation is bound to different intent",
        );
      }
      return { snapshot, report: snapshot.validationRuns.at(-1), reused: true };
    }
    if (snapshot.state !== "validating" || snapshot.worktree?.status !== "leased" ||
      request?.status !== "requested" ||
      request.headSha !== snapshot.worktree.headSha ||
      request.branch !== snapshot.worktree.branch ||
      request.intentSha256 !== digest(intent) ||
      JSON.stringify(request.tool) !== JSON.stringify(this.gate.pinEvidence())) {
      throw new LocalValidationRecoveryRequiredError(
        "Durable validation request no longer matches the exact active lease and intent",
      );
    }
    const report = await this.gate.run({
      taskId,
      worktreePath: snapshot.worktree.worktreePath,
      expectedHeadSha: request.headSha,
      intent,
      onProgress: validationProgressRecorder({
        store: this.store, taskId, actor: this.actor, attemptId: request.attemptId,
        idFactory: this.idFactory,
      }),
    });
    snapshot = await this.store.recordLocalValidation({
      taskId,
      actor: this.actor,
      report,
      operationId: request.operationId,
      requestEventId: request.requestEventId,
      eventId: `${taskId}:validation:${report.runId}:v1`,
      at: report.completedAt,
    });
    snapshot = await transitionForApprovalGate({
      store: this.store, snapshot, report, taskId, actor: this.actor,
    });
    return { snapshot, report, reused: false };
  }
}

function normalizeProgressMessage(value) {
  const message = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (message || "Validation step running").slice(0, 240);
}

function validationProgressRecorder({ store, taskId, actor, attemptId, idFactory }) {
  const recorder = new TaskProgressRecorder({ store, taskId, actor, idFactory });
  return (message) => recorder.record({
    phase: "validation",
    step: validationStep(message),
    message: normalizeProgressMessage(message),
    operationId: attemptId,
  });
}

function validationStep(message) {
  const text = String(message || "").toLowerCase();
  for (const step of ["test", "lint", "document", "review", "intent", "rebase", "push", "pr", "ci"]) {
    if (text.includes(step)) return step;
  }
  return "pipeline";
}

async function transitionForApprovalGate({ store, snapshot, report, taskId, actor }) {
  if (report.gate?.status !== "awaiting_approval") return snapshot;
  return store.transition({
    taskId,
    from: "validating",
    to: "awaiting_human",
    actor,
    reason: `Local validation awaits human approval at ${report.gate.step}`,
    eventId: `${taskId}:validation:awaiting-approval:${report.runId}:v1`,
  });
}

export class LocalValidationWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "LocalValidationWorkflowError";
  }
}

export class LocalValidationRecoveryRequiredError extends LocalValidationWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "LocalValidationRecoveryRequiredError";
  }
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
