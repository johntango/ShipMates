import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitHubReadGateway {
  constructor({ client = new GhApiReadClient(), clock = () => new Date() } = {}) {
    if (!client || typeof client.get !== "function") {
      throw new TypeError("GitHubReadGateway requires a client with a get method");
    }
    this.client = client;
    this.clock = clock;
  }

  async readRepository({ owner, repo }) {
    const target = repositoryTarget(owner, repo);
    const endpoint = `repos/${target}`;
    const value = await this.client.get({ endpoint });
    const fullName = requiredString(value, "full_name", endpoint);
    if (fullName.toLowerCase() !== target.toLowerCase()) {
      throw new GitHubReadError(`Repository response was for ${fullName}, expected ${target}`);
    }
    return this.#observation(endpoint, {
      nameWithOwner: fullName,
      defaultBranch: requiredString(value, "default_branch", endpoint),
      visibility: requiredString(value, "visibility", endpoint),
      archived: requiredBoolean(value, "archived", endpoint),
      disabled: requiredBoolean(value, "disabled", endpoint),
      allowSquashMerge: requiredBoolean(value, "allow_squash_merge", endpoint),
      url: requiredString(value, "html_url", endpoint),
    });
  }

  async readBranchProtection({ owner, repo, branch }) {
    const target = repositoryTarget(owner, repo);
    const branchName = encodedRef(branch, "branch");
    const endpoint = `repos/${target}/branches/${branchName}/protection`;
    const value = await this.client.get({ endpoint });
    const status = value.required_status_checks;
    const reviews = value.required_pull_request_reviews;
    return this.#observation(endpoint, {
      repository: target,
      branch,
      enforceAdmins: Boolean(value.enforce_admins?.enabled),
      requiredStatusChecks: status === null ? null : {
        strict: requiredBoolean(status, "strict", endpoint),
        contexts: requiredStringArray(status.contexts, `${endpoint}.contexts`),
        checks: optionalArray(status.checks, `${endpoint}.checks`).map((check) => ({
          context: requiredString(check, "context", endpoint),
          appId: check.app_id === null ? null : requiredInteger(check, "app_id", endpoint),
        })),
      },
      requiredPullRequestReviews: reviews === null ? null : {
        approvals: requiredInteger(reviews, "required_approving_review_count", endpoint),
        dismissStaleReviews: requiredBoolean(reviews, "dismiss_stale_reviews", endpoint),
        requireCodeOwnerReviews: requiredBoolean(reviews, "require_code_owner_reviews", endpoint),
        requireLastPushApproval: Boolean(reviews.require_last_push_approval),
      },
      requiredConversationResolution: Boolean(value.required_conversation_resolution?.enabled),
      allowForcePushes: Boolean(value.allow_force_pushes?.enabled),
      allowDeletions: Boolean(value.allow_deletions?.enabled),
    });
  }

  async readBranchHead({ owner, repo, branch }) {
    const target = repositoryTarget(owner, repo);
    const branchName = encodedRef(branch, "branch");
    const endpoint = `repos/${target}/git/ref/heads/${branchName}`;
    const value = await this.client.get({ endpoint });
    const expectedRef = `refs/heads/${branch}`;
    if (requiredString(value, "ref", endpoint) !== expectedRef) {
      throw new GitHubReadError(`GitHub ref did not match ${expectedRef}`);
    }
    const objectType = requiredString(value.object, "type", endpoint);
    if (objectType !== "commit") {
      throw new GitHubReadError(`GitHub branch ref points to ${objectType}, expected commit`);
    }
    return this.#observation(endpoint, {
      repository: target,
      branch,
      sha: fullSha(requiredString(value.object, "sha", endpoint)),
      objectType,
    });
  }

  async readIssue({ owner, repo, number }) {
    const target = repositoryTarget(owner, repo);
    const issueNumber = positiveInteger(number, "issue number");
    const endpoint = `repos/${target}/issues/${issueNumber}`;
    const value = await this.client.get({ endpoint });
    const actual = requiredInteger(value, "number", endpoint);
    if (actual !== issueNumber) {
      throw new GitHubReadError(`Issue response was for ${actual}, expected ${issueNumber}`);
    }
    if (value.pull_request !== undefined) {
      throw new GitHubReadError(`${target}#${issueNumber} is a pull request, not an issue`);
    }
    return this.#observation(endpoint, {
      repository: target,
      number: actual,
      url: requiredString(value, "html_url", endpoint),
      state: requiredString(value, "state", endpoint),
      title: requiredString(value, "title", endpoint),
      actor: requiredString(value.user, "login", endpoint),
      locked: requiredBoolean(value, "locked", endpoint),
      createdAt: requiredTimestamp(value, "created_at", endpoint),
      updatedAt: requiredTimestamp(value, "updated_at", endpoint),
      closedAt: optionalTimestamp(value.closed_at, `${endpoint}.closed_at`),
    });
  }

  async readPullRequest({ owner, repo, number }) {
    const target = repositoryTarget(owner, repo);
    const prNumber = positiveInteger(number, "pull request number");
    const endpoint = `repos/${target}/pulls/${prNumber}`;
    return this.#observation(endpoint, normalizePullRequest(await this.client.get({ endpoint }), endpoint, target, prNumber));
  }

  async listPullRequests({ owner, repo, state = "all" }) {
    const target = repositoryTarget(owner, repo);
    if (!new Set(["open", "closed", "all"]).has(state)) {
      throw new TypeError("state must be open, closed, or all");
    }
    const endpoint = `repos/${target}/pulls?state=${state}&per_page=100`;
    const pages = await this.client.get({ endpoint, paginate: true });
    const values = flattenArrayPages(pages, endpoint);
    const seen = new Set();
    return values.map((value) => {
      const number = requiredInteger(value, "number", endpoint);
      if (seen.has(number)) {
        throw new GitHubReadError(`Ambiguous pull request ${number} appeared more than once`);
      }
      seen.add(number);
      return this.#observation(
        `${endpoint}#${number}`,
        normalizePullRequestSummary(value, endpoint, target, number),
      );
    });
  }

  async listCheckRuns({ owner, repo, headSha }) {
    const target = repositoryTarget(owner, repo);
    const sha = fullSha(headSha);
    const endpoint = `repos/${target}/commits/${sha}/check-runs?per_page=100`;
    const pages = await this.client.get({ endpoint, paginate: true });
    const values = flattenObjectPages(pages, "check_runs", endpoint);
    return uniqueById(values, endpoint).map((value) => this.#observation(
      `${endpoint}#${requiredInteger(value, "id", endpoint)}`,
      {
        id: requiredInteger(value, "id", endpoint),
        name: requiredString(value, "name", endpoint),
        headSha: exactString(value, "head_sha", sha, endpoint),
        status: requiredString(value, "status", endpoint),
        conclusion: optionalString(value.conclusion, `${endpoint}.conclusion`),
        appSlug: optionalString(value.app?.slug, `${endpoint}.app.slug`),
        url: requiredString(value, "html_url", endpoint),
        startedAt: optionalTimestamp(value.started_at, `${endpoint}.started_at`),
        completedAt: optionalTimestamp(value.completed_at, `${endpoint}.completed_at`),
      },
    ));
  }

  async listReviews({ owner, repo, number }) {
    const target = repositoryTarget(owner, repo);
    const prNumber = positiveInteger(number, "pull request number");
    const endpoint = `repos/${target}/pulls/${prNumber}/reviews?per_page=100`;
    const pages = await this.client.get({ endpoint, paginate: true });
    return uniqueById(flattenArrayPages(pages, endpoint), endpoint).map((value) => this.#observation(
      `${endpoint}#${requiredInteger(value, "id", endpoint)}`,
      {
        id: requiredInteger(value, "id", endpoint),
        state: requiredString(value, "state", endpoint),
        actor: requiredString(value.user, "login", endpoint),
        commitSha: optionalFullSha(value.commit_id, `${endpoint}.commit_id`),
        submittedAt: optionalTimestamp(value.submitted_at, `${endpoint}.submitted_at`),
        url: requiredString(value, "html_url", endpoint),
      },
    ));
  }

  async listReviewThreads({ owner, repo, number }) {
    const target = repositoryTarget(owner, repo);
    const prNumber = positiveInteger(number, "pull request number");
    if (typeof this.client.graphql !== "function") {
      throw new GitHubReadError("GitHub client cannot read review threads");
    }
    const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          reviewThreads(first:100,after:$cursor){
            nodes{id isResolved isOutdated}
            pageInfo{hasNextPage endCursor}
          }
        }
      }
    }`;
    const threads = [];
    let cursor = null;
    do {
      const response = await this.client.graphql({
        query,
        variables: { owner, repo, number: prNumber, cursor },
      });
      const connection = response?.data?.repository?.pullRequest?.reviewThreads;
      if (!connection || !Array.isArray(connection.nodes) ||
        typeof connection.pageInfo?.hasNextPage !== "boolean") {
        throw new GitHubReadError("GitHub review-thread response is malformed");
      }
      for (const node of connection.nodes) {
        const id = requiredString(node, "id", "graphql:reviewThreads");
        if (threads.some((thread) => thread.id === id)) {
          throw new GitHubReadError(`Ambiguous review thread ${id}`);
        }
        threads.push(this.#observation(`graphql:${target}#${prNumber}:${id}`, {
          id,
          resolved: requiredBoolean(node, "isResolved", "graphql:reviewThreads"),
          outdated: requiredBoolean(node, "isOutdated", "graphql:reviewThreads"),
        }));
      }
      cursor = connection.pageInfo.hasNextPage
        ? requiredString(connection.pageInfo, "endCursor", "graphql:reviewThreads")
        : null;
    } while (cursor !== null);
    return threads;
  }

  async listWorkflowRuns({ owner, repo, headSha }) {
    const target = repositoryTarget(owner, repo);
    const sha = fullSha(headSha);
    const endpoint = `repos/${target}/actions/runs?head_sha=${sha}&per_page=100`;
    const pages = await this.client.get({ endpoint, paginate: true });
    const values = flattenObjectPages(pages, "workflow_runs", endpoint);
    return uniqueById(values, endpoint).map((value) => this.#observation(
      `${endpoint}#${requiredInteger(value, "id", endpoint)}`,
      {
        id: requiredInteger(value, "id", endpoint),
        name: requiredString(value, "name", endpoint),
        headSha: exactString(value, "head_sha", sha, endpoint),
        event: requiredString(value, "event", endpoint),
        status: requiredString(value, "status", endpoint),
        conclusion: optionalString(value.conclusion, `${endpoint}.conclusion`),
        url: requiredString(value, "html_url", endpoint),
        runAttempt: requiredInteger(value, "run_attempt", endpoint),
      },
    ));
  }

  #observation(endpoint, value) {
    return {
      ...value,
      observedAt: this.clock().toISOString(),
      source: { kind: "github-rest", endpoint },
    };
  }
}

