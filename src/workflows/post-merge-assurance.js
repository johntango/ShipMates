import { randomUUID } from "node:crypto";

export class PostMergeAssuranceWorkflow {
  constructor({
    store,
    readGateway,
    treehouseWorkflow,
    actor = "firstmate",
    clock = () => new Date(),
    idFactory = randomUUID,
  } = {}) {
    if (!store || !readGateway || !treehouseWorkflow ||
      typeof readGateway.readRepository !== "function" ||
      typeof readGateway.readPullRequest !== "function" ||
      typeof readGateway.readBranchHead !== "function" ||
      typeof readGateway.readBranchProtection !== "function" ||
      typeof readGateway.listCheckRuns !== "function" ||
      typeof readGateway.listWorkflowRuns !== "function" ||
      typeof treehouseWorkflow.completeExactTreeLanding !== "function" ||
      typeof treehouseWorkflow.reconcileReturn !== "function") {
      throw new TypeError(
        "PostMergeAssuranceWorkflow requires store, GitHub read gateway, and Treehouse workflow",
      );
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
    this.store = store;
    this.readGateway = readGateway;
    this.treehouseWorkflow = treehouseWorkflow;
    this.actor = actor;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  async complete({ taskId, operationId }) {
    validateIdentifier("operationId", operationId);
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = (snapshot.postMergeAssurances || []).find(
      ({ operationId: id }) => id === operationId,
    );
    if (snapshot.state === "complete" && snapshot.worktree?.status === "returned") {
      if (!existing) {
        throw new PostMergeAssuranceError(
          "Completed task is not bound to the requested post-merge operation",
        );
      }
      return snapshot;
    }

    const merge = completedMerge(snapshot);
    const other = (snapshot.postMergeAssurances || []).find(
      ({ mergeOperationId }) => mergeOperationId === merge.operationId,
    );
    if (!existing && other) {
      throw new PostMergeAssuranceError(
        `Merge is already bound to post-merge operation ${other.operationId}`,
      );
    }
    if (existing && existing.mergeOperationId !== merge.operationId) {
      throw new PostMergeAssuranceError(
        "Post-merge operation ID is already bound to a different merge",
      );
    }
    if (!existing) {
      if (snapshot.state !== "landed" || snapshot.worktree?.status !== "leased") {
        throw new PostMergeAssuranceError(
          "Post-merge assurance starts from a landed task with its active lease",
        );
      }
      const report = await this.#observe({ snapshot, merge, operationId });
      snapshot = await this.store.recordPostMergeAssurance({
        taskId,
        actor: this.actor,
        report,
        eventId: `${taskId}:post-merge:${operationId}:verified:v1`,
        at: report.observedAt,
      });
    } else if (snapshot.state === "landed") {
      await this.#observe({ snapshot, merge, operationId });
    }

    return this.treehouseWorkflow.completeExactTreeLanding({
      taskId,
      operationId,
    });
  }

  async reconcileReturn({ taskId }) {
    return this.treehouseWorkflow.reconcileReturn({ taskId });
  }

  async #observe({ snapshot, merge, operationId }) {
    const result = merge.result;
    const { owner, repo } = parseRepository(merge.repository);
    const repository = await this.readGateway.readRepository({ owner, repo });
    const pullRequest = await this.readGateway.readPullRequest({
      owner, repo, number: merge.prNumber,
    });
    const [branchProtection, branchHead, checks, workflowRuns] = await Promise.all([
      this.readGateway.readBranchProtection({
        owner, repo, branch: result.baseBranch,
      }),
      this.readGateway.readBranchHead({
        owner, repo, branch: result.baseBranch,
      }),
      this.readGateway.listCheckRuns({
        owner, repo, headSha: result.mergeCommitSha,
      }),
      this.readGateway.listWorkflowRuns({
        owner, repo, headSha: result.mergeCommitSha,
      }),
    ]);
    const [confirmedPullRequest, confirmedBranchHead] = await Promise.all([
      this.readGateway.readPullRequest({ owner, repo, number: merge.prNumber }),
      this.readGateway.readBranchHead({ owner, repo, branch: result.baseBranch }),
    ]);
    validateRemoteBinding({
      snapshot,
      merge,
      repository,
      pullRequest,
      branchHead,
      confirmedPullRequest,
      confirmedBranchHead,
    });
    const preMergeStatus = snapshot.githubObservations.find(
      ({ eventId }) => eventId === merge.preMergeStatusEventId,
    );
    if (!preMergeStatus) {
      throw new PostMergeAssuranceError(
        "Completed merge lacks its bound pre-merge status evidence",
      );
    }
    const requiredChecks = summarizeChecks(
      checks,
      effectiveRequiredChecks(branchProtection, preMergeStatus.requiredChecks.names),
    );
    if (requiredChecks.satisfied !== true) {
      throw new PostMergeChecksPendingError(
        `Merge-commit checks are not satisfied: missing=[${requiredChecks.missing.join(",")}] unsuccessful=[${requiredChecks.unsuccessful.join(",")}]`,
      );
    }
    return {
      schemaVersion: 1,
      operationId,
      observationId: this.idFactory(),
      mergeOperationId: merge.operationId,
      repository: merge.repository,
      prNumber: merge.prNumber,
      approvedHeadSha: merge.headSha,
      mergeCommitSha: result.mergeCommitSha,
      baseBranch: result.baseBranch,
      baseHeadSha: confirmedBranchHead.sha,
      observedAt: this.clock().toISOString(),
      repositoryObservation: repository,
      pullRequest: confirmedPullRequest,
      branchHead: confirmedBranchHead,
      branchProtection,
      checks,
      workflowRuns,
      requiredChecks,
    };
  }
}

export class PostMergeAssuranceError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PostMergeAssuranceError";
  }
}

