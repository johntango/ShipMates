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
      validationCheck(snapshot),
      draftPullRequestCheck(snapshot),
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
      if (inspection.headSha !== worktree.headSha || inspection.dirty) {
        return [recoveryCheck(
          "git-worktree",
          `Leased worktree expected clean ${worktree.headSha}, found ${inspection.headSha}${inspection.dirty ? " dirty" : ""}`,
          "inspect_unlanded_worktree_manually",
          { source: gitSource(worktree.worktreePath), observed: inspection },
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
        if (live.state !== recorded.pullRequest.state) {
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
          `PR #${live.number} head, state, and required checks match`,
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

function validationCheck(snapshot) {
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

export class RestartReconciliationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "RestartReconciliationError";
  }
}
