export class HerdrProjection {
  constructor({ store } = {}) {
    if (!store || typeof store.getSnapshot !== "function") {
      throw new TypeError("HerdrProjection requires a store with getSnapshot()");
    }
    this.store = store;
  }

  async read({ taskId }) {
    return projectHerdrSnapshot(await this.store.getSnapshot(taskId));
  }
}

export function projectHerdrSnapshot(snapshot) {
  requireSnapshot(snapshot);
  const latestValidation = snapshot.validationRuns.at(-1) || null;
  const latestGitHub = snapshot.githubObservations.at(-1) || null;
  const latestRecovery = snapshot.recoveryAudits.at(-1) || null;
  const recoveryCurrent = latestRecovery?.eventId === snapshot.lastEventId;
  const syntheses = (snapshot.scoutSyntheses || []).map(projectScoutSynthesis);
  const followUps = (snapshot.scoutFollowUps || []).map(projectScoutFollowUp);
  const workers = snapshot.workers.map(projectWorker);
  const draftPullRequests = (snapshot.githubDraftPullRequests || []).map(
    projectDraftPullRequest,
  );
  const commits = (snapshot.gitCommits || []).map(projectGitCommit);
  const pushes = (snapshot.gitPushes || []).map(projectGitPush);
  const merges = (snapshot.githubMerges || []).map(projectGitHubMerge);
  const postMerge = (snapshot.postMergeAssurances || []).map(
    (assurance) => projectPostMergeAssurance(assurance, snapshot),
  );
  const branchCleanups = (snapshot.branchCleanups || []).map(
    projectBranchCleanup,
  );
  const attention = deriveAttention({
    snapshot,
    workers,
    commits,
    pushes,
    merges,
    postMerge,
    branchCleanups,
    draftPullRequests,
    latestValidation,
    latestGitHub,
    latestRecovery,
    recoveryCurrent,
    syntheses,
    followUps,
  });
  return {
    schemaVersion: 1,
    source: {
      kind: "shipmates-task-ledger",
      taskId: snapshot.id,
      eventsCount: snapshot.eventsCount,
      lastEventId: snapshot.lastEventId,
      lastEventAt: snapshot.lastEventAt,
    },
    task: {
      id: snapshot.id,
      kind: snapshot.kind,
      repository: snapshot.repo,
      state: snapshot.state,
      displayState: displayState(snapshot.state),
      baseSha: snapshot.baseSha,
    },
    worktree: projectWorktree(snapshot.worktree),
    workers,
    commits,
    pushes,
    merges,
    postMerge,
    branchCleanups,
    validation: projectValidation(latestValidation),
    github: {
      draftPullRequests,
      ci: projectCi(latestGitHub),
      postMerge,
    },
    approvals: {
      merge: [
        ...(snapshot.approvals || []),
        ...(snapshot.githubMergeApprovals || []),
      ].map((approval) => ({
        approvalId: approval.approvalId || null,
        eventId: approval.eventId,
        actor: approval.actor,
        repository: approval.repository || approval.repo,
        prNumber: approval.prNumber,
        headSha: approval.headSha,
        decision: approval.decision,
        consumedBy: approval.consumedBy ?? null,
      })),
      draftPullRequest: (snapshot.githubDraftPrApprovals || []).map(
        (approval) => ({
          approvalId: approval.approvalId,
          actor: approval.actor,
          repository: approval.repository,
          headBranch: approval.headBranch,
          headSha: approval.headSha,
          decision: approval.decision,
          consumedBy: approval.consumedBy,
        }),
      ),
      push: (snapshot.gitPushApprovals || []).map((approval) => ({
        approvalId: approval.approvalId,
        actor: approval.actor,
        repository: approval.repository,
        branch: approval.branch,
        headSha: approval.headSha,
        decision: approval.decision,
        consumedBy: approval.consumedBy,
      })),
      branchCleanup: (snapshot.branchCleanupApprovals || []).map((approval) => ({
        approvalId: approval.approvalId,
        actor: approval.actor,
        repository: approval.repository,
        branch: approval.branch,
        headSha: approval.headSha,
        decision: approval.decision,
        consumedBy: approval.consumedBy,
      })),
    },
    recovery: latestRecovery === null ? null : {
      auditId: latestRecovery.auditId,
      safeToResume: latestRecovery.safeToResume,
      recommendedActions: [...latestRecovery.recommendedActions],
      auditedEventId: latestRecovery.auditedEventId,
      current: recoveryCurrent,
    },
    syntheses,
    followUps,
    attention,
    summary: {
      workers: workers.length,
      activeWorkers: workers.filter(({ status }) =>
        new Set(["dispatch_requested", "started"]).has(status)).length,
      pendingReplies: workers.reduce(
        (count, worker) => count + worker.replies.filter(
          ({ status }) => status === "requested",
        ).length,
        0,
      ),
      draftPullRequests: draftPullRequests.length,
      pendingDraftPullRequests: draftPullRequests.filter(
        ({ status }) => status === "requested",
      ).length,
      pushes: pushes.length,
      pendingPushes: pushes.filter(({ status }) => status === "requested").length,
      merges: merges.length,
      pendingMerges: merges.filter(({ status }) => status === "requested").length,
      postMergeAssurances: postMerge.length,
      branchCleanups: branchCleanups.length,
      pendingBranchCleanups: branchCleanups.filter(
        ({ status }) => status === "requested",
      ).length,
      requiredChecksSatisfied: latestGitHub?.requiredChecks?.satisfied ?? null,
      attentionItems: attention.length,
      syntheses: syntheses.length,
      followUps: followUps.length,
      pendingFollowUps: followUps.filter(({ status }) => status === "selected").length,
    },
  };
}

