import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertProjectInvariants } from "./project-invariants.js";

export class ProjectStore {
  #mutation = Promise.resolve();

  constructor({ rootDir = path.resolve(".shipmates"), clock = () => new Date() } = {}) {
    this.target = path.join(path.resolve(rootDir), "projects.json");
    this.clock = clock;
  }

  async list({ includeArchived = false } = {}) {
    const document = await this.#read();
    return includeArchived ? document.projects : document.projects.filter(({ status }) => status !== "archived");
  }

  async get(projectId) {
    return (await this.list({ includeArchived: true })).find(({ id }) => id === projectId) || null;
  }

  async repository(query) {
    const projects = await this.list({ includeArchived: true });
    const matches = matchProjects(projects, query);
    if (matches.length === 0) throw new Error(`No project or repository matched ${query}`);
    const paths = [...new Set(matches.map(({ repoPath }) => path.resolve(repoPath)))];
    if (paths.length !== 1) throw new Error(`Repository selection matched ${paths.length} repositories`);
    const repoPath = paths[0];
    return {
      repoPath,
      projects: projects.filter((project) => path.resolve(project.repoPath) === repoPath),
    };
  }

  async setRepositoryProtected({ query, protected: protectedValue = true }) {
    const { repoPath } = await this.repository(query);
    const document = await this.#read();
    const projects = document.projects.filter((project) => path.resolve(project.repoPath) === repoPath);
    const now = this.clock().toISOString();
    for (const project of projects) {
      project.protected = protectedValue === true;
      project.updatedAt = now;
    }
    await this.#write(document);
    return { repoPath, protected: protectedValue === true, projects };
  }

  async recordRepositoryDeletion({ repoPath, receipt }) {
    const resolvedPath = path.resolve(repoPath);
    const document = await this.#read();
    const projects = document.projects.filter((project) => path.resolve(project.repoPath) === resolvedPath);
    if (projects.length === 0) throw new Error(`No projects exist for repository ${resolvedPath}`);
    if (projects.some((project) => project.protected === true)) {
      throw new Error(`Repository ${resolvedPath} is protected`);
    }
    const ids = new Set(projects.map(({ id }) => id));
    document.projects = document.projects.filter(({ id }) => !ids.has(id));
    document.repositoryDeletionReceipts ||= [];
    document.repositoryDeletionReceipts.push(structuredClone(receipt));
    if (ids.has(document.activeProjectId)) {
      document.activeProjectId = document.projects.find(({ status }) => status !== "archived")?.id || null;
    }
    await this.#write(document);
    return { projects, receipt };
  }

  async active() {
    const document = await this.#read();
    return document.projects.find(({ id, status }) => id === document.activeProjectId && status !== "archived") || null;
  }

  async describeTask(taskId) {
    for (const project of await this.list({ includeArchived: true })) {
      const task = project.tasks.find((candidate) => candidate.taskId === taskId ||
        candidate.attempts.some((attempt) => attempt.taskId === taskId));
      if (task) return {
        projectId: project.id,
        projectName: project.name,
        taskName: task.title,
        planTaskId: task.id,
        ownerName: project.executionPolicy?.mode === "persistent_project"
          ? `ShipMates Project: ${project.name}` : "ShipMates Firstmate",
      };
    }
    return null;
  }

  async describeAttempt(taskId) {
    const context = await this.describeTask(taskId);
    if (!context) return null;
    const project = await this.get(context.projectId);
    const task = project.tasks.find(({ id }) => id === context.planTaskId);
    return { ...context, attempt: task.attempts.find((attempt) => attempt.taskId === taskId) || null };
  }

  async activate(query) {
    const document = await this.#read();
    const matches = matchProjects(document.projects, query);
    if (matches.length !== 1) throw new Error(`Project selection matched ${matches.length} projects`);
    document.activeProjectId = matches[0].id;
    await this.#write(document);
    return matches[0];
  }

  async pauseMatching(query) {
    const document = await this.#read();
    const matches = matchProjects(document.projects, query, { includeObjective: true });
    if (matches.length !== 1) throw new Error(`Project selection matched ${matches.length} projects`);
    matches[0].status = "paused";
    matches[0].updatedAt = this.clock().toISOString();
    await this.#write(document);
    return matches[0];
  }