export class GhApiReadClient {
  constructor({ command = "gh", env = process.env } = {}) {
    this.command = command;
    this.env = env;
  }

  async get({ endpoint, paginate = false }) {
    requiredNonEmpty(endpoint, "endpoint");
    const args = ["api", "--method", "GET"];
    if (paginate) args.push("--paginate", "--slurp");
    args.push(endpoint);
    let stdout;
    try {
      ({ stdout } = await execFileAsync(this.command, args, {
        env: this.env,
        maxBuffer: 10 * 1024 * 1024,
      }));
    } catch (cause) {
      throw new GitHubReadError(`GitHub GET failed for ${endpoint}`, { cause });
    }
    try {
      return JSON.parse(stdout);
    } catch (cause) {
      throw new GitHubReadError(`GitHub returned malformed JSON for ${endpoint}`, { cause });
    }
  }

  async graphql({ query, variables }) {
    requiredNonEmpty(query, "query");
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      throw new TypeError("variables must be an object");
    }
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value !== null) args.push("-F", `${name}=${value}`);
    }
    let stdout;
    try {
      ({ stdout } = await execFileAsync(this.command, args, {
        env: this.env,
        maxBuffer: 10 * 1024 * 1024,
      }));
    } catch (cause) {
      throw new GitHubReadError("GitHub GraphQL request failed", { cause });
    }
    try {
      return JSON.parse(stdout);
    } catch (cause) {
      throw new GitHubReadError("GitHub GraphQL returned malformed JSON", { cause });
    }
  }
}

