import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FIRSTMATE_GIT_IDENTITY = Object.freeze({
  name: "ShipMates Firstmate",
  email: "firstmate@shipmates.local",
});

export class ControlledGitCommitAdapter {
  constructor({ runner = runCommand, timeoutMs = 60_000 } = {}) {
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    this.runner = runner;
    this.timeoutMs = timeoutMs;
  }

  async create({ worktreePath, baseHeadSha, branch, changedPaths, message }) {
    const authority = validateAuthority({
      worktreePath, baseHeadSha, branch, changedPaths, message,
    });
    const before = await this.#inspectWorkspace(authority.worktreePath);
    if (before.headSha !== authority.baseHeadSha || before.branch !== authority.branch ||
      before.staged.length !== 0 || before.ignored.length !== 0 ||
      !sameArray(before.all, authority.changedPaths)) {
      throw new ControlledGitCommitError(
        "Commit preflight does not match the exact verified workspace mutation",
      );
    }

    await this.#git(authority.worktreePath, [
      "add", "-A", "--", ...authority.changedPaths,
    ]);
    const staged = await this.#inspectWorkspace(authority.worktreePath);
    if (staged.headSha !== authority.baseHeadSha || staged.branch !== authority.branch ||
      !sameArray(staged.staged, authority.changedPaths) ||
      staged.unstaged.length !== 0 || staged.untracked.length !== 0 ||
      staged.ignored.length !== 0) {
      throw new ControlledGitCommitError(
        "Git index does not contain exactly the authorized changed paths",
      );
    }

    await this.#git(authority.worktreePath, [
      "-c", `user.name=${FIRSTMATE_GIT_IDENTITY.name}`,
      "-c", `user.email=${FIRSTMATE_GIT_IDENTITY.email}`,
      "-c", "commit.gpgSign=false",
      "commit", "--no-verify", "-m", authority.message,
    ]);
    return this.inspectCreated(authority);
  }

  async inspectCreated({ worktreePath, baseHeadSha, branch, changedPaths, message }) {
    const authority = validateAuthority({
      worktreePath, baseHeadSha, branch, changedPaths, message,
    });
    const workspace = await this.#inspectWorkspace(authority.worktreePath);
    if (workspace.branch !== authority.branch || workspace.all.length !== 0 ||
      workspace.ignored.length !== 0 || workspace.headSha === authority.baseHeadSha) {
      throw new ControlledGitCommitError(
        "Worktree does not contain one clean candidate commit",
      );
    }
    const [parents, tree, messageResult, identity, paths] = await Promise.all([
      this.#git(authority.worktreePath, ["rev-list", "--parents", "-n", "1", "HEAD"]),
      this.#git(authority.worktreePath, ["rev-parse", "HEAD^{tree}"]),
      this.#git(authority.worktreePath, ["log", "-1", "--format=%B"]),
      this.#git(authority.worktreePath, [
        "show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD",
      ]),
      this.#git(authority.worktreePath, [
        "diff", "--name-only", "-z", authority.baseHeadSha, workspace.headSha,
      ]),
    ]);
    const parentFields = parents.stdout.trim().split(/\s+/u);
    const identityFields = identity.stdout.trimEnd().split("\0");
    const committedPaths = uniqueSorted(parseNullSeparated(paths.stdout));
    if (parentFields.length !== 2 || parentFields[0] !== workspace.headSha ||
      parentFields[1] !== authority.baseHeadSha ||
      messageResult.stdout.trimEnd() !== authority.message ||
      identityFields.length !== 4 ||
      identityFields[0] !== FIRSTMATE_GIT_IDENTITY.name ||
      identityFields[1] !== FIRSTMATE_GIT_IDENTITY.email ||
      identityFields[2] !== FIRSTMATE_GIT_IDENTITY.name ||
      identityFields[3] !== FIRSTMATE_GIT_IDENTITY.email ||
      !sameArray(committedPaths, authority.changedPaths)) {
      throw new ControlledGitCommitError(
        "Candidate commit does not match its exact durable authority",
      );
    }
    const treeSha = fullSha(tree.stdout.trim(), "commit tree SHA");
    return Object.freeze({
      baseHeadSha: authority.baseHeadSha,
      headSha: fullSha(workspace.headSha, "commit SHA"),
      parentSha: authority.baseHeadSha,
      treeSha,
      branch: authority.branch,
      changedPaths: authority.changedPaths,
      messageSha256: digest(authority.message),
      author: { ...FIRSTMATE_GIT_IDENTITY },
      committer: { ...FIRSTMATE_GIT_IDENTITY },
      clean: true,
      commitCreated: true,
    });
  }

  async #inspectWorkspace(worktreePath) {
    const [head, branch, staged, unstaged, untracked, ignored] = await Promise.all([
      this.#git(worktreePath, ["rev-parse", "HEAD"]),
      this.#git(worktreePath, ["branch", "--show-current"]),
      this.#git(worktreePath, ["diff", "--cached", "--name-only", "-z"]),
      this.#git(worktreePath, ["diff", "--name-only", "-z"]),
      this.#git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
      this.#git(worktreePath, [
        "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
      ]),
    ]);
    const result = {
      headSha: fullSha(head.stdout.trim(), "Git HEAD"),
      branch: requireText(branch.stdout.trim(), "Git branch"),
      staged: uniqueSorted(parseNullSeparated(staged.stdout)),
      unstaged: uniqueSorted(parseNullSeparated(unstaged.stdout)),
      untracked: uniqueSorted(parseNullSeparated(untracked.stdout)),
      ignored: uniqueSorted(parseNullSeparated(ignored.stdout)),
    };
    return {
      ...result,
      all: uniqueSorted([...result.staged, ...result.unstaged, ...result.untracked]),
    };
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
      throw new ControlledGitCommitError(
        `git ${args[0]} failed: ${cause?.stderr?.trim() || cause?.message || "unknown error"}`,
        { cause },
      );
    }
  }
}

export class ControlledGitCommitError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ControlledGitCommitError";
  }
}

async function runCommand(file, args, options) {
  return execFileAsync(file, args, options);
}

function validateAuthority({ worktreePath, baseHeadSha, branch, changedPaths, message }) {
  if (!path.isAbsolute(worktreePath)) throw new TypeError("worktreePath must be absolute");
  const paths = uniqueSorted(changedPaths || []);
  if (!Array.isArray(changedPaths) || paths.length === 0 ||
    paths.length !== changedPaths.length || paths.some(pathIsUnsafe)) {
    throw new TypeError("changedPaths must be unique safe repository-relative paths");
  }
  const commitMessage = requireText(message, "message");
  if (commitMessage.includes("\n") || commitMessage.length > 120) {
    throw new TypeError("message must be one line of at most 120 characters");
  }
  return {
    worktreePath: path.resolve(worktreePath),
    baseHeadSha: fullSha(baseHeadSha, "baseHeadSha"),
    branch: requireText(branch, "branch"),
    changedPaths: paths,
    message: commitMessage,
  };
}

function pathIsUnsafe(value) {
  return typeof value !== "string" || value.trim() === "" ||
    value.startsWith("/") || value.startsWith(":") ||
    value.split("/").includes("..") || /[\p{Cc}\p{Cf}]/u.test(value) ||
    value === ".git" || value.startsWith(".git/") ||
    value === ".shipmates" || value.startsWith(".shipmates/");
}

function parseNullSeparated(value) {
  return value.split("\0").filter(Boolean);
}

function uniqueSorted(values) {
  return Object.freeze([...new Set(values)].sort());
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

function sameArray(first, second) {
  return first.length === second.length &&
    first.every((value, index) => value === second[index]);
}
