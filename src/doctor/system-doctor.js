import path from "node:path";

import { inspectProjectInvariants } from "../projects/project-invariants.js";

const activePlanStatuses = new Set(["claimed", "dispatched"]);

export class ShipMatesDoctor {
  constructor({ projectStore, taskStore, observer, clock = () => new Date() } = {}) {
    if (!projectStore || !taskStore || !observer) {
      throw new TypeError("ShipMatesDoctor requires projectStore, taskStore, and observer");
    }
    this.projectStore = projectStore;
    this.taskStore = taskStore;
    this.observer = observer;
    this.clock = clock;
  }

  async inspect({ project: projectFilter = null, task: taskFilter = null } = {}) {
    const allProjects = await this.projectStore.list({ includeArchived: true });
    const selected = selectProjects(allProjects, projectFilter, taskFilter);
    if (projectFilter && selected.length === 0) throw new Error(`No project matched ${projectFilter}`);
    if (taskFilter && !selected.some((project) => matchingTasks(project, taskFilter).length > 0)) {
      throw new Error(`No task matched ${taskFilter}`);
    }

    const destinationByPath = new Map();
    const worktreesByPath = new Map();
    for (const repoPath of new Set(selected.map(({ repoPath }) => path.resolve(repoPath)))) {
      destinationByPath.set(repoPath, await this.observer.repository(repoPath));
      worktreesByPath.set(repoPath, await this.observer.worktrees(repoPath));
    }

    const findings = [];
    const projects = [];
    for (const project of selected) {
      const projectFindings = inspectProjectInvariants(project).map(({ code, subject }) =>
        finding("violation", `registry_${code}`, { projectId: project.id, subject },
          `Project registry invariant ${code} failed for ${subject}.`,
          manualRepair(`Repair ${project.id} in ${this.projectStore.target} without discarding task history.`)));
      const tasks = [];
      const selectedTasks = taskFilter ? matchingTasks(project, taskFilter) : project.tasks;
      for (const planTask of selectedTasks) {
        const taskReport = await this.#inspectPlanTask(project, planTask,
          worktreesByPath.get(path.resolve(project.repoPath)),
          destinationByPath.get(path.resolve(project.repoPath)),
          projectFindings,
          project.status === "completed" && project.tasks.at(-1)?.id === planTask.id);
        tasks.push(taskReport);
      }
      const destination = destinationByPath.get(path.resolve(project.repoPath));
      inspectDestination(project, destination, projectFindings);
      findings.push(...projectFindings);
      projects.push({
        id: project.id, name: project.name, status: project.status,
        repository: { identity: project.repo, registeredPath: project.repoPath, observed: destination },
        worktrees: worktreesByPath.get(path.resolve(project.repoPath)),
        tasks, findings: projectFindings,
      });
    }

    const counts = countFindings(findings);
    return {
      schemaVersion: 1,
      generatedAt: this.clock().toISOString(),
      readOnly: true,
      filters: { project: projectFilter, task: taskFilter },
      clean: findings.length === 0,
      summary: { projects: projects.length, tasks: projects.reduce((sum, item) => sum + item.tasks.length, 0), findings: findings.length, ...counts },
      projects,
      findings,
    };
  }

  async #inspectPlanTask(project, planTask, worktrees, destination, projectFindings, isFinalTask) {
    const attempts = [];
    for (const attempt of planTask.attempts || []) {
      let snapshot = null;
      let observedProcess = null;
      let observedWorktree = null;
      try {
        snapshot = await this.taskStore.getSnapshot(attempt.taskId);
      } catch (error) {
        projectFindings.push(finding("violation", "task_ledger_unreadable",
          scope(project, planTask, attempt.taskId), `Task ledger cannot be replayed: ${error.message}`,
          manualRepair(`Repair the ledger for ${attempt.taskId} before any retry.`)));
      }
      if (!snapshot) {
        projectFindings.push(finding("violation", "task_ledger_missing",
          scope(project, planTask, attempt.taskId), "Registered task attempt has no durable task ledger.",
          operation("reconcile_task", `shipmates reconcile --task ${attempt.taskId}`)));
      } else {
        inspectProjection(project, planTask, attempt, snapshot, projectFindings);
        inspectValidation(project, planTask, attempt, snapshot, projectFindings);
        inspectHumanWait(project, planTask, attempt, snapshot, projectFindings);
        if (snapshot.worktree?.worktreePath) {
          observedWorktree = await this.observer.worktree(snapshot.worktree.worktreePath);
        }
        inspectWorktree(project, planTask, attempt, snapshot, worktrees, observedWorktree, projectFindings);
        inspectDelivery(project, planTask, attempt, snapshot, destination, projectFindings, isFinalTask);
        observedProcess = await this.#inspectProcess(project, planTask, attempt, projectFindings);
      }
      attempts.push({
        taskId: attempt.taskId, registryStatus: attempt.status,
        process: observedProcess || null, worktree: observedWorktree,
        ledger: summarizeSnapshot(snapshot),
      });
    }
    return {
      id: planTask.id, title: planTask.title, status: planTask.status,
      blockingReason: planTask.blockingReason || null, attempts,
    };
  }

  async #inspectProcess(project, planTask, attempt, projectFindings) {
    const pid = attempt.launchReceipt?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const observed = await this.observer.process(pid);
    if (activePlanStatuses.has(attempt.status) && observed.running === false) {
      projectFindings.push(finding("uncertainty", "worker_process_missing",
        scope(project, planTask, attempt.taskId), `Recorded worker process ${pid} is not running.`,
        operation("mark_worker_lost", `shipmates reconcile --task ${attempt.taskId}`)));
    } else if (observed.running === null) {
      projectFindings.push(finding("uncertainty", "worker_process_unobservable",
        scope(project, planTask, attempt.taskId), `Worker process ${pid} could not be observed: ${observed.error}`,
        operation("inspect_process", `ps -p ${pid}`)));
    }
    return observed;
  }
}