export class GitHubReadError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubReadError";
  }
}

function normalizePullRequest(value, endpoint, target, number) {
  const actual = requiredInteger(value, "number", endpoint);
  if (actual !== number) throw new GitHubReadError(`Pull request response was for ${actual}, expected ${number}`);
  const baseRepo = requiredString(value.base?.repo, "full_name", endpoint);
  if (baseRepo.toLowerCase() !== target.toLowerCase()) {
    throw new GitHubReadError(`Pull request base repository was ${baseRepo}, expected ${target}`);
  }
  return {
    repository: baseRepo,
    number: actual,
    url: requiredString(value, "html_url", endpoint),
    state: requiredString(value, "state", endpoint),
    draft: requiredBoolean(value, "draft", endpoint),
    title: requiredString(value, "title", endpoint),
    merged: requiredBoolean(value, "merged", endpoint),
    mergeCommitSha: optionalFullSha(value.merge_commit_sha, `${endpoint}.merge_commit_sha`),
    mergeable: value.mergeable === null ? null : requiredBoolean(value, "mergeable", endpoint),
    mergeableState: requiredString(value, "mergeable_state", endpoint),
    base: {
      repository: baseRepo,
      branch: requiredString(value.base, "ref", endpoint),
      sha: fullSha(requiredString(value.base, "sha", endpoint)),
    },
    head: {
      repository: requiredString(value.head?.repo, "full_name", endpoint),
      owner: requiredString(value.head?.repo?.owner, "login", endpoint),
      branch: requiredString(value.head, "ref", endpoint),
      sha: fullSha(requiredString(value.head, "sha", endpoint)),
    },
    updatedAt: requiredTimestamp(value, "updated_at", endpoint),
  };
}

