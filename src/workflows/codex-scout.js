import { createHash } from "node:crypto";
import path from "node:path";

import { validateWorkerReport } from "../adapters/codex-worker.js";

export class CodexScoutWorkflow {
  constructor({
    store,
    runtime,
    worktreeManager,
    schemaPath,
    actor = "firstmate",
  }) {
    if (!store || !runtime || !worktreeManager || !schemaPath) {
      throw new TypeError(
        "CodexScoutWorkflow requires store, runtime, worktreeManager, and schemaPath",
      );
    }
    this.store = store;
    this.runtime = runtime;
    this.worktreeManager = worktreeManager;
    this.schemaPath = path.resolve(schemaPath);
    this.actor = actor;
    this.backend = runtime.backend || "codex-cli";
  }

  async run({ taskId, workerId, brief }) {
    validateWorkerId(workerId);
    requireNonEmpty("brief", brief);
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = snapshot.workers.find((worker) => worker.id === workerId);
    if (existing?.status === "reported") {
      return snapshot;
    }
    if (existing) {
      throw new CodexScoutRecoveryRequiredError(
        `Worker ${workerId} already has status ${existing.status}; reconcile its durable artifacts instead of dispatching again`,
      );
    }
    requireRunnableLease(snapshot);

    const before = await this.worktreeManager.inspect({
      worktreePath: snapshot.worktree.worktreePath,
    });
    verifyCleanLease(snapshot, before);
    const briefSha256 = digest(brief);
    snapshot = await this.store.requestWorkerDispatch({
      taskId,
      actor: this.actor,
      workerId,
      backend: this.backend,
      mode: "scout",
      worktreePath: snapshot.worktree.worktreePath,
      sandbox: "read-only",
      brief,
      briefSha256,
      eventId: operationId(taskId, workerId, "dispatch"),
    });
    snapshot = await this.#enterAwaitingWorker(snapshot, workerId);

    let result;
    try {
      result = await this.runtime.run({
        taskId,
        workingDirectory: snapshot.worktree.worktreePath,
        prompt: buildScoutPrompt({ taskId, brief }),
        schemaPath: this.schemaPath,
        artifactDirectory: this.#artifactDirectory(taskId, workerId),
        sandbox: "read-only",
      });
    } catch (cause) {
      await this.store.recordWorkerFailure({
        taskId,
        actor: this.actor,
        workerId,
        message: `Codex scout failed (${safeErrorName(cause)})`,
        eventId: operationId(taskId, workerId, "failed"),
      });
      await this.#leaveAwaitingWorker(taskId, workerId, "Codex scout failed");
      throw cause;
    }
    return this.#recordCompleted({ taskId, workerId, result });
  }

  async reconcile({ taskId, workerId }) {
    validateWorkerId(workerId);
    let snapshot = await this.store.getSnapshot(taskId);
    const worker = snapshot.workers.find((candidate) => candidate.id === workerId);
    if (!worker) {
      throw new CodexScoutWorkflowError(`Unknown worker: ${workerId}`);
    }
    if (worker.status === "reported") {
      return snapshot;
    }
    if (!new Set(["dispatch_requested", "started"]).has(worker.status)) {
      throw new CodexScoutWorkflowError(
        `Worker ${workerId} cannot be reconciled from status ${worker.status}`,
      );
    }
    snapshot = await this.#enterAwaitingWorker(snapshot, workerId);
    const result = await this.runtime.loadCompleted({
      taskId,
      artifactDirectory: this.#artifactDirectory(taskId, workerId),
    });
    return this.#recordCompleted({ taskId, workerId, result });
  }

  async reply({ taskId, workerId, replyId, prompt }) {
    validateWorkerId(workerId);
    validateWorkerId(replyId);
    requireNonEmpty("prompt", prompt);
    let snapshot = await this.store.getSnapshot(taskId);
    const worker = requireReportedWorker(snapshot, workerId);
    const promptSha256 = digest(prompt);
    const existing = (worker.replies || []).find(({ id }) => id === replyId);
    if (existing) {
      verifyExistingReply(existing, promptSha256);
      if (existing.status === "completed") return snapshot;
      if (existing.status === "requested") {
        throw new CodexScoutRecoveryRequiredError(
          `Reply ${replyId} has durable intent but no result; reconcile its artifact instead of calling codex-reply again`,
        );
      }
      throw new CodexScoutWorkflowError(
        `Reply ${replyId} previously failed; use a new reply ID after review`,
      );
    }
    requireRunnableLease(snapshot);
    const before = await this.worktreeManager.inspect({
      worktreePath: snapshot.worktree.worktreePath,
    });
    verifyCleanLease(snapshot, before);
    snapshot = await this.store.requestWorkerReply({
      taskId,
      actor: this.actor,
      workerId,
      replyId,
      threadId: worker.threadId,
      leaseHeadSha: snapshot.worktree.headSha,
      sandbox: "read-only",
      promptSha256,
      eventId: replyOperationId(taskId, workerId, replyId, "requested"),
    });
    snapshot = await this.#enterAwaitingReply(snapshot, workerId, replyId);
    let result;
    try {
      result = await this.runtime.reply({
        taskId,
        replyId,
        threadId: worker.threadId,
        prompt,
        leaseHeadSha: snapshot.worktree.headSha,
        promptSha256,
        schemaPath: this.schemaPath,
        artifactDirectory: this.#artifactDirectory(taskId, workerId),
      });
    } catch (cause) {
      await this.store.recordWorkerReplyFailed({
        taskId,
        actor: this.actor,
        workerId,
        replyId,
        requestEventId: replyOperationId(taskId, workerId, replyId, "requested"),
        message: `Codex scout reply failed (${safeErrorName(cause)})`,
        eventId: replyOperationId(taskId, workerId, replyId, "failed"),
      });
      await this.#leaveAwaitingWorker(taskId, `${workerId}:${replyId}`, "Codex scout reply failed");
      throw cause;
    }
    return this.#recordReplyCompleted({ taskId, workerId, replyId, result });
  }

