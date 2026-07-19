import { rm } from "node:fs/promises";
import path from "node:path";

export class ProjectArchiveWorkflow {
  constructor({ projectStore, taskStore, stateRoot, clock = () => new Date(), remove = rm } = {}) {
    if (!projectStore || !taskStore || !stateRoot) {
      throw new TypeError("Project archival requires projectStore, taskStore, and stateRoot");
    }
    this.projectStore = projectStore;
    this.taskStore = taskStore;
    this.stateRoot = path.resolve(stateRoot);
    this.clock = clock;
    this.remove = remove;
  }

  async archive({ projectId, trigger = "manual" }) {
    const project = await this.projectStore.get(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    if (project.status === "archived") return { project, receipt: project.archiveReceipt, reused: true };
    if (project.tasks.some(({ status }) => status !== "completed")) {
      throw new Error("Archival requires every planned task to be completed");
    }
    const taskIds = [...new Set(project.tasks.flatMap(({ taskId, previousTaskIds = [] }) =>
      [taskId, ...previousTaskIds]).filter(Boolean))];
    const snapshots = [];
    for (const taskId of taskIds) {
      try { snapshots.push(await this.taskStore.getSnapshot(taskId)); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    const landed = snapshots.find(isVerifiedLandedTask);
    if (!landed) {
      throw new Error("Bulk archival requires a verified merged task with a returned worktree");
    }
    if (snapshots.some((snapshot) => !terminal(snapshot.state))) {
      throw new Error("Archival refused because project task work is still active");
    }
    const receipt = {
      schemaVersion: 1,
      projectId: project.id,
      projectName: project.name,
      repository: project.repo,
      archivedAt: this.clock().toISOString(),
      trigger,
      recoverability: {
        prNumber: landed.githubMerges.at(-1).prNumber,
        approvedHeadSha: landed.githubMerges.at(-1).headSha,
        mergeCommitSha: landed.githubMerges.at(-1).result.mergeCommitSha,
        postMergeEventId: landed.postMergeAssurances.at(-1).eventId,
        branchCleanupEventId: landed.branchCleanups.at(-1).completedEventId,
        remoteVerified: true,
      },
      tasks: project.tasks.map(({ id, title, status }) => ({ id, title, status })),
      removedTaskIds: taskIds,
    };
    const archivedProject = await this.projectStore.archive({ projectId, receipt });
    for (const taskId of taskIds) {
      await this.remove(path.join(this.stateRoot, "tasks", taskId), { recursive: true, force: true });
    }
    await this.remove(path.join(this.stateRoot, "persistent-project-runs", project.id), { recursive: true, force: true });
    await this.remove(path.join(this.stateRoot, "project-agent-jobs", project.id), { recursive: true, force: true });
    return { project: archivedProject, receipt, reused: false };
  }

  async archiveForTask({ taskId, trigger = "verified-post-merge" }) {
    const projects = await this.projectStore.list({ includeArchived: true });
    const project = projects.find(({ tasks }) => tasks.some((task) =>
      task.taskId === taskId || task.previousTaskIds?.includes(taskId)));
    if (!project) return null;
    return this.archive({ projectId: project.id, trigger });
  }
}

function isVerifiedLandedTask(snapshot) {
  const merge = snapshot.githubMerges?.at(-1);
  const assurance = snapshot.postMergeAssurances?.at(-1);
  const cleanup = snapshot.branchCleanups?.at(-1);
  return snapshot.state === "complete" && snapshot.worktree?.status === "returned" &&
    merge?.status === "completed" && merge.result?.merged === true &&
    assurance?.requiredChecks?.satisfied === true &&
    assurance.mergeCommitSha === merge.result.mergeCommitSha &&
    cleanup?.status === "completed";
}

function terminal(state) {
  return new Set(["complete", "cancelled", "failed", "blocked"]).has(state);
}
