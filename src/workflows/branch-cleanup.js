import { randomUUID } from "node:crypto";

export class BranchCleanupWorkflow {
  constructor({
    store,
    deleteAdapter,
    readGateway,
    actor = "firstmate",
    idFactory = randomUUID,
  } = {}) {
    if (!store || !deleteAdapter || !readGateway ||
      typeof deleteAdapter.inspect !== "function" ||
      typeof deleteAdapter.deleteExact !== "function" ||
      typeof deleteAdapter.reconcile !== "function" ||
      typeof readGateway.readRepository !== "function") {
      throw new TypeError(
        "BranchCleanupWorkflow requires store, exact deletion adapter, and GitHub reader",
      );
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
    this.store = store;
    this.deleteAdapter = deleteAdapter;
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
      throw new BranchCleanupWorkflowError(
        "Branch cleanup approval actor must be distinct from Firstmate",
      );
    }
    const target = binding({ repository, branch, headSha });
    const snapshot = await this.store.getSnapshot(taskId);
    const existing = (snapshot.branchCleanupApprovals || []).find(
      ({ approvalId: id }) => id === approvalId,
    );
    if (existing) {
      if (existing.actor === humanActor && sameBinding(existing, target)) return snapshot;
      throw new BranchCleanupWorkflowError(
        "Branch cleanup approval ID is already bound to another human or target",
      );
    }
    const completion = validateCompletedTarget(snapshot, target);
    await this.#requireActiveNonDefaultRepository(target);
    const observation = await this.deleteAdapter.inspect(adapterInput(snapshot, target));
    if (observation.remoteHeadSha !== target.headSha) {
      throw new BranchCleanupWorkflowError(
        "Cleanup approval requires the remote task branch at the completed exact head",
      );
    }
    return this.store.recordBranchCleanupApproval({
      taskId,
      actor: humanActor,
      approval: {
        approvalId,
        ...target,
        decision: "approved",
        approverType: "human",
        postMergeAssuranceEventId: completion.assurance.eventId,
        treeProofEventId: completion.proof.eventId,
        worktreeReturnedEventId: snapshot.worktree.returnedEventId,
      },
      eventId: `${taskId}:branch-cleanup:approval:${approvalId}:v1`,
    });
  }

  async delete({ taskId, operationId, approvalId }) {
    validateIdentifier("operationId", operationId);
    validateIdentifier("approvalId", approvalId);
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = (snapshot.branchCleanups || []).find(
      ({ operationId: id }) => id === operationId,
    );
    if (existing) {
      if (existing.approvalId !== approvalId) {
        throw new BranchCleanupWorkflowError(
          "Branch cleanup operation ID is bound to another approval",
        );
      }
      if (existing.status === "completed") return snapshot;
      if (existing.status === "requested") {
        throw new BranchCleanupRecoveryRequiredError(
          `Branch cleanup ${operationId} has durable intent; reconcile the remote`,
        );
      }
      throw new BranchCleanupWorkflowError(
        `Branch cleanup ${operationId} ended ${existing.status}; obtain a new approval`,
      );
    }
    const approval = (snapshot.branchCleanupApprovals || []).find(
      ({ approvalId: id }) => id === approvalId,
    );
    if (!approval || approval.consumedBy !== null) {
      throw new BranchCleanupWorkflowError(
        "Remote branch deletion lacks a matching unused human approval",
      );
    }
    const target = binding(approval);
    validateCompletedTarget(snapshot, target, approval);
    await this.#requireActiveNonDefaultRepository(target);
    const input = adapterInput(snapshot, target);
    const before = await this.deleteAdapter.inspect(input);
    if (before.remoteHeadSha !== target.headSha) {
      throw new BranchCleanupWorkflowError(
        "Branch cleanup preflight requires the approved exact remote head",
      );
    }
    const requestEventId = `${taskId}:branch-cleanup:${operationId}:requested:v1`;
    snapshot = await this.store.requestBranchCleanup({
      taskId,
      actor: this.actor,
      request: {
        operationId,
        attemptId: this.idFactory(),
        approvalId,
        approvalEventId: approval.eventId,
        ...target,
        remoteName: "origin",
        remoteRef: `refs/heads/${target.branch}`,
        expectedRemoteHeadSha: target.headSha,
      },
      eventId: requestEventId,
    });
    let result;
    try {
      result = await this.deleteAdapter.deleteExact(input);
    } catch (cause) {
      throw new BranchCleanupRecoveryRequiredError(
        `Branch cleanup ${operationId} may have reached the remote; reconcile before retry`,
        { cause },
      );
    }
    return this.#recordCompleted({ taskId, operationId, requestEventId, result });
  }

