import { createHash, randomUUID } from "node:crypto";

export class GitHubMergeWorkflow {
  constructor({
    store,
    mergeGateway,
    readGateway,
    statusWorkflow,
    actor = "firstmate",
    idFactory = randomUUID,
  } = {}) {
    if (!store || !mergeGateway || !readGateway || !statusWorkflow ||
      typeof mergeGateway.mergeSquash !== "function" ||
      typeof readGateway.readRepository !== "function" ||
      typeof readGateway.readPullRequest !== "function" ||
      typeof readGateway.readBranchHead !== "function" ||
      typeof readGateway.listReviewThreads !== "function") {
      throw new TypeError(
        "GitHubMergeWorkflow requires store, merge, read, status, and review-thread gateways",
      );
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
    this.store = store;
    this.mergeGateway = mergeGateway;
    this.readGateway = readGateway;
    this.statusWorkflow = statusWorkflow;
    this.actor = actor;
    this.idFactory = idFactory;
  }

  async approve({
    taskId, approvalId, humanActor, repository, prNumber, headSha,
    mergeMethod = "squash",
  }) {
    validateIdentifier("approvalId", approvalId);
    requireText("humanActor", humanActor);
    if (humanActor === this.actor) {
      throw new GitHubMergeWorkflowError(
        "Merge approval actor must be distinct from the Firstmate merge actor",
      );
    }
    const target = binding({ repository, prNumber, headSha, mergeMethod });
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = (snapshot.githubMergeApprovals || []).find(
      ({ approvalId: id }) => id === approvalId,
    );
    if (existing) {
      if (existing.actor === humanActor && sameBinding(existing, target)) return snapshot;
      throw new GitHubMergeWorkflowError(
        "Merge approval ID is already bound to a different human or target",
      );
    }
    await this.statusWorkflow.inspectPullRequest({
      taskId,
      repository,
      prNumber,
      expectedHeadSha: headSha,
    });
    snapshot = await this.store.getSnapshot(taskId);
    const readiness = await this.#readiness(snapshot, target);
    return this.store.recordGitHubMergeApproval({
      taskId,
      actor: humanActor,
      approval: {
        approvalId,
        ...target,
        baseBranch: readiness.baseBranch,
        decision: "approved",
        approverType: "human",
        statusEventId: readiness.statusEventId,
        reviewThreadsSha256: readiness.reviewThreadsSha256,
        reviewThreadsCount: readiness.reviewThreadsCount,
        unresolvedThreads: 0,
      },
      eventId: `${taskId}:github:merge:approval:${approvalId}:v1`,
    });
  }

  async merge({ taskId, operationId, approvalId }) {
    validateIdentifier("operationId", operationId);
    validateIdentifier("approvalId", approvalId);
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = (snapshot.githubMerges || []).find(
      ({ operationId: id }) => id === operationId,
    );
    if (existing) {
      if (existing.approvalId !== approvalId) {
        throw new GitHubMergeWorkflowError(
          "Merge operation ID is bound to a different approval",
        );
      }
      if (existing.status === "completed") return snapshot;
      if (existing.status === "requested") {
        throw new GitHubMergeRecoveryRequiredError(
          `Merge ${operationId} has durable intent but no result; reconcile GitHub`,
        );
      }
      throw new GitHubMergeWorkflowError(
        `Merge ${operationId} ended ${existing.status}; obtain a new approval`,
      );
    }
    const approval = (snapshot.githubMergeApprovals || []).find(
      ({ approvalId: id }) => id === approvalId,
    );
    if (!approval || approval.consumedBy !== null) {
      throw new GitHubMergeWorkflowError(
        "Squash merge lacks a matching unused human approval",
      );
    }
    const target = binding(approval);
    await this.statusWorkflow.inspectPullRequest({
      taskId,
      repository: target.repository,
      prNumber: target.prNumber,
      expectedHeadSha: target.headSha,
    });
    snapshot = await this.store.getSnapshot(taskId);
    const readiness = await this.#readiness(snapshot, target);
    if (readiness.baseBranch !== approval.baseBranch) {
      throw new GitHubMergeWorkflowError("Default branch changed after merge approval");
    }
    const requestEventId = `${taskId}:github:merge:${operationId}:requested:v1`;
    await this.store.requestGitHubMerge({
      taskId,
      actor: this.actor,
      request: {
        operationId,
        attemptId: this.idFactory(),
        approvalId,
        approvalEventId: approval.eventId,
        ...target,
        baseBranch: readiness.baseBranch,
        preMergeStatusEventId: readiness.statusEventId,
        preMergeReviewThreadsSha256: readiness.reviewThreadsSha256,
        preMergeReviewThreadsCount: readiness.reviewThreadsCount,
        preMergeUnresolvedThreads: 0,
      },
      eventId: requestEventId,
    });
    const { owner, repo } = parseRepository(target.repository);
    let merged;
    try {
      merged = await this.mergeGateway.mergeSquash({
        owner,
        repo,
        prNumber: target.prNumber,
        headSha: target.headSha,
      });
    } catch (cause) {
      throw new GitHubMergeRecoveryRequiredError(
        `Merge ${operationId} may have reached GitHub; reconcile before any retry`,
        { cause },
      );
    }
    const result = await this.#confirmMerged({
      ...target,
      baseBranch: readiness.baseBranch,
      expectedMergeCommitSha: merged.mergeCommitSha,
      evidenceKind: "merge-confirmation",
    });
    return this.#recordCompleted({ taskId, operationId, requestEventId, result });
  }

  async reconcile({ taskId, operationId }) {
    validateIdentifier("operationId", operationId);
    const snapshot = await this.store.getSnapshot(taskId);
    const operation = (snapshot.githubMerges || []).find(
      ({ operationId: id }) => id === operationId,
    );
    if (!operation) throw new GitHubMergeWorkflowError(`Unknown merge: ${operationId}`);
    if (operation.status === "completed" || operation.status === "failed") return snapshot;
    if (operation.status !== "requested") {
      throw new GitHubMergeWorkflowError(
        `Merge ${operationId} cannot be reconciled from ${operation.status}`,
      );
    }
    const { owner, repo } = parseRepository(operation.repository);
    const pull = await this.readGateway.readPullRequest({
      owner, repo, number: operation.prNumber,
    });
    if (pull.head.sha !== operation.headSha) {
      throw new GitHubMergeRecoveryRequiredError(
        "Pull request head differs from the approved merge head",
      );
    }
    if (pull.merged !== true) {
      if (pull.state !== "open") {
        throw new GitHubMergeRecoveryRequiredError(
          "Pull request is closed without a confirmed approved merge",
        );
      }
      return this.store.recordGitHubMergeFailure({
        taskId,
        actor: this.actor,
        operationId,
        requestEventId: operation.requestEventId,
        code: "pull_request_not_merged",
        eventId: `${taskId}:github:merge:${operationId}:failed:v1`,
      });
    }
    const result = await this.#confirmMerged({
      ...operation,
      expectedMergeCommitSha: pull.mergeCommitSha,
      evidenceKind: "remote-reconciliation",
    });
    return this.#recordCompleted({
      taskId,
      operationId,
      requestEventId: operation.requestEventId,
      result,
    });
  }

  async #readiness(snapshot, target) {
    validateTaskBinding(snapshot, target);
    const status = [...snapshot.githubObservations].reverse().find((observation) =>
      observation.pullRequest.number === target.prNumber &&
      observation.pullRequest.head.sha === target.headSha);
    if (!status) throw new GitHubMergeWorkflowError("Merge lacks exact-head status evidence");
    const pull = status.pullRequest;
    const repository = status.repository;
    if (repository.archived || repository.disabled ||
      repository.allowSquashMerge !== true ||
      pull.state !== "open" || pull.draft !== false || pull.merged !== false ||
      pull.mergeable !== true || status.requiredChecks.satisfied !== true ||
      pull.base.branch !== repository.defaultBranch) {
      throw new GitHubMergeWorkflowError(
        "Pull request is not an open, non-draft, mergeable exact-head target with passing checks",
      );
    }
    const reviewPolicy = status.branchProtection.requiredPullRequestReviews;
    if (status.branchProtection.requiredConversationResolution !== true) {
      throw new GitHubMergeWorkflowError(
        "Default-branch policy must enforce conversation resolution before merge",
      );
    }
    if (reviewPolicy?.requireCodeOwnerReviews === true ||
      reviewPolicy?.requireLastPushApproval === true) {
      throw new GitHubMergeWorkflowError(
        "Configured review policy cannot be independently proven by this merge gateway",
      );
    }
    const requiredApprovals = reviewPolicy?.approvals || 0;
    if (approvedReviewers(status.reviews, target.headSha) < requiredApprovals) {
      throw new GitHubMergeWorkflowError("Required pull-request reviews are not satisfied");
    }
    const { owner, repo } = parseRepository(target.repository);
    const threads = await this.readGateway.listReviewThreads({
      owner, repo, number: target.prNumber,
    });
    if (threads.some(({ resolved }) => resolved !== true)) {
      throw new GitHubMergeWorkflowError("Pull request has unresolved review threads");
    }
    return {
      baseBranch: pull.base.branch,
      statusEventId: status.eventId,
      reviewThreadsSha256: digestReviewThreads(threads),
      reviewThreadsCount: threads.length,
    };
  }

  async #confirmMerged({
    repository, prNumber, headSha, baseBranch, expectedMergeCommitSha,
    evidenceKind,
  }) {
    requireFullSha(expectedMergeCommitSha);
    const { owner, repo } = parseRepository(repository);
    const pull = await this.readGateway.readPullRequest({ owner, repo, number: prNumber });
    if (pull.merged !== true || pull.head.sha !== headSha ||
      pull.mergeCommitSha !== expectedMergeCommitSha) {
      throw new GitHubMergeRecoveryRequiredError(
        "GitHub pull request does not confirm the approved merge result",
      );
    }
    const base = await this.readGateway.readBranchHead({ owner, repo, branch: baseBranch });
    if (base.sha !== expectedMergeCommitSha) {
      throw new GitHubMergeRecoveryRequiredError(
        "Default branch does not point at the confirmed merge commit",
      );
    }
    return {
      evidenceKind,
      repository,
      prNumber,
      headSha,
      mergeMethod: "squash",
      mergeCommitSha: expectedMergeCommitSha,
      baseBranch,
      baseHeadSha: base.sha,
      merged: true,
    };
  }

  #recordCompleted({ taskId, operationId, requestEventId, result }) {
    return this.store.recordGitHubMergeCompleted({
      taskId,
      actor: this.actor,
      operationId,
      requestEventId,
      result,
      eventId: `${taskId}:github:merge:${operationId}:completed:v1`,
    });
  }
}

