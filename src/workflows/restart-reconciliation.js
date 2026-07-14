export class RestartReconciler {
  constructor({
    store,
    treehouseManager = null,
    githubGateway = null,
    actor = "firstmate",
    clock = () => new Date(),
  } = {}) {
    if (!store) throw new TypeError("RestartReconciler requires a task store");
    this.store = store;
    this.treehouseManager = treehouseManager;
    this.githubGateway = githubGateway;
    this.actor = actor;
    this.clock = clock;
  }

  async audit({ taskId, auditId }) {
    validateAuditId(auditId);
    const snapshot = await this.store.getSnapshot(taskId);
    const existing = snapshot.recoveryAudits.find(
      (candidate) => candidate.auditId === auditId,
    );
    if (existing) return snapshot;

    const checks = [
      ledgerCheck(snapshot),
      ...(await this.#worktreeChecks(snapshot)),
      workerCheck(snapshot),
      ...scoutFollowUpChecks(snapshot),
      commitCheck(snapshot),
      pushCheck(snapshot),
      validationCheck(snapshot),
      draftPullRequestCheck(snapshot),
      mergeCheck(snapshot),
      postMergeCheck(snapshot),
      ...(await this.#githubChecks(snapshot)),
    ];
    const recoveryChecks = checks.filter(
      ({ status }) => status === "recovery_required",
    );
    const report = {
      schemaVersion: 1,
      taskId,
      auditId,
      actor: this.actor,
      observedAt: this.clock().toISOString(),
      auditedEventId: snapshot.lastEventId,
      auditedEventsCount: snapshot.eventsCount,
      taskState: snapshot.state,
      checks,
      safeToResume: recoveryChecks.length === 0,
      recommendedActions: unique(
        recoveryChecks.flatMap(({ action }) => (action ? [action] : [])),
      ),
    };
    return this.store.recordRecoveryAudit({
      taskId,
      actor: this.actor,
      report,
      eventId: `${taskId}:recovery:${auditId}:v1`,
      at: report.observedAt,
    });
  }

  async #worktreeChecks(snapshot) {
    const worktree = snapshot.worktree;
    if (worktree === null) {
      return [check("worktree", "not_applicable", "Task has no worktree lifecycle")];
    }
    if (!this.treehouseManager) {
      return [recoveryCheck(
        "worktree",
        "Treehouse state cannot be inspected without a manager",
        "configure_treehouse_and_audit_again",
      )];
    }

    if (worktree.status === "lease_requested") {
      try {
        const entries = await this.treehouseManager.list({ repoPath: worktree.repoPath });
        const matches = entries.filter(({ leaseHolder }) => leaseHolder === snapshot.id);
        if (matches.length === 1) {
          return [recoveryCheck(
            "worktree",
            `Treehouse has an unrecorded lease at ${matches[0].worktreePath}`,
            "reconcile_treehouse_acquisition",
            { source: treehouseSource(worktree.repoPath), observed: matches[0] },
          )];
        }
        return [recoveryCheck(
          "worktree",
          `Uncertain lease request has ${matches.length} matching Treehouse holders`,
          "inspect_treehouse_lease_manually",
          { source: treehouseSource(worktree.repoPath) },
        )];
      } catch (cause) {
        return [toolFailureCheck("worktree", cause, "inspect_treehouse_lease_manually")];
      }
    }

    try {
      const entry = await this.treehouseManager.findWorktree({
        repoPath: worktree.repoPath,
        worktreePath: worktree.worktreePath,
      });
      if (worktree.status === "returned") {
        if (entry.state === "available" && entry.leaseHolder === null) {
          return [check("worktree", "pass", "Returned lease is available with no holder", {
            source: treehouseSource(worktree.repoPath),
            observed: entry,
          })];
        }
        return [recoveryCheck(
          "worktree",
          `Returned lease is state=${entry.state}, holder=${entry.leaseHolder || "none"}`,
          "inspect_treehouse_return_manually",
          { source: treehouseSource(worktree.repoPath), observed: entry },
        )];
      }
      if (worktree.status === "return_requested") {
        if (entry.state === "available" && entry.leaseHolder === null) {
          return [recoveryCheck(
            "worktree",
            "Treehouse return completed but its result is absent from the ledger",
            "reconcile_treehouse_return",
            { source: treehouseSource(worktree.repoPath), observed: entry },
          )];
        }
        return [recoveryCheck(
          "worktree",
          `Treehouse return is uncertain at state=${entry.state}, holder=${entry.leaseHolder || "none"}`,
          "inspect_treehouse_return_manually",
          { source: treehouseSource(worktree.repoPath), observed: entry },
        )];
      }
      if (worktree.status !== "leased") {
        return [recoveryCheck(
          "worktree",
          `Unsupported durable worktree status: ${worktree.status}`,
          "inspect_treehouse_lease_manually",
        )];
      }
      if (entry.state !== "leased" || entry.leaseHolder !== snapshot.id) {
        return [recoveryCheck(
          "worktree",
          `Expected lease holder ${snapshot.id}, found state=${entry.state}, holder=${entry.leaseHolder || "none"}`,
          "inspect_treehouse_lease_manually",
          { source: treehouseSource(worktree.repoPath), observed: entry },
        )];
      }
      const inspection = await this.treehouseManager.inspect({
        worktreePath: worktree.worktreePath,
      });
      if (inspection.headSha !== worktree.headSha) {
        return [recoveryCheck(
          "git-worktree",
          `Leased worktree expected ${worktree.headSha}, found ${inspection.headSha}`,
          "inspect_unlanded_worktree_manually",
          { source: gitSource(worktree.worktreePath), observed: inspection },
        )];
      }
      if (inspection.dirty) {
        const verifiedMutation = [...snapshot.workers].reverse().find((worker) =>
          worker.status === "reported" && worker.mode === "ship" &&
          worker.verification?.kind === "workspace-write" &&
          worker.verification.headSha === worktree.headSha &&
          worker.verification.dirty === true);
        if (!verifiedMutation || typeof this.treehouseManager.listChangedPaths !== "function") {
          return [recoveryCheck(
            "git-worktree",
            `Leased worktree is dirty without a comparable verified mutation`,
            "inspect_unlanded_worktree_manually",
            { source: gitSource(worktree.worktreePath), observed: inspection },
          )];
        }
        const changedPaths = await this.treehouseManager.listChangedPaths({
          worktreePath: worktree.worktreePath,
        });
        if (!sameArray(changedPaths, verifiedMutation.verification.changedPaths)) {
          return [recoveryCheck(
            "git-worktree",
            "Current changed paths differ from the verified mutating-worker report",
            "inspect_unlanded_worktree_manually",
            { source: gitSource(worktree.worktreePath), observed: inspection },
          )];
        }
        return [check(
          "git-worktree",
          "pass",
          `Verified uncommitted mutation from worker ${verifiedMutation.id}`,
          {
            source: gitSource(worktree.worktreePath),
            observed: { inspection, changedPaths },
          },
        )];
      }
      return [check("worktree", "pass", "Active lease holder, SHA, and cleanliness match", {
        source: treehouseSource(worktree.repoPath),
        observed: { entry, inspection },
      })];
    } catch (cause) {
      return [toolFailureCheck("worktree", cause, "inspect_treehouse_lease_manually")];
    }
  }

  async #githubChecks(snapshot) {
    const observations = latestPullRequestObservations(snapshot.githubObservations);
    if (observations.length === 0) {
      return [check("github", "not_applicable", "Task has no GitHub PR evidence")];
    }
    if (!this.githubGateway) {
      return [recoveryCheck(
        "github",
        "GitHub evidence cannot be refreshed without a read gateway",
        "configure_github_reader_and_audit_again",
      )];
    }
    const { owner, repo } = parseRepository(snapshot.repo);
    const checks = [];
    try {
      const repository = await this.githubGateway.readRepository({ owner, repo });
      if (repository.nameWithOwner.toLowerCase() !== snapshot.repo.toLowerCase()) {
        checks.push(recoveryCheck(
          "github-repository",
          `GitHub returned ${repository.nameWithOwner}, expected ${snapshot.repo}`,
          "inspect_github_target_manually",
          { source: repository.source },
        ));
        return checks;
      }
    } catch (cause) {
      return [toolFailureCheck("github-repository", cause, "inspect_github_target_manually")];
    }

    for (const recorded of observations) {
      try {
        const live = await this.githubGateway.readPullRequest({
          owner,
          repo,
          number: recorded.pullRequest.number,
        });
        if (live.head.sha !== recorded.pullRequest.head.sha) {
          checks.push(recoveryCheck(
            "github-pull-request",
            `PR #${live.number} moved from ${recorded.pullRequest.head.sha} to ${live.head.sha}`,
            "refresh_github_evidence_before_resuming",
            { source: live.source, observed: { number: live.number, headSha: live.head.sha } },
          ));
          continue;
        }
        const completedMerge = [...(snapshot.githubMerges || [])].reverse().find(
          (operation) => operation.status === "completed" &&
            operation.prNumber === live.number && operation.headSha === live.head.sha,
        );
        const expectedMergedState = completedMerge && live.state === "closed" &&
          live.merged === true &&
          live.mergeCommitSha === completedMerge.result.mergeCommitSha;
        if (live.state !== recorded.pullRequest.state && !expectedMergedState) {
          checks.push(recoveryCheck(
            "github-pull-request",
            `PR #${live.number} state changed from ${recorded.pullRequest.state} to ${live.state}`,
            "refresh_github_evidence_before_resuming",
            { source: live.source, observed: { number: live.number, state: live.state } },
          ));
          continue;
        }
        const liveChecks = await this.githubGateway.listCheckRuns({
          owner,
          repo,
          headSha: live.head.sha,
        });
        const byName = new Map(liveChecks.map((item) => [item.name, item]));
        const missing = recorded.requiredChecks.names.filter((name) => !byName.has(name));
        const unsuccessful = recorded.requiredChecks.names.filter((name) => {
          const item = byName.get(name);
          return item && (item.status !== "completed" || item.conclusion !== "success");
        });
        if (missing.length > 0 || unsuccessful.length > 0) {
          checks.push(recoveryCheck(
            "github-checks",
            `PR #${live.number} missing=[${missing.join(",")}] unsuccessful=[${unsuccessful.join(",")}]`,
            "refresh_github_evidence_before_resuming",
            { source: live.source, observed: { missing, unsuccessful } },
          ));
          continue;
        }
        checks.push(check(
          "github-pull-request",
          "pass",
          expectedMergedState
            ? `PR #${live.number} confirms the recorded exact-head merge`
            : `PR #${live.number} head, state, and required checks match`,
          {
            source: live.source,
            observed: {
              number: live.number,
              headSha: live.head.sha,
              state: live.state,
              requiredChecks: [...recorded.requiredChecks.names],
            },
          },
        ));
      } catch (cause) {
        checks.push(toolFailureCheck(
          "github-pull-request",
          cause,
          "inspect_github_target_manually",
        ));
      }
    }
    return checks;
  }
}

