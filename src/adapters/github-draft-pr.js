import { spawn } from "node:child_process";

import { normalizePullRequestSummary } from "./github-read.js";

export class GitHubDraftPullRequestGateway {
  constructor({ client = new GhApiWriteClient(), clock = () => new Date() } = {}) {
    if (!client || typeof client.post !== "function") {
      throw new TypeError("GitHubDraftPullRequestGateway requires a client with post()");
    }
    this.client = client;
    this.clock = clock;
  }

  async create({ owner, repo, title, body, headBranch, headSha, baseBranch }) {
    const target = repositoryTarget(owner, repo);
    requireText("title", title, 256);
    requireText("body", body, 65_536);
    requireBranch("headBranch", headBranch);
    requireBranch("baseBranch", baseBranch);
    requireFullSha(headSha);
    const endpoint = `repos/${target}/pulls`;
    const raw = await this.client.post({
      endpoint,
      body: {
        title,
        body,
        head: headBranch,
        base: baseBranch,
        draft: true,
        maintainer_can_modify: false,
      },
    });
    const number = positiveInteger(raw?.number, "pull request number");
    const result = normalizePullRequestSummary(raw, endpoint, target, number);
    if (
      result.state !== "open" || result.draft !== true ||
      result.title !== title || result.head.branch !== headBranch ||
      result.head.sha !== headSha.toLowerCase() || result.base.branch !== baseBranch
    ) {
      throw new GitHubDraftPullRequestError(
        "GitHub created pull request does not match the exact draft target",
      );
    }
    return {
      ...result,
      observedAt: this.clock().toISOString(),
      source: { kind: "github-rest", endpoint },
    };
  }
}

export class GhApiWriteClient {
  constructor({ command = "gh", env = process.env } = {}) {
    this.command = command;
    this.env = env;
  }

  async post({ endpoint, body }) {
    requireText("endpoint", endpoint, 1_024);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("GitHub POST body must be an object");
    }
    const child = spawn(
      this.command,
      ["api", "--method", "POST", "--input", "-", endpoint],
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
        resolve({ code: exitCode, signal: exitSignal }),
      );
    });
    if (code !== 0) {
      throw new GitHubDraftPullRequestError(
        `GitHub POST failed (exit=${code ?? "none"}, signal=${signal ?? "none"}, stderrBytes=${Buffer.concat(stderr).length})`,
      );
    }
    try {
      return JSON.parse(Buffer.concat(stdout).toString("utf8"));
    } catch (cause) {
      throw new GitHubDraftPullRequestError("GitHub POST returned malformed JSON", {
        cause,
      });
    }
  }
}

export class GitHubDraftPullRequestError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubDraftPullRequestError";
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

function requireBranch(label, value) {
  requireText(label, value, 255);
  if (
    value === "@" ||
    /\p{Cc}|\.\.|@\{|[ ~^:?*\\[]|^\/|\/\/|\/$|^\.|\.$|\.lock$/u.test(value)
  ) {
    throw new TypeError(`${label} is not a safe Git branch`);
  }
}

function requireFullSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TypeError("headSha must be a full 40-character hexadecimal SHA");
  }
}

function requireText(label, value, maximum) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHubDraftPullRequestError(`${label} must be positive`);
  }
  return value;
}