export class GitHubMergeWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubMergeWorkflowError";
  }
}

export class GitHubMergeRecoveryRequiredError extends GitHubMergeWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubMergeRecoveryRequiredError";
  }
}

function validateTaskBinding(snapshot, target) {
  const draft = [...(snapshot.githubDraftPullRequests || [])].reverse().find((operation) =>
    operation.status === "completed" && operation.pullRequest?.number === target.prNumber &&
    operation.repository.toLowerCase() === target.repository.toLowerCase() &&
    operation.headSha === target.headSha);
  if (!new Set(["validating", "ready_to_merge"]).has(snapshot.state) || !draft ||
    snapshot.repo.toLowerCase() !== target.repository.toLowerCase() ||
    snapshot.worktree?.headSha !== target.headSha) {
    throw new GitHubMergeWorkflowError(
      "Merge target must match the task's completed draft PR and active exact head",
    );
  }
}

function approvedReviewers(reviews, headSha) {
  const latest = new Map();
  for (const review of reviews) {
    if (review.commitSha !== headSha) continue;
    latest.set(review.actor, review);
  }
  return [...latest.values()].filter(({ state }) => state === "APPROVED").length;
}

function digestReviewThreads(threads) {
  const normalized = threads.map(({ id, resolved, outdated }) => ({
    id, resolved, outdated,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

function binding({ repository, prNumber, headSha, mergeMethod }) {
  parseRepository(repository);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new TypeError("prNumber must be a positive integer");
  }
  requireFullSha(headSha);
  if (mergeMethod !== "squash") throw new TypeError("mergeMethod must be squash");
  return { repository, prNumber, headSha: headSha.toLowerCase(), mergeMethod };
}

function sameBinding(left, right) {
  return ["repository", "prNumber", "headSha", "mergeMethod"].every(
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

function validateIdentifier(label, value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe 3-64 character identifier`);
  }
}

function requireFullSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TypeError("SHA must be a full 40-character hexadecimal value");
  }
}

function requireText(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be non-empty`);
  }
}