function ledgerCheck(snapshot) {
  return check("ledger", "pass", "Authoritative JSONL replay succeeded", {
    source: { kind: "task-ledger", taskId: snapshot.id },
    observed: {
      state: snapshot.state,
      eventsCount: snapshot.eventsCount,
      lastEventId: snapshot.lastEventId,
    },
  });
}

function workerCheck(snapshot) {
  const uncertain = snapshot.workers.filter(({ status }) =>
    new Set(["dispatch_requested", "started"]).has(status),
  );
  const uncertainReplies = snapshot.workers.flatMap((worker) =>
    (worker.replies || [])
      .filter(({ status }) => status === "requested")
      .map((reply) => ({
        workerId: worker.id,
        replyId: reply.id,
        status: reply.status,
        threadId: reply.threadId,
      })),
  );
  if (uncertain.length === 0 && uncertainReplies.length === 0) {
    return check(
      "workers",
      snapshot.workers.length === 0 ? "not_applicable" : "pass",
      snapshot.workers.length === 0
        ? "Task has no workers"
        : "Every worker has a durable terminal report or failure",
      { observed: snapshot.workers.map(({ id, status, threadId, paneId }) => ({
        id, status, threadId, paneId: paneId ?? null,
      })) },
    );
  }
  if (uncertain.length === 0) {
    return recoveryCheck(
      "workers",
      `Worker replies need artifact reconciliation: ${uncertainReplies.map(({ workerId, replyId }) => `${workerId}:${replyId}`).join(", ")}`,
      "reconcile_worker_replies",
      { observed: uncertainReplies },
    );
  }
  return recoveryCheck(
    "workers",
    `Workers need artifact reconciliation: ${uncertain.map(({ id, status }) => `${id}:${status}`).join(", ")}`,
    "reconcile_worker_artifacts",
    { observed: uncertain.map(({ id, status, threadId, paneId }) => ({
      id, status, threadId, paneId: paneId ?? null,
    })) },
  );
}

