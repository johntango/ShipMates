import { randomUUID } from "node:crypto";

export class ExactHeadPushWorkflow {
  constructor({
    store, pushAdapter, readGateway, actor = "firstmate", idFactory = randomUUID,
  } = {}) {
    if (!store || !pushAdapter || !readGateway ||
      typeof pushAdapter.inspect !== "function" ||
      typeof pushAdapter.pushExact !== "function" ||
      typeof pushAdapter.reconcile !== "function" ||
      typeof readGateway.readRepository !== "function" ||
      typeof readGateway.readBranchHead !== "function") {
      throw new TypeError(
        "ExactHeadPushWorkflow requires store, pushAdapter, and readGateway",
      );
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
    this.store = store;
    this.pushAdapter = pushAdapter;
    this.readGateway = readGateway;
    this.actor = actor;
    this.idFactory = idFactory;
  }

  async approve({
    taskId, approvalId, humanActor, repository, branch, headSha,
  }) {
    validateIdentifier("approvalId", approvalId);
    requireText("humanActor", humanActor);
    if (humanActor === this.actor) {
      throw new ExactHeadPushWorkflowError(
        "Push approval actor must be distinct from the Firstmate write actor",
      );
    }
    const snapshot = await this.store.getSnapshot(taskId);
    validateTaskTarget(snapshot, { repository, branch, headSha });
    const expected = binding({ repository, branch, headSha });
    const existing = snapshot.gitPushApprovals.find(({ approvalId: id }) =>
      id === approvalId);
    if (existing) {
      if (existing.actor === humanActor && sameBinding(existing, expected)) {
        return snapshot;
      }
      throw new ExactHeadPushWorkflowError(
        "Push approval ID is already bound to a different human or target",
      );
    }
    return this.store.recordGitPushApproval({
      taskId,
      actor: humanActor,
      approval: {
        approvalId,
        ...expected,
        decision: "approved",
        approverType: "human",
      },
      eventId: `${taskId}:git-push:approval:${approvalId}:v1`,
    });
  }

  async push({
    taskId, operationId, approvalId, repository, branch, headSha,
  }) {
    validateIdentifier("operationId", operationId);
    validateIdentifier("approvalId", approvalId);
    let snapshot = await this.store.getSnapshot(taskId);
    const expected = binding({ repository, branch, headSha });
    validateTaskTarget(snapshot, expected);
    const existing = snapshot.gitPushes.find(({ operationId: id }) =>
      id === operationId);
    if (existing) {
      verifyExistingOperation(existing, expected, approvalId);
      if (existing.status === "completed") return snapshot;
      if (existing.status === "requested") {
        throw new ExactHeadPushRecoveryRequiredError(
          `Push ${operationId} has durable intent but no result; reconcile the remote`,
        );
      }
      throw new ExactHeadPushWorkflowError(
        `Push ${operationId} ended ${existing.status}; use a new human approval and operation`,
      );
    }
    const approval = snapshot.gitPushApprovals.find(({ approvalId: id }) =>
      id === approvalId);
    if (!approval || approval.consumedBy !== null ||
      !sameBinding(approval, expected)) {
      throw new ExactHeadPushWorkflowError(
        "Exact-head push lacks a matching unused human approval",
      );
    }
    const { owner, repo } = parseRepository(repository);
    const repositoryState = await this.readGateway.readRepository({ owner, repo });
    if (repositoryState.nameWithOwner.toLowerCase() !== repository.toLowerCase() ||
      repositoryState.archived || repositoryState.disabled ||
      repositoryState.defaultBranch === branch) {
      throw new ExactHeadPushWorkflowError(
        "Push target must be an active repository and a non-default task branch",
      );
    }
    const input = pushInput(snapshot, expected);
    const before = await this.pushAdapter.inspect(input);
    if (before.localHeadSha !== headSha || before.localBranch !== branch ||
      before.clean !== true || before.remoteHeadSha !== null) {
      throw new ExactHeadPushWorkflowError(
        "Push preflight requires the clean validated head and an absent remote task branch",
      );
    }
    const requestEventId = `${taskId}:git-push:${operationId}:requested:v1`;
    snapshot = await this.store.requestGitPush({
      taskId,
      actor: this.actor,
      request: {
        operationId,
        attemptId: this.idFactory(),
        approvalId,
        approvalEventId: approval.eventId,
        ...expected,
        remoteName: "origin",
        remoteRef: `refs/heads/${branch}`,
        expectedRemoteHeadSha: null,
      },
      eventId: requestEventId,
    });
    let result;
    try {
      result = await this.pushAdapter.pushExact(input);
    } catch (cause) {
      throw new ExactHeadPushRecoveryRequiredError(
        `Push ${operationId} may have reached the remote; reconcile before any retry`,
        { cause },
      );
    }
    await this.#confirmGitHub({ repository, branch, headSha });
    return this.#recordCompleted({
      taskId, operationId, requestEventId, result,
    });
  }

  async reconcile({ taskId, operationId }) {
    validateIdentifier("operationId", operationId);
    const snapshot = await this.store.getSnapshot(taskId);
    const operation = snapshot.gitPushes.find(({ operationId: id }) =>
      id === operationId);
    if (!operation) throw new ExactHeadPushWorkflowError(`Unknown push: ${operationId}`);
    if (operation.status === "completed" || operation.status === "failed") return snapshot;
    if (operation.status !== "requested") {
      throw new ExactHeadPushWorkflowError(
        `Push ${operationId} cannot be reconciled from ${operation.status}`,
      );
    }
    const reconciliation = await this.pushAdapter.reconcile(pushInput(snapshot, operation));
    if (reconciliation.status === "conflict") {
      throw new ExactHeadPushRecoveryRequiredError(
        "Remote task branch exists at a different SHA; manual recovery is required",
      );
    }
    if (reconciliation.status === "absent") {
      return this.store.recordGitPushFailure({
        taskId,
        actor: this.actor,
        operationId,
        requestEventId: operation.requestEventId,
        code: "remote_branch_absent",
        eventId: `${taskId}:git-push:${operationId}:failed:v1`,
      });
    }
    await this.#confirmGitHub(operation);
    return this.#recordCompleted({
      taskId,
      operationId,
      requestEventId: operation.requestEventId,
      result: reconciliation.evidence,
    });
  }

  async #confirmGitHub({ repository, branch, headSha }) {
    const { owner, repo } = parseRepository(repository);
    const remote = await this.readGateway.readBranchHead({ owner, repo, branch });
    if (remote.repository.toLowerCase() !== repository.toLowerCase() ||
      remote.branch !== branch || remote.sha !== headSha) {
      throw new ExactHeadPushRecoveryRequiredError(
        "GitHub branch observation does not match the approved exact head",
      );
    }
  }

  #recordCompleted({ taskId, operationId, requestEventId, result }) {
    return this.store.recordGitPushCompleted({
      taskId,
      actor: this.actor,
      operationId,
      requestEventId,
      result,
      eventId: `${taskId}:git-push:${operationId}:completed:v1`,
    });
  }
}

