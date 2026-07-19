import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const activeTaskStatuses = new Set(["claimed", "dispatched"]);

export class RepositoryDeleteWorkflow {
  constructor({
    projectStore,
    stateRoot,
    inspectRepository = inspectGitRepository,
    trashRoot = path.join(homedir(), ".Trash"),
    move = rename,
    remove = rm,
    clock = () => new Date(),
  } = {}) {
    if (!projectStore || !stateRoot) {
      throw new TypeError("Repository deletion requires projectStore and stateRoot");
    }
    this.projectStore = projectStore;
    this.stateRoot = path.resolve(stateRoot);
    this.inspectRepository = inspectRepository;
    this.trashRoot = path.resolve(trashRoot);
    this.move = move;
    this.remove = remove;
    this.clock = clock;
  }

  async preview(query) {
    const repository = await this.projectStore.repository(query);
    const inspection = await this.inspectRepository(repository.repoPath);
    const protectedProjects = repository.projects.filter((project) => project.protected === true);
    const activeTasks = repository.projects.flatMap((project) => project.tasks
      .filter(({ status }) => activeTaskStatuses.has(status))
      .map((task) => ({ projectId: project.id, projectName: project.name,
        planTaskId: task.id, taskId: task.taskId, status: task.status })));
    const blockers = [];
    if (protectedProjects.length > 0) blockers.push("repository is protected");
    if (!inspection.exists) blockers.push("repository directory does not exist");
    if (!inspection.isGitRepository) blockers.push("target is not a Git repository");
    if (activeTasks.length > 0) blockers.push("repository has active project tasks");
    const warnings = [];
    if (!inspection.clean) warnings.push("repository has uncommitted or untracked files");
    if (inspection.unpushedCommitCount > 0) warnings.push("repository has commits absent from every configured remote");
    if (!inspection.hasRemote) warnings.push("repository has no configured Git remote");
    const facts = {
      repoPath: repository.repoPath,
      projectIds: repository.projects.map(({ id }) => id).sort(),
      headSha: inspection.headSha,
      clean: inspection.clean,
      unpushedCommitCount: inspection.unpushedCommitCount,
      blockers,
      warnings,
    };
    return {
      schemaVersion: 1,
      ...facts,
      repository: repository.projects[0]?.repo || null,
      projects: repository.projects.map(({ id, name, status, protected: protectedValue }) =>
        ({ id, name, status, protected: protectedValue === true })),
      artifactTaskIds: [...new Set(repository.projects.flatMap(({ tasks }) => tasks.flatMap(
        ({ taskId, previousTaskIds = [] }) => [taskId, ...previousTaskIds],
      )).filter(Boolean))],
      activeTasks,
      eligible: blockers.length === 0,
      confirmationId: digest(facts).slice(0, 16),
    };
  }

  async delete({ query, confirmationId }) {
    const preview = await this.preview(query);
    if (!preview.eligible) {
      throw new RepositoryDeleteError(`Repository deletion refused: ${preview.blockers.join("; ")}`);
    }
    if (confirmationId !== preview.confirmationId) {
      throw new RepositoryDeleteError("Repository deletion requires the exact current preview confirmation ID");
    }
    await mkdir(this.trashRoot, { recursive: true, mode: 0o700 });
    const deletedAt = this.clock().toISOString();
    const trashPath = path.join(this.trashRoot,
      `${path.basename(preview.repoPath)}-${deletedAt.replaceAll(/[:.]/gu, "-")}-${preview.confirmationId}`);
    await this.move(preview.repoPath, trashPath);
    const receipt = {
      schemaVersion: 1,
      deletedAt,
      repository: preview.repository,
      repoPath: preview.repoPath,
      trashPath,
      confirmationId: preview.confirmationId,
      warningsAccepted: preview.warnings,
      projects: preview.projects.map(({ id, name }) => ({ id, name })),
      recoverable: true,
    };
    await this.projectStore.recordRepositoryDeletion({ repoPath: preview.repoPath, receipt });
    await this.#removeProjectArtifacts(preview);
    return receipt;
  }

  async #removeProjectArtifacts(preview) {
    const projectIds = preview.projects.map(({ id }) => id);
    await Promise.all([
      ...preview.artifactTaskIds.map((taskId) => this.remove(path.join(this.stateRoot, "tasks", taskId), { recursive: true, force: true })),
      ...projectIds.flatMap((projectId) => [
        this.remove(path.join(this.stateRoot, "persistent-project-runs", projectId), { recursive: true, force: true }),
        this.remove(path.join(this.stateRoot, "project-agent-jobs", projectId), { recursive: true, force: true }),
      ]),
    ]);
  }
}

export class RepositoryDeleteError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryDeleteError";
  }
}

export async function inspectGitRepository(repoPath) {
  const resolved = path.resolve(repoPath);
  try { await access(resolved); } catch { return missingInspection(); }
  try {
    const [{ stdout: topLevel }, { stdout: status }, { stdout: head }, { stdout: remotes }] = await Promise.all([
      execFileAsync("git", ["-C", resolved, "rev-parse", "--show-toplevel"]),
      execFileAsync("git", ["-C", resolved, "status", "--porcelain=v1"]),
      execFileAsync("git", ["-C", resolved, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", resolved, "remote"]),
    ]);
    const hasRemote = remotes.trim().length > 0;
    let unpushedCommitCount = 0;
    if (hasRemote) {
      const { stdout } = await execFileAsync("git", ["-C", resolved, "rev-list", "--count", "--branches", "--not", "--remotes"]);
      unpushedCommitCount = Number.parseInt(stdout.trim(), 10) || 0;
    }
    return {
      exists: true,
      isGitRepository: path.resolve(topLevel.trim()) === resolved,
      clean: status.trim().length === 0,
      headSha: head.trim(),
      hasRemote,
      unpushedCommitCount,
    };
  } catch {
    return { ...missingInspection(), exists: true };
  }
}

function missingInspection() {
  return { exists: false, isGitRepository: false, clean: false,
    headSha: null, hasRemote: false, unpushedCommitCount: 0 };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