function scoutFollowUpChecks(snapshot) {
  const followUps = snapshot.scoutFollowUps || [];
  const pending = followUps.filter(({ status }) => status === "selected");
  if (pending.length === 0) {
    return [check(
      "scout-follow-ups",
      followUps.length === 0 ? "not_applicable" : "pass",
      followUps.length === 0
        ? "Task has no human-selected scout follow-up"
        : "Every selected scout follow-up has a durable resolution",
    )];
  }
  const withCompletedReply = [];
  const withoutReplyIntent = [];
  const withUncertainReply = [];
  for (const followUp of pending) {
    const worker = snapshot.workers.find(({ id }) => id === followUp.workerId);
    const reply = worker?.replies?.find(({ id }) => id === followUp.replyId);
    if (reply?.status === "completed") withCompletedReply.push(followUp.followUpId);
    else if (reply?.status === "requested") withUncertainReply.push(followUp.followUpId);
    else withoutReplyIntent.push(followUp.followUpId);
  }
  const checks = [];
  if (withUncertainReply.length > 0) {
    checks.push(recoveryCheck(
      "scout-follow-ups",
      `Selected follow-ups have uncertain replies: ${withUncertainReply.join(", ")}`,
      "reconcile_worker_replies",
    ));
  }
  if (withCompletedReply.length > 0) {
    checks.push(recoveryCheck(
      "scout-follow-ups",
      `Verified replies need follow-up resolution: ${withCompletedReply.join(", ")}`,
      "resolve_scout_follow_ups",
    ));
  }
  if (withoutReplyIntent.length > 0) {
    checks.push(recoveryCheck(
      "scout-follow-ups",
      `Selected checks have no reply intent: ${withoutReplyIntent.join(", ")}`,
      "resume_scout_follow_ups",
    ));
  }
  return checks;
}

