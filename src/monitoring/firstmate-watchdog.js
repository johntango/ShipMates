import { readFile } from "node:fs/promises";
import path from "node:path";

const activeStates = new Set(["preparing", "running", "awaiting_worker", "validating"]);
const activeWorkerStates = new Set(["dispatch_requested", "started"]);

export class FirstmateWatchdog {
  constructor({
    store, projectStore = null, thresholdMs = 15 * 60 * 1_000,
    historicalAfterMs = 24 * 60 * 60 * 1_000,
    clock = () => new Date(), isLiveTask = () => false, read = readFile,
  } = {}) {
    if (!store || typeof store.listTaskIds !== "function" || typeof store.getSnapshot !== "function") {
      throw new TypeError("FirstmateWatchdog requires a task store");
    }
    this.store = store;
    this.projectStore = projectStore;
    this.thresholdMs = thresholdMs;
    this.historicalAfterMs = historicalAfterMs;
    this.clock = clock;
    this.isLiveTask = isLiveTask;
    this.read = read;
  }

  async inspect() {
    const alerts = [];
    for (const taskId of await this.store.listTaskIds()) {
      try {
        const snapshot = await this.store.getSnapshot(taskId);
        if (!activeStates.has(snapshot.state)) continue;
        const ageMs = this.clock().getTime() - Date.parse(snapshot.lastEventAt);
        if (!Number.isFinite(ageMs) || ageMs < this.thresholdMs || ageMs >= this.historicalAfterMs) continue;
        const context = await this.#projectContext(taskId);
        if (context?.taskStatus && !new Set(["claimed", "dispatched"]).has(context.taskStatus)) continue;
        const alert = await this.#alert(snapshot, ageMs, context);
        if (alert) alerts.push(alert);
      } catch {
        // One damaged historical task must not disable monitoring for every task.
      }
    }
    alerts.push(...await this.#persistentAlerts());
    return alerts.sort((left, right) => right.ageMinutes - left.ageMinutes);
  }

  async inspectHistorical() {
    const records = [];
    for (const taskId of await this.store.listTaskIds()) {
      try {
        const snapshot = await this.store.getSnapshot(taskId);
        if (!activeStates.has(snapshot.state)) continue;
        const ageMs = this.clock().getTime() - Date.parse(snapshot.lastEventAt);
        if (!Number.isFinite(ageMs) || ageMs < this.historicalAfterMs) continue;
        const context = await this.#projectContext(taskId);
        if (context?.taskStatus && !new Set(["claimed", "dispatched"]).has(context.taskStatus)) continue;
        records.push({
          taskId,
          projectName: context?.projectName || "Unassigned work",
          taskName: context?.taskName || snapshot.firstmateRuns?.at(-1)?.classification?.summary || "ShipMates task",
          state: snapshot.state,
          ageMinutes: Math.floor(ageMs / 60_000),
          remedy: "Historical cleanup only: reconcile, archive, or dismiss this ledger record without treating it as a live process.",
        });
      } catch { /* Keep the remaining historical audit available. */ }
    }
    return records.sort((left, right) => right.ageMinutes - left.ageMinutes);
  }

  async terminalizeStale() {
    if (!this.projectStore?.updateTaskStatus) return [];
    const terminalized = [];
    for (const alert of await this.inspect()) {
      if (alert.category !== "stale_execution" || !alert.projectId || !alert.planTaskId) continue;
      if (this.projectStore.get) {
        const current = await this.projectStore.get(alert.projectId);
        const task = current?.tasks?.find(({ id }) => id === alert.planTaskId);
        if (!task || !new Set(["claimed", "dispatched"]).has(task.status)) continue;
      }
      const reason = `Task runner became stale after ${alert.ageMinutes} minutes: ${alert.status}. Last durable activity: ${alert.lastEventAt}. Existing evidence must be reconciled before retrying.`;
      const project = await this.projectStore.updateTaskStatus({
        projectId: alert.projectId,
        planTaskId: alert.planTaskId,
        status: "blocked",
        blockingReason: reason,
      });
      terminalized.push({ ...alert, reason, project });
    }
    return terminalized;
  }

  async #alert(snapshot, ageMs, context) {
    const owner = context?.ownerName || "Firstmate";
    const implementer = snapshot.workers?.find(({ id, status: workerStatus }) =>
      id === "implementer" && activeWorkerStates.has(workerStatus));
    const activeWorker = implementer || snapshot.workers?.find(({ status }) => activeWorkerStates.has(status));
    const validation = snapshot.validationRuns?.at(-1);
    let category;
    let status;
    let remedy;
    if (validation?.gate?.status === "awaiting_approval") {
      category = "approval_required";
      status = `validation is waiting for approval at ${validation.gate.step}`;
      remedy = `${owner} should show the exact requested command and ask the human to approve or reject it.`;
    } else if (activeWorker) {
      const terminal = await this.#terminal(snapshot.id, activeWorker.id);
      if (terminal?.status === "completed") {
        category = "reconciliation_required";
        status = `${activeWorker.id} completed but its durable result was not reconciled`;
        remedy = `${owner} should reconcile the existing terminal artifact and must not launch a duplicate worker.`;
      } else if (this.isLiveTask(snapshot.id)) {
        category = "overdue_process";
        status = `${activeWorker.id} has been live beyond the time limit`;
        remedy = `${owner} should refer the task to the human with its latest stage; continue waiting, interrupt, or recover only after a human decision.`;
      } else {
        category = "stale_execution";
        status = `${activeWorker.id} is recorded active but no Firstmate child is live`;
        remedy = `${owner} should inspect terminal artifacts and Herdr state, then reconcile; do not retry blindly.`;
      }
    } else if (snapshot.validationRequests?.at(-1)?.status === "requested") {
      category = "reconciliation_required";
      status = "validation was requested but no terminal result was recorded";
      remedy = `${owner} should reconcile the existing validation request and must not start a new validation attempt.`;
    }
    if (!category) return null;
    return {
      taskId: snapshot.id,
      projectId: context?.projectId || null,
      planTaskId: context?.planTaskId || null,
      projectName: context?.projectName || "Unassigned work",
      taskName: context?.taskName || snapshot.firstmateRuns?.at(-1)?.classification?.summary || "ShipMates task",
      category,
      status,
      remedy,
      ageMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
      lastEventAt: snapshot.lastEventAt,
    };
  }

