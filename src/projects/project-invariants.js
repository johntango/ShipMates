const activeAttemptStatuses = new Set(["claimed", "dispatched"]);

export function inspectProjectInvariants(project) {
  const issues = [];
  const planIds = new Set();
  const taskIds = new Map();
  for (const task of project?.tasks || []) {
    if (planIds.has(task.id)) issues.push(issue("duplicate_plan_task", task.id));
    planIds.add(task.id);
    const active = (task.attempts || []).filter(({ status }) => activeAttemptStatuses.has(status));
    if (active.length > 1) issues.push(issue("multiple_active_attempts", task.id));
    if (task.taskId && !(task.attempts || []).some(({ taskId }) => taskId === task.taskId)) {
      issues.push(issue("missing_current_attempt", task.id));
    }
    if (task.status === "blocked" && !task.blockingReason) {
      issues.push(issue("missing_blocking_reason", task.id));
    }
    for (const attempt of task.attempts || []) {
      const prior = taskIds.get(attempt.taskId);
      if (prior && prior !== task.id) issues.push(issue("attempt_attached_twice", attempt.taskId));
      taskIds.set(attempt.taskId, task.id);
    }
  }
  for (const task of project?.tasks || []) {
    for (const dependency of task.dependsOn || []) {
      if (!planIds.has(dependency)) issues.push(issue("missing_dependency", `${task.id}:${dependency}`));
    }
  }
  return issues;
}

export function assertProjectInvariants(project) {
  const issues = inspectProjectInvariants(project);
  if (issues.length > 0) {
    throw new Error(`Project registry invariant failed: ${issues.map(({ code, subject }) => `${code}(${subject})`).join(", ")}`);
  }
  return project;
}

function issue(code, subject) { return { code, subject }; }