  async remove(projectId) {
    const document = await this.#read();
    const index = document.projects.findIndex(({ id }) => id === projectId);
    if (index < 0) throw new Error(`Unknown project ${projectId}`);
    const project = document.projects[index];
    if (project.tasks.some(({ taskId, status }) => taskId || status === "dispatched")) {
      throw new Error(`Cannot remove project ${project.name} because it has dispatched task history`);
    }
    document.projects.splice(index, 1);
    if (document.activeProjectId === projectId) {
      document.activeProjectId = document.projects[0]?.id || null;
    }
    await this.#write(document);
    return project;
  }

  async ensureRepository({ name, repo, repoPath, baseSha }) {
    const document = await this.#read();
    let project = document.projects.find((candidate) =>
      candidate.repo === repo && candidate.repoPath === path.resolve(repoPath));
    if (!project) {
      project = normalizeProject({
        id: `project-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        name, repo, repoPath: path.resolve(repoPath), baseSha,
        objective: "", status: "active", tasks: [],
        createdAt: this.clock().toISOString(), updatedAt: this.clock().toISOString(),
      });
      document.projects.push(project);
    }
    document.activeProjectId ||= project.id;
    await this.#write(document);
    return project;
  }

  async create({ name, repo, repoPath, baseSha, objective = "" }) {
    const document = await this.#read();
    const normalizedName = requireText("name", name);
    const resolvedPath = path.resolve(repoPath);
    if (document.projects.some((project) =>
      project.name.toLowerCase() === normalizedName.toLowerCase() &&
      project.repoPath === resolvedPath)) {
      throw new Error(`Project ${normalizedName} already exists in ${resolvedPath}`);
    }
    const now = this.clock().toISOString();
    const project = normalizeProject({
      id: `project-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      name: normalizedName,
      repo: requireText("repo", repo),
      repoPath: resolvedPath,
      baseSha: requireText("baseSha", baseSha),
      objective: typeof objective === "string" ? objective.trim() : "",
      status: "active",
      tasks: [],
      createdAt: now,
      updatedAt: now,
    });
    document.projects.push(project);
    document.activeProjectId = project.id;
    await this.#write(document);
    return project;
  }

  async savePlan({ projectId, objective, tasks }) {
    const document = await this.#read();
    const index = document.projects.findIndex(({ id }) => id === projectId);
    if (index < 0) throw new Error(`Unknown project ${projectId}`);
    const project = document.projects[index];
    project.objective = requireText("objective", objective);
    const nextTasks = tasks.map((task, taskIndex) => normalizePlanTask(task, taskIndex));
    const nextById = new Map(nextTasks.map((task) => [task.id, task]));
    for (const existing of project.tasks) {
      if (existing.attempts.length === 0) continue;
      const retained = nextById.get(existing.id);
      if (!retained) {
        throw new Error(`Cannot remove planned task ${existing.id} because it has execution attempts`);
      }
      retained.status = existing.status;
      retained.taskId = existing.taskId;
      retained.previousTaskIds = [...existing.previousTaskIds];
      retained.attempts = structuredClone(existing.attempts);
      retained.blockingReason = existing.blockingReason;
    }
    project.tasks = nextTasks;
    project.status = "planning";
    project.updatedAt = this.clock().toISOString();
    await this.#write(document);
    return project;
  }

  async clearPlan(projectId) {
    return this.#updateProject(projectId, (project) => {
      if (project.tasks.some(({ status }) => status === "dispatched")) {
        throw new Error("Cannot clear a plan with dispatched tasks");
      }
      project.objective = "";
      project.tasks = [];
      project.status = "active";
    });
  }

  async approve(projectId) {
    return this.#updateProject(projectId, (project) => {
      if (project.tasks.length === 0) throw new Error("Cannot approve a project without a plan");
      project.status = "approved";
    });
  }

  async setPaused(projectId, paused) {
    return this.#updateProject(projectId, (project) => {
      if (paused) project.status = "paused";
      else project.status = project.tasks.length > 0 ? "approved" : "active";
    });
  }

  async setExecutionPolicy({ projectId, policy }) {
    return this.#updateProject(projectId, (project) => {
      project.executionPolicy = normalizeExecutionPolicy(policy);
    });
  }

  async setDemoMode({ projectId, enabled = true }) {
    return this.#updateProject(projectId, (project) => {
      project.demoMode = enabled === true;
    });
  }

  async archive({ projectId, receipt }) {
    return this.#updateProject(projectId, (project) => {
      if (!receipt || receipt.schemaVersion !== 1 || receipt.projectId !== project.id) {
        throw new TypeError("Archive receipt must match the project");
      }
      project.status = "archived";
      project.archivedAt = receipt.archivedAt;
      project.archiveReceipt = structuredClone(receipt);
      project.tasks = project.tasks.map(({ id, title, status, dependsOn }) => ({
        id, title, status, dependsOn, description: "", taskId: null,
        previousTaskIds: [], attempts: [], blockingReason: null,
      }));
      project.objective = "";
      project.executionPolicy = null;
      project.demoMode = false;
    });
  }

  async prioritize({ projectId, planTaskId, direction }) {
    if (!new Set(["up", "down"]).has(direction)) throw new TypeError("direction must be up or down");
    return this.#updateProject(projectId, (project) => {
      const index = project.tasks.findIndex(({ id }) => id === planTaskId);
      if (index < 0) throw new Error(`Unknown planned task ${planTaskId}`);
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= project.tasks.length) return;
      [project.tasks[index], project.tasks[target]] = [project.tasks[target], project.tasks[index]];
    });
  }

  async nextReady(projectId) {
    const project = await this.get(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    if (project.status !== "approved") throw new Error("Project plan must be approved and resumed before dispatch");
    const complete = new Set(project.tasks.filter(({ status }) => status === "completed").map(({ id }) => id));
    return project.tasks.find((task) =>
      new Set(["planned", "ready"]).has(task.status) && task.dependsOn.every((id) => complete.has(id))) || null;
  }

  async claimNextReady(projectId) {
    let claimed = null;
    await this.#updateProject(projectId, (project) => {
      if (project.status !== "approved") {
        throw new Error("Project plan must be approved and resumed before dispatch");
      }
      const complete = new Set(project.tasks.filter(({ status }) => status === "completed").map(({ id }) => id));
      claimed = project.tasks.find((task) =>
        new Set(["planned", "ready"]).has(task.status) && task.dependsOn.every((id) => complete.has(id))) || null;
      if (claimed) claimed.status = "claimed";
    });
    return claimed ? structuredClone(claimed) : null;
  }

  async recoverOrphanedClaims(projectId) {
    const recovered = [];
    await this.#updateProject(projectId, (project) => {
      for (const task of project.tasks) {
        if (task.status !== "claimed" || task.taskId !== null) continue;
        task.status = "planned";
        task.blockingReason = null;
        recovered.push({ id: task.id, title: task.title });
      }
    });
    return structuredClone(recovered);
  }

  async dependencyTaskId({ projectId, planTaskId }) {
    const project = await this.get(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    const task = project.tasks.find(({ id }) => id === planTaskId);
    if (!task) throw new Error(`Unknown planned task ${planTaskId}`);
    if (task.dependsOn.length === 0) return null;
    const dependencies = task.dependsOn.map((id) => project.tasks.find((candidate) => candidate.id === id));
    if (dependencies.some((dependency) =>
      !dependency || dependency.status !== "completed" || !dependency.taskId)) {
      throw new Error(`Planned task ${planTaskId} has an incomplete dependency`);
    }
    return dependencies.at(-1).taskId;
  }

  async updateTaskStatus({ projectId, planTaskId, status, blockingReason = null }) {
    return this.#updateProject(projectId, (project) => {
      const task = project.tasks.find(({ id }) => id === planTaskId);
      if (!task) throw new Error(`Unknown planned task ${planTaskId}`);
      task.status = status;
      task.blockingReason = status === "blocked" && typeof blockingReason === "string"
        ? blockingReason.trim() || null : null;
      const attempt = task.attempts.find(({ taskId }) => taskId === task.taskId);
      if (attempt) {
        attempt.status = status;
        attempt.blockingReason = task.blockingReason;
        attempt.completedAt = new Set(["completed", "blocked"]).has(status)
          ? this.clock().toISOString() : null;
      }
    });
  }

  async resetBlockedTask({ projectId, planTaskId }) {
    return this.#updateProject(projectId, (project) => {
      const task = project.tasks.find(({ id }) => id === planTaskId);
      if (!task || task.status !== "blocked") throw new Error("Only a blocked planned task can be reset");
      if (task.taskId) task.previousTaskIds = [...new Set([...(task.previousTaskIds || []), task.taskId])];
      task.taskId = null;
      task.status = "planned";
      task.blockingReason = null;
    });
  }

  async detachUnstartedAttempt({ projectId, planTaskId, taskId }) {
    return this.#updateProject(projectId, (project) => {
      const index = project.tasks.findIndex(({ id }) => id === planTaskId);
      if (index < 0) throw new Error(`Unknown planned task ${planTaskId}`);
      const task = project.tasks[index];
      if (task.taskId !== taskId || !new Set(["claimed", "dispatched"]).has(task.status)) {
        throw new Error("Only the current unstarted attempt can be detached");
      }
      task.attempts = task.attempts.filter((attempt) => attempt.taskId !== taskId);
      task.taskId = null;
      task.previousTaskIds = task.attempts.map((attempt) => attempt.taskId);
      task.status = "planned";
      task.blockingReason = null;
      if (project.objective === "" && task.description === "" && /^plan-\d+$/u.test(task.id) &&
        task.attempts.length === 0) {
        project.tasks.splice(index, 1);
      }
    });
  }

  async attachTask({ projectId, taskId, title, planTaskId = null }) {
    return this.#updateProject(projectId, (project) => {
      const planned = planTaskId
        ? project.tasks.find((task) => task.id === planTaskId)
        : project.tasks.find((task) => !task.taskId && task.title === title);
      if (planTaskId && !planned) throw new Error(`Unknown planned task ${planTaskId}`);
      if (planned && !new Set(["planned", "ready", "claimed", "blocked"]).has(planned.status)) {
        throw new Error(`Planned task ${planned.id} is already ${planned.status}; resume its existing task instead`);
      }
      if (!planTaskId && !planned && project.tasks.length > 0) {
        throw new Error("Unplanned work cannot be attached to a project with a saved plan");
      }
      if (planned) {
        if (planned.taskId === taskId) return;
        if (planned.attempts.some((attempt) => attempt.taskId === taskId)) {
          throw new Error(`Task ${taskId} is already recorded as an attempt of ${planned.id}`);
        }
        if (planned.taskId && planned.taskId !== taskId) {
          planned.previousTaskIds = [...new Set([...(planned.previousTaskIds || []), planned.taskId])];
        }
        planned.taskId = taskId;
        planned.status = "dispatched";
        planned.blockingReason = null;
        planned.attempts.push({
          taskId, status: "dispatched", startedAt: this.clock().toISOString(),
          completedAt: null, blockingReason: null,
        });
      } else {
        project.tasks.push(normalizePlanTask({ title, status: "dispatched", taskId }, project.tasks.length));
      }
    });
  }

  async #read() {
    try {
      const value = JSON.parse(await readFile(this.target, "utf8"));
      if (value?.schemaVersion === 1 && Array.isArray(value.projects)) {
        value.projects = value.projects.map((project) => normalizeProject(project));
        value.repositoryDeletionReceipts = Array.isArray(value.repositoryDeletionReceipts)
          ? value.repositoryDeletionReceipts : [];
        return value;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return { schemaVersion: 1, activeProjectId: null, projects: [], repositoryDeletionReceipts: [] };
  }

  async #updateProject(projectId, update) {
    const operation = this.#mutation.then(async () => {
      const document = await this.#read();
      const project = document.projects.find(({ id }) => id === projectId);
      if (!project) throw new Error(`Unknown project ${projectId}`);
      update(project);
      project.updatedAt = this.clock().toISOString();
      await this.#write(document);
      return project;
    });
    this.#mutation = operation.catch(() => {});
    return operation;
  }

  async #write(document) {
    for (const project of document.projects) assertProjectInvariants(normalizeProject(project));
    await mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 });
    const temporary = `${this.target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.target);
  }
}

function normalizeProject(project) {
  for (const field of ["id", "name", "repo", "repoPath", "baseSha"]) requireText(field, project[field]);
  project.executionPolicy = project.executionPolicy
    ? normalizeExecutionPolicy(project.executionPolicy)
    : null;
  project.demoMode = project.demoMode === true;
  project.protected = project.protected === true;
  project.archiveReceipt = project.archiveReceipt && typeof project.archiveReceipt === "object"
    ? project.archiveReceipt : null;
  project.tasks = Array.isArray(project.tasks)
    ? project.tasks.map((task, index) => normalizePlanTask(task, index)) : [];
  return project;
}

function normalizeExecutionPolicy(policy) {
  if (!policy || policy.mode !== "persistent_project" ||
    policy.scouts !== "none" || policy.validation !== "milestone" ||
    typeof policy.branch !== "string" || !/^shipmates\/[a-z0-9._-]+$/u.test(policy.branch) ||
    typeof policy.worktreePath !== "string" || !path.isAbsolute(policy.worktreePath)) {
    throw new TypeError("Invalid persistent project execution policy");
  }
  return {
    mode: "persistent_project",
    scouts: "none",
    validation: "milestone",
    autoAdvance: policy.autoAdvance !== false,
    branch: policy.branch,
    worktreePath: path.resolve(policy.worktreePath),
  };
}

function normalizePlanTask(task, index) {
  const id = typeof task.id === "string" && task.id ? task.id : `plan-${index + 1}`;
  const title = requireText("task title", task.title);
  const attempts = normalizeAttempts(task);
  const currentTaskId = typeof task.taskId === "string" ? task.taskId : null;
  return {
    id, title,
    description: typeof task.description === "string" ? task.description.trim() : "",
    status: new Set(["planned", "ready", "claimed", "dispatched", "completed", "blocked"]).has(task.status)
      ? task.status : "planned",
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter((value) => typeof value === "string") : [],
    taskId: currentTaskId,
    previousTaskIds: attempts.filter(({ taskId }) => taskId !== currentTaskId)
      .map(({ taskId }) => taskId),
    attempts,
    blockingReason: typeof task.blockingReason === "string" && task.blockingReason.trim()
      ? task.blockingReason.trim()
      : task.status === "blocked" ? "Blocking reason was not recorded by the prior attempt" : null,
  };
}

function normalizeAttempts(task) {
  const allowed = new Set([
    "planned", "claimed", "dispatched", "completed", "blocked",
    "failed", "cancelled", "recovery_required", "superseded",
  ]);
  const attempts = Array.isArray(task.attempts) ? task.attempts.map((attempt) => ({
    taskId: typeof attempt?.taskId === "string" ? attempt.taskId : null,
    status: allowed.has(attempt?.status) ? attempt.status : "superseded",
    startedAt: typeof attempt?.startedAt === "string" ? attempt.startedAt : null,
    completedAt: typeof attempt?.completedAt === "string" ? attempt.completedAt : null,
    blockingReason: typeof attempt?.blockingReason === "string" && attempt.blockingReason.trim()
      ? attempt.blockingReason.trim() : null,
  })).filter(({ taskId }) => taskId) : [];
  if (attempts.length === 0) {
    for (const taskId of Array.isArray(task.previousTaskIds) ? task.previousTaskIds : []) {
      if (typeof taskId === "string") attempts.push({
        taskId, status: "superseded", startedAt: null, completedAt: null, blockingReason: null,
      });
    }
    if (typeof task.taskId === "string") attempts.push({
      taskId: task.taskId, status: task.status || "dispatched", startedAt: null,
      completedAt: new Set(["completed", "blocked"]).has(task.status) ? null : null,
      blockingReason: typeof task.blockingReason === "string" ? task.blockingReason : null,
    });
  }
  return attempts;
}

function requireText(label, value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function matchProjects(projects, query, { includeObjective = false } = {}) {
  const normalized = requireText("project", query).toLowerCase();
  const exact = projects.filter((project) =>
    [project.id, project.name, project.repo, project.repoPath]
      .some((value) => value.toLowerCase() === normalized));
  if (exact.length > 0 || !includeObjective) return exact;
  return projects.filter((project) => project.objective?.toLowerCase().includes(normalized));
}
