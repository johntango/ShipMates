import { createHash } from "node:crypto";

import { validateWorkerReport } from "../adapters/codex-worker.js";

export class ParallelCodexScoutsWorkflow {
  constructor({
    store,
    runtime,
    worktreeManager,
    panePool,
    paneLauncher,
    paneCwd = process.cwd(),
    actor = "firstmate",
  } = {}) {
    if (!store || !runtime || !worktreeManager || !panePool || !paneLauncher) {
      throw new TypeError(
        "ParallelCodexScoutsWorkflow requires store, runtime, worktreeManager, panePool, and paneLauncher",
      );
    }
    this.store = store;
    this.runtime = runtime;
    this.worktreeManager = worktreeManager;
    this.panePool = panePool;
    this.paneLauncher = paneLauncher;
    this.paneCwd = paneCwd;
    this.actor = actor;
    this.backend = runtime.backend || "codex-mcp";
  }

  async run({ taskId, scouts }) {
    validateScouts(scouts);
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = scouts.map(({ workerId }) =>
      snapshot.workers.find(({ id }) => id === workerId)).filter(Boolean);
    if (existing.length === 2 && existing.every(({ status }) => status === "reported")) {
      return snapshot;
    }
    if (existing.length > 0) {
      throw new ParallelCodexScoutsRecoveryRequiredError(
        "A paired worker ID already exists; reconcile the pair instead of dispatching again",
      );
    }
    requireRunnableLease(snapshot);
    verifyCleanLease(snapshot, await this.worktreeManager.inspect({
      worktreePath: snapshot.worktree.worktreePath,
    }));
    const panes = await this.panePool.select({ count: 2, cwd: this.paneCwd });
    if (new Set(panes.map(({ paneId }) => paneId)).size !== 2) {
      throw new ParallelCodexScoutsWorkflowError("Two distinct Herdr panes are required");
    }
    for (const [index, scout] of scouts.entries()) {
      snapshot = await this.store.requestWorkerDispatch({
        taskId,
        actor: this.actor,
        workerId: scout.workerId,
        backend: this.backend,
        mode: "scout",
        worktreePath: snapshot.worktree.worktreePath,
        sandbox: "read-only",
        brief: scout.brief,
        briefSha256: digest(scout.brief),
        paneId: panes[index].paneId,
        eventId: operationId(taskId, scout.workerId, "dispatch"),
      });
    }
    snapshot = await this.store.transition({
      taskId,
      from: "running",
      to: "awaiting_worker",
      reason: "Two read-only Codex scouts dispatched in Herdr panes",
      actor: this.actor,
      eventId: batchOperationId(taskId, scouts, "awaiting-worker"),
    });

    const launches = await Promise.allSettled(scouts.map((scout, index) =>
      this.paneLauncher.run({
        taskId,
        workerId: scout.workerId,
        paneId: panes[index].paneId,
        worktreePath: snapshot.worktree.worktreePath,
      })));
    const failures = [];
    for (const [index, scout] of scouts.entries()) {
      try {
        const result = await this.runtime.loadCompleted({
          taskId,
          artifactDirectory: this.#artifactDirectory(taskId, scout.workerId),
        });
        await this.#recordCompleted({ taskId, workerId: scout.workerId, result });
      } catch (cause) {
        const launchDefinitivelyFinished =
          launches[index].status === "fulfilled" ||
          launches[index].reason?.definitive === true;
        if (launchDefinitivelyFinished) {
          await this.#recordFailure({
            taskId,
            workerId: scout.workerId,
            message: `Pane scout completed without a valid artifact (${safeErrorName(cause)})`,
          });
        }
        failures.push({
          workerId: scout.workerId,
          cause,
          uncertain: !launchDefinitivelyFinished,
        });
      }
    }
    await this.#releaseTerminalWorkers(taskId, scouts.map(({ workerId }) => workerId));
    snapshot = await this.#leaveAwaitingIfTerminal(taskId, scouts);
    if (failures.length > 0) {
      const ErrorType = failures.some(({ uncertain }) => uncertain)
        ? ParallelCodexScoutsRecoveryRequiredError
        : ParallelCodexScoutsWorkflowError;
      throw new ErrorType(
        `Paired scouts did not both complete: ${failures.map(({ workerId }) => workerId).join(", ")}`,
        { cause: failures[0].cause },
      );
    }
    return snapshot;
  }

  async reconcile({ taskId, workerIds }) {
    validateWorkerIds(workerIds);
    let snapshot = await this.store.getSnapshot(taskId);
    const uncertain = [];
    for (const workerId of workerIds) {
      let worker = snapshot.workers.find(({ id }) => id === workerId);
      if (!worker) throw new ParallelCodexScoutsWorkflowError(`Unknown worker: ${workerId}`);
      if (new Set(["reported", "failed"]).has(worker.status)) continue;
      if (!new Set(["dispatch_requested", "started"]).has(worker.status)) {
        throw new ParallelCodexScoutsWorkflowError(
          `Worker ${workerId} cannot be reconciled from ${worker.status}`,
        );
      }
      try {
        const result = await this.runtime.loadCompleted({
          taskId,
          artifactDirectory: this.#artifactDirectory(taskId, workerId),
        });
        snapshot = await this.#recordCompleted({ taskId, workerId, result });
        worker = snapshot.workers.find(({ id }) => id === workerId);
      } catch (cause) {
        uncertain.push({ workerId, paneId: worker.paneId, cause });
      }
    }
    await this.#releaseTerminalWorkers(taskId, workerIds);
    snapshot = await this.#leaveAwaitingIfTerminal(
      taskId,
      workerIds.map((workerId) => ({ workerId })),
    );
    if (uncertain.length > 0) {
      throw new ParallelCodexScoutsRecoveryRequiredError(
        `Pane workers still need artifact reconciliation: ${uncertain.map(({ workerId }) => workerId).join(", ")}`,
        { cause: uncertain[0].cause },
      );
    }
    return snapshot;
  }

  async #recordCompleted({ taskId, workerId, result }) {
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
      throw new ParallelCodexScoutsWorkflowError(
        `Worker ${workerId} artifact thread differs from its durable thread`,
      );
    }
    const inspection = await this.worktreeManager.inspect({
      worktreePath: snapshot.worktree.worktreePath,
    });
    verifyCleanLease(snapshot, inspection);
    if (worker.status === "started") {
      snapshot = await this.store.recordWorkerReport({
        taskId,
        actor: this.actor,
        workerId,
        threadId: result.threadId,
        report: result.report,
        verification: {
          noMutation: true,
          headSha: inspection.headSha,
          branch: inspection.branch,
          dirty: inspection.dirty,
          eventCount: result.eventCount,
          paneId: worker.paneId,
        },
        eventId: operationId(taskId, workerId, "report"),
      });
    }
    return snapshot;
  }

  async #recordFailure({ taskId, workerId, message }) {
    const snapshot = await this.store.getSnapshot(taskId);
    const worker = snapshot.workers.find(({ id }) => id === workerId);
    if (new Set(["dispatch_requested", "started"]).has(worker?.status)) {
      return this.store.recordWorkerFailure({
        taskId,
        actor: this.actor,
        workerId,
        message,
        eventId: operationId(taskId, workerId, "failed"),
      });
    }
    return snapshot;
  }

  async #releaseTerminalWorkers(taskId, workerIds) {
    const snapshot = await this.store.getSnapshot(taskId);
    for (const workerId of workerIds) {
      const worker = snapshot.workers.find(({ id }) => id === workerId);
      if (worker?.paneId && new Set(["reported", "failed"]).has(worker.status)) {
        await this.paneLauncher.release({ taskId, workerId, paneId: worker.paneId });
      }
    }
  }

  async #leaveAwaitingIfTerminal(taskId, scouts) {
    let snapshot = await this.store.getSnapshot(taskId);
    const workers = scouts.map(({ workerId }) =>
      snapshot.workers.find(({ id }) => id === workerId));
    if (
      snapshot.state === "awaiting_worker" &&
      workers.every((worker) => worker &&
        new Set(["reported", "failed"]).has(worker.status))
    ) {
      snapshot = await this.store.transition({
        taskId,
        from: "awaiting_worker",
        to: "running",
        reason: "Both Herdr pane scouts reached durable terminal states",
        actor: this.actor,
        eventId: batchOperationId(taskId, scouts, "finished"),
      });
    }
    return snapshot;
  }

  #artifactDirectory(taskId, workerId) {
    return `${this.store.rootDir}/tasks/${taskId}/workers/${workerId}`;
  }
}

