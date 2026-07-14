import { createHash } from "node:crypto";
import path from "node:path";

import { validateWorkerReport } from "../adapters/codex-worker.js";

export class CodexShipWorkflow {
  constructor({
    store, runtime, worktreeManager, schemaPath, actor = "firstmate", observer = null,
  } = {}) {
    if (!store || !runtime || !worktreeManager || !schemaPath ||
      typeof runtime.run !== "function" ||
      typeof runtime.loadCompleted !== "function" ||
      typeof worktreeManager.inspect !== "function" ||
      typeof worktreeManager.inspectChangedPaths !== "function") {
      throw new TypeError(
        "CodexShipWorkflow requires store, runtime, worktreeManager, and schemaPath",
      );
    }
    this.store = store;
    this.runtime = runtime;
    this.worktreeManager = worktreeManager;
    this.schemaPath = path.resolve(schemaPath);
    this.actor = actor;
    this.observer = observer;
    this.backend = runtime.backend || "codex-cli";
  }

  async run({ taskId, workerId = "implementer", brief }) {
    validateIdentifier("workerId", workerId);
    requireText("brief", brief);
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = snapshot.workers.find(({ id }) => id === workerId);
    const briefSha256 = digest(brief);
    if (existing) {
      verifyExistingWorker(existing, briefSha256);
      if (existing.status === "reported") {
        return { snapshot, worker: existing, reused: true };
      }
      throw new CodexShipRecoveryRequiredError(
        `Worker ${workerId} has durable status ${existing.status}; reconcile its artifacts`,
      );
    }
    requireRunnableLease(snapshot);
    const before = await this.worktreeManager.inspect({
      worktreePath: snapshot.worktree.worktreePath,
    });
    verifyCleanBase(snapshot, before);
    snapshot = await this.store.requestWorkerDispatch({
      taskId,
      actor: this.actor,
      workerId,
      backend: this.backend,
      mode: "ship",
      worktreePath: snapshot.worktree.worktreePath,
      sandbox: "workspace-write",
      brief,
      briefSha256,
      eventId: operationId(taskId, workerId, "dispatch"),
    });
    snapshot = await this.#enterAwaitingWorker(snapshot, workerId);
    await this.observer?.workerStarted?.({ workerId, sandbox: "workspace-write" });
    let result;
    try {
      result = await this.runtime.run({
        taskId,
        workingDirectory: snapshot.worktree.worktreePath,
        prompt: buildShipPrompt({ taskId, brief }),
        schemaPath: this.schemaPath,
        artifactDirectory: this.#artifactDirectory(taskId, workerId),
        sandbox: "workspace-write",
        onEvent: (event) => this.observer?.workerEvent?.({ workerId, event }),
      });
    } catch (cause) {
      await this.#recordFailure({ taskId, workerId, cause });
      throw cause;
    }
    return this.#recordCompleted({ taskId, workerId, result, before });
  }

  async reconcile({ taskId, workerId = "implementer" }) {
    validateIdentifier("workerId", workerId);
    let snapshot = await this.store.getSnapshot(taskId);
    const worker = snapshot.workers.find(({ id }) => id === workerId);
    if (!worker) throw new CodexShipError(`Unknown worker: ${workerId}`);
    if (worker.mode !== "ship" || worker.sandbox !== "workspace-write") {
      throw new CodexShipAuthorityError(`Worker ${workerId} is not a mutating worker`);
    }
    if (worker.status === "reported") return { snapshot, worker, reused: true };
    if (!new Set(["dispatch_requested", "started"]).has(worker.status)) {
      throw new CodexShipError(
        `Worker ${workerId} cannot be reconciled from ${worker.status}`,
      );
    }
    requireRunnableLease(snapshot, { allowAwaiting: true });
    const result = await this.runtime.loadCompleted({
      taskId,
      artifactDirectory: this.#artifactDirectory(taskId, workerId),
    });
    const before = {
      headSha: snapshot.worktree.headSha,
      branch: snapshot.worktree.branch,
      dirty: false,
      worktreePath: snapshot.worktree.worktreePath,
    };
    return this.#recordCompleted({ taskId, workerId, result, before });
  }