function validationCheck(snapshot) {
  const pending = (snapshot.validationRequests || []).find(({ status }) =>
    status === "requested");
  if (pending) {
    return recoveryCheck(
      "validation",
      `Local validation ${pending.operationId} has intent but no durable result`,
      "reconcile_local_validation_manually",
      { source: { kind: "task-ledger", eventId: pending.requestEventId } },
    );
  }
  const latest = snapshot.validationRuns.at(-1);
  const requiresPass = new Set([
    "awaiting_human",
    "ready_to_merge",
    "merging",
    "landed",
    "cleaning",
  ]).has(snapshot.state);
  if (!latest) {
    return requiresPass
      ? recoveryCheck(
        "validation",
        `Task state ${snapshot.state} has no local validation evidence`,
        "run_local_validation_before_resuming",
      )
      : check("validation", "not_applicable", "Task has no local validation evidence");
  }
  if (latest.passed !== true) {
    return recoveryCheck(
      "validation",
      `Latest local validation ${latest.runId} did not pass`,
      "resolve_local_validation_before_resuming",
      { source: { kind: "task-ledger", eventId: latest.eventId } },
    );
  }
  if (snapshot.worktree?.status === "leased" && latest.finalHeadSha !== snapshot.worktree.headSha) {
    return recoveryCheck(
      "validation",
      "Passing validation does not match the active lease SHA",
      "run_local_validation_before_resuming",
      { source: { kind: "task-ledger", eventId: latest.eventId } },
    );
  }
  return check("validation", "pass", `Local validation ${latest.runId} passed`, {
    source: { kind: "task-ledger", eventId: latest.eventId },
    observed: { runId: latest.runId, headSha: latest.finalHeadSha },
  });
}