function inspectDestination(project, observed, findings) {
  if (observed.exists === false) {
    findings.push(finding("violation", "registered_repository_missing", { projectId: project.id },
      `Registered destination repository does not exist at ${project.repoPath}.`,
      manualRepair(`Restore the registered repository at ${project.repoPath} or explicitly update its registry identity.`)));
  } else if (observed.error) {
    findings.push(finding("uncertainty", "registered_repository_unobservable", { projectId: project.id },
      `Registered destination repository could not be inspected: ${observed.error}`,
      operation("inspect_repository", `git -C ${project.repoPath} status --short --branch`)));
  }
}

function inspectProjection(project, planTask, attempt, snapshot, findings) {
  if (snapshot.state === "complete" && activePlanStatuses.has(attempt.status)) {
    findings.push(finding("stale_projection", "completed_task_still_active",
      scope(project, planTask, attempt.taskId), "The ledger proves completion but the Project attempt remains active.",
      operation("record_observed_completion", `shipmates reconcile --task ${attempt.taskId}`)));
  }
  if (attempt.status === "completed" && snapshot.state !== "complete") {
    findings.push(finding("violation", "registry_completion_not_proven",
      scope(project, planTask, attempt.taskId), `The registry says completed while the ledger is ${snapshot.state}.`,
      manualRepair(`Inspect ${attempt.taskId}; do not redispatch or mark complete without durable proof.`)));
  }
}

function inspectValidation(project, planTask, attempt, snapshot, findings) {
  const validation = snapshot.validationRuns?.at(-1);
  const request = snapshot.validationRequests?.at(-1);
  if (request && (!validation || validation.requestEventId !== request.requestEventId) && snapshot.state === "validating") {
    findings.push(finding("uncertainty", "validation_result_missing",
      scope(project, planTask, attempt.taskId), "Validation intent exists without a matching terminal result.",
      operation("resume_existing_validation", `shipmates reconcile --task ${attempt.taskId}`)));
  }
  if (validation?.passed === true && validation.finalHeadSha !== snapshot.worktree?.headSha) {
    findings.push(finding("violation", "validated_head_mismatch",
      scope(project, planTask, attempt.taskId), "Passing validation does not match the recorded worktree HEAD.",
      manualRepair(`Do not deliver ${attempt.taskId}; verify its validation and Git evidence.`)));
  }
}

function inspectHumanWait(project, planTask, attempt, snapshot, findings) {
  if (snapshot.state !== "awaiting_human") return;
  const gate = snapshot.validationRuns?.at(-1)?.gate;
  const hasApprovalCommand = gate?.status === "awaiting_approval";
  if (!hasApprovalCommand && !planTask.blockingReason) {
    findings.push(finding("violation", "human_wait_has_no_prompt",
      scope(project, planTask, attempt.taskId), "Task awaits a human without an explicit question or approval gate.",
      operation("request_human_approval", `shipmates reconcile --task ${attempt.taskId}`)));
  }
}

function inspectWorktree(project, planTask, attempt, snapshot, observed, git, findings) {
  const worktree = snapshot.worktree;
  if (!worktree || !new Set(["leased", "return_requested"]).has(worktree.status)) return;
  if (observed?.entries === null) {
    findings.push(finding("uncertainty", "worktrees_unobservable",
      scope(project, planTask, attempt.taskId), `Treehouse state could not be observed: ${observed.error}`,
      operation("inspect_worktrees", `treehouse status --repo ${project.repoPath}`)));
    return;
  }
  const entry = observed?.entries?.find(({ worktreePath }) =>
    path.resolve(worktreePath) === path.resolve(worktree.worktreePath));
  if (!entry || entry.state !== "leased" || entry.leaseHolder !== attempt.taskId) {
    findings.push(finding("violation", "worktree_lease_mismatch",
      scope(project, planTask, attempt.taskId), "Durable lease evidence does not match observed Treehouse ownership.",
      operation("require_manual_repair", `shipmates doctor --task ${attempt.taskId} --json`)));
  }
  if (git?.error) {
    findings.push(finding("uncertainty", "worktree_git_unobservable",
      scope(project, planTask, attempt.taskId), `Leased worktree Git state could not be observed: ${git.error}`,
      operation("inspect_worktree", `git -C ${worktree.worktreePath} status --short --branch`)));
  } else if (git && git.headSha !== worktree.headSha) {
    findings.push(finding("violation", "worktree_head_mismatch",
      scope(project, planTask, attempt.taskId), `Observed worktree HEAD ${git.headSha} does not match durable HEAD ${worktree.headSha}.`,
      operation("require_manual_repair", `shipmates doctor --task ${attempt.taskId} --json`)));
  } else if (git?.dirty && snapshot.state !== "running" && snapshot.state !== "awaiting_worker") {
    findings.push(finding("uncertainty", "worktree_unexpected_changes",
      scope(project, planTask, attempt.taskId), "Leased worktree has changes outside an active implementation state.",
      operation("inspect_worktree", `git -C ${worktree.worktreePath} status --short`)));
  }
}

