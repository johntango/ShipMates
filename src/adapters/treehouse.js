import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bundledTreehouseCandidate = "/private/tmp/treehouse-v2.0.0/treehouse";

export class TreehouseAdapterError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TreehouseAdapterError";
  }
}

export class TreehouseWorktreeManager {
  constructor({
    binary = defaultTreehouseBinary(),
    executeFile = execFileAsync,
    timeoutMs = 60_000,
    homeDirectory = homedir(),
    environment = process.env,
    gitDirectory = process.env.TREEHOUSE_GIT_DIRECTORY || "/opt/homebrew/bin",
    demoWorktreeRoot = process.env.SHIPMATES_STATE_DIR
      ? path.join(process.env.SHIPMATES_STATE_DIR, "demo-worktrees")
      : path.resolve(".shipmates/demo-worktrees"),
  } = {}) {
    this.binary = binary;
    this.executeFile = executeFile;
    this.timeoutMs = timeoutMs;
    this.homeDirectory = homeDirectory;
    this.environment = withPreferredPath(environment, gitDirectory);
    this.demoWorktreeRoot = path.resolve(demoWorktreeRoot);
  }

  async lease({ repoPath, taskId, localOnly = false }) {
    assertAbsolutePath("repoPath", repoPath);
    assertNonEmpty("taskId", taskId);

    if (localOnly) {
      const worktreePath = path.join(this.demoWorktreeRoot, taskId);
      await mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
      const { stdout: originOutput } = await this.#run("git", ["remote", "get-url", "origin"], { cwd: repoPath });
      await this.#run("git", ["clone", "--no-hardlinks", "--no-checkout", repoPath, worktreePath], { cwd: repoPath });
      await this.#run("git", ["remote", "set-url", "origin", originOutput.trim()], { cwd: worktreePath });
      await this.#run("git", ["switch", "--detach", "HEAD"], { cwd: worktreePath });
      return Object.freeze({ taskId, repoPath: path.resolve(repoPath), worktreePath });
    }

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

  async prepareRepository({ repoPath, localOnly = false }) {
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

    if (localOnly) {
      const { stdout: branchOutput } = await this.#run(
        "git", ["branch", "--show-current"], { cwd: repoPath },
      );
      const branch = branchOutput.trim();
      if (!branch) throw new TreehouseAdapterError("Local-only demo repository must be on a branch");
      await this.#run("git", ["update-ref", `refs/remotes/origin/${branch}`, "HEAD"], { cwd: repoPath });
      await this.#run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`], { cwd: repoPath });
      return `refs/remotes/origin/${branch}`;
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

  async alignLeaseBase({ worktreePath, expectedHeadSha }) {
    assertAbsolutePath("worktreePath", worktreePath);
    assertFullSha("expectedHeadSha", expectedHeadSha);
    const before = await this.inspect({ worktreePath });
    if (before.dirty) {
      throw new TreehouseAdapterError(
        "Cannot align a dirty Treehouse lease to the task base",
      );
    }
    if (before.headSha === expectedHeadSha) return before;
    await this.#run("git", ["cat-file", "-e", `${expectedHeadSha}^{commit}`], {
      cwd: worktreePath,
    });
    await this.#run("git", ["switch", "--detach", expectedHeadSha], {
      cwd: worktreePath,
    });
    const after = await this.inspect({ worktreePath });
    if (after.dirty || after.headSha !== expectedHeadSha || after.branch !== null) {
      throw new TreehouseAdapterError(
        "Treehouse lease did not align to the exact detached task base",
      );
    }
    return after;
  }

  async listChangedPaths({ worktreePath }) {
    return (await this.inspectChangedPaths({ worktreePath })).all;
  }

  async inspectChangedPaths({ worktreePath }) {
    assertAbsolutePath("worktreePath", worktreePath);
    const [unstaged, staged, untracked, ignored] = await Promise.all([
      this.#run("git", ["diff", "--name-only", "-z"], { cwd: worktreePath }),
      this.#run("git", ["diff", "--cached", "--name-only", "-z"], {
        cwd: worktreePath,
      }),
      this.#run("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: worktreePath,
      }),
      this.#run(
        "git",
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        { cwd: worktreePath },
      ),
    ]);
    const result = {
      staged: uniqueSorted(parseNullSeparated(staged.stdout)),
      unstaged: uniqueSorted(parseNullSeparated(unstaged.stdout)),
      untracked: uniqueSorted(parseNullSeparated(untracked.stdout)),
      ignored: uniqueSorted(parseNullSeparated(ignored.stdout)),
    };
    return Object.freeze({
      ...result,
      all: uniqueSorted([...result.staged, ...result.unstaged, ...result.untracked]),
    });
  }

  async prepareTaskBranch({
    worktreePath, expectedHeadSha, branch, expectedChangedPaths,
  }) {
    const authority = validateBranchAuthority({
      worktreePath, expectedHeadSha, branch, expectedChangedPaths,
    });
    const before = await this.#inspectBranchAuthority(authority);
    if (before.branch !== null) {
      throw new TreehouseAdapterError(
        `Task branch preparation requires detached HEAD, found ${before.branch}`,
      );
    }
    await this.#run("git", ["check-ref-format", "--branch", authority.branch], {
      cwd: authority.worktreePath,
    });
    await this.#run("git", ["switch", "--create", authority.branch, "--no-track"], {
      cwd: authority.worktreePath,
    });
    return this.inspectPreparedTaskBranch(authority);
  }

  async inspectPreparedTaskBranch({
    worktreePath, expectedHeadSha, branch, expectedChangedPaths,
  }) {
    const authority = validateBranchAuthority({
      worktreePath, expectedHeadSha, branch, expectedChangedPaths,
    });
    const inspection = await this.#inspectBranchAuthority(authority);
    if (inspection.branch !== authority.branch) {
      throw new TreehouseAdapterError(
        `Expected prepared task branch ${authority.branch}, found ${inspection.branch || "detached HEAD"}`,
      );
    }
    return Object.freeze({
      branch: inspection.branch,
      headSha: inspection.headSha,
      dirty: inspection.dirty,
      changedPaths: authority.expectedChangedPaths,
    });
  }

  async #inspectBranchAuthority(authority) {
    const [inspection, paths] = await Promise.all([
      this.inspect({ worktreePath: authority.worktreePath }),
      this.inspectChangedPaths({ worktreePath: authority.worktreePath }),
    ]);
    if (inspection.headSha !== authority.expectedHeadSha ||
      paths.staged.length !== 0 || paths.ignored.length !== 0 ||
      !sameArray(paths.all, authority.expectedChangedPaths) ||
      inspection.dirty !== (authority.expectedChangedPaths.length > 0)) {
      throw new TreehouseAdapterError(
        "Task branch preparation does not match the exact leased workspace",
      );
    }
    return inspection;
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

  async fetchExactCommit({ worktreePath, commitSha, remote = "origin" }) {
    assertAbsolutePath("worktreePath", worktreePath);
    assertFullSha("commitSha", commitSha);
    assertNonEmpty("remote", remote);
    if (!/^[A-Za-z0-9._-]+$/u.test(remote)) {
      throw new TypeError("remote must be a safe Git remote name");
    }

    await this.#run(
      "git",
      ["fetch", "--no-tags", "--no-recurse-submodules", remote, commitSha],
      { cwd: worktreePath },
    );
    await this.#run("git", ["cat-file", "-e", `${commitSha}^{commit}`], {
      cwd: worktreePath,
    });
    return Object.freeze({ commitSha, remote });
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
        env: this.environment,
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