  async #recordCompleted({ taskId, workerId, result, before }) {
    validateWorkerReport(result.report, taskId);
    let snapshot = await this.store.getSnapshot(taskId);
    let worker = snapshot.workers.find(({ id }) => id === workerId);
    if (worker.status === "dispatch_requested") {
      snapshot = await this.store.recordWorkerStarted({
        taskId,
        actor: this.actor,
        workerId,
        requestEventId: worker.dispatchEventId,
        threadId: result.threadId,
        eventId: operationId(taskId, workerId, "started"),
      });
      worker = snapshot.workers.find(({ id }) => id === workerId);
    }
    if (worker.threadId !== result.threadId) {
      throw new CodexShipAuthorityError("Durable worker thread differs from its artifact");
    }
    const [after, paths] = await Promise.all([
      this.worktreeManager.inspect({ worktreePath: snapshot.worktree.worktreePath }),
      this.worktreeManager.inspectChangedPaths({
        worktreePath: snapshot.worktree.worktreePath,
      }),
    ]);
    const verification = verifyMutation({
      snapshot,
      before,
      after,
      paths,
      report: result.report,
    });
    if (worker.status === "started") {
      snapshot = await this.store.recordWorkerReport({
        taskId,
        actor: this.actor,
        workerId,
        threadId: result.threadId,
        report: result.report,
        verification,
        eventId: operationId(taskId, workerId, "report"),
      });
    }
    snapshot = await this.#leaveAwaitingWorker(snapshot, workerId);
    const completed = snapshot.workers.find(({ id }) => id === workerId);
    await this.observer?.workerFinished?.({ workerId, report: completed.report });
    return { snapshot, worker: completed, reused: false };
  }

  async #recordFailure({ taskId, workerId, cause }) {
    let snapshot = await this.store.getSnapshot(taskId);
    const worker = snapshot.workers.find(({ id }) => id === workerId);
    if (worker && new Set(["dispatch_requested", "started"]).has(worker.status)) {
      snapshot = await this.store.recordWorkerFailure({
        taskId,
        actor: this.actor,
        workerId,
        message: `Codex ship worker failed (${safeErrorName(cause)})`,
        eventId: operationId(taskId, workerId, "failed"),
      });
    }
    await this.observer?.workerFailed?.({ workerId, error: cause });
    if (snapshot.state === "awaiting_worker") {
      await this.store.transition({
        taskId,
        from: "awaiting_worker",
        to: "recovery_required",
        actor: this.actor,
        reason: "Mutating worker failed; preserve and inspect its leased workspace",
        eventId: operationId(taskId, workerId, "recovery-required"),
      });
    }
  }

  async #enterAwaitingWorker(snapshot, workerId) {
    return this.store.transition({
      taskId: snapshot.id,
      from: "running",
      to: "awaiting_worker",
      actor: this.actor,
      reason: "Durable mutating worker dispatched",
      eventId: operationId(snapshot.id, workerId, "awaiting-worker"),
    });
  }

  async #leaveAwaitingWorker(snapshot, workerId) {
    if (snapshot.state === "running") return snapshot;
    if (snapshot.state !== "awaiting_worker") {
      throw new CodexShipRecoveryRequiredError(
        `Completed worker cannot resume task from ${snapshot.state}`,
      );
    }
    return this.store.transition({
      taskId: snapshot.id,
      from: "awaiting_worker",
      to: "running",
      actor: this.actor,
      reason: "Mutating worker changes independently verified",
      eventId: operationId(snapshot.id, workerId, "worker-finished"),
    });
  }

  #artifactDirectory(taskId, workerId) {
    return path.join(this.store.rootDir, "tasks", taskId, "workers", workerId);
  }
}

