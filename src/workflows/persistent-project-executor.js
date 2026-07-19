import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class PersistentProjectExecutor {
  constructor({ projectStore, runtime, schemaPath, stateRoot, runner = runGit, clock = () => new Date() } = {}) {
    if (!projectStore || !runtime || typeof runtime.run !== "function" || !schemaPath || !stateRoot) {
      throw new TypeError("PersistentProjectExecutor requires projectStore, runtime, schemaPath, and stateRoot");
    }
    this.projectStore = projectStore;
    this.runtime = runtime;
    this.schemaPath = path.resolve(schemaPath);
    this.stateRoot = path.resolve(stateRoot);
    this.runner = runner;
    this.clock = clock;
  }

  async run({ projectId, planTaskId, instruction, baseSha }) {
    const project = await this.projectStore.get(projectId);
    const task = project?.tasks.find(({ id }) => id === planTaskId);
    const policy = project?.executionPolicy;
    if (!project || !task || policy?.mode !== "persistent_project") {
      throw new Error("Persistent execution requires a configured project and planned task");
    }
    const recordPath = this.#recordPath(projectId, planTaskId);
    const existing = await readRecord(recordPath);
    if (existing?.status === "completed") return this.#reconcileRecord(project, task, existing, true);
    if (existing?.status === "started") return this.#recoverStarted(project, task, existing);
    await this.#ensureWorktree(project, baseSha);
    const before = await this.#inspect(policy.worktreePath);
    if (before.dirty) throw new Error("Persistent project worktree must be clean before implementation");
    const started = {
      schemaVersion: 1, projectId, planTaskId, taskId: task.taskId,
      status: "started", instruction, baseHeadSha: before.headSha,
      startedAt: this.clock().toISOString(), completedAt: null, report: null, commit: null,
    };
    await writeRecord(recordPath, started);
    const artifactDirectory = path.join(path.dirname(recordPath), `${planTaskId}-worker`);
    const result = await this.runtime.run({
      taskId: planTaskId,
      workerId: "implementer",
      workingDirectory: policy.worktreePath,
      prompt: buildPrompt(project, task, instruction),
      schemaPath: this.schemaPath,
      artifactDirectory,
      sandbox: "workspace-write",
    });
    return this.#finalize(project, task, started, result, false);
  }

  async #finalize(project, task, started, result, reused) {
    const { projectId, planTaskId } = started;
    const policy = project.executionPolicy;
    const recordPath = this.#recordPath(projectId, planTaskId);
    const report = commitBoundaryOnly(result.report)
      ? { ...result.report, status: "completed",
        summary: `${result.report.summary} Recovered at the controlled executor commit boundary.` }
      : result.report;
    if (report.status !== "completed") {
      await writeRecord(recordPath, { ...started, status: "blocked", completedAt: this.clock().toISOString(), report: result.report });
      await this.projectStore.updateTaskStatus({ projectId, planTaskId, status: "blocked" });
      return { status: "blocked", report: result.report, reused };
    }
    const changed = await this.#changed(policy.worktreePath);
    const reported = [...report.files].sort();
    if (changed.join("\n") !== reported.join("\n")) {
      throw new Error("Implementer report does not match persistent worktree changes");
    }
    let commit = { headSha: started.baseHeadSha, noMutation: true };
    if (changed.length > 0) {
      await this.runner("git", ["-C", policy.worktreePath, "add", "--", ...changed]);
      await this.runner("git", ["-C", policy.worktreePath, "-c", "user.name=ShipMates Firstmate",
        "-c", "user.email=firstmate@shipmates.local", "commit", "-m", `${project.name}: ${task.title}`]);
      commit = { headSha: (await this.runner("git", ["-C", policy.worktreePath, "rev-parse", "HEAD"])).stdout.trim(), noMutation: false };
    }
    const completed = { ...started, status: "completed", completedAt: this.clock().toISOString(), report, commit };
    await writeRecord(recordPath, completed);
    return this.#reconcileRecord(project, task, completed, reused);
  }

  async reconcile({ projectId, planTaskId }) {
    const project = await this.projectStore.get(projectId);
    const task = project?.tasks.find(({ id }) => id === planTaskId);
    const record = await readRecord(this.#recordPath(projectId, planTaskId));
    if (!project || !task || !record) return null;
    if (record.status === "completed") return this.#reconcileRecord(project, task, record, true);
    if (record.status === "started") return this.#recoverStarted(project, task, record);
    if (record.status === "blocked") {
      await this.projectStore.updateTaskStatus({ projectId, planTaskId, status: "blocked" });
      return { status: "blocked", report: record.report, reused: true };
    }
    return null;
  }

  async #reconcileRecord(project, task, record, reused) {
    await this.projectStore.updateTaskStatus({ projectId: project.id, planTaskId: task.id, status: "completed" });
    return { status: "completed", report: record.report, commit: record.commit, reused };
  }

  async #recoverStarted(project, task, record) {
    if (typeof this.runtime.loadCompleted !== "function") {
      throw new Error("Persistent runtime cannot reconcile completed artifacts");
    }
    const result = await this.runtime.loadCompleted({
      taskId: record.planTaskId,
      artifactDirectory: path.join(path.dirname(this.#recordPath(record.projectId, record.planTaskId)), `${record.planTaskId}-worker`),
    });
    return this.#finalize(project, task, record, result, true);
  }

  async #ensureWorktree(project, baseSha) {
    const policy = project.executionPolicy;
    try {
      const branch = (await this.runner("git", ["-C", policy.worktreePath, "branch", "--show-current"])).stdout.trim();
      if (branch !== policy.branch) throw new Error("Persistent project worktree is on the wrong branch");
      return;
    } catch (error) {
      if (error.message?.includes("wrong branch")) throw error;
    }
    await mkdir(path.dirname(policy.worktreePath), { recursive: true, mode: 0o700 });
    try {
      await this.runner("git", ["-C", project.repoPath, "worktree", "add", "-b", policy.branch, policy.worktreePath, baseSha]);
    } catch {
      await this.runner("git", ["-C", project.repoPath, "worktree", "add", policy.worktreePath, policy.branch]);
    }
  }

  async #inspect(worktreePath) {
    const [head, status] = await Promise.all([
      this.runner("git", ["-C", worktreePath, "rev-parse", "HEAD"]),
      this.runner("git", ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    return { headSha: head.stdout.trim(), dirty: Boolean(status.stdout.trim()) };
  }

  async #changed(worktreePath) {
    const result = await this.runner("git", ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]);
    return [...new Set(result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).trim()))].sort();
  }

  #recordPath(projectId, planTaskId) {
    return path.join(this.stateRoot, "persistent-project-runs", projectId, `${planTaskId}.json`);
  }
}