function inspectDelivery(project, planTask, attempt, snapshot, destination, findings, isFinalTask) {
  if (!isFinalTask || snapshot.state !== "complete") return;
  const record = [...(snapshot.evidence || [])].reverse().find(({ kind }) => kind === "local-delivery");
  if (!record) return;
  let delivery;
  try {
    delivery = JSON.parse(record.value);
  } catch {
    findings.push(finding("violation", "delivery_evidence_invalid",
      scope(project, planTask, attempt.taskId), "Final delivery evidence is not valid structured JSON.",
      manualRepair(`Inspect delivery evidence for ${attempt.taskId} before changing the destination.`)));
    return;
  }
  if (typeof delivery.repoPath !== "string" || typeof delivery.headSha !== "string") {
    findings.push(finding("violation", "delivery_evidence_invalid",
      scope(project, planTask, attempt.taskId), "Final delivery evidence lacks an exact repository path or commit.",
      manualRepair(`Inspect delivery evidence for ${attempt.taskId} before changing the destination.`)));
  } else if (path.resolve(delivery.repoPath) !== path.resolve(project.repoPath)) {
    findings.push(finding("violation", "delivery_destination_mismatch",
      scope(project, planTask, attempt.taskId), "Final delivery evidence targets a repository other than the registered Project repository.",
      operation("retry_delivery", `shipmates reconcile --task ${attempt.taskId}`)));
  } else if (destination?.headSha && delivery.headSha !== destination.headSha) {
    findings.push(finding("stale_projection", "destination_head_mismatch",
      scope(project, planTask, attempt.taskId), `Registered destination HEAD is ${destination.headSha}, not delivered commit ${delivery.headSha}.`,
      operation("retry_delivery", `shipmates reconcile --task ${attempt.taskId}`)));
  }
}

function summarizeSnapshot(snapshot) {
  if (!snapshot) return null;
  const validation = snapshot.validationRuns?.at(-1);
  return {
    taskId: snapshot.id,
    state: snapshot.state,
    lastEventAt: snapshot.lastEventAt || null,
    worktree: snapshot.worktree ? {
      status: snapshot.worktree.status,
      repoPath: snapshot.worktree.repoPath,
      worktreePath: snapshot.worktree.worktreePath || null,
      headSha: snapshot.worktree.headSha || null,
    } : null,
    workers: (snapshot.workers || []).map(({ id, backend, status }) => ({ id, backend, status })),
    validation: validation ? {
      operationId: validation.operationId,
      outcome: validation.outcome || null,
      passed: validation.passed === true,
      finalHeadSha: validation.finalHeadSha || null,
      gate: validation.gate ? { step: validation.gate.step, status: validation.gate.status } : null,
    } : null,
  };
}

function selectProjects(projects, projectFilter, taskFilter) {
  return projects.filter((project) =>
    (!projectFilter || [project.id, project.name, project.repo, project.repoPath].some((value) => matches(value, projectFilter))) &&
    (!taskFilter || matchingTasks(project, taskFilter).length > 0));
}

function matchingTasks(project, filter) {
  return project.tasks.filter((task) => [task.id, task.title, task.taskId,
    ...(task.attempts || []).map(({ taskId }) => taskId)].some((value) => matches(value, filter)));
}

function matches(value, filter) {
  return typeof value === "string" && value.toLowerCase() === String(filter).toLowerCase();
}

function scope(project, planTask, taskId) {
  return { projectId: project.id, planTaskId: planTask.id, taskId };
}

function finding(kind, code, target, message, recovery) {
  return { kind, code, target, message, recovery };
}

function operation(name, command) { return { operation: name, command }; }
function manualRepair(instruction) { return { operation: "require_manual_repair", instruction }; }

function countFindings(findings) {
  const counts = { violations: 0, uncertainties: 0, staleProjections: 0 };
  for (const { kind } of findings) {
    if (kind === "violation") counts.violations += 1;
    if (kind === "uncertainty") counts.uncertainties += 1;
    if (kind === "stale_projection") counts.staleProjections += 1;
  }
  return counts;
}