  async reconcileReply({ taskId, workerId, replyId }) {
    validateWorkerId(workerId);
    validateWorkerId(replyId);
    let snapshot = await this.store.getSnapshot(taskId);
    const worker = requireReportedWorker(snapshot, workerId);
    const reply = (worker.replies || []).find(({ id }) => id === replyId);
    if (!reply) throw new CodexScoutWorkflowError(`Unknown reply: ${replyId}`);
    if (reply.status === "completed") return snapshot;
    if (reply.status !== "requested") {
      throw new CodexScoutWorkflowError(
        `Reply ${replyId} cannot be reconciled from status ${reply.status}`,
      );
    }
    snapshot = await this.#enterAwaitingReply(snapshot, workerId, replyId);
    const result = await this.runtime.loadCompletedReply({
      taskId,
      replyId,
      threadId: reply.threadId,
      leaseHeadSha: reply.leaseHeadSha,
      promptSha256: reply.promptSha256,
      artifactDirectory: this.#artifactDirectory(taskId, workerId),
    });
    return this.#recordReplyCompleted({ taskId, workerId, replyId, result });
  }

  async #recordReplyCompleted({ taskId, workerId, replyId, result }) {
    validateWorkerReport(result.report, taskId);
    let snapshot = await this.store.getSnapshot(taskId);
    const worker = requireReportedWorker(snapshot, workerId);
    const reply = (worker.replies || []).find(({ id }) => id === replyId);
    if (!reply || reply.status !== "requested") {
      if (reply?.status === "completed") return snapshot;
      throw new CodexScoutWorkflowError("Reply has no matching durable intent");
    }
    if (result.threadId !== worker.threadId || result.threadId !== reply.threadId) {
      throw new CodexScoutWorkflowError("Reply artifact thread differs from the durable worker thread");
    }
    const after = await this.worktreeManager.inspect({
      worktreePath: snapshot.worktree.worktreePath,
    });
    verifyCleanLease(snapshot, after);
    snapshot = await this.store.recordWorkerReplyCompleted({
      taskId,
      actor: this.actor,
      workerId,
      replyId,
      requestEventId: reply.requestEventId,
      threadId: worker.threadId,
      leaseHeadSha: reply.leaseHeadSha,
      report: result.report,
      verification: {
        noMutation: true,
        headSha: after.headSha,
        branch: after.branch,
        dirty: after.dirty,
        eventCount: result.eventCount,
      },
      eventId: replyOperationId(taskId, workerId, replyId, "completed"),
    });
    return this.#leaveAwaitingWorker(
      taskId,
      `${workerId}:${replyId}`,
      "Codex scout reply independently verified",
    );
  }

  async #recordCompleted({ taskId, workerId, result }) {
    validateWorkerReport(result.report, taskId);
    let snapshot = await this.store.getSnapshot(taskId);
    let worker = snapshot.workers.find((candidate) => candidate.id === workerId);
    if (worker.status === "dispatch_requested") {
      snapshot = await this.store.recordWorkerStarted({
        taskId,
        actor: this.actor,
        workerId,
        requestEventId: worker.dispatchEventId,
        threadId: result.threadId,
        eventId: operationId(taskId, workerId, "started"),
      });
      worker = snapshot.workers.find((candidate) => candidate.id === workerId);
    }
    if (worker.threadId !== result.threadId) {
      throw new CodexScoutWorkflowError(
        "Durable worker thread differs from the completed artifact stream",
      );
    }

    const after = await this.worktreeManager.inspect({
      worktreePath: snapshot.worktree.worktreePath,
    });
    verifyCleanLease(snapshot, after);
    if (worker.status === "started") {
      snapshot = await this.store.recordWorkerReport({
        taskId,
        actor: this.actor,
        workerId,
        threadId: result.threadId,
        report: result.report,
        verification: {
          noMutation: true,
          headSha: after.headSha,
          branch: after.branch,
          dirty: after.dirty,
          eventCount: result.eventCount,
        },
        eventId: operationId(taskId, workerId, "report"),
      });
    }
    return this.#leaveAwaitingWorker(
      taskId,
      workerId,
      "Codex scout report independently verified",
    );
  }

  async #enterAwaitingWorker(snapshot, workerId) {
    if (snapshot.state === "awaiting_worker") {
      return snapshot;
    }
    if (snapshot.state !== "running") {
      throw new CodexScoutWorkflowError(
        `Task must be running or awaiting_worker, found ${snapshot.state}`,
      );
    }
    return this.store.transition({
      taskId: snapshot.id,
      from: "running",
      to: "awaiting_worker",
      reason: "Codex scout dispatched",
      actor: this.actor,
      eventId: operationId(snapshot.id, workerId, "awaiting-worker"),
    });
  }

  async #enterAwaitingReply(snapshot, workerId, replyId) {
    if (snapshot.state === "awaiting_worker") return snapshot;
    if (snapshot.state !== "running") {
      throw new CodexScoutWorkflowError(
        `Task must be running or awaiting_worker, found ${snapshot.state}`,
      );
    }
    return this.store.transition({
      taskId: snapshot.id,
      from: "running",
      to: "awaiting_worker",
      reason: "Codex scout reply dispatched",
      actor: this.actor,
      eventId: replyOperationId(snapshot.id, workerId, replyId, "awaiting-worker"),
    });
  }

  async #leaveAwaitingWorker(taskId, workerId, reason) {
    const snapshot = await this.store.getSnapshot(taskId);
    if (snapshot.state === "running") {
      return snapshot;
    }
    if (snapshot.state !== "awaiting_worker") {
      throw new CodexScoutWorkflowError(
        `Task must be awaiting_worker, found ${snapshot.state}`,
      );
    }
    return this.store.transition({
      taskId,
      from: "awaiting_worker",
      to: "running",
      reason,
      actor: this.actor,
      eventId: operationId(taskId, workerId, "worker-finished"),
    });
  }

  #artifactDirectory(taskId, workerId) {
    return path.join(this.store.rootDir, "tasks", taskId, "workers", workerId);
  }
}

