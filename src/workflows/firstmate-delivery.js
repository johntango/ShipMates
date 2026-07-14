export class FirstmateDeliveryWorkflow {
  constructor({
    store,
    pushWorkflow,
    draftWorkflow,
    mergeWorkflow = null,
    postMergeWorkflow = null,
  } = {}) {
    if (!store || !pushWorkflow || !draftWorkflow) {
      throw new TypeError(
        "FirstmateDeliveryWorkflow requires store, pushWorkflow, and draftWorkflow",
      );
    }
    this.store = store;
    this.pushWorkflow = pushWorkflow;
    this.draftWorkflow = draftWorkflow;
    this.mergeWorkflow = mergeWorkflow;
    this.postMergeWorkflow = postMergeWorkflow;
  }

  async status({ taskId }) {
    return summarize(await this.store.getSnapshot(taskId));
  }

  async approvePush({ taskId, approvalId, humanActor }) {
    const target = validatedTarget(await this.store.getSnapshot(taskId));
    await this.pushWorkflow.approve({
      taskId,
      approvalId,
      humanActor,
      repository: target.repository,
      branch: target.branch,
      headSha: target.headSha,
    });
    return this.status({ taskId });
  }

  async push({ taskId, operationId, approvalId }) {
    const target = validatedTarget(await this.store.getSnapshot(taskId));
    await this.pushWorkflow.push({
      taskId,
      operationId,
      approvalId,
      repository: target.repository,
      branch: target.branch,
      headSha: target.headSha,
    });
    return this.status({ taskId });
  }

  async reconcilePush({ taskId, operationId }) {
    await this.pushWorkflow.reconcile({ taskId, operationId });
    return this.status({ taskId });
  }

  async approveDraftPullRequest({
    taskId, approvalId, humanActor, baseBranch, title, body,
  }) {
    const target = pushedTarget(await this.store.getSnapshot(taskId));
    await this.draftWorkflow.approve({
      taskId,
      approvalId,
      humanActor,
      repository: target.repository,
      headBranch: target.branch,
      headSha: target.headSha,
      baseBranch,
      title,
      body,
    });
    return this.status({ taskId });
  }

  async createDraftPullRequestAndObserveCi({
    taskId, operationId, approvalId, baseBranch, title, body, requiredChecks = [],
  }) {
    const target = pushedTarget(await this.store.getSnapshot(taskId));
    await this.draftWorkflow.create({
      taskId,
      operationId,
      approvalId,
      repository: target.repository,
      headBranch: target.branch,
      headSha: target.headSha,
      baseBranch,
      title,
      body,
    });
    await this.draftWorkflow.observeCi({ taskId, operationId, requiredChecks });
    return this.status({ taskId });
  }

  async reconcileDraftPullRequest({ taskId, operationId }) {
    await this.draftWorkflow.reconcile({ taskId, operationId });
    return this.status({ taskId });
  }

  async observeCi({ taskId, operationId, requiredChecks = [] }) {
    await this.draftWorkflow.observeCi({ taskId, operationId, requiredChecks });
    return this.status({ taskId });
  }

  async approveMerge({ taskId, approvalId, humanActor }) {
    this.#requireMergeWorkflow();
    const target = mergeTarget(await this.store.getSnapshot(taskId));
    await this.mergeWorkflow.approve({
      taskId,
      approvalId,
      humanActor,
      repository: target.repository,
      prNumber: target.prNumber,
      headSha: target.headSha,
      mergeMethod: "squash",
    });
    return this.status({ taskId });
  }

  async merge({ taskId, operationId, approvalId }) {
    this.#requireMergeWorkflow();
    await this.mergeWorkflow.merge({ taskId, operationId, approvalId });
    return this.status({ taskId });
  }

  async reconcileMerge({ taskId, operationId }) {
    this.#requireMergeWorkflow();
    await this.mergeWorkflow.reconcile({ taskId, operationId });
    return this.status({ taskId });
  }

  async completePostMerge({ taskId, operationId }) {
    this.#requirePostMergeWorkflow();
    await this.postMergeWorkflow.complete({ taskId, operationId });
    return this.status({ taskId });
  }

  async reconcileTreehouseReturn({ taskId }) {
    this.#requirePostMergeWorkflow();
    await this.postMergeWorkflow.reconcileReturn({ taskId });
    return this.status({ taskId });
  }

  #requireMergeWorkflow() {
    if (!this.mergeWorkflow) {
      throw new FirstmateDeliveryWorkflowError("Merge workflow is not configured");
    }
  }

  #requirePostMergeWorkflow() {
    if (!this.postMergeWorkflow) {
      throw new FirstmateDeliveryWorkflowError(
        "Post-merge assurance workflow is not configured",
      );
    }
  }
}

