import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class TreehouseAdapterError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TreehouseAdapterError";
  }
}

export class TreehouseWorktreeManager {
  constructor({
    binary = process.env.TREEHOUSE_BIN || "treehouse",
    executeFile = execFileAsync,
    timeoutMs = 60_000,
    homeDirectory = homedir(),
  } = {}) {
    this.binary = binary;
    this.executeFile = executeFile;
    this.timeoutMs = timeoutMs;
    this.homeDirectory = homeDirectory;
  }

  async lease({ repoPath, taskId }) {
    assertAbsolutePath("repoPath", repoPath);
    assertNonEmpty("taskId", taskId);

    const { stdout } = await this.#run(
      this.binary,
      ["get", "--lease", "--lease-holder", taskId],
      { cwd: repoPath },
    );
    const worktreePath = parseLeasePath(stdout);

    return Object.freeze({
      taskId,
      repoPath: path.resolve(repoPath),
      worktreePath,
    });
  }

  async prepareRepository({ repoPath }) {
    assertAbsolutePath("repoPath", repoPath);

    const { stdout: commonDirOutput } = await this.#run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repoPath },
    );
    const commonDirLines = commonDirOutput
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (commonDirLines.length !== 1 || !path.isAbsolute(commonDirLines[0])) {
      throw new TreehouseAdapterError(
        "Treehouse requires a Git version that supports rev-parse --path-format=absolute",
      );
    }

    await this.#run("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
    });
    await this.#run("git", ["remote", "set-head", "origin", "--auto"], {
      cwd: repoPath,
    });
    const { stdout } = await this.#run(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: repoPath },
    );
    const remoteHead = stdout.trim();
    const branch = remoteHead.replace(/^refs\/remotes\/origin\//u, "");
    if (!branch || branch === remoteHead) {
      throw new TreehouseAdapterError(
        `Unexpected origin HEAD symbolic ref: ${remoteHead}`,
      );
    }

    return remoteHead;
  }

  async status({ repoPath }) {
    assertAbsolutePath("repoPath", repoPath);

    const { stdout } = await this.#run(this.binary, ["status"], {
      cwd: repoPath,
    });

    return stdout.trimEnd();
  }

  async list({ repoPath }) {
    assertAbsolutePath("repoPath", repoPath);
    const status = await this.status({ repoPath });
    if (status.trim() === "") {
      return [];
    }
    return status.split(/\r?\n/u).map((line) =>
      parseStatusLine(line, {
        homeDirectory: this.homeDirectory,
      }),
    );
  }

  async findWorktree({ repoPath, worktreePath }) {
    assertAbsolutePath("worktreePath", worktreePath);
    const expectedPath = path.resolve(worktreePath);
    const matches = (await this.list({ repoPath })).filter(
      (entry) => entry.worktreePath === expectedPath,
    );
    if (matches.length !== 1) {
      throw new TreehouseAdapterError(
        `Expected one Treehouse status entry for ${expectedPath}, found ${matches.length}`,
      );
    }
    return matches[0];
  }

  async findLease({ repoPath, taskId, worktreePath }) {
    assertNonEmpty("taskId", taskId);
    const entry = await this.findWorktree({ repoPath, worktreePath });
    if (entry.state !== "leased" || entry.leaseHolder !== taskId) {
      throw new TreehouseAdapterError(
        `Worktree is not leased to ${taskId}: state=${entry.state}, holder=${entry.leaseHolder || "none"}`,
      );
    }
    return entry;
  }

  async inspect({ worktreePath }) {
    assertAbsolutePath("worktreePath", worktreePath);

    const [status, head, branch] = await Promise.all([
      this.#run(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: worktreePath },
      ),
      this.#run("git", ["rev-parse", "HEAD"], { cwd: worktreePath }),
      this.#run("git", ["branch", "--show-current"], { cwd: worktreePath }),
    ]);
    const changes = status.stdout
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    return Object.freeze({
      worktreePath: path.resolve(worktreePath),
      headSha: head.stdout.trim(),
      branch: branch.stdout.trim() || null,
      dirty: changes.length > 0,
      changes,
    });
  }

  async proveNoMutation({ worktreePath, expectedHeadSha }) {
    assertNonEmpty("expectedHeadSha", expectedHeadSha);
    const inspection = await this.inspect({ worktreePath });

    if (inspection.dirty) {
      throw new TreehouseAdapterError(
        `Cannot prove a no-mutation lease: ${worktreePath} is dirty`,
      );
    }
    if (inspection.headSha !== expectedHeadSha) {
      throw new TreehouseAdapterError(
        `Cannot prove a no-mutation lease: expected ${expectedHeadSha}, found ${inspection.headSha}`,
      );
    }

    return Object.freeze({
      kind: "no-mutation",
      verified: true,
      worktreePath: inspection.worktreePath,
      headSha: inspection.headSha,
    });
  }

  async proveExactTreeLanding({
    worktreePath,
    approvedHeadSha,
    mergedCommitSha,
    remoteMainSha,
  }) {
    assertNonEmpty("approvedHeadSha", approvedHeadSha);
    assertNonEmpty("mergedCommitSha", mergedCommitSha);
    assertNonEmpty("remoteMainSha", remoteMainSha);
    const inspection = await this.inspect({ worktreePath });

    if (inspection.dirty || inspection.headSha !== approvedHeadSha) {
      throw new TreehouseAdapterError(
        "The leased worktree no longer matches the approved pull-request head",
      );
    }
    if (remoteMainSha !== mergedCommitSha) {
      throw new TreehouseAdapterError(
        "Remote main does not point to the reported merge commit",
      );
    }

    const [approvedTree, mergedTree] = await Promise.all([
      this.#run("git", ["rev-parse", `${approvedHeadSha}^{tree}`], {
        cwd: worktreePath,
      }),
      this.#run("git", ["rev-parse", `${mergedCommitSha}^{tree}`], {
        cwd: worktreePath,
      }),
    ]);
    if (approvedTree.stdout.trim() !== mergedTree.stdout.trim()) {
      throw new TreehouseAdapterError(
        "The squash-merge tree does not match the approved pull-request tree",
      );
    }

    return Object.freeze({
      kind: "exact-tree-landing",
      verified: true,
      worktreePath: inspection.worktreePath,
      headSha: inspection.headSha,
      mergedCommitSha,
      remoteMainSha,
      treeSha: approvedTree.stdout.trim(),
    });
  }

  async returnLease({ worktreePath, proof }) {
    assertAbsolutePath("worktreePath", worktreePath);
    const acceptedProofKinds = new Set([
      "no-mutation",
      "exact-tree-landing",
    ]);
    if (
      proof?.verified !== true ||
      !acceptedProofKinds.has(proof.kind) ||
      proof.worktreePath !== path.resolve(worktreePath)
    ) {
      throw new TreehouseAdapterError(
        "Returning a Treehouse lease requires a matching verified proof",
      );
    }

    const current = await this.inspect({ worktreePath });
    if (current.dirty || current.headSha !== proof.headSha) {
      throw new TreehouseAdapterError(
        "The worktree changed after proof; refusing to return the lease",
      );
    }

    await this.#run(this.binary, ["return", path.resolve(worktreePath)]);
  }

  async #run(file, args, options = {}) {
    try {
      return await this.executeFile(file, args, {
        encoding: "utf8",
        timeout: this.timeoutMs,
        ...options,
      });
    } catch (cause) {
      const detail = cause?.stderr?.trim() || cause?.message || "unknown error";
      throw new TreehouseAdapterError(
        `${file} ${args.join(" ")} failed: ${detail}`,
        { cause },
      );
    }
  }
}