export function renderHerdrView(projection) {
  if (!projection || projection.schemaVersion !== 1) {
    throw new TypeError("Herdr view requires a schemaVersion 1 projection");
  }
  const lines = [
    `${safe(projection.task.id)}  ${safe(projection.task.state)}  [${safe(projection.task.displayState)}]`,
    `${safe(projection.task.repository)}  events=${projection.source.eventsCount}  last=${safe(projection.source.lastEventId)}`,
    `worktree: ${projection.worktree ? `${safe(projection.worktree.status)} ${safe(projection.worktree.headSha)}` : "none"}`,
    `workers: ${projection.summary.workers} (${projection.summary.activeWorkers} active, ${projection.summary.pendingReplies} replies pending)`,
    `pushes: ${projection.summary.pushes} (${projection.summary.pendingPushes} pending)`,
    `merges: ${projection.summary.merges} (${projection.summary.pendingMerges} pending)`,
    `post-merge assurances: ${projection.summary.postMergeAssurances}`,
    `branch cleanups: ${projection.summary.branchCleanups} (${projection.summary.pendingBranchCleanups} pending)`,
    `draft PRs: ${projection.summary.draftPullRequests} (${projection.summary.pendingDraftPullRequests} pending)`,
    `CI required checks: ${formatNullableBoolean(projection.summary.requiredChecksSatisfied)}`,
    `recovery: ${projection.recovery ? (!projection.recovery.current ? "stale" : projection.recovery.safeToResume ? "safe" : "required") : "not audited"}`,
    `scout syntheses: ${projection.summary.syntheses}`,
    `scout follow-ups: ${projection.summary.followUps} (${projection.summary.pendingFollowUps} pending)`,
  ];
  if (projection.workers.length > 0) {
    lines.push("", "Workers");
    for (const worker of projection.workers) {
      lines.push(
        `- ${safe(worker.id)}: ${safe(worker.status)} via ${safe(worker.backend)}; pane=${safe(worker.paneId || "none")}; thread=${safe(worker.threadId || "none")}`,
      );
      for (const reply of worker.replies) {
        lines.push(`  - reply ${safe(reply.id)}: ${safe(reply.status)}`);
      }
    }
  }
  if (projection.github.draftPullRequests.length > 0) {
    lines.push("", "Draft pull requests");
    for (const operation of projection.github.draftPullRequests) {
      lines.push(
        `- ${safe(operation.operationId)}: ${safe(operation.status)}; PR=${operation.pullRequest?.number ?? "none"}; head=${safe(operation.headSha)}`,
      );
    }
  }
  if (projection.pushes.length > 0) {
    lines.push("", "Git pushes");
    for (const operation of projection.pushes) {
      lines.push(
        `- ${safe(operation.operationId)}: ${safe(operation.status)}; branch=${safe(operation.branch)}; head=${safe(operation.headSha)}`,
      );
    }
  }
  if (projection.merges.length > 0) {
    lines.push("", "GitHub merges");
    for (const operation of projection.merges) {
      lines.push(
        `- ${safe(operation.operationId)}: ${safe(operation.status)}; PR=${operation.prNumber}; head=${safe(operation.headSha)}; merge=${safe(operation.mergeCommitSha || "none")}`,
      );
    }
  }
  if (projection.postMerge.length > 0) {
    lines.push("", "Post-merge assurance");
    for (const assurance of projection.postMerge) {
      lines.push(
        `- ${safe(assurance.operationId)}: checks=${assurance.requiredChecksSatisfied ? "passing" : "not passing"}; merge=${safe(assurance.mergeCommitSha)}; tree=${safe(assurance.treeProofEventId || "pending")}; lease=${safe(assurance.leaseStatus)}`,
      );
    }
  }
  if (projection.branchCleanups.length > 0) {
    lines.push("", "Remote branch cleanup");
    for (const cleanup of projection.branchCleanups) {
      lines.push(
        `- ${safe(cleanup.operationId)}: ${safe(cleanup.status)}; branch=${safe(cleanup.branch)}; head=${safe(cleanup.headSha)}`,
      );
    }
  }
  if (projection.syntheses.length > 0) {
    lines.push("", "Scout syntheses");
    for (const synthesis of projection.syntheses) {
      lines.push(
        `- ${safe(synthesis.id)}: ${safe(synthesis.outcome)}; agreements=${synthesis.counts.agreements}; disagreements=${synthesis.counts.disagreements}; unsupported=${synthesis.counts.unsupportedClaims}; follow-ups=${synthesis.counts.followUpChecks}`,
      );
    }
  }
  if (projection.followUps.length > 0) {
    lines.push("", "Scout follow-ups");
    for (const followUp of projection.followUps) {
      lines.push(
        `- ${safe(followUp.id)}: ${safe(followUp.status)}; synthesis=${safe(followUp.synthesisId)}; check=${followUp.checkIndex}; action=${safe(followUp.action)}; worker=${safe(followUp.workerId)}; outcome=${safe(followUp.outcome || "pending")}`,
      );
    }
  }
  if (projection.attention.length > 0) {
    lines.push("", "Attention");
    for (const item of projection.attention) {
      lines.push(`- ${safe(item.code)}: ${safe(item.message)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function projectWorker(worker) {
  return {
    id: worker.id,
    backend: worker.backend,
    mode: worker.mode,
    sandbox: worker.sandbox,
    paneId: worker.paneId ?? null,
    status: worker.status,
    threadId: worker.threadId,
    reportStatus: worker.report?.status ?? null,
    verificationKind: worker.verification?.kind ??
      (worker.verification?.noMutation === true ? "no-mutation" : null),
    noMutation: worker.verification?.noMutation ?? null,
    changedPaths: worker.verification?.changedPaths?.length ?? 0,
    failure: worker.failure,
    replies: (worker.replies || []).map((reply) => ({
      id: reply.id,
      status: reply.status,
      threadId: reply.threadId,
      reportStatus: reply.report?.status ?? null,
      noMutation: reply.verification?.noMutation ?? null,
      failure: reply.failure,
    })),
  };
}

function projectScoutSynthesis(synthesis) {
  return {
    id: synthesis.synthesisId,
    eventId: synthesis.eventId,
    workerIds: [...synthesis.workerIds],
    leaseHeadSha: synthesis.leaseHeadSha,
    artifactSha256: synthesis.artifactSha256,
    outcome: synthesis.outcome,
    counts: { ...synthesis.counts },
  };
}

function projectScoutFollowUp(followUp) {
  return {
    id: followUp.followUpId,
    status: followUp.status,
    synthesisId: followUp.synthesisId,
    synthesisEventId: followUp.synthesisEventId,
    synthesisArtifactSha256: followUp.synthesisArtifactSha256,
    leaseHeadSha: followUp.leaseHeadSha,
    checkIndex: followUp.checkIndex,
    checkSha256: followUp.checkSha256,
    action: followUp.action,
    workerId: followUp.workerId,
    replyId: followUp.replyId,
    selectionEventId: followUp.selectionEventId,
    selectedBy: followUp.selectedBy,
    outcome: followUp.outcome,
    counts: followUp.counts === null ? null : { ...followUp.counts },
    replyEventId: followUp.replyEventId,
    resolvedEventId: followUp.resolvedEventId,
  };
}

function projectWorktree(worktree) {
  if (worktree === null) return null;
  return {
    status: worktree.status,
    worktreePath: worktree.worktreePath ?? null,
    headSha: worktree.headSha ?? worktree.baseSha ?? null,
    branch: worktree.branch ?? null,
    branchPreparation: worktree.branchPreparation === null ||
      worktree.branchPreparation === undefined ? null : {
        branch: worktree.branchPreparation.branch,
        status: worktree.branchPreparation.status,
        expectedHeadSha: worktree.branchPreparation.expectedHeadSha,
        expectedChangedPaths: worktree.branchPreparation.expectedChangedPaths.length,
        requestEventId: worktree.branchPreparation.requestEventId,
        completedEventId: worktree.branchPreparation.completedEventId || null,
      },
    leaseHolder: worktree.leaseHolder ?? null,
  };
}

function projectValidation(validation) {
  if (validation === null) return null;
  return {
    runId: validation.runId,
    passed: validation.passed,
    outcome: validation.outcome,
    gate: validation.gate || null,
    headSha: validation.finalHeadSha,
    completedAt: validation.completedAt,
  };
}

function projectGitCommit(operation) {
  return {
    operationId: operation.operationId,
    status: operation.status,
    baseHeadSha: operation.baseHeadSha,
    branch: operation.branch,
    changedPaths: operation.changedPaths.length,
    headSha: operation.result?.headSha || null,
    treeSha: operation.result?.treeSha || null,
    requestEventId: operation.requestEventId,
    completedEventId: operation.completedEventId || null,
  };
}

function projectGitPush(operation) {
  return {
    operationId: operation.operationId,
    approvalId: operation.approvalId,
    status: operation.status,
    repository: operation.repository,
    branch: operation.branch,
    headSha: operation.headSha,
    remoteHeadSha: operation.result?.remoteHeadSha || null,
    evidenceKind: operation.result?.evidenceKind || null,
    failure: operation.failure,
    requestEventId: operation.requestEventId,
    completedEventId: operation.completedEventId || null,
  };
}

function projectGitHubMerge(operation) {
  return {
    operationId: operation.operationId,
    approvalId: operation.approvalId,
    status: operation.status,
    repository: operation.repository,
    prNumber: operation.prNumber,
    headSha: operation.headSha,
    mergeMethod: operation.mergeMethod,
    mergeCommitSha: operation.result?.mergeCommitSha || null,
    failure: operation.failure,
    requestEventId: operation.requestEventId,
    completedEventId: operation.completedEventId || null,
  };
}

function projectPostMergeAssurance(assurance, snapshot) {
  return {
    operationId: assurance.operationId,
    mergeOperationId: assurance.mergeOperationId,
    mergeCommitSha: assurance.mergeCommitSha,
    observedAt: assurance.observedAt,
    requiredChecksSatisfied: assurance.requiredChecks.satisfied,
    requiredChecks: [...assurance.requiredChecks.names],
    treeProofEventId: snapshot.worktree?.proof?.kind === "exact-tree-landing"
      ? snapshot.worktree.proof.eventId
      : null,
    leaseStatus: snapshot.worktree?.status || null,
  };
}

function projectBranchCleanup(operation) {
  return {
    operationId: operation.operationId,
    approvalId: operation.approvalId,
    status: operation.status,
    repository: operation.repository,
    branch: operation.branch,
    headSha: operation.headSha,
    failure: operation.failure,
    requestEventId: operation.requestEventId,
    completedEventId: operation.completedEventId || null,
  };
}

function projectDraftPullRequest(operation) {
  return {
    operationId: operation.operationId,
    approvalId: operation.approvalId,
    status: operation.status,
    repository: operation.repository,
    headBranch: operation.headBranch,
    headSha: operation.headSha,
    baseBranch: operation.baseBranch,
    failure: operation.failure,
    pullRequest: operation.pullRequest === null ? null : {
      number: operation.pullRequest.number,
      url: operation.pullRequest.url,
      state: operation.pullRequest.state,
      draft: operation.pullRequest.draft,
      headSha: operation.pullRequest.head.sha,
    },
  };
}

function projectCi(observation) {
  if (observation === null) return null;
  return {
    prNumber: observation.pullRequest.number,
    headSha: observation.pullRequest.head.sha,
    observedAt: observation.observedAt,
    requiredChecks: {
      names: [...observation.requiredChecks.names],
      missing: [...observation.requiredChecks.missing],
      unsuccessful: [...observation.requiredChecks.unsuccessful],
      satisfied: observation.requiredChecks.satisfied,
    },
    checks: observation.checks.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    })),
  };
}

function deriveAttention({
  snapshot, workers, commits, pushes, merges, postMerge, branchCleanups,
  draftPullRequests,
  latestValidation, latestGitHub,
  latestRecovery, recoveryCurrent, syntheses, followUps,
}) {
  const result = [];
  if (new Set(["lease_requested", "return_requested"]).has(snapshot.worktree?.status)) {
    result.push(item("worktree_reconciliation", `Worktree is ${snapshot.worktree.status}`));
  }
  if (snapshot.worktree?.branchPreparation?.status === "requested") {
    result.push(item(
      "task_branch_reconciliation",
      `Task branch ${snapshot.worktree.branchPreparation.branch} needs reconciliation`,
    ));
  } else if (snapshot.kind === "firstmate-intake" &&
    snapshot.worktree?.status === "leased" && snapshot.worktree.branch === null) {
    result.push(item(
      "task_branch_preparation",
      "Active local-write lease needs a deterministic task branch",
    ));
  }
  for (const worker of workers) {
    if (new Set(["dispatch_requested", "started"]).has(worker.status)) {
      result.push(item("worker_reconciliation", `Worker ${worker.id} is ${worker.status}`));
    }
    for (const reply of worker.replies) {
      if (reply.status === "requested") {
        result.push(item(
          "reply_reconciliation",
          `Worker ${worker.id} reply ${reply.id} needs reconciliation`,
        ));
      }
    }
  }
  for (const operation of draftPullRequests) {
    if (operation.status === "requested") {
      result.push(item(
        "draft_pr_reconciliation",
        `Draft PR operation ${operation.operationId} needs reconciliation`,
      ));
    }
  }
  for (const operation of commits) {
    if (operation.status === "requested") {
      result.push(item(
        "git_commit_reconciliation",
        `Git commit operation ${operation.operationId} needs reconciliation`,
      ));
    }
  }
  for (const operation of pushes) {
    if (operation.status === "requested") {
      result.push(item(
        "git_push_reconciliation",
        `Git push operation ${operation.operationId} needs remote reconciliation`,
      ));
    } else if (operation.status === "failed") {
      result.push(item(
        "git_push_approval",
        `Git push operation ${operation.operationId} needs a new human approval`,
      ));
    }
  }
  for (const operation of merges) {
    if (operation.status === "requested") {
      result.push(item(
        "merge_reconciliation",
        `GitHub merge ${operation.operationId} needs remote reconciliation`,
      ));
    } else if (operation.status === "failed") {
      result.push(item(
        "merge_approval",
        `GitHub merge ${operation.operationId} needs a new human approval`,
      ));
    }
  }
  for (const operation of branchCleanups) {
    if (operation.status === "requested") {
      result.push(item(
        "branch_cleanup_reconciliation",
        `Remote branch cleanup ${operation.operationId} needs reconciliation`,
      ));
    } else if (operation.status === "failed") {
      result.push(item(
        "branch_cleanup_approval",
        `Remote branch cleanup ${operation.operationId} needs a new human approval`,
      ));
    }
  }
  if (latestValidation?.passed === true && pushes.length === 0) {
    result.push(item(
      "git_push_approval",
      "Validated task commit awaits exact-head push approval",
    ));
  }
  const completedPush = [...pushes].reverse().find(({ status }) => status === "completed");
  if (latestValidation?.passed === true && completedPush && draftPullRequests.length === 0) {
    result.push(item(
      "draft_pr_approval",
      "Pushed exact task head awaits separate draft-PR approval",
    ));
  }
  const completedDraft = [...draftPullRequests].reverse().find(
    ({ status }) => status === "completed",
  );
  if (completedDraft && (!latestGitHub ||
    latestGitHub.pullRequest.number !== completedDraft.pullRequest?.number ||
    latestGitHub.pullRequest.head.sha !== completedDraft.headSha)) {
    result.push(item(
      "ci_observation_required",
      "Completed draft PR awaits exact-head CI observation",
    ));
  }
  if ((snapshot.validationRequests || []).some(({ status }) => status === "requested")) {
    result.push(item(
      "validation_reconciliation",
      "Pinned local validation needs manual reconciliation",
    ));
  }
  if (latestValidation?.gate?.status === "awaiting_approval") {
    result.push(item(
      "validation_approval_required",
      `Local validation awaits human approval at ${latestValidation.gate.step}`,
    ));
  } else if (latestValidation && latestValidation.passed !== true) {
    result.push(item("validation_not_passing", "Latest local validation is not passing"));
  }
  if (latestGitHub && latestGitHub.requiredChecks.satisfied !== true) {
    result.push(item("ci_not_satisfied", "Required GitHub checks are not satisfied"));
  }
  const exactCompletedDraft = [...draftPullRequests].reverse().find(
    ({ status }) => status === "completed",
  );
  if (exactCompletedDraft && latestGitHub?.requiredChecks.satisfied === true &&
    latestGitHub.pullRequest.head.sha === exactCompletedDraft.headSha &&
    latestGitHub.pullRequest.draft === false && merges.length === 0) {
    result.push(item("merge_approval", "Exact-head PR awaits separate human merge approval"));
  }
  if (merges.some(({ status }) => status === "completed") && postMerge.length === 0) {
    result.push(item(
      "post_merge_verification",
      "Landed merge awaits post-merge CI and exact-tree landing proof",
    ));
  } else if (postMerge.length > 0 && snapshot.worktree?.proof?.kind !==
      "exact-tree-landing") {
    result.push(item(
      "exact_tree_verification",
      "Passing merge-commit CI awaits exact-tree landed-work proof",
    ));
  } else if (postMerge.length > 0 && snapshot.worktree?.status === "leased") {
    result.push(item(
      "treehouse_return",
      "Verified landed work awaits Treehouse lease return",
    ));
  }
  if (snapshot.state === "complete" && snapshot.worktree?.status === "returned" &&
    branchCleanups.length === 0) {
    const approved = (snapshot.branchCleanupApprovals || []).some(
      ({ decision, consumedBy }) => decision === "approved" && consumedBy === null,
    );
    result.push(item(
      approved ? "branch_cleanup_execution" : "branch_cleanup_approval",
      approved
        ? "Approved exact remote branch cleanup awaits execution"
        : "Completed task awaits separate remote branch cleanup approval",
    ));
  }
  if (snapshot.state === "awaiting_human") {
    result.push(item("human_decision", "Task is awaiting a human decision"));
  }
  for (const synthesis of syntheses) {
    if (synthesis.outcome === "review_required") {
      result.push(item(
        "scout_synthesis_review",
        `Scout synthesis ${synthesis.id} has disagreements or uncorroborated claims`,
      ));
    }
  }
  for (const followUp of followUps) {
    if (followUp.status === "selected") {
      result.push(item(
        "scout_follow_up_pending",
        `Scout follow-up ${followUp.id} needs execution or reconciliation`,
      ));
    } else if (followUp.outcome !== "completed") {
      result.push(item(
        "scout_follow_up_unresolved",
        `Scout follow-up ${followUp.id} ended ${followUp.outcome}`,
      ));
    }
  }
  if (latestRecovery && !recoveryCurrent) {
    result.push(item(
      "recovery_audit_stale",
      "Task evidence changed after the latest recovery audit",
    ));
  } else if (latestRecovery && latestRecovery.safeToResume !== true) {
    result.push(item(
      "recovery_required",
      `Recovery actions: ${latestRecovery.recommendedActions.join(", ") || "manual inspection"}`,
    ));
  }
  return result;
}

function item(code, message) {
  return { code, message };
}

function displayState(state) {
  if (state === "complete") return "done";
  if (new Set(["blocked", "failed", "cancelled", "recovery_required"]).has(state)) {
    return "blocked";
  }
  if (state === "awaiting_human") return "idle";
  if (new Set(["proposed", "clarified", "approved_for_dispatch"]).has(state)) {
    return "idle";
  }
  return "working";
}

function formatNullableBoolean(value) {
  if (value === null) return "not observed";
  return value ? "satisfied" : "not satisfied";
}

function safe(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

function requireSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Herdr source snapshot must be an object");
  }
  for (const field of [
    "id", "kind", "repo", "state", "baseSha", "eventsCount", "lastEventId",
    "lastEventAt", "workers", "validationRuns", "githubObservations",
    "recoveryAudits", "approvals",
  ]) {
    if (snapshot[field] === undefined || snapshot[field] === null) {
      throw new TypeError(`Herdr source snapshot lacks ${field}`);
    }
  }
  for (const field of [
    "workers", "validationRuns", "githubObservations", "recoveryAudits",
    "approvals",
  ]) {
    if (!Array.isArray(snapshot[field])) {
      throw new TypeError(`Herdr source snapshot ${field} must be an array`);
    }
  }
}