export function normalizePullRequestSummary(value, endpoint, target, number) {
  const common = normalizePullRequestIdentity(value, endpoint, target, number);
  return {
    ...common,
    updatedAt: requiredTimestamp(value, "updated_at", endpoint),
  };
}

function normalizePullRequestIdentity(value, endpoint, target, number) {
  const actual = requiredInteger(value, "number", endpoint);
  if (actual !== number) throw new GitHubReadError(`Pull request response was for ${actual}, expected ${number}`);
  const baseRepo = requiredString(value.base?.repo, "full_name", endpoint);
  if (baseRepo.toLowerCase() !== target.toLowerCase()) {
    throw new GitHubReadError(`Pull request base repository was ${baseRepo}, expected ${target}`);
  }
  return {
    repository: baseRepo,
    number: actual,
    url: requiredString(value, "html_url", endpoint),
    state: requiredString(value, "state", endpoint),
    draft: requiredBoolean(value, "draft", endpoint),
    title: requiredString(value, "title", endpoint),
    base: {
      repository: baseRepo,
      branch: requiredString(value.base, "ref", endpoint),
      sha: fullSha(requiredString(value.base, "sha", endpoint)),
    },
    head: {
      repository: requiredString(value.head?.repo, "full_name", endpoint),
      owner: requiredString(value.head?.repo?.owner, "login", endpoint),
      branch: requiredString(value.head, "ref", endpoint),
      sha: fullSha(requiredString(value.head, "sha", endpoint)),
    },
  };
}

function repositoryTarget(owner, repo) {
  return `${pathSegment(owner, "owner")}/${pathSegment(repo, "repo")}`;
}

function pathSegment(value, label) {
  requiredNonEmpty(value, label);
  if (!/^[A-Za-z0-9_.-]+$/u.test(value)) throw new TypeError(`${label} is not a safe GitHub path segment`);
  return value;
}

function encodedRef(value, label) {
  requiredNonEmpty(value, label);
  if (/\p{Cc}/u.test(value)) throw new TypeError(`${label} contains control characters`);
  return encodeURIComponent(value);
}

function fullSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TypeError("headSha must be a full 40-character hexadecimal SHA");
  }
  return value.toLowerCase();
}

function optionalFullSha(value, label) {
  return value === null || value === undefined
    ? null
    : fullSha(requiredNonEmpty(value, label));
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function flattenArrayPages(pages, endpoint) {
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new GitHubReadError(`Malformed paginated array response for ${endpoint}`);
  }
  return pages.flat();
}

function flattenObjectPages(pages, field, endpoint) {
  if (!Array.isArray(pages)) throw new GitHubReadError(`Malformed paginated response for ${endpoint}`);
  return pages.flatMap((page) => optionalArray(page?.[field], `${endpoint}.${field}`));
}

function uniqueById(values, endpoint) {
  const seen = new Set();
  return values.map((value) => {
    const id = requiredInteger(value, "id", endpoint);
    if (seen.has(id)) throw new GitHubReadError(`Ambiguous result: id ${id} appeared more than once for ${endpoint}`);
    seen.add(id);
    return value;
  });
}

function requiredString(object, field, context) {
  return requiredNonEmpty(object?.[field], `${context}.${field}`);
}

function exactString(object, field, expected, context) {
  const actual = requiredString(object, field, context).toLowerCase();
  if (actual !== expected) throw new GitHubReadError(`${context}.${field} was ${actual}, expected ${expected}`);
  return actual;
}

function requiredNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new GitHubReadError(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value, label) {
  return value === null || value === undefined ? null : requiredNonEmpty(value, label);
}

function requiredBoolean(object, field, context) {
  if (typeof object?.[field] !== "boolean") throw new GitHubReadError(`${context}.${field} must be a boolean`);
  return object[field];
}

function requiredInteger(object, field, context) {
  const value = object?.[field];
  if (!Number.isSafeInteger(value) || value < 0) throw new GitHubReadError(`${context}.${field} must be a non-negative integer`);
  return value;
}

function optionalArray(value, label) {
  if (!Array.isArray(value)) throw new GitHubReadError(`${label} must be an array`);
  return value;
}

function requiredStringArray(value, label) {
  return optionalArray(value, label).map((item) => requiredNonEmpty(item, label));
}

function requiredTimestamp(object, field, context) {
  return timestamp(requiredString(object, field, context), `${context}.${field}`);
}

function optionalTimestamp(value, label) {
  return value === null || value === undefined ? null : timestamp(value, label);
}

function timestamp(value, label) {
  requiredNonEmpty(value, label);
  if (Number.isNaN(Date.parse(value))) throw new GitHubReadError(`${label} must be a timestamp`);
  return value;
}
