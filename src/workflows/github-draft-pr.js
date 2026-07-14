import { createHash } from "node:crypto";

export class GitHubDraftPullRequestWorkflow {
  constructor({
    store,
    writeGateway,
    readGateway,
    statusWorkflow = null,
    actor = "firstmate",
  } = {}) {
    if (!store || !writeGateway || !readGateway) {
      throw new TypeError(
        "GitHubDraftPullRequestWorkflow requires store, writeGateway, and readGateway",
      );
    }
    this.store = store;
    this.writeGateway = writeGateway;
    this.readGateway = readGateway;
    this.statusWorkflow = statusWorkflow;
    this.actor = actor;
  }

  async approve({
    taskId, approvalId, humanActor, repository, headBranch, headSha, baseBranch,
    title, body,
  }) {
    validateIdentifier("approvalId", approvalId);
    requireText("humanActor", humanActor, 128);
    if (humanActor === this.actor) {
      throw new GitHubDraftPullRequestWorkflowError(
        "Draft PR approval actor must be distinct from the Firstmate write actor",
      );
    }
    const snapshot = await this.store.getSnapshot(taskId);
    validateTaskTarget(snapshot, { repository, headSha });
    const approval = binding({
      repository, headBranch, headSha, baseBranch, title, body,
    });
    const existing = snapshot.githubDraftPrApprovals.find(
      (candidate) => candidate.approvalId === approvalId,
    );
    if (existing) {
      if (existing.actor === humanActor && sameBinding(existing, approval)) {
        return snapshot;
      }
      throw new GitHubDraftPullRequestWorkflowError(
        "Approval ID is already bound to a different human or target",
      );
    }
    return this.store.recordDraftPullRequestApproval({
      taskId,
      actor: humanActor,
      approval: {
        approvalId,
        ...approval,
        decision: "approved",
        approverType: "human",
      },
      eventId: `${taskId}:github:draft-pr:approval:${approvalId}:v1`,
    });
  }

  async create({
    taskId, operationId, approvalId, repository, headBranch, headSha, baseBranch,
    title, body,
  }) {
    validateIdentifier("operationId", operationId);
    validateIdentifier("approvalId", approvalId);
    let snapshot = await this.store.getSnapshot(taskId);
    const expected = binding({
      repository, headBranch, headSha, baseBranch, title, body,
    });
    validateTaskTarget(snapshot, expected);
    const existing = snapshot.githubDraftPullRequests.find(
      (operation) => operation.operationId === operationId,
    );
    if (existing) {
      verifyExistingOperation(existing, expected, approvalId);
      if (existing.status === "completed") return snapshot;
      if (existing.status === "requested") {
        throw new GitHubDraftPullRequestRecoveryRequiredError(
          `Draft PR operation ${operationId} has durable intent but no result; reconcile GitHub instead of creating again`,
        );
      }
      throw new GitHubDraftPullRequestWorkflowError(
        `Draft PR operation ${operationId} previously failed; use a new approval and operation after review`,
      );
    }
    const approval = snapshot.githubDraftPrApprovals.find(
      (candidate) => candidate.approvalId === approvalId,
    );
    if (!approval || approval.consumedBy !== null ||
      !sameBinding(approval, expected)) {
      throw new GitHubDraftPullRequestWorkflowError(
        "Draft PR creation lacks a matching unused human approval",
      );
    }
    const { owner, repo } = parseRepository(repository);
    const branch = await this.readGateway.readBranchHead({
      owner,
      repo,
      branch: headBranch,
    });
    if (branch.sha !== headSha) {
      throw new GitHubDraftPullRequestWorkflowError(
        `GitHub branch ${headBranch} is ${branch.sha}, expected approved ${headSha}`,
      );
    }
    const requestEventId = `${taskId}:github:draft-pr:create:${operationId}:requested:v1`;
    snapshot = await this.store.requestDraftPullRequestCreate({
      taskId,
      actor: this.actor,
      request: {
        operationId,
        approvalId,
        approvalEventId: approval.eventId,
        ...expected,
      },
      eventId: requestEventId,
    });

    let created;
    try {
      created = await this.writeGateway.create({
        owner, repo, title, body, headBranch, headSha, baseBranch,
      });
    } catch (cause) {
      throw new GitHubDraftPullRequestRecoveryRequiredError(
        `Draft PR operation ${operationId} may have reached GitHub; reconcile before any retry`,
        { cause },
      );
    }
    const confirmed = await this.readGateway.readPullRequest({
      owner,
      repo,
      number: created.number,
    });
    return this.#recordCompleted({
      taskId,
      operationId,
      requestEventId,
      created,
      confirmed,
    });
  }

  async reconcile({ taskId, operationId }) {
    validateIdentifier("operationId", operationId);
    const snapshot = await this.store.getSnapshot(taskId);
    const operation = snapshot.githubDraftPullRequests.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!operation) {
      throw new GitHubDraftPullRequestWorkflowError(`Unknown operation: ${operationId}`);
    }
    if (operation.status === "completed") return snapshot;
    if (operation.status !== "requested") {
      throw new GitHubDraftPullRequestWorkflowError(
        `Operation ${operationId} cannot be reconciled from ${operation.status}`,
      );
    }
    const { owner, repo } = parseRepository(operation.repository);
    const pulls = await this.readGateway.listPullRequests({ owner, repo, state: "all" });
    const matches = pulls.filter((pull) =>
      pull.state === "open" && pull.draft === true &&
      pull.repository.toLowerCase() === operation.repository.toLowerCase() &&
      pull.head.repository.toLowerCase() === operation.repository.toLowerCase() &&
      pull.head.branch === operation.headBranch && pull.head.sha === operation.headSha &&
      pull.base.branch === operation.baseBranch &&
      digest(pull.title) === operation.titleSha256,
    );
    if (matches.length !== 1) {
      throw new GitHubDraftPullRequestRecoveryRequiredError(
        `Draft PR reconciliation found ${matches.length} exact matches; do not repeat the write`,
      );
    }
    const confirmed = await this.readGateway.readPullRequest({
      owner,
      repo,
      number: matches[0].number,
    });
    return this.#recordCompleted({
      taskId,
      operationId,
      requestEventId: operation.requestEventId,
      created: matches[0],
      confirmed,
    });
  }

  async observeCi({ taskId, operationId, requiredChecks = [] }) {
    if (!this.statusWorkflow) {
      throw new GitHubDraftPullRequestWorkflowError("CI observation workflow is not configured");
    }
    const snapshot = await this.store.getSnapshot(taskId);
    const operation = snapshot.githubDraftPullRequests.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (operation?.status !== "completed") {
      throw new GitHubDraftPullRequestWorkflowError(
        "CI observation requires a completed draft PR operation",
      );
    }
    return this.statusWorkflow.inspectPullRequest({
      taskId,
      repository: operation.repository,
      prNumber: operation.pullRequest.number,
      requiredChecks,
    });
  }

  async #recordCompleted({
    taskId, operationId, requestEventId, created, confirmed,
  }) {
    if (created.number !== confirmed.number || created.head.sha !== confirmed.head.sha) {
      throw new GitHubDraftPullRequestRecoveryRequiredError(
        "Created pull request identity changed before confirmation",
      );
    }
    return this.store.recordDraftPullRequestCreated({
      taskId,
      actor: this.actor,
      operationId,
      requestEventId,
      pullRequest: confirmed,
      eventId: `${taskId}:github:draft-pr:create:${operationId}:completed:v1`,
      at: confirmed.observedAt,
    });
  }
}

export class GitHubDraftPullRequestWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubDraftPullRequestWorkflowError";
  }
}

export class GitHubDraftPullRequestRecoveryRequiredError extends
  GitHubDraftPullRequestWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubDraftPullRequestRecoveryRequiredError";
  }
}

function binding({ repository, headBranch, headSha, baseBranch, title, body }) {
  parseRepository(repository);
  requireText("headBranch", headBranch, 255);
  requireText("baseBranch", baseBranch, 255);
  requireFullSha(headSha);
  requireText("title", title, 256);
  requireText("body", body, 65_536);
  return {
    repository,
    headBranch,
    headSha: headSha.toLowerCase(),
    baseBranch,
    titleSha256: digest(title),
    bodySha256: digest(body),
  };
}

function validateTaskTarget(snapshot, { repository, headSha }) {
  const push = [...(snapshot.gitPushes || [])].reverse().find((operation) =>
    operation.status === "completed" &&
    operation.repository.toLowerCase() === repository.toLowerCase() &&
    operation.headSha === headSha && operation.result?.remoteHeadSha === headSha);
  if (
    snapshot.repo.toLowerCase() !== repository.toLowerCase() ||
    snapshot.state !== "validating" ||
    snapshot.worktree?.status !== "leased" ||
    snapshot.worktree.headSha !== headSha ||
    snapshot.validationRuns.at(-1)?.passed !== true ||
    snapshot.validationRuns.at(-1)?.finalHeadSha !== headSha || !push
  ) {
    throw new GitHubDraftPullRequestWorkflowError(
      "Draft PR target must match a passing validation on the active leased head",
    );
  }
}

function verifyExistingOperation(operation, expected, approvalId) {
  if (operation.approvalId !== approvalId || !sameBinding(operation, expected)) {
    throw new GitHubDraftPullRequestWorkflowError(
      "Operation ID is already bound to a different approved target",
    );
  }
}

function sameBinding(left, right) {
  return [
    "repository", "headBranch", "headSha", "baseBranch", "titleSha256",
    "bodySha256",
  ].every((field) => left[field] === right[field]);
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
    throw new TypeError("headSha must be a full 40-character hexadecimal SHA");
  }
}

function requireText(label, value, maximum) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new TypeError(`${label} must be non-empty and at most ${maximum} characters`);
  }
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
