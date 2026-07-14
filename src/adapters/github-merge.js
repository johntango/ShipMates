import { spawn } from "node:child_process";

export class GitHubMergeGateway {
  constructor({ client = new GhApiMergeClient(), clock = () => new Date() } = {}) {
    if (!client || typeof client.put !== "function") {
      throw new TypeError("GitHubMergeGateway requires a client with put()");
    }
    this.client = client;
    this.clock = clock;
  }

  async mergeSquash({ owner, repo, prNumber, headSha }) {
    const repository = repositoryTarget(owner, repo);
    const number = positiveInteger(prNumber, "pull request number");
    const sha = fullSha(headSha);
    const endpoint = `repos/${repository}/pulls/${number}/merge`;
    const raw = await this.client.put({
      endpoint,
      body: { sha, merge_method: "squash" },
    });
    if (raw?.merged !== true) {
      throw new GitHubMergeError("GitHub did not confirm the approved squash merge");
    }
    return Object.freeze({
      repository,
      prNumber: number,
      headSha: sha,
      mergeMethod: "squash",
      mergeCommitSha: fullSha(raw.sha),
      merged: true,
      observedAt: this.clock().toISOString(),
      source: { kind: "github-rest", endpoint },
    });
  }
}

export class GhApiMergeClient {
  constructor({ command = "gh", env = process.env } = {}) {
    this.command = command;
    this.env = env;
  }

  async put({ endpoint, body }) {
    requireText(endpoint, "endpoint");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("GitHub merge body must be an object");
    }
    const child = spawn(
      this.command,
      ["api", "--method", "PUT", "--input", "-", endpoint],
      { env: this.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(`${JSON.stringify(body)}\n`);
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) =>
        resolve({ code: exitCode, signal: exitSignal }));
    });
    if (code !== 0) {
      throw new GitHubMergeError(
        `GitHub merge failed (exit=${code ?? "none"}, signal=${signal ?? "none"}, stderrBytes=${Buffer.concat(stderr).length})`,
      );
    }
    try {
      return JSON.parse(Buffer.concat(stdout).toString("utf8"));
    } catch (cause) {
      throw new GitHubMergeError("GitHub merge returned malformed JSON", { cause });
    }
  }
}

export class GitHubMergeError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubMergeError";
  }
}

function repositoryTarget(owner, repo) {
  for (const [label, value] of Object.entries({ owner, repo })) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(value)) {
      throw new TypeError(`${label} is not a safe GitHub path segment`);
    }
  }
  return `${owner}/${repo}`;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  return value;
}

function fullSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TypeError("headSha must be a full 40-character hexadecimal SHA");
  }
  return value.toLowerCase();
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be non-empty`);
  }
}