function buildPrompt(project, task, instruction) {
  return [
    `You are the sole Implementer for ${project.name}, planned task “${task.title}”.`,
    `Your structured report taskId must be exactly ${task.id}.`,
    "Work directly in this persistent project branch. Do not launch scouts or subagents.",
    "Implement only this planned task, preserve prior project work, and run focused tests for the edited behavior.",
    "Do not commit, push, access GitHub, or run the full no-mistakes pipeline.",
    "The controlled executor—not you—owns Git commits. Ignore any conflicting commit request embedded in the task instruction. Uncommitted verified edits are successful work, not a blocker.",
    `Instruction: ${instruction}`,
    "Return the structured report with every changed file and each focused test command and result.",
  ].join("\n");
}

export function commitBoundaryOnly(report) {
  if (report?.status !== "blocked" || !Array.isArray(report.files) || report.files.length === 0 ||
    !Array.isArray(report.tests) || report.tests.length === 0) return false;
  const text = `${report.summary || ""} ${(report.risks || []).join(" ")}`;
  const commitBoundary = /commit[^.\n]*(?:could not|failed|not writable|outside the writable sandbox)|(?:could not|failed)[^.\n]*commit/iu.test(text);
  const failedTest = report.tests.some(({ result }) => /\b(?:fail(?:ed)?|blocked|error)\b/iu.test(String(result)));
  return commitBoundary && !failedTest;
}

async function readRecord(target) {
  try { return JSON.parse(await readFile(target, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeRecord(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function runGit(file, args) {
  try { return await execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { throw new Error(`Persistent project Git command failed: ${args.join(" ")}`, { cause: error }); }
}