  async #projectContext(taskId) {
    const context = await this.projectStore?.describeTask?.(taskId);
    if (!context || !this.projectStore?.get) return context;
    const project = await this.projectStore.get(context.projectId);
    const task = project?.tasks?.find(({ id }) => id === context.planTaskId);
    return { ...context, taskStatus: task?.status || null };
  }

  async #persistentAlerts() {
    if (!this.projectStore?.list) return [];
    const alerts = [];
    for (const project of await this.projectStore.list()) {
      if (project.executionPolicy?.mode !== "persistent_project") continue;
      for (const task of project.tasks.filter(({ status }) => new Set(["claimed", "dispatched"]).has(status))) {
        let record;
        try {
          record = JSON.parse(await this.read(path.join(this.store.rootDir,
            "persistent-project-runs", project.id, `${task.id}.json`), "utf8"));
        } catch { continue; }
        const ageMs = this.clock().getTime() - Date.parse(record.startedAt);
        if (!Number.isFinite(ageMs) || ageMs < this.thresholdMs || ageMs >= this.historicalAfterMs) continue;
        const reportExists = await this.#persistentReportExists(project.id, task.id);
        let category;
        let status;
        let remedy;
        if (record.status === "completed" || (record.status === "started" && reportExists)) {
          category = "reconciliation_required";
          status = "the Project Agent's Implementer completed but the project plan was not reconciled";
          remedy = `ShipMates Project: ${project.name} should reconcile the existing worker artifact and must not dispatch another Implementer.`;
        } else if (record.status === "started" && this.isLiveTask(task.taskId)) {
          category = "overdue_process";
          status = "the Project Agent's Implementer exceeded the monitoring limit";
          remedy = `ShipMates Project: ${project.name} should refer the operation to Firstmate and the human for a continue or interrupt decision.`;
        } else if (record.status === "started") {
          category = "stale_execution";
          status = "the Project Agent has durable start intent but no live Firstmate child";
          remedy = `ShipMates Project: ${project.name} should reconcile its worker artifacts before any retry.`;
        } else continue;
        alerts.push({
          taskId: task.taskId, projectId: project.id, planTaskId: task.id,
          projectName: project.name, taskName: task.title,
          category, status, remedy, ageMinutes: Math.floor(ageMs / 60_000),
          lastEventAt: record.startedAt,
        });
      }
    }
    return alerts;
  }

  async #persistentReportExists(projectId, planTaskId) {
    try {
      await this.read(path.join(this.store.rootDir, "persistent-project-runs", projectId,
        `${planTaskId}-worker`, "report.json"), "utf8");
      return true;
    } catch { return false; }
  }

  async #terminal(taskId, workerId) {
    const target = path.join(this.store.rootDir, "tasks", taskId,
      workerId === "implementer" ? "workers" : "local-execution",
      workerId, "firstmate-pane-terminal.json");
    try { return JSON.parse(await this.read(target, "utf8")); } catch { return null; }
  }
}