function commitCheck(snapshot) {
  const operations = snapshot.gitCommits || [];
  const pending = operations.find(({ status }) => status === "requested");
  if (pending) {
    return recoveryCheck(
      "git-commit",
      `Git commit ${pending.operationId} has durable intent but no result`,
      "reconcile_git_commit",
      { source: { kind: "task-ledger", eventId: pending.requestEventId } },
    );
  }
  const completed = operations.at(-1);
  if (!completed) {
    return check("git-commit", "not_applicable", "Task has no controlled commit");
  }
  if (snapshot.worktree?.status !== "leased" ||
    completed.result?.headSha !== snapshot.worktree.headSha ||
    completed.result?.clean !== true) {
    return recoveryCheck(
      "git-commit",
      "Controlled commit evidence does not match the active lease",
      "inspect_controlled_commit_manually",
    );
  }
  return check("git-commit", "pass", `Controlled commit ${completed.result.headSha} recorded`, {
    source: { kind: "task-ledger", eventId: completed.completedEventId },
    observed: {
      operationId: completed.operationId,
      headSha: completed.result.headSha,
      treeSha: completed.result.treeSha,
    },
  });
}

function pushCheck(snapshot) {
  const operations = snapshot.gitPushes || [];
  const pending = operations.find(({ status }) => status === "requested");
  if (pending) {
    return recoveryCheck(
      "git-push",
      `Git push ${pending.operationId} has durable intent but no result`,
      "reconcile_git_push",
      { source: { kind: "task-ledger", eventId: pending.requestEventId } },
    );
  }
  const latest = operations.at(-1);
  if (!latest) return check("git-push", "not_applicable", "Task has no Git push");
  if (latest.status === "failed") {
    return recoveryCheck(
      "git-push",
      `Git push ${latest.operationId} did not publish a branch`,
      "request_new_git_push_approval",
      { source: { kind: "task-ledger", eventId: latest.failedEventId } },
    );
  }
  if (latest.status !== "completed" ||
    latest.result?.remoteHeadSha !== latest.headSha ||
    latest.headSha !== snapshot.worktree?.headSha) {
    return recoveryCheck(
      "git-push",
      "Git push evidence does not match the active leased head",
      "inspect_remote_task_branch_manually",
    );
  }
  return check("git-push", "pass", `Remote task branch is ${latest.headSha}`, {
    source: { kind: "task-ledger", eventId: latest.completedEventId },
    observed: {
      operationId: latest.operationId,
      branch: latest.branch,
      headSha: latest.headSha,
    },
  });
}

function draftPullRequestCheck(snapshot) {
  const operations = snapshot.githubDraftPullRequests || [];
  const uncertain = operations.filter(({ status }) => status === "requested");
  if (uncertain.length > 0) {
    return recoveryCheck(
      "github-draft-pr",
      `Draft PR writes need GitHub reconciliation: ${uncertain.map(({ operationId }) => operationId).join(", ")}`,
      "reconcile_draft_pr_create",
      {
        observed: uncertain.map((operation) => ({
          operationId: operation.operationId,
          repository: operation.repository,
          headBranch: operation.headBranch,
          headSha: operation.headSha,
        })),
      },
    );
  }
  return check(
    "github-draft-pr",
    operations.length === 0 ? "not_applicable" : "pass",
    operations.length === 0
      ? "Task has no draft PR write operation"
      : "Every draft PR write has a durable terminal result",
    {
      observed: operations.map(({ operationId, status, pullRequest }) => ({
        operationId,
        status,
        prNumber: pullRequest?.number ?? null,
      })),
    },
  );
}

