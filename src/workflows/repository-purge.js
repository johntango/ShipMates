import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class RepositoryPurgeWorkflow {
  constructor({
    projectStore,
    taskStore,
    stateRoot,
    processRunning = isProcessRunning,
    removeWorktree = removeRegisteredWorktree,
    remove = rm,
    visibility = null,
  } = {}) {
    if (!projectStore || !taskStore || !stateRoot) {
      throw new TypeError("Repository purge requires projectStore, taskStore, and stateRoot");
    }
    this.projectStore = projectStore;
    this.taskStore = taskStore;
    this.stateRoot = path.resolve(stateRoot);
    this.processRunning = processRunning;
    this.removeWorktree = removeWorktree;
    this.remove = remove;
    this.visibility = visibility;
  }

  async preview(query) {
    const repository = await this.projectStore.repository(query);
    const projects = repository.projects;
    const taskIds = [...new Set(projects.flatMap(({ tasks }) => tasks.flatMap((task) => [
      task.taskId,
      ...(task.previousTaskIds || []),
      ...(task.attempts || []).map(({ taskId }) => taskId),
    ])).filter(Boolean))].sort();
    const activeProcesses = [];
    for (const project of projects) {
      for (const task of project.tasks) {
        for (const attempt of task.attempts || []) {
          const pid = attempt.launchReceipt?.pid;
          if (Number.isSafeInteger(pid) && pid > 0 && await this.processRunning(pid)) {
            activeProcesses.push({ projectId: project.id, taskId: attempt.taskId, pid });
          }
        }
      }
    }
    const worktreePaths = [];
    for (const project of projects) {
      if (project.executionPolicy?.worktreePath) {
        worktreePaths.push(path.resolve(project.executionPolicy.worktreePath));
      }
    }
    for (const taskId of taskIds) {
      try {
        const snapshot = await this.taskStore.getSnapshot(taskId);
        if (snapshot.worktree?.status === "leased" && snapshot.worktree.worktreePath) {
          worktreePaths.push(path.resolve(snapshot.worktree.worktreePath));
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const blockers = [];
    if (projects.some(({ protected: value }) => value === true)) {
      blockers.push("repository is protected");
    }
    if (activeProcesses.length > 0) blockers.push("repository has live project processes");
    const facts = {
      repoPath: repository.repoPath,
      projectIds: projects.map(({ id }) => id).sort(),
      taskIds,
      worktreePaths: [...new Set(worktreePaths)].sort(),
      activeProcesses: activeProcesses.sort((left, right) => left.pid - right.pid),
      blockers,
    };
    return {
      schemaVersion: 1,
      ...facts,
      repository: projects[0]?.repo || null,
      projects: projects.map(({ id, name, status }) => ({ id, name, status })),
      eligible: blockers.length === 0,
      confirmationId: digest(facts).slice(0, 16),
      warning: "Purge is permanent and leaves GitHub and the repository checkout unchanged",
    };
  }

  async purge({ query, confirmationId }) {
    const preview = await this.preview(query);
    if (!preview.eligible) {
      throw new RepositoryPurgeError(`Repository purge refused: ${preview.blockers.join("; ")}`);
    }
    if (confirmationId !== preview.confirmationId) {
      throw new RepositoryPurgeError("Repository purge requires the exact current preview confirmation ID");
    }
    for (const worktreePath of preview.worktreePaths) {
      await this.removeWorktree({
        repoPath: preview.repoPath,
        worktreePath,
        stateRoot: this.stateRoot,
      });
    }
    await this.visibility?.release?.(preview);
    await this.#removeArtifacts(preview);
    await this.projectStore.purgeRepository({ repoPath: preview.repoPath });
    return {
      schemaVersion: 1,
      purged: true,
      repoPath: preview.repoPath,
      repository: preview.repository,
      projectNames: preview.projects.map(({ name }) => name),
      removedTaskIds: preview.taskIds,
      removedWorktreePaths: preview.worktreePaths,
      githubChanged: false,
      checkoutChanged: false,
    };
  }

  async #removeArtifacts(preview) {
    const projectIds = preview.projects.map(({ id }) => id);
    await Promise.all([
      ...preview.taskIds.flatMap((taskId) => [
        this.remove(path.join(this.stateRoot, "tasks", taskId), { recursive: true, force: true }),
        this.remove(path.join(this.stateRoot, "demo-worktrees", taskId),
          { recursive: true, force: true }),
      ]),
      ...projectIds.flatMap((projectId) => [
        this.remove(path.join(this.stateRoot, "persistent-project-runs", projectId),
          { recursive: true, force: true }),
        this.remove(path.join(this.stateRoot, "project-agent-jobs", projectId),
          { recursive: true, force: true }),
      ]),
      this.remove(path.join(this.stateRoot, "reviews", "dashboard"),
        { recursive: true, force: true }),
    ]);
    await removeMatchingConversationTurns({
      directory: path.join(this.stateRoot, "firstmate-conversation"),
      needles: [
        preview.repoPath,
        preview.repository,
        ...preview.projectIds,
        ...preview.projects.map(({ name }) => name),
        ...preview.taskIds,
      ].filter(Boolean),
      remove: this.remove,
    });
    await removeMatchingFile({
      target: path.join(this.stateRoot, "active-project.json"),
      needles: preview.taskIds,
      remove: this.remove,
    });
  }
}

export class RepositoryPurgeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RepositoryPurgeError";
  }
}

export function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export async function removeRegisteredWorktree({ repoPath, worktreePath, stateRoot }) {
  const repository = path.resolve(repoPath);
  const worktree = path.resolve(worktreePath);
  const state = path.resolve(stateRoot);
  if (worktree === repository || worktree === state || worktree === path.parse(worktree).root) {
    throw new RepositoryPurgeError(`Unsafe worktree purge target ${worktree}`);
  }
  try { await access(worktree); } catch { return; }
  try {
    await execFileAsync("git", ["-C", repository, "worktree", "remove", "--force", worktree]);
    await execFileAsync("git", ["-C", repository, "worktree", "prune"]);
  } catch (cause) {
    const relative = path.relative(state, worktree);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new RepositoryPurgeError(`Could not remove registered worktree ${worktree}`, { cause });
    }
    await rm(worktree, { recursive: true, force: true });
  }
}

async function removeMatchingConversationTurns({ directory, needles, remove }) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return; else throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^turn-.+\.jsonl?$/u.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const value = await readFile(target, "utf8");
    if (needles.some((needle) => value.includes(needle))) {
      await remove(target, { force: true });
    }
  }
}

async function removeMatchingFile({ target, needles, remove }) {
  let value;
  try { value = await readFile(target, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return; else throw error; }
  if (needles.some((needle) => value.includes(needle))) await remove(target, { force: true });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