export class ParallelCodexScoutsWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ParallelCodexScoutsWorkflowError";
  }
}

export class ParallelCodexScoutsRecoveryRequiredError extends
  ParallelCodexScoutsWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ParallelCodexScoutsRecoveryRequiredError";
  }
}

function validateScouts(scouts) {
  if (!Array.isArray(scouts) || scouts.length !== 2) {
    throw new TypeError("Exactly two scouts are required");
  }
  validateWorkerIds(scouts.map(({ workerId }) => workerId));
  for (const { brief } of scouts) {
    if (typeof brief !== "string" || brief.trim() === "" || brief.length > 10_000) {
      throw new TypeError("Each scout brief must be 1-10,000 characters");
    }
  }
}

function validateWorkerIds(workerIds) {
  if (!Array.isArray(workerIds) || workerIds.length !== 2 ||
    new Set(workerIds).size !== 2) {
    throw new TypeError("Exactly two distinct worker IDs are required");
  }
  for (const workerId of workerIds) {
    if (typeof workerId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(workerId)) {
      throw new TypeError("Worker IDs must be safe 3-64 character identifiers");
    }
  }
}

function requireRunnableLease(snapshot) {
  if (snapshot.state !== "running" || snapshot.worktree?.status !== "leased") {
    throw new ParallelCodexScoutsWorkflowError(
      "Parallel scouts require a running task with an active lease",
    );
  }
}

function verifyCleanLease(snapshot, inspection) {
  if (
    inspection.worktreePath !== snapshot.worktree.worktreePath ||
    inspection.headSha !== snapshot.worktree.headSha ||
    inspection.dirty
  ) {
    throw new ParallelCodexScoutsWorkflowError(
      "Parallel scouts require the exact clean durable lease",
    );
  }
}

function operationId(taskId, workerId, operation) {
  return `${taskId}:worker:${workerId}:${operation}:v1`;
}

function batchOperationId(taskId, scouts, operation) {
  const ids = scouts.map(({ workerId }) => workerId).sort().join("+");
  return `${taskId}:workers:${ids}:${operation}:v1`;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeErrorName(error) {
  return typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : "UnknownError";
}