function mergeCheck(snapshot) {
  const operations = snapshot.githubMerges || [];
  const pending = operations.find(({ status }) => status === "requested");
  if (pending) {
    return recoveryCheck(
      "github-merge",
      `GitHub merge ${pending.operationId} has durable intent but no result`,
      "reconcile_github_merge",
      { source: { kind: "task-ledger", eventId: pending.requestEventId } },
    );
  }
  const latest = operations.at(-1);
  if (!latest) return check("github-merge", "not_applicable", "Task has no merge operation");
  if (latest.status === "failed") {
    return recoveryCheck(
      "github-merge",
      `GitHub merge ${latest.operationId} did not land`,
      "request_new_merge_approval",
      { source: { kind: "task-ledger", eventId: latest.failedEventId } },
    );
  }
  if (latest.status !== "completed" ||
    latest.result?.mergeCommitSha !== latest.result?.baseHeadSha ||
    !new Set(["landed", "cleaning", "complete"]).has(snapshot.state)) {
    return recoveryCheck(
      "github-merge",
      "Merge evidence does not match the landed task state",
      "inspect_github_merge_manually",
    );
  }
  return check("github-merge", "pass", `Merge landed at ${latest.result.mergeCommitSha}`, {
    source: { kind: "task-ledger", eventId: latest.completedEventId },
    observed: {
      operationId: latest.operationId,
      prNumber: latest.prNumber,
      mergeCommitSha: latest.result.mergeCommitSha,
    },
  });
}

function postMergeCheck(snapshot) {
  const merge = [...(snapshot.githubMerges || [])].reverse().find(
    ({ status }) => status === "completed",
  );
  if (!merge) {
    return check("post-merge", "not_applicable", "Task has no completed merge");
  }
  const assurance = [...(snapshot.postMergeAssurances || [])].reverse().find(
    ({ mergeOperationId }) => mergeOperationId === merge.operationId,
  );
  if (!assurance) {
    return recoveryCheck(
      "post-merge",
      `Merge ${merge.operationId} lacks merge-commit CI and landed-tree assurance`,
      "complete_post_merge_assurance",
    );
  }
  if (assurance.requiredChecks?.satisfied !== true ||
    assurance.approvedHeadSha !== merge.headSha ||
    assurance.mergeCommitSha !== merge.result.mergeCommitSha ||
    assurance.baseHeadSha !== merge.result.mergeCommitSha) {
    return recoveryCheck(
      "post-merge",
      "Post-merge assurance does not match the completed merge",
      "inspect_post_merge_evidence_manually",
    );
  }
  const proof = snapshot.worktree?.proof;
  if (proof?.kind !== "exact-tree-landing" ||
    proof.assuranceEventId !== assurance.eventId ||
    proof.mergedCommitSha !== assurance.mergeCommitSha) {
    return recoveryCheck(
      "post-merge",
      "Passing merge-commit CI lacks its exact-tree landed-work proof",
      "resume_post_merge_assurance",
    );
  }
  if (snapshot.state === "complete" && snapshot.worktree?.status !== "returned") {
    return recoveryCheck(
      "post-merge",
      "Completed task did not record a returned Treehouse lease",
      "inspect_treehouse_return_manually",
    );
  }
  return check(
    "post-merge",
    "pass",
    `Merge-commit checks and exact tree ${proof.treeSha} are verified`,
    {
      source: { kind: "task-ledger", eventId: assurance.eventId },
      observed: {
        operationId: assurance.operationId,
        mergeCommitSha: assurance.mergeCommitSha,
        treeSha: proof.treeSha,
        leaseStatus: snapshot.worktree?.status,
      },
    },
  );
}

function latestPullRequestObservations(observations) {
  const latest = new Map();
  for (const observation of observations) {
    latest.set(observation.pullRequest.number, observation);
  }
  return [...latest.values()];
}

function check(kind, status, detail, extra = {}) {
  return { kind, status, detail, ...extra };
}

function recoveryCheck(kind, detail, action, extra = {}) {
  return check(kind, "recovery_required", detail, { action, ...extra });
}

function toolFailureCheck(kind, cause, action) {
  return recoveryCheck(
    kind,
    `${kind} observation failed: ${cause.message}`,
    action,
  );
}

function treehouseSource(repoPath) {
  return { kind: "treehouse-status", repoPath };
}

function gitSource(worktreePath) {
  return { kind: "git-inspection", worktreePath };
}

function parseRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new RestartReconciliationError("Task repository is not an owner/name pair");
  }
  const [owner, repo] = repository.split("/");
  return { owner, repo };
}

function validateAuditId(auditId) {
  if (typeof auditId !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(auditId)) {
    throw new TypeError("auditId must be 3-64 lowercase letters, numbers, dots, underscores, or hyphens");
  }
}

function unique(values) {
  return [...new Set(values)];
}

function sameArray(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export class RestartReconciliationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "RestartReconciliationError";
  }
}
