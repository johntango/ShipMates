import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ExactHeadGitPushAdapter {
  constructor({ runner = runCommand, timeoutMs = 120_000 } = {}) {
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    this.runner = runner;
    this.timeoutMs = timeoutMs;
  }

  async inspect({ worktreePath, repository, branch, headSha }) {
    const target = validateTarget({ worktreePath, repository, branch, headSha });
    const [head, localBranch, status, remoteUrl, remote] = await Promise.all([
      this.#git(target.worktreePath, ["rev-parse", "HEAD"]),
      this.#git(target.worktreePath, ["branch", "--show-current"]),
      this.#git(target.worktreePath, ["status", "--porcelain=v1", "-z"]),
      this.#git(target.worktreePath, ["remote", "get-url", "origin"]),
      this.#git(target.worktreePath, [
        "ls-remote", "--heads", "origin", `refs/heads/${target.branch}`,
      ]),
    ]);
    const remoteRepository = parseGitHubRepository(remoteUrl.stdout);
    if (remoteRepository?.toLowerCase() !== target.repository.toLowerCase()) {
      throw new ExactHeadGitPushError(
        "Origin remote does not match the approved GitHub repository",
      );
    }
    const remoteHeadSha = parseRemoteHead(remote.stdout, target.branch);
    return Object.freeze({
      repository: target.repository,
      worktreePath: target.worktreePath,
      remoteName: "origin",
      branch: target.branch,
      remoteRef: `refs/heads/${target.branch}`,
      localHeadSha: fullSha(head.stdout.trim(), "local HEAD"),
      localBranch: requireText(localBranch.stdout.trim(), "local branch"),
      clean: status.stdout.length === 0,
      remoteHeadSha,
    });
  }

  async pushExact(input) {
    const target = validateTarget(input);
    const before = await this.inspect(target);
    requireExactLocal(before, target);
    if (before.remoteHeadSha !== null) {
      throw new ExactHeadGitPushError(
        "Exact-head push requires a new remote task branch",
      );
    }
    const pushed = await this.#git(target.worktreePath, [
      "push", "--porcelain", "--no-verify", "origin",
      `${target.headSha}:refs/heads/${target.branch}`,
    ]);
    const after = await this.inspect(target);
    requireExactLocal(after, target);
    if (after.remoteHeadSha !== target.headSha) {
      throw new ExactHeadGitPushError(
        "Remote task branch does not match the exact pushed head",
      );
    }
    return pushEvidence({
      target,
      remoteHeadSha: after.remoteHeadSha,
      evidenceKind: "push-confirmation",
      transportOutputSha256: digest(`${pushed.stdout}\0${pushed.stderr}`),
    });
  }

  async reconcile(input) {
    const target = validateTarget(input);
    const observation = await this.inspect(target);
    requireExactLocal(observation, target);
    if (observation.remoteHeadSha === null) {
      return Object.freeze({ status: "absent", observation });
    }
    if (observation.remoteHeadSha !== target.headSha) {
      return Object.freeze({ status: "conflict", observation });
    }
    return Object.freeze({
      status: "completed",
      observation,
      evidence: pushEvidence({
        target,
        remoteHeadSha: observation.remoteHeadSha,
        evidenceKind: "remote-reconciliation",
        transportOutputSha256: null,
      }),
    });
  }

  async #git(worktreePath, args) {
    try {
      return await this.runner("git", args, {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (cause) {
      throw new ExactHeadGitPushError(
        `Git ${args[0]} failed (stderrBytes=${Buffer.byteLength(cause?.stderr || "")})`,
        { cause },
      );
    }
  }
}

export class ExactHeadGitPushError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ExactHeadGitPushError";
  }
}

async function runCommand(file, args, options) {
  return execFileAsync(file, args, options);
}

function validateTarget({ worktreePath, repository, branch, headSha }) {
  if (!path.isAbsolute(worktreePath)) throw new TypeError("worktreePath must be absolute");
  if (typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new TypeError("repository must be an owner/name pair");
  }
  validateBranch(branch);
  return {
    worktreePath: path.resolve(worktreePath),
    repository,
    branch,
    headSha: fullSha(headSha, "headSha"),
  };
}

function requireExactLocal(observation, target) {
  if (observation.localHeadSha !== target.headSha ||
    observation.localBranch !== target.branch || observation.clean !== true) {
    throw new ExactHeadGitPushError(
      "Push requires the clean exact validated branch and head",
    );
  }
}

function pushEvidence({
  target, remoteHeadSha, evidenceKind, transportOutputSha256,
}) {
  return Object.freeze({
    evidenceKind,
    repository: target.repository,
    remoteName: "origin",
    branch: target.branch,
    remoteRef: `refs/heads/${target.branch}`,
    headSha: target.headSha,
    previousHeadSha: null,
    remoteHeadSha,
    transportOutputSha256,
    pushed: true,
  });
}

function parseRemoteHead(stdout, branch) {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length !== 1) {
    throw new ExactHeadGitPushError("Remote task branch observation is ambiguous");
  }
  const fields = lines[0].split("\t");
  if (fields.length !== 2 || fields[1] !== `refs/heads/${branch}`) {
    throw new ExactHeadGitPushError("Remote task branch observation is malformed");
  }
  return fullSha(fields[0], "remote head");
}

function parseGitHubRepository(remoteUrl) {
  const value = String(remoteUrl).trim().replace(/\.git$/u, "");
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/u.exec(value);
  if (ssh) return ssh[1];
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const repository = url.pathname.replace(/^\//u, "");
    return /^[^/]+\/[^/]+$/u.test(repository) ? repository : null;
  } catch {
    return null;
  }
}

function validateBranch(value) {
  requireText(value, "branch");
  if (value === "@" ||
    /\p{Cc}|\.\.|@\{|[ ~^:?*\\[]|^\/|\/\/|\/$|^\.|\.$|\.lock$/u.test(value)) {
    throw new TypeError("branch is not a safe Git branch");
  }
}

function fullSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TypeError(`${label} must be a full SHA`);
  }
  return value.toLowerCase();
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be non-empty`);
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
