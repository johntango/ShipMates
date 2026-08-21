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
    const report = await this.#runGate({ snapshot, request, taskId, intent });
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
    if (!new Set(["validating", "blocked"]).has(snapshot.state) ||
      snapshot.worktree?.status !== "leased" ||
      request?.status !== "requested" ||
      request.headSha !== snapshot.worktree.headSha ||
      request.branch !== snapshot.worktree.branch ||
      request.intentSha256 !== digest(intent) ||
      JSON.stringify(request.tool) !== JSON.stringify(this.gate.pinEvidence())) {
      throw new LocalValidationRecoveryRequiredError(
        "Durable validation request no longer matches the exact active lease and intent",
      );
    }
    if (snapshot.state === "blocked") {
      snapshot = await this.store.transition({
        taskId, from: "blocked", to: "running", actor: this.actor,
        reason: "Resume the exact blocked local validation request",
        eventId: `${taskId}:validation:${request.attemptId}:resume-running:${this.idFactory()}:v1`,
      });
      snapshot = await this.store.transition({
        taskId, from: "running", to: "validating", actor: this.actor,
        reason: "Resume the exact blocked local validation request",
        eventId: `${taskId}:validation:${request.attemptId}:resume-validating:${this.idFactory()}:v1`,
      });
    }
    const report = await this.#runGate({ snapshot, request, taskId, intent });
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

  async #runGate({ snapshot, request, taskId, intent }) {
    try {
      return await this.gate.run({
        taskId,
        worktreePath: snapshot.worktree.worktreePath,
        expectedHeadSha: request.headSha,
        intent,
        onProgress: validationProgressRecorder({
          store: this.store, taskId, actor: this.actor, attemptId: request.attemptId,
          idFactory: this.idFactory,
        }),
      });
    } catch (cause) {
      const message = safeSetupMessage(cause);
      await this.store.recordEvidence({
        taskId,
        actor: this.actor,
        kind: "validation-setup-failure",
        value: JSON.stringify({
          operationId: request.operationId,
          attemptId: request.attemptId,
          requestEventId: request.requestEventId,
          errorName: safeErrorName(cause),
          message,
        }),
        eventId: `${taskId}:validation:${request.attemptId}:setup-failed:${this.idFactory()}:v1`,
      });
      const current = await this.store.getSnapshot(taskId);
      if (current.state === "validating") {
        await this.store.transition({
          taskId, from: "validating", to: "blocked", actor: this.actor,
          reason: `Local validation setup blocked safely: ${message}`,
          eventId: `${taskId}:validation:${request.attemptId}:blocked:${this.idFactory()}:v1`,
        });
      }
      throw new LocalValidationSetupBlockedError(
        `Local validation setup blocked safely: ${message}`,
        { cause },
      );
    }
  }

  async approve({ taskId, intent }) {
    if (typeof intent !== "string" || intent.trim() === "") {
      throw new TypeError("intent must be a non-empty string");
    }
    let snapshot = await this.store.getSnapshot(taskId);
    const prior = snapshot.validationRuns?.at(-1);
    const request = snapshot.validationRequests?.at(-1);
    const intentSha256 = digest(intent);
    const reconciled = request?.status === "completed" && request.passed === true &&
      request.reconciledEventId === prior?.eventId && prior?.gate === null &&
      prior?.passed === true && request.runId === prior?.runId;
    if (reconciled &&
      request.intentSha256 === intentSha256 && prior.intentSha256 === intentSha256) {
      if (snapshot.state === "awaiting_human") {
        snapshot = await transitionApprovedValidation(
          this.store, snapshot, this.actor, taskId, prior.runId,
        );
      }
      if (snapshot.state === "ready_to_merge") {
        return { snapshot, report: prior, reused: true };
      }
    }
    if (snapshot.state !== "awaiting_human" || request?.status !== "completed" ||
      prior?.gate?.status !== "awaiting_approval" ||
      request.intentSha256 !== intentSha256 || prior.intentSha256 !== intentSha256) {
      throw new LocalValidationRecoveryRequiredError(
        "Validation approval does not match the exact recorded approval gate and intent",
      );
    }
    const approval = snapshot.validationApprovalRequests?.at(-1);
    const operationId = "validation-approval-v1";
    if (!approval) {
      snapshot = await this.store.requestValidationApproval({
        taskId, actor: this.actor,
        request: {
          operationId, runId: prior.runId,
          headSha: prior.finalHeadSha,
          intentSha256,
        },
        eventId: `${taskId}:validation:${prior.runId}:approval-requested:v1`,
      });
    } else if (approval.operationId !== operationId || approval.runId !== prior.runId ||
      approval.headSha !== prior.finalHeadSha || approval.intentSha256 !== intentSha256) {
      throw new LocalValidationRecoveryRequiredError(
        "Durable validation approval intent does not match the active gate",
      );
    }
    let report = await this.gate.observe({
      taskId, worktreePath: snapshot.worktree.worktreePath,
      expectedHeadSha: snapshot.worktree.headSha, intent, runId: prior.runId,
    });
    if (report.runId === prior.runId && report.passed !== true &&
      report.gate?.status === "awaiting_approval") {
      report = await this.gate.respond({
        taskId,
        worktreePath: snapshot.worktree.worktreePath,
        expectedHeadSha: snapshot.worktree.headSha,
        intent,
        action: "approve",
      });
    }
    if (report.runId !== prior.runId || report.passed !== true) {
      throw new LocalValidationRecoveryRequiredError(
        "Approved validation did not return a terminal passing result for the same run",
      );
    }
    snapshot = await this.store.reconcileLocalValidation({
      taskId, actor: this.actor, report, runId: prior.runId,
      eventId: `${taskId}:validation:${prior.runId}:reconciled:v1`,
    });
    snapshot = await transitionApprovedValidation(
      this.store, snapshot, this.actor, taskId, prior.runId,
    );
    return { snapshot, report, reused: false };
  }

  async reconcileApproval({ taskId, intent }) {
    return this.approve({ taskId, intent });
  }

  async reconcileCompletedApproval({ taskId, intent }) {
    if (typeof intent !== "string" || intent.trim() === "") {
      throw new TypeError("intent must be a non-empty string");
    }
    let snapshot = await this.store.getSnapshot(taskId);
    const prior = snapshot.validationRuns?.at(-1);
    const request = snapshot.validationRequests?.at(-1);
    const intentSha256 = digest(intent);
    if (snapshot.state !== "awaiting_human" || request?.status !== "completed" ||
      prior?.gate?.status !== "awaiting_approval" || request.runId !== prior.runId ||
      request.intentSha256 !== intentSha256 || prior.intentSha256 !== intentSha256 ||
      prior.finalHeadSha !== snapshot.worktree?.headSha) {
      return { snapshot, report: prior, reconciled: false };
    }
    const report = await this.gate.observe({
      taskId, worktreePath: snapshot.worktree.worktreePath,
      expectedHeadSha: snapshot.worktree.headSha, intent, runId: prior.runId,
    });
    if (report.runId !== prior.runId || report.passed !== true || report.gate !== null ||
      report.finalHeadSha !== prior.finalHeadSha || report.intentSha256 !== intentSha256) {
      return { snapshot, report, reconciled: false };
    }
    const approval = snapshot.validationApprovalRequests?.at(-1);
    if (!approval) {
      snapshot = await this.store.requestValidationApproval({
        taskId, actor: this.actor,
        request: {
          operationId: "validation-approval-v1", runId: prior.runId,
          headSha: prior.finalHeadSha, intentSha256,
        },
        eventId: `${taskId}:validation:${prior.runId}:approval-requested:v1`,
      });
    } else if (approval.runId !== prior.runId || approval.headSha !== prior.finalHeadSha ||
      approval.intentSha256 !== intentSha256) {
      throw new LocalValidationRecoveryRequiredError(
        "Durable validation approval intent does not match the completed validator run",
      );
    }
    snapshot = await this.store.reconcileLocalValidation({
      taskId, actor: this.actor, report, runId: prior.runId,
      eventId: `${taskId}:validation:${prior.runId}:reconciled:v1`,
    });
    snapshot = await transitionApprovedValidation(
      this.store, snapshot, this.actor, taskId, prior.runId,
    );
    return { snapshot, report, reconciled: true };
  }
}

function transitionApprovedValidation(store, snapshot, actor, taskId, runId) {
  return store.transition({
    taskId, from: "awaiting_human", to: "ready_to_merge", actor,
    reason: "Human approved the exact local validation gate",
    eventId: `${taskId}:validation:${runId}:approved:v1`,
  });
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

export class LocalValidationSetupBlockedError extends LocalValidationWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "LocalValidationSetupBlockedError";
  }
}

function safeErrorName(error) {
  return typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name : "UnknownError";
}

function safeSetupMessage(error) {
  const value = typeof error?.message === "string" ? error.message : "Validation tool unavailable";
  return value.replaceAll(/\s+/gu, " ").trim().slice(0, 300) || "Validation tool unavailable";
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