function parseLeasePath(stdout) {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 1 || !path.isAbsolute(lines[0])) {
    throw new TreehouseAdapterError(
      "treehouse get --lease must print exactly one absolute path to stdout",
    );
  }

  return path.resolve(lines[0]);
}

function parseStatusLine(line, { homeDirectory }) {
  const holderMatch = line.match(/\s{2,}\(held by (.+)\)\s*$/u);
  const body = holderMatch ? line.slice(0, holderMatch.index) : line;
  const match = body.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/u);
  if (!match) {
    throw new TreehouseAdapterError(
      `Could not parse Treehouse status line: ${line}`,
    );
  }
  const [, slot, state, displayedPath] = match;
  const leaseHolder = holderMatch?.[1];
  if (!new Set(["available", "leased", "in-use"]).has(state)) {
    throw new TreehouseAdapterError(`Unknown Treehouse worktree state: ${state}`);
  }
  const expandedPath = displayedPath.startsWith("~/")
    ? path.join(homeDirectory, displayedPath.slice(2))
    : displayedPath;
  if (!path.isAbsolute(expandedPath)) {
    throw new TreehouseAdapterError(
      `Treehouse status path is not absolute: ${displayedPath}`,
    );
  }
  return Object.freeze({
    slot: Number.parseInt(slot, 10),
    state,
    worktreePath: path.resolve(expandedPath),
    leaseHolder: leaseHolder || null,
  });
}

function assertAbsolutePath(label, value) {
  assertNonEmpty(label, value);
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
}

function assertNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