export function buildShipPrompt({ taskId, brief }) {
  return [
    `You are the bounded workspace-write ShipMates worker for task ${taskId}.`,
    "Implement only the requested local change in the leased workspace.",
    "Do not commit, push, access GitHub, alter .git or .shipmates, or clean up the lease.",
    "Preserve unrelated files and run relevant local tests.",
    "In report.files, list every changed or newly created repository-relative path and no unchanged paths.",
    "Return only the required structured worker report.",
    "Brief:",
    brief,
  ].join("\n");
}

export class CodexShipError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CodexShipError";
  }
}

export class CodexShipAuthorityError extends CodexShipError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CodexShipAuthorityError";
  }
}

export class CodexShipRecoveryRequiredError extends CodexShipError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CodexShipRecoveryRequiredError";
  }
}

function verifyMutation({ snapshot, before, after, paths, report }) {
  const sortedReported = [...report.files].sort();
  const sortedChanged = [...paths.all].sort();
  if (before.dirty || before.headSha !== snapshot.worktree.headSha ||
    before.branch !== snapshot.worktree.branch ||
    after.headSha !== snapshot.worktree.headSha ||
    after.branch !== snapshot.worktree.branch ||
    paths.staged.length > 0 || paths.ignored.length > 0 ||
    !sameArray(sortedChanged, sortedReported) ||
    sortedChanged.some(pathIsUnsafe) ||
    after.dirty !== (sortedChanged.length > 0) ||
    (report.status === "completed" && sortedChanged.length === 0)) {
    throw new CodexShipAuthorityError(
      "Workspace mutation does not match the worker report and durable lease",
    );
  }
  return {
    kind: "workspace-write",
    noMutation: sortedChanged.length === 0,
    baseHeadSha: before.headSha,
    headSha: after.headSha,
    branchBefore: before.branch,
    branchAfter: after.branch,
    commitCreated: false,
    dirty: after.dirty,
    changedPaths: sortedChanged,
    stagedPaths: [...paths.staged],
    unstagedPaths: [...paths.unstaged],
    untrackedPaths: [...paths.untracked],
    ignoredPaths: [...paths.ignored],
    reportedPathsMatch: true,
  };
}

function verifyCleanBase(snapshot, inspection) {
  if (inspection.worktreePath !== snapshot.worktree.worktreePath ||
    inspection.headSha !== snapshot.worktree.headSha ||
    inspection.branch !== snapshot.worktree.branch || inspection.dirty) {
    throw new CodexShipAuthorityError(
      "Mutating worker requires the exact clean active lease",
    );
  }
}

function verifyExistingWorker(worker, briefSha256) {
  if (worker.mode !== "ship" || worker.sandbox !== "workspace-write" ||
    worker.briefSha256 !== briefSha256) {
    throw new CodexShipAuthorityError(
      `Worker ${worker.id} is bound to different authority or input`,
    );
  }
}

function requireRunnableLease(snapshot, { allowAwaiting = false } = {}) {
  const states = allowAwaiting ? ["running", "awaiting_worker"] : ["running"];
  if (!states.includes(snapshot.state) || snapshot.worktree?.status !== "leased") {
    throw new CodexShipAuthorityError(
      "Mutating worker requires a running task with an active Treehouse lease",
    );
  }
}

function pathIsUnsafe(value) {
  return value.startsWith("/") || value.split("/").includes("..") ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    value === ".git" || value.startsWith(".git/") ||
    value === ".shipmates" || value.startsWith(".shipmates/");
}

function validateIdentifier(label, value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe 3-64 character identifier`);
  }
}

function requireText(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameArray(first, second) {
  return first.length === second.length &&
    first.every((value, index) => value === second[index]);
}

function operationId(taskId, workerId, operation) {
  return `${taskId}:worker:${workerId}:${operation}:v1`;
}

function safeErrorName(error) {
  return error?.name || "Error";
}
