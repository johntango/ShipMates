import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { TreehouseWorktreeManager } from "../adapters/treehouse.js";

const execFileAsync = promisify(execFile);

export class SystemDoctorObserver {
  constructor({ executeFile = execFileAsync, treehouse = new TreehouseWorktreeManager() } = {}) {
    this.executeFile = executeFile;
    this.treehouse = treehouse;
  }

  async repository(repoPath) {
    const resolved = path.resolve(repoPath);
    try {
      await access(resolved);
    } catch (error) {
      if (error.code === "ENOENT") return { path: resolved, exists: false };
      return { path: resolved, exists: null, error: error.message };
    }
    try {
      const [head, status] = await Promise.all([
        this.#git(resolved, ["rev-parse", "HEAD"]),
        this.#git(resolved, ["status", "--porcelain=v1", "--untracked-files=all"]),
      ]);
      const changes = status.split(/\r?\n/u).filter(Boolean);
      return { path: resolved, exists: true, headSha: head.trim(), clean: changes.length === 0, changes };
    } catch (error) {
      return { path: resolved, exists: true, error: error.message };
    }
  }

  async worktrees(repoPath) {
    try {
      return { repoPath: path.resolve(repoPath), entries: await this.treehouse.list({ repoPath }) };
    } catch (error) {
      return { repoPath: path.resolve(repoPath), entries: null, error: error.message };
    }
  }

  async worktree(worktreePath) {
    try {
      return await this.treehouse.inspect({ worktreePath });
    } catch (error) {
      return { worktreePath: path.resolve(worktreePath), error: error.message };
    }
  }

  async process(pid) {
    try {
      process.kill(pid, 0);
      return { pid, running: true };
    } catch (error) {
      if (error.code === "EPERM") return { pid, running: true, permissionLimited: true };
      if (error.code === "ESRCH") return { pid, running: false };
      return { pid, running: null, error: error.message };
    }
  }

  async #git(cwd, args) {
    const { stdout } = await this.executeFile("git", args, {
      cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }
}
