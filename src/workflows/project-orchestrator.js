import {
  ControlPlaneRefusal,
  FirstmateControlPlane,
  selectFirstmateCommand,
} from "../control/firstmate-control-plane.js";
import { ReconciliationEngine } from "../reconciliation/reconciliation-engine.js";
import { completeFirstmateDemoTask } from "./firstmate-demo-completion.js";
import { classifyTaskRecovery } from "./task-recovery.js";

export class ProjectOrchestrator {
  constructor({
    taskStore,
    projectStore,
    reconciliationEngine = new ReconciliationEngine(),
    advanceProject,
    validationWorkflow,
    deliveryWorkflow,
    archiveWorkflow,
    purgeWorkflow,
  } = {}) {
    if (!taskStore || !projectStore) throw new TypeError("ProjectOrchestrator requires task and project stores");
    this.taskStore = taskStore;
    this.projectStore = projectStore;
    this.reconciliationEngine = reconciliationEngine;
    this.controlPlane = new FirstmateControlPlane({ handlers: {
      "task.inspect": ({ taskId }) => this.inspectTask(taskId),
      "task.reconcile": ({ taskId }) => this.reconcileTask(taskId),
      "project.create": (input) => this.projectStore.create(input),
      "project.approve": ({ projectId }) => this.projectStore.approve(projectId),
      "project.advance": ({ projectId }) =>
        invokeWorkflow("project.advance", advanceProject, { projectId }),
      "validation.approve": (input) =>
        invokeWorkflow("validation.approve", validationWorkflow?.approve?.bind(validationWorkflow), input),
      "delivery.retry": (input) =>
        invokeWorkflow("delivery.retry", deliveryWorkflow?.retry?.bind(deliveryWorkflow), input),
      "project.archive": ({ projectId }) =>
        invokeWorkflow("project.archive", archiveWorkflow?.archive?.bind(archiveWorkflow), { projectId }),
      "repository.purge": ({ projectId, approvalId }) =>
        invokeWorkflow("repository.purge", purgeWorkflow?.purge?.bind(purgeWorkflow), {
          query: projectId, confirmationId: approvalId,
        }),
    } });
  }

  async resolveControl(message) { return this.selectCommand(message); }

  selectCommand(message) { return selectFirstmateCommand(message); }

  async executeCommand(command) { return this.controlPlane.execute(command); }

  async inspectTask(taskId) {
    const [context, snapshot] = await Promise.all([
      this.projectStore.describeAttempt(taskId), this.taskStore.getSnapshot(taskId),
    ]);
    return {
      context,
      snapshot,
      recovery: classifyTaskRecovery(snapshot),
      reconciliation: this.reconciliationEngine.plan({
        snapshot, projectTask: context?.attempt || null, source: "command",
      }),
    };
  }

  async applyControl(command) { return this.executeCommand(command); }

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
        results.push({ planTaskId: task.id, action: "require_manual_repair", status: "blocked", reason: error.message });
        continue;
      }
      const { recovery, snapshot } = inspected;
      const reconciliation = this.reconciliationEngine.plan({
        snapshot, projectTask: task, source: "project_reconciliation",
      });
      if (reconciliation.decision === "record_observed_completion") {
        await this.projectStore.updateTaskStatus({
          projectId, planTaskId: task.id, status: "completed",
        });
        results.push({ planTaskId: task.id, action: reconciliation.decision, status: "completed", reason: reconciliation.reason });
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
          action: reconciliation.decision,
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
        results.push({ planTaskId: task.id, action: "record_observed_completion", status: "completed",
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
        planTaskId: task.id, action: reconciliation.decision,
        status: terminalBlock ? "blocked" : task.status, reason: recovery.reason,
      });
    }
    await this.projectStore.reconcileCompletion?.(projectId);
    return results;
  }

  async reconcileTask(taskId) {
    const context = await this.projectStore.describeAttempt(taskId);
    if (!context) throw new Error(`Task ${taskId} is not attached to a project plan`);
    const results = await this.reconcileProject(context.projectId);
    const reconciled = results.find(({ planTaskId }) => planTaskId === context.planTaskId);
    if (reconciled) return { ...reconciled, context };
    const project = await this.projectStore.get(context.projectId);
    const task = project.tasks.find(({ id }) => id === context.planTaskId);
    return {
      context,
      planTaskId: task.id,
      status: task.status,
      action: "no_action",
      reason: task.blockingReason || `Project registry already reflects task ${taskId}`,
    };
  }
}

function invokeWorkflow(command, handler, input) {
  if (typeof handler === "function") return handler(input);
  throw new ControlPlaneRefusal({
    command,
    invariant: "governed_workflow_configured",
    reason: `No governed workflow is configured for ${command}`,
    nextAction: "configure the authoritative workflow before retrying the typed command",
  });
}
