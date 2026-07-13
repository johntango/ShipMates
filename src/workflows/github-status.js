export class GitHubStatusWorkflow {
  constructor({ store, gateway, actor = "firstmate", clock = () => new Date() }) {
    if (!store || !gateway) throw new TypeError("GitHubStatusWorkflow requires store and gateway");
    this.store = store;
    this.gateway = gateway;
    this.actor = actor;
    this.clock = clock;
  }

  async inspectPullRequest({ taskId, repository, prNumber, requiredChecks = [] }) {
    const { owner, repo } = parseRepository(repository);
    validateRequiredChecks(requiredChecks);
    const snapshot = await this.store.getSnapshot(taskId);
    if (snapshot.repo.toLowerCase() !== repository.toLowerCase()) {
      throw new GitHubStatusError(`Task repository ${snapshot.repo} does not match ${repository}`);
    }

    const repositoryObservation = await this.gateway.readRepository({ owner, repo });
    const pullRequest = await this.gateway.readPullRequest({ owner, repo, number: prNumber });
    const [branchProtection, checks, reviews, workflowRuns] = await Promise.all([
      this.gateway.readBranchProtection({ owner, repo, branch: pullRequest.base.branch }),
      this.gateway.listCheckRuns({ owner, repo, headSha: pullRequest.head.sha }),
      this.gateway.listReviews({ owner, repo, number: prNumber }),
      this.gateway.listWorkflowRuns({ owner, repo, headSha: pullRequest.head.sha }),
    ]);
    const confirmed = await this.gateway.readPullRequest({ owner, repo, number: prNumber });
    if (confirmed.head.sha !== pullRequest.head.sha) {
      throw new GitHubHeadMovedError(
        `Pull request ${repository}#${prNumber} moved from ${pullRequest.head.sha} to ${confirmed.head.sha}`,
      );
    }

    const checkSummary = summarizeChecks(checks, requiredChecks);
    const report = {
      schemaVersion: 1,
      actor: this.actor,
      observedAt: this.clock().toISOString(),
      repository: repositoryObservation,
      pullRequest: confirmed,
      branchProtection,
      checks,
      reviews,
      workflowRuns,
      requiredChecks: checkSummary,
    };
    return this.store.recordGitHubStatus({
      taskId,
      actor: this.actor,
      report,
      eventId: `${taskId}:github:${prNumber}:${confirmed.head.sha}:status:v1`,
      at: report.observedAt,
    });
  }

  async listPullRequests({ repository }) {
    const { owner, repo } = parseRepository(repository);
    return this.gateway.listPullRequests({ owner, repo, state: "all" });
  }
}

export class GitHubStatusError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubStatusError";
  }
}

export class GitHubHeadMovedError extends GitHubStatusError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubHeadMovedError";
  }
}

function parseRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new TypeError("repository must be an owner/name pair");
  }
  const [owner, repo] = repository.split("/");
  return { owner, repo };
}

function validateRequiredChecks(requiredChecks) {
  if (!Array.isArray(requiredChecks) || requiredChecks.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new TypeError("requiredChecks must be an array of non-empty names");
  }
  if (new Set(requiredChecks).size !== requiredChecks.length) {
    throw new TypeError("requiredChecks contains duplicate names");
  }
}

function summarizeChecks(checks, requiredChecks) {
  const byName = new Map();
  for (const check of checks) {
    if (byName.has(check.name)) {
      throw new GitHubStatusError(`Ambiguous check name: ${check.name}`);
    }
    byName.set(check.name, check);
  }
  const missing = requiredChecks.filter((name) => !byName.has(name));
  const unsuccessful = requiredChecks.filter((name) => {
    const check = byName.get(name);
    return check && (check.status !== "completed" || check.conclusion !== "success");
  });
  return {
    names: [...requiredChecks],
    missing,
    unsuccessful,
    satisfied: missing.length === 0 && unsuccessful.length === 0,
  };
}
