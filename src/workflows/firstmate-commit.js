import { createHash, randomUUID } from "node:crypto";

export class FirstmateCommitWorkflow {
  constructor({
    store, commitAdapter, actor = "firstmate", idFactory = randomUUID,
  } = {}) {
    if (!store || !commitAdapter ||
      typeof commitAdapter.create !== "function" ||
      typeof commitAdapter.inspectCreated !== "function") {
      throw new TypeError("FirstmateCommitWorkflow requires store and commitAdapter");
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
    this.store = store;
    this.commitAdapter = commitAdapter;
    this.actor = actor;
    this.idFactory = idFactory;
  }

  async run({ taskId, workerId = "implementer" }) {
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = snapshot.gitCommits.at(-1);
    if (existing) {
      if (existing.workerId !== workerId) {
        throw new FirstmateCommitError(
          `Git commit is bound to worker ${existing.workerId}, not ${workerId}`,
        );
      }
      if (existing.status === "completed") return this.#finish(snapshot, existing, true);
      throw new FirstmateCommitRecoveryRequiredError(
        "A Git commit request is durable but incomplete; reconcile it without repeating Git mutations",
      );
    }
    const request = buildRequest(snapshot, workerId, this.idFactory());
    snapshot = await this.store.requestGitCommit({
      taskId,
      actor: this.actor,
      request,
      eventId: eventId(taskId, "requested"),
    });
    const operation = snapshot.gitCommits.at(-1);
    let result;
    try {
      result = await this.commitAdapter.create(commitInput(snapshot, operation));
    } catch (cause) {
      throw new FirstmateCommitRecoveryRequiredError(
        "Controlled Git commit did not produce accepted evidence; inspect and reconcile the leased workspace",
        { cause },
      );
    }
    snapshot = await this.#record(snapshot, operation, result);
    return this.#finish(snapshot, snapshot.gitCommits.at(-1), false);
  }

  async reconcile({ taskId }) {
    let snapshot = await this.store.getSnapshot(taskId);
    const operation = snapshot.gitCommits.at(-1);
    if (!operation) throw new FirstmateCommitError("Task has no Git commit request");
    if (operation.status === "completed") return this.#finish(snapshot, operation, true);
    if (operation.status !== "requested") {
      throw new FirstmateCommitError(`Cannot reconcile Git commit from ${operation.status}`);
    }
    let result;
    try {
      result = await this.commitAdapter.inspectCreated(commitInput(snapshot, operation));
    } catch (cause) {
      throw new FirstmateCommitRecoveryRequiredError(
        "No exact completed commit can be recovered from the durable request",
        { cause },
      );
    }
    snapshot = await this.#record(snapshot, operation, result);
    return this.#finish(snapshot, snapshot.gitCommits.at(-1), false);
  }

  async #record(snapshot, operation, result) {
    if (operation.status === "completed") return snapshot;
    return this.store.recordGitCommitCompleted({
      taskId: snapshot.id,
      actor: this.actor,
      operationId: operation.operationId,
      requestEventId: operation.requestEventId,
      result,
      eventId: eventId(snapshot.id, "completed"),
    });
  }

  async #finish(snapshot, operation, reused) {
    if (operation.status !== "completed") {
      throw new FirstmateCommitRecoveryRequiredError("Git commit is not complete");
    }
    if (snapshot.state === "running") {
      snapshot = await this.store.transition({
        taskId: snapshot.id,
        from: "running",
        to: "validating",
        actor: this.actor,
        reason: "Exact controlled commit recorded; begin pinned local validation",
        eventId: eventId(snapshot.id, "validating"),
      });
    } else if (snapshot.state !== "validating") {
      throw new FirstmateCommitRecoveryRequiredError(
        `Committed task cannot enter validation from ${snapshot.state}`,
      );
    }
    return { snapshot, commit: operation.result, reused };
  }
}

export class FirstmateCommitError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FirstmateCommitError";
  }
}

export class FirstmateCommitRecoveryRequiredError extends FirstmateCommitError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FirstmateCommitRecoveryRequiredError";
  }
}

function buildRequest(snapshot, workerId, attemptId) {
  const worker = snapshot.workers.find(({ id }) => id === workerId);
  if (snapshot.state !== "running" || snapshot.worktree?.status !== "leased" ||
    !snapshot.worktree.branch || !worker || worker.status !== "reported" ||
    worker.mode !== "ship" || worker.report?.status !== "completed" ||
    worker.verification?.kind !== "workspace-write" ||
    worker.verification?.dirty !== true ||
    worker.verification?.headSha !== snapshot.worktree.headSha) {
    throw new FirstmateCommitError(
      "Controlled commit requires completed exact worker changes in the active lease",
    );
  }
  const message = `ShipMates task ${snapshot.id}`;
  return {
    operationId: "commit-v1",
    attemptId,
    workerId,
    workerReportEventId: worker.reportEventId,
    baseHeadSha: snapshot.worktree.headSha,
    branch: snapshot.worktree.branch,
    changedPaths: [...worker.verification.changedPaths],
    message,
    messageSha256: digest(message),
  };
}

function commitInput(snapshot, operation) {
  return {
    worktreePath: snapshot.worktree.worktreePath,
    baseHeadSha: operation.baseHeadSha,
    branch: operation.branch,
    changedPaths: operation.changedPaths,
    message: operation.message,
  };
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function eventId(taskId, phase) {
  return `${taskId}:git-commit:${phase}:v1`;
}
