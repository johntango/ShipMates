import { resolveFirstmateControlIntent } from "../cli/firstmate-control-intent.js";
import { acceptFirstmateDemoWarning } from "./firstmate-demo-recovery.js";
import { completeFirstmateDemoTask } from "./firstmate-demo-completion.js";
import { classifyTaskRecovery } from "./task-recovery.js";

export class ProjectOrchestrator {
  constructor({ taskStore, projectStore } = {}) {
    if (!taskStore || !projectStore) throw new TypeError("ProjectOrchestrator requires task and project stores");
    this.taskStore = taskStore;
    this.projectStore = projectStore;
  }

  async resolveControl(message) {
    return resolveFirstmateControlIntent({ message, projectStore: this.projectStore });
  }

  async inspectTask(taskId) {
    const [context, snapshot] = await Promise.all([
      this.projectStore.describeAttempt(taskId), this.taskStore.getSnapshot(taskId),
    ]);
    return { context, snapshot, recovery: classifyTaskRecovery(snapshot) };
  }

  async applyControl(intent) {
    if (!intent || typeof intent.taskId !== "string") throw new TypeError("Control intent requires a task id");
    if (intent.action === "accept_demo_warning") {
      return acceptFirstmateDemoWarning({
        store: this.taskStore, projectStore: this.projectStore, taskId: intent.taskId,
      });
    }
    return this.inspectTask(intent.taskId);
  }

  async attachAttempt(input) {
    return this.projectStore.attachTask(input);
  }

  async dismissUnstartedAttempt({ projectId, planTaskId, taskId }) {
    let snapshot = await this.taskStore.getSnapshot(taskId);
    if (snapshot.worktree || snapshot.workers?.length > 0 ||
      !new Set(["clarified", "approved_for_dispatch", "preparing"]).has(snapshot.state)) {
      throw new Error("Attempt has execution evidence and cannot be dismissed as unstarted");
    }
    snapshot = await this.taskStore.transition({
      taskId, from: snapshot.state, to: "cancelled", actor: "firstmate",
      reason: "Dismissed unstarted attempt created by failed conversational planning fallback",
      eventId: `${taskId}:dismiss-unstarted:v1`,
    });
    const project = await this.projectStore.detachUnstartedAttempt({
      projectId, planTaskId, taskId,
    });
    return { snapshot, project };
  }

  async reconcileProject(projectId) {
    const project = await this.projectStore.get(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    const results = [];
    for (const task of project.tasks.filter(({ taskId, status }) =>
      taskId && new Set(["dispatched", "blocked"]).has(status))) {
      let inspected;
      try {
        inspected = await this.inspectTask(task.taskId);
      } catch (error) {
        results.push({ planTaskId: task.id, action: "inspect_evidence", status: "blocked", reason: error.message });
        continue;
      }
      const { recovery, snapshot } = inspected;
      if (recovery.category === "complete") {
        await this.projectStore.updateTaskStatus({
          projectId, planTaskId: task.id, status: "completed",
        });
        results.push({ planTaskId: task.id, action: "registry_reconciled", status: "completed", reason: recovery.reason });
        continue;
      }
      if (recovery.category === "validation_approval_required") {
        let awaiting = snapshot;
        if (snapshot.state === "validating") {
          awaiting = await this.taskStore.transition({
            taskId: task.taskId,
            from: "validating",
            to: "awaiting_human",
            actor: "firstmate",
            reason: recovery.reason,
            eventId: `${task.taskId}:validation:approval-reconciled:v1`,
          });
        }
        if (task.status === "blocked") {
          await this.projectStore.updateTaskStatus({
            projectId, planTaskId: task.id, status: "dispatched",
          });
        }
        results.push({
          planTaskId: task.id,
          action: recovery.action,
          status: "awaiting_human",
          reason: recovery.reason,
          snapshot: awaiting,
        });
        continue;
      }
      const demoCompletable = recovery.category === "verified_no_change" ||
        (recovery.category === "validation_passed" && snapshot.state === "validating");
      if (project.demoMode === true && demoCompletable) {
        const completed = await completeFirstmateDemoTask({ store: this.taskStore, taskId: task.taskId });
        await this.projectStore.updateTaskStatus({
          projectId, planTaskId: task.id, status: "completed",
        });
        results.push({ planTaskId: task.id, action: "demo_completed", status: "completed",
          reason: recovery.reason, snapshot: completed.snapshot });
        continue;
      }
      const terminalBlock = new Set(["blocked", "failed", "recovery_required"]).has(snapshot.state) ||
        recovery.category === "intake_failed";
      if (terminalBlock || recovery.category === "capability_warning") {
        if (task.status !== "blocked" || task.blockingReason !== recovery.reason) {
          await this.projectStore.updateTaskStatus({
            projectId, planTaskId: task.id, status: "blocked", blockingReason: recovery.reason,
          });
        }
      }
      results.push({
        planTaskId: task.id, action: recovery.action,
        status: terminalBlock ? "blocked" : task.status, reason: recovery.reason,
      });
    }
    return results;
  }
}
