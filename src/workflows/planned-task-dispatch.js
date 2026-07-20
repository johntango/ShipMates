export class PlannedTaskDispatcher {
  constructor({ projectStore, selectProject, dispatchRequest } = {}) {
    if (!projectStore || typeof selectProject !== "function" ||
      typeof dispatchRequest !== "function") {
      throw new TypeError("PlannedTaskDispatcher requires projectStore, selectProject, and dispatchRequest");
    }
    this.projectStore = projectStore;
    this.selectProject = selectProject;
    this.dispatchRequest = dispatchRequest;
  }

  async dispatchNext({ projectId }) {
    const task = await this.projectStore.claimNextReady(projectId);
    if (!task) return { status: "idle", task: null };
    return this.#dispatchClaimed({ projectId, task });
  }

  async retryBlocked({ projectId, planTaskId }) {
    await this.projectStore.resetBlockedTask({ projectId, planTaskId });
    const task = await this.projectStore.claimReadyTask({ projectId, planTaskId });
    return this.#dispatchClaimed({ projectId, task });
  }

  async #dispatchClaimed({ projectId, task }) {
    const project = await this.selectProject(projectId);
    try {
      await this.dispatchRequest(
        `Implement planned task ${task.id} for ${project.name}: ${task.title}. ${task.description} ` +
        `This request is bound to plan task id ${task.id}.`,
      );
    } catch (error) {
      const failed = (await this.projectStore.get(projectId))?.tasks.find(({ id }) => id === task.id);
      await this.projectStore.updateTaskStatus(failed?.taskId ? {
        projectId, planTaskId: task.id, status: "blocked",
        blockingReason: `Worker launch failed before a durable receipt (${error.name || "Error"})`,
      } : {
        projectId, planTaskId: task.id, status: "planned",
      });
      throw error;
    }
    const updated = await this.projectStore.get(projectId);
    const attached = updated?.tasks.find(({ id }) => id === task.id) || null;
    const currentAttempt = attached?.attempts?.find(({ taskId }) => taskId === attached.taskId);
    if (attached?.taskId && attached.status === "dispatched" && currentAttempt?.launchReceipt) {
      return { status: "dispatched", task: attached };
    }
    if (attached?.taskId && attached.status === "dispatched") {
      await this.projectStore.updateTaskStatus({
        projectId, planTaskId: task.id, status: "blocked",
        blockingReason: "Dispatch returned without an exact process or pane launch receipt",
      });
      const blocked = await this.projectStore.get(projectId);
      return {
        status: "blocked",
        task: blocked?.tasks.find(({ id }) => id === task.id) || null,
      };
    }
    await this.projectStore.blockOrphanedClaim({
      projectId,
      planTaskId: task.id,
      reason: "Dispatch returned before a durable task was created",
    });
    const blocked = await this.projectStore.get(projectId);
    return {
      status: "blocked",
      task: blocked?.tasks.find(({ id }) => id === task.id) || null,
    };
  }
}
