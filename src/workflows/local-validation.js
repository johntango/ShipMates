import { createHash, randomUUID } from "node:crypto";

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
    return { snapshot: recorded, report, reused: false };
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
    return { snapshot, report, reused: false };
  }
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