export class PostMergeChecksPendingError extends PostMergeAssuranceError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PostMergeChecksPendingError";
  }
}

function completedMerge(snapshot) {
  const merge = [...(snapshot.githubMerges || [])].reverse().find(
    ({ status }) => status === "completed",
  );
  if (!merge || snapshot.state !== "landed" && snapshot.state !== "cleaning" &&
    snapshot.state !== "complete") {
    throw new PostMergeAssuranceError("Task has no completed landed merge");
  }
  return merge;
}

function validateRemoteBinding({
  snapshot,
  merge,
  repository,
  pullRequest,
  branchHead,
  confirmedPullRequest,
  confirmedBranchHead,
}) {
  const result = merge.result;
  const pulls = [pullRequest, confirmedPullRequest];
  if (repository.nameWithOwner.toLowerCase() !== snapshot.repo.toLowerCase() ||
    repository.defaultBranch !== result.baseBranch ||
    pulls.some((pull) => pull.number !== merge.prNumber || pull.merged !== true ||
      pull.head.sha !== merge.headSha || pull.mergeCommitSha !== result.mergeCommitSha ||
      pull.base.branch !== result.baseBranch) ||
    branchHead.sha !== result.mergeCommitSha ||
    confirmedBranchHead.sha !== result.mergeCommitSha) {
    throw new PostMergeAssuranceError(
      "GitHub no longer proves the approved head at the confirmed merge commit on the default branch",
    );
  }
}

function effectiveRequiredChecks(branchProtection, preMergeNames) {
  const policy = branchProtection.requiredStatusChecks;
  return [...new Set([
    ...preMergeNames,
    ...(policy?.contexts || []),
    ...(policy?.checks || []).map(({ context }) => context),
  ])];
}

function summarizeChecks(checks, requiredNames) {
  const byName = new Map();
  for (const check of checks) {
    if (byName.has(check.name)) {
      throw new PostMergeAssuranceError(`Ambiguous merge-commit check name: ${check.name}`);
    }
    byName.set(check.name, check);
  }
  const missing = requiredNames.filter((name) => !byName.has(name));
  const unsuccessful = requiredNames.filter((name) => {
    const check = byName.get(name);
    return check && (check.status !== "completed" || check.conclusion !== "success");
  });
  return {
    names: [...requiredNames],
    missing,
    unsuccessful,
    satisfied: missing.length === 0 && unsuccessful.length === 0,
  };
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