  async reconcile({ taskId, operationId }) {
    validateIdentifier("operationId", operationId);
    const snapshot = await this.store.getSnapshot(taskId);
    const operation = (snapshot.branchCleanups || []).find(
      ({ operationId: id }) => id === operationId,
    );
    if (!operation) {
      throw new BranchCleanupWorkflowError(`Unknown branch cleanup: ${operationId}`);
    }
    if (operation.status === "completed" || operation.status === "failed") return snapshot;
    if (operation.status !== "requested") {
      throw new BranchCleanupWorkflowError(
        `Branch cleanup ${operationId} cannot reconcile from ${operation.status}`,
      );
    }
    const reconciliation = await this.deleteAdapter.reconcile(
      adapterInput(snapshot, operation),
    );
    if (reconciliation.status === "conflict") {
      throw new BranchCleanupRecoveryRequiredError(
        "Remote task branch moved away from its approved cleanup SHA",
      );
    }
    if (reconciliation.status === "not_deleted") {
      return this.store.recordBranchCleanupFailure({
        taskId,
        actor: this.actor,
        operationId,
        requestEventId: operation.requestEventId,
        code: "remote_branch_not_deleted",
        eventId: `${taskId}:branch-cleanup:${operationId}:failed:v1`,
      });
    }
    return this.#recordCompleted({
      taskId,
      operationId,
      requestEventId: operation.requestEventId,
      result: reconciliation.evidence,
    });
  }

  async #requireActiveNonDefaultRepository(target) {
    const { owner, repo } = parseRepository(target.repository);
    const repository = await this.readGateway.readRepository({ owner, repo });
    if (repository.nameWithOwner.toLowerCase() !== target.repository.toLowerCase() ||
      repository.archived || repository.disabled ||
      repository.defaultBranch === target.branch) {
      throw new BranchCleanupWorkflowError(
        "Cleanup target must be a non-default branch in the active task repository",
      );
    }
  }

  #recordCompleted({ taskId, operationId, requestEventId, result }) {
    return this.store.recordBranchCleanupCompleted({
      taskId,
      actor: this.actor,
      operationId,
      requestEventId,
      result,
      eventId: `${taskId}:branch-cleanup:${operationId}:completed:v1`,
    });
  }
}

export class BranchCleanupWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "BranchCleanupWorkflowError";
  }
}

export class BranchCleanupRecoveryRequiredError extends BranchCleanupWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "BranchCleanupRecoveryRequiredError";
  }
}

function validateCompletedTarget(snapshot, target, approval = null) {
  const assurance = (snapshot.postMergeAssurances || []).at(-1);
  const proof = snapshot.worktree?.proof;
  const push = [...(snapshot.gitPushes || [])].reverse().find((operation) =>
    operation.status === "completed" &&
    operation.repository.toLowerCase() === target.repository.toLowerCase() &&
    operation.branch === target.branch && operation.headSha === target.headSha);
  const cleanupActive = (snapshot.branchCleanups || []).some(
    ({ status }) => new Set(["requested", "completed"]).has(status),
  );
  if (snapshot.state !== "complete" || snapshot.worktree?.status !== "returned" ||
    snapshot.repo.toLowerCase() !== target.repository.toLowerCase() ||
    snapshot.worktree.branch !== target.branch ||
    snapshot.worktree.headSha !== target.headSha || !push || cleanupActive ||
    assurance?.requiredChecks?.satisfied !== true ||
    assurance.approvedHeadSha !== target.headSha ||
    proof?.kind !== "exact-tree-landing" ||
    proof.assuranceEventId !== assurance.eventId ||
    snapshot.worktree.returnedEventId === null) {
    throw new BranchCleanupWorkflowError(
      "Branch cleanup requires completed assurance, exact-tree proof, and returned lease",
    );
  }
  if (approval && (approval.postMergeAssuranceEventId !== assurance.eventId ||
    approval.treeProofEventId !== proof.eventId ||
    approval.worktreeReturnedEventId !== snapshot.worktree.returnedEventId)) {
    throw new BranchCleanupWorkflowError(
      "Branch cleanup approval no longer matches completion evidence",
    );
  }
  return { assurance, proof, push };
}

function adapterInput(snapshot, target) {
  return {
    repoPath: snapshot.worktree.repoPath,
    repository: target.repository,
    branch: target.branch,
    headSha: target.headSha,
  };
}

function binding({ repository, branch, headSha }) {
  parseRepository(repository);
  validateBranch(branch);
  requireFullSha(headSha);
  return { repository, branch, headSha: headSha.toLowerCase() };
}

function sameBinding(left, right) {
  return ["repository", "branch", "headSha"].every(
    (field) => left[field] === right[field],
  );
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

function requireFullSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TypeError("headSha must be a full SHA");
  }
}

function validateIdentifier(label, value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe 3-64 character identifier`);
  }
}

function requireText(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be non-empty`);
  }
}