export class CodexScoutWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CodexScoutWorkflowError";
  }
}

export class CodexScoutRecoveryRequiredError extends CodexScoutWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CodexScoutRecoveryRequiredError";
  }
}

export function buildScoutPrompt({ taskId, brief }) {
  return [
    `You are a read-only ShipMates scout for task ${taskId}.`,
    "Do not modify files, create commits, access GitHub, or address the human.",
    "Inspect only the current worktree and answer the bounded brief below.",
    "Return only the JSON object required by the supplied output schema.",
    `The report taskId must be exactly ${taskId}.`,
    "Use files for paths inspected and tests only for commands actually run.",
    "Brief:",
    brief,
  ].join("\n");
}

function requireRunnableLease(snapshot) {
  if (snapshot.state !== "running" || snapshot.worktree?.status !== "leased") {
    throw new CodexScoutWorkflowError(
      "Codex scout requires a running task with an active Treehouse lease",
    );
  }
}

function verifyCleanLease(snapshot, inspection) {
  if (
    inspection.worktreePath !== snapshot.worktree.worktreePath ||
    inspection.headSha !== snapshot.worktree.headSha ||
    inspection.dirty
  ) {
    throw new CodexScoutWorkflowError(
      "Read-only scout worktree is dirty or no longer matches its durable lease",
    );
  }
}

function validateWorkerId(workerId) {
  if (
    typeof workerId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(workerId)
  ) {
    throw new TypeError(
      "workerId must be 3-64 lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
}

function operationId(taskId, workerId, operation) {
  return `${taskId}:worker:${workerId}:${operation}:v1`;
}

function replyOperationId(taskId, workerId, replyId, operation) {
  return `${taskId}:worker:${workerId}:reply:${replyId}:${operation}:v1`;
}

function requireReportedWorker(snapshot, workerId) {
  const worker = snapshot.workers.find(({ id }) => id === workerId);
  if (!worker) throw new CodexScoutWorkflowError(`Unknown worker: ${workerId}`);
  if (worker.status !== "reported" || !worker.threadId) {
    throw new CodexScoutWorkflowError(`Worker ${workerId} has no reported thread to continue`);
  }
  return worker;
}

function verifyExistingReply(reply, promptSha256) {
  if (reply.promptSha256 !== promptSha256) {
    throw new CodexScoutWorkflowError("Reply ID is already bound to a different prompt digest");
  }
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function safeErrorName(error) {
  return typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : "UnknownError";
}
