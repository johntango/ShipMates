export class FirstmateDeliveryWorkflow {
  constructor({ store, pushWorkflow, draftWorkflow } = {}) {
    if (!store || !pushWorkflow || !draftWorkflow) {
      throw new TypeError(
        "FirstmateDeliveryWorkflow requires store, pushWorkflow, and draftWorkflow",
      );
    }
    this.store = store;
    this.pushWorkflow = pushWorkflow;
    this.draftWorkflow = draftWorkflow;
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
  let stage;
  if (push?.status === "requested") {
    stage = "push_reconciliation_required";
  } else if (!push || push.status === "failed") {
    const approval = latestUnusedPushApproval(snapshot, target);
    stage = approval ? "ready_to_push" : "awaiting_push_approval";
  } else if (draft?.status === "requested") {
    stage = "draft_pr_reconciliation_required";
  } else if (draft?.status === "completed") {
    stage = observation === null
      ? "awaiting_ci_observation"
      : observation.requiredChecks.satisfied
        ? "ci_passed"
        : "ci_pending_or_failed";
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
  if (snapshot.state !== "validating" || snapshot.worktree?.status !== "leased" ||
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