export class FirstmateDeliveryWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FirstmateDeliveryWorkflowError";
  }
}

function summarize(snapshot) {
  const target = validatedTarget(snapshot);
  const push = latestExactPush(snapshot, target);
  const draft = latestExactDraft(snapshot, target);
  const observation = draft?.status === "completed"
    ? latestExactObservation(snapshot, draft)
    : null;
  const merge = latestExactMerge(snapshot, draft);
  let stage;
  if (push?.status === "requested") {
    stage = "push_reconciliation_required";
  } else if (!push || push.status === "failed") {
    const approval = latestUnusedPushApproval(snapshot, target);
    stage = approval ? "ready_to_push" : "awaiting_push_approval";
  } else if (draft?.status === "requested") {
    stage = "draft_pr_reconciliation_required";
  } else if (draft?.status === "completed") {
    if (merge?.status === "requested") {
      stage = "merge_reconciliation_required";
    } else if (merge?.status === "completed") {
      if (snapshot.state === "complete" && snapshot.worktree?.status === "returned") {
        stage = "complete";
      } else if (snapshot.worktree?.status === "return_requested") {
        stage = "treehouse_return_reconciliation_required";
      } else if (snapshot.state === "cleaning") {
        stage = "ready_to_release_treehouse_lease";
      } else {
        stage = "awaiting_post_merge_assurance";
      }
    } else if (observation === null) {
      stage = "awaiting_ci_observation";
    } else if (observation.requiredChecks.satisfied !== true) {
      stage = "ci_pending_or_failed";
    } else if (observation.pullRequest.draft === true) {
      stage = "awaiting_pr_ready";
    } else {
      stage = latestUnusedMergeApproval(snapshot, draft)
        ? "ready_to_merge"
        : "awaiting_merge_approval";
    }
  } else {
    const approval = latestUnusedDraftApproval(snapshot, target);
    stage = approval ? "ready_to_create_draft_pr" : "awaiting_draft_pr_approval";
  }
  return {
    schemaVersion: 1,
    taskId: snapshot.id,
    stage,
    target,
    push: push === null ? null : {
      operationId: push.operationId,
      approvalId: push.approvalId,
      status: push.status,
      remoteHeadSha: push.result?.remoteHeadSha || null,
      failure: push.failure,
    },
    draftPullRequest: draft === null ? null : {
      operationId: draft.operationId,
      approvalId: draft.approvalId,
      status: draft.status,
      number: draft.pullRequest?.number || null,
      url: draft.pullRequest?.url || null,
      baseBranch: draft.baseBranch,
    },
    ci: observation === null ? null : {
      observedAt: observation.observedAt,
      headSha: observation.pullRequest.head.sha,
      requiredChecks: { ...observation.requiredChecks },
    },
    merge: merge === null ? null : {
      operationId: merge.operationId,
      approvalId: merge.approvalId,
      status: merge.status,
      mergeCommitSha: merge.result?.mergeCommitSha || null,
      failure: merge.failure,
    },
    postMerge: snapshot.postMergeAssurances?.at(-1) ? {
      operationId: snapshot.postMergeAssurances.at(-1).operationId,
      observedAt: snapshot.postMergeAssurances.at(-1).observedAt,
      mergeCommitSha: snapshot.postMergeAssurances.at(-1).mergeCommitSha,
      requiredChecks: { ...snapshot.postMergeAssurances.at(-1).requiredChecks },
      treeProofEventId: snapshot.worktree?.proof?.kind === "exact-tree-landing"
        ? snapshot.worktree.proof.eventId
        : null,
      leaseStatus: snapshot.worktree?.status || null,
    } : null,
    ledger: {
      state: snapshot.state,
      eventsCount: snapshot.eventsCount,
      lastEventId: snapshot.lastEventId,
    },
  };
}

