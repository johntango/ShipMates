import { randomUUID } from "node:crypto";

export class TaskBranchWorkflow {
  constructor({ store, manager, actor = "firstmate", idFactory = randomUUID } = {}) {
    if (!store || !manager ||
      typeof manager.prepareTaskBranch !== "function" ||
      typeof manager.inspectPreparedTaskBranch !== "function") {
      throw new TypeError("TaskBranchWorkflow requires store and branch-capable manager");
    }
    this.store = store;
    this.manager = manager;
    this.actor = actor;
    this.idFactory = idFactory;
  }

  async prepare({ taskId }) {
    let snapshot = await this.store.getSnapshot(taskId);
    const branch = taskBranchName(snapshot.id);
    if (snapshot.worktree?.branch === branch) {
      return { snapshot, result: completedResult(snapshot), reused: true };
    }
    const target = targetFrom(snapshot);
    const existing = snapshot.worktree.branchPreparation;
    if (existing?.status === "requested") {
      throw new TaskBranchRecoveryRequiredError(
        "Task branch preparation has durable intent but no result; reconcile it",
      );
    }
    snapshot = await this.store.requestWorktreeBranch({
      taskId,
      actor: this.actor,
      request: { ...target, attemptId: this.idFactory() },
      eventId: `${taskId}:worktree-branch:requested:v1`,
    });
    const operation = snapshot.worktree.branchPreparation;
    let result;
    try {
      result = await this.manager.prepareTaskBranch(adapterInput(snapshot, operation));
    } catch (cause) {
      throw new TaskBranchRecoveryRequiredError(
        "Task branch preparation may have changed Git; reconcile before retrying",
        { cause },
      );
    }
    snapshot = await recordResult(this.store, snapshot, operation, result, this.actor);
    return { snapshot, result, reused: false };
  }

  async reconcile({ taskId }) {
    let snapshot = await this.store.getSnapshot(taskId);
    const operation = snapshot.worktree?.branchPreparation;
    if (!operation) throw new TaskBranchWorkflowError("Task has no branch request");
    if (operation.status === "completed") {
      return { snapshot, result: operation.result, reused: true };
    }
    let result;
    try {
      result = await this.manager.inspectPreparedTaskBranch(
        adapterInput(snapshot, operation),
      );
    } catch (cause) {
      throw new TaskBranchRecoveryRequiredError(
        "No exact prepared task branch can be recovered from durable intent",
        { cause },
      );
    }
    snapshot = await recordResult(this.store, snapshot, operation, result, this.actor);
    return { snapshot, result, reused: false };
  }
}

export class TaskBranchWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TaskBranchWorkflowError";
  }
}

export class TaskBranchRecoveryRequiredError extends TaskBranchWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TaskBranchRecoveryRequiredError";
  }
}

export function taskBranchName(taskId) {
  return `agent/${taskId}`;
}

function targetFrom(snapshot) {
  if (snapshot.state !== "running" || snapshot.worktree?.status !== "leased" ||
    snapshot.worktree.branch !== null || !snapshot.worktree.headSha) {
    throw new TaskBranchWorkflowError(
      "Task branch preparation requires an active detached running lease",
    );
  }
  const worker = [...snapshot.workers].reverse().find((candidate) =>
    candidate.mode === "ship" && candidate.status === "reported" &&
    candidate.verification?.dirty === true);
  return {
    branch: taskBranchName(snapshot.id),
    expectedHeadSha: snapshot.worktree.headSha,
    expectedChangedPaths: worker ? [...worker.verification.changedPaths] : [],
  };
}

function adapterInput(snapshot, operation) {
  return {
    worktreePath: snapshot.worktree.worktreePath,
    expectedHeadSha: operation.expectedHeadSha,
    branch: operation.branch,
    expectedChangedPaths: operation.expectedChangedPaths,
  };
}

async function recordResult(store, snapshot, operation, result, actor) {
  return store.recordWorktreeBranch({
    taskId: snapshot.id,
    actor,
    requestEventId: operation.requestEventId,
    result,
    eventId: `${snapshot.id}:worktree-branch:prepared:v1`,
  });
}

function completedResult(snapshot) {
  return snapshot.worktree.branchPreparation?.result || {
    branch: snapshot.worktree.branch,
    headSha: snapshot.worktree.headSha,
    dirty: false,
    changedPaths: [],
  };
}
