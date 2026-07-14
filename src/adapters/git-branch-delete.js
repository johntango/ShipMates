import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ExactRemoteBranchDeleteAdapter {
  constructor({ runner = runCommand, timeoutMs = 120_000 } = {}) {
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    this.runner = runner;
    this.timeoutMs = timeoutMs;
  }

  async inspect(input) {
    const target = validateTarget(input);
    const [remoteUrl, remote] = await Promise.all([
      this.#git(target.repoPath, ["remote", "get-url", "origin"]),
      this.#git(target.repoPath, [
        "ls-remote", "--heads", "origin", target.remoteRef,
      ]),
    ]);
    const remoteRepository = parseGitHubRepository(remoteUrl.stdout);
    if (remoteRepository?.toLowerCase() !== target.repository.toLowerCase()) {
      throw new ExactRemoteBranchDeleteError(
        "Origin remote does not match the approved GitHub repository",
      );
    }
    return Object.freeze({
      repository: target.repository,
      repoPath: target.repoPath,
      remoteName: "origin",
      branch: target.branch,
      remoteRef: target.remoteRef,
      remoteHeadSha: parseRemoteHead(remote.stdout, target.branch),
    });
  }

  async deleteExact(input) {
    const target = validateTarget(input);
    const before = await this.inspect(target);
    requireExpectedRemote(before, target);
    const deleted = await this.#git(target.repoPath, [
      "push",
      "--porcelain",
      "--no-verify",
      `--force-with-lease=${target.remoteRef}:${target.headSha}`,
      "origin",
      `:${target.remoteRef}`,
    ]);
    const after = await this.inspect(target);
    if (after.remoteHeadSha !== null) {
      throw new ExactRemoteBranchDeleteError(
        "Remote task branch still exists after exact deletion",
      );
    }
    return deletionEvidence({
      target,
      evidenceKind: "delete-confirmation",
      transportOutputSha256: digest(`${deleted.stdout}\0${deleted.stderr}`),
    });
  }

  async reconcile(input) {
    const target = validateTarget(input);
    const observation = await this.inspect(target);
    if (observation.remoteHeadSha === null) {
      return Object.freeze({
        status: "completed",
        observation,
        evidence: deletionEvidence({
          target,
          evidenceKind: "remote-reconciliation",
          transportOutputSha256: null,
        }),
      });
    }
    if (observation.remoteHeadSha === target.headSha) {
      return Object.freeze({ status: "not_deleted", observation });
    }
    return Object.freeze({ status: "conflict", observation });
  }

  async #git(repoPath, args) {
    try {
      return await this.runner("git", args, {
        cwd: repoPath,
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (cause) {
      throw new ExactRemoteBranchDeleteError(
        `Git ${args[0]} failed (stderrBytes=${Buffer.byteLength(cause?.stderr || "")})`,
        { cause },
      );
    }
  }
}

export class ExactRemoteBranchDeleteError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ExactRemoteBranchDeleteError";
  }
}

async function runCommand(file, args, options) {
  return execFileAsync(file, args, options);
}

function validateTarget({ repoPath, repository, branch, headSha }) {
  if (!path.isAbsolute(repoPath)) throw new TypeError("repoPath must be absolute");
  if (typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new TypeError("repository must be an owner/name pair");
  }
  validateBranch(branch);
  return {
    repoPath: path.resolve(repoPath),
    repository,
    branch,
    remoteRef: `refs/heads/${branch}`,
    headSha: fullSha(headSha, "headSha"),
  };
}

function requireExpectedRemote(observation, target) {
  if (observation.remoteHeadSha !== target.headSha) {
    throw new ExactRemoteBranchDeleteError(
      "Branch deletion requires the remote task branch at the approved exact head",
    );
  }
}

function deletionEvidence({ target, evidenceKind, transportOutputSha256 }) {
  return Object.freeze({
    evidenceKind,
    repository: target.repository,
    remoteName: "origin",
    branch: target.branch,
    remoteRef: target.remoteRef,
    deletedHeadSha: target.headSha,
    remoteHeadSha: null,
    transportOutputSha256,
    deleted: true,
  });
}

function parseRemoteHead(stdout, branch) {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length !== 1) {
    throw new ExactRemoteBranchDeleteError(
      "Remote task branch observation is ambiguous",
    );
  }
  const fields = lines[0].split("\t");
  if (fields.length !== 2 || fields[1] !== `refs/heads/${branch}`) {
    throw new ExactRemoteBranchDeleteError(
      "Remote task branch observation is malformed",
    );
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
  if (typeof value !== "string" || value.trim() === "" || value === "@" ||
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

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