function validatedTarget(snapshot) {
  const validation = snapshot.validationRuns?.at(-1);
  const commit = snapshot.gitCommits?.at(-1);
  if (!new Set([
    "validating", "ready_to_merge", "merging", "landed", "awaiting_human",
    "cleaning", "complete",
  ]).has(snapshot.state) ||
    !new Set(["leased", "return_requested", "returned"]).has(snapshot.worktree?.status) ||
    validation?.passed !== true ||
    validation.finalHeadSha !== snapshot.worktree.headSha ||
    commit?.status !== "completed" ||
    commit.result?.headSha !== snapshot.worktree.headSha) {
    throw new FirstmateDeliveryWorkflowError(
      "Delivery requires a controlled, passing validation on the active leased head",
    );
  }
  return {
    repository: snapshot.repo,
    branch: snapshot.worktree.branch,
    headSha: snapshot.worktree.headSha,
  };
}

function pushedTarget(snapshot) {
  const target = validatedTarget(snapshot);
  const push = latestExactPush(snapshot, target);
  if (push?.status !== "completed" || push.result?.remoteHeadSha !== target.headSha) {
    throw new FirstmateDeliveryWorkflowError(
      "Draft PR delivery requires a completed exact-head push",
    );
  }
  return target;
}

function latestExactPush(snapshot, target) {
  return [...(snapshot.gitPushes || [])].reverse().find((operation) =>
    operation.repository.toLowerCase() === target.repository.toLowerCase() &&
    operation.branch === target.branch && operation.headSha === target.headSha) || null;
}

function latestExactDraft(snapshot, target) {
  return [...(snapshot.githubDraftPullRequests || [])].reverse().find((operation) =>
    operation.repository.toLowerCase() === target.repository.toLowerCase() &&
    operation.headBranch === target.branch && operation.headSha === target.headSha) || null;
}

function latestExactObservation(snapshot, draft) {
  return [...(snapshot.githubObservations || [])].reverse().find((observation) =>
    observation.pullRequest.number === draft.pullRequest.number &&
    observation.pullRequest.head.sha === draft.headSha) || null;
}

function latestExactMerge(snapshot, draft) {
  if (!draft) return null;
  return [...(snapshot.githubMerges || [])].reverse().find((operation) =>
    operation.repository.toLowerCase() === draft.repository.toLowerCase() &&
    operation.prNumber === draft.pullRequest?.number &&
    operation.headSha === draft.headSha) || null;
}

function latestUnusedPushApproval(snapshot, target) {
  return [...(snapshot.gitPushApprovals || [])].reverse().find((approval) =>
    approval.consumedBy === null && approval.decision === "approved" &&
    approval.repository.toLowerCase() === target.repository.toLowerCase() &&
    approval.branch === target.branch && approval.headSha === target.headSha) || null;
}

function latestUnusedDraftApproval(snapshot, target) {
  return [...(snapshot.githubDraftPrApprovals || [])].reverse().find((approval) =>
    approval.consumedBy === null && approval.decision === "approved" &&
    approval.repository.toLowerCase() === target.repository.toLowerCase() &&
    approval.headBranch === target.branch && approval.headSha === target.headSha) || null;
}

function latestUnusedMergeApproval(snapshot, draft) {
  return [...(snapshot.githubMergeApprovals || [])].reverse().find((approval) =>
    approval.consumedBy === null && approval.decision === "approved" &&
    approval.repository.toLowerCase() === draft.repository.toLowerCase() &&
    approval.prNumber === draft.pullRequest.number && approval.headSha === draft.headSha) || null;
}

function mergeTarget(snapshot) {
  const target = pushedTarget(snapshot);
  const draft = latestExactDraft(snapshot, target);
  const observation = draft?.status === "completed"
    ? latestExactObservation(snapshot, draft)
    : null;
  if (!draft || !observation || observation.requiredChecks.satisfied !== true ||
    observation.pullRequest.draft !== false) {
    throw new FirstmateDeliveryWorkflowError(
      "Merge approval requires a non-draft pull request with passing exact-head CI",
    );
  }
  return {
    repository: target.repository,
    prNumber: draft.pullRequest.number,
    headSha: target.headSha,
  };
}