export class ExactHeadPushWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ExactHeadPushWorkflowError";
  }
}

export class ExactHeadPushRecoveryRequiredError extends ExactHeadPushWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ExactHeadPushRecoveryRequiredError";
  }
}

function validateTaskTarget(snapshot, { repository, branch, headSha }) {
  const validation = snapshot.validationRuns.at(-1);
  const commit = snapshot.gitCommits.at(-1);
  if (snapshot.repo.toLowerCase() !== repository.toLowerCase() ||
    snapshot.state !== "validating" || snapshot.worktree?.status !== "leased" ||
    snapshot.worktree.branch !== branch || snapshot.worktree.headSha !== headSha ||
    validation?.passed !== true || validation.finalHeadSha !== headSha ||
    commit?.status !== "completed" || commit.result?.headSha !== headSha) {
    throw new ExactHeadPushWorkflowError(
      "Push target must match the controlled commit and passing validation on the active lease",
    );
  }
}

function binding({ repository, branch, headSha }) {
  parseRepository(repository);
  validateBranch(branch);
  requireFullSha(headSha);
  return {
    repository,
    branch,
    headSha: headSha.toLowerCase(),
  };
}

function pushInput(snapshot, target) {
  return {
    worktreePath: snapshot.worktree.worktreePath,
    repository: target.repository,
    branch: target.branch,
    headSha: target.headSha,
  };
}

function verifyExistingOperation(operation, expected, approvalId) {
  if (operation.approvalId !== approvalId || !sameBinding(operation, expected)) {
    throw new ExactHeadPushWorkflowError(
      "Push operation ID is already bound to a different approved target",
    );
  }
}

function sameBinding(left, right) {
  return ["repository", "branch", "headSha"].every((field) =>
    left[field] === right[field]);
}

function parseRepository(repository) {
  if (typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new TypeError("repository must be an owner/name pair");
  }
  const [owner, repo] = repository.split("/");
  return { owner, repo };
}

function validateBranch(value) {
  requireText("branch", value);
  if (value === "@" ||
    /\p{Cc}|\.\.|@\{|[ ~^:?*\\[]|^\/|\/\/|\/$|^\.|\.$|\.lock$/u.test(value)) {
    throw new TypeError("branch is not a safe Git branch");
  }
}

function validateIdentifier(label, value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe 3-64 character identifier`);
  }
}

function requireFullSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TypeError("headSha must be a full SHA");
  }
}

function requireText(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be non-empty`);
  }
}