function defaultTreehouseBinary() {
  if (process.env.TREEHOUSE_BIN) return process.env.TREEHOUSE_BIN;
  return existsSync(bundledTreehouseCandidate) ? bundledTreehouseCandidate : "treehouse";
}

function withPreferredPath(environment, directory) {
  const result = { ...environment };
  const entries = String(result.PATH || "").split(path.delimiter).filter(Boolean);
  result.PATH = [directory, ...entries.filter((entry) => entry !== directory)]
    .join(path.delimiter);
  return result;
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

function assertFullSha(label, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TypeError(`${label} must be a full 40-character hexadecimal SHA`);
  }
}

function validateBranchAuthority({
  worktreePath, expectedHeadSha, branch, expectedChangedPaths,
}) {
  assertAbsolutePath("worktreePath", worktreePath);
  assertFullSha("expectedHeadSha", expectedHeadSha);
  assertNonEmpty("branch", branch);
  if (!/^agent\/[a-z0-9][a-z0-9._-]{2,63}$/u.test(branch)) {
    throw new TypeError("branch must be a deterministic agent task branch");
  }
  const paths = uniqueSorted(expectedChangedPaths || []);
  if (!Array.isArray(expectedChangedPaths) || paths.length !== expectedChangedPaths.length ||
    paths.some((value) => typeof value !== "string" || value.trim() === "" ||
      value.startsWith("/") || value.split("/").includes("..") ||
      value === ".git" || value.startsWith(".git/") ||
      value === ".shipmates" || value.startsWith(".shipmates/"))) {
    throw new TypeError("expectedChangedPaths must be an exact safe path set");
  }
  return {
    worktreePath: path.resolve(worktreePath),
    expectedHeadSha: expectedHeadSha.toLowerCase(),
    branch,
    expectedChangedPaths: paths,
  };
}

function parseNullSeparated(value) {
  return value.split("\0").filter(Boolean);
}

function uniqueSorted(values) {
  return Object.freeze([...new Set(values)].sort());
}

function sameArray(first, second) {
  return first.length === second.length &&
    first.every((value, index) => value === second[index]);
}
