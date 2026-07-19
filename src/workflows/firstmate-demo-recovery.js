export async function acceptFirstmateDemoWarning({
  store, projectStore, taskId, actor = "firstmate",
  warning = "Browser-level validation unavailable",
} = {}) {
  if (!store || !projectStore) throw new TypeError("Demo warning recovery requires task and project stores");
  const context = await projectStore.describeTask(taskId);
  if (!context) throw new Error(`Task ${taskId} is not attached to a planned project task`);
  const project = await projectStore.get(context.projectId);
  if (project?.demoMode !== true) throw new Error("Validation warnings may be accepted only in local-only demo mode");
  let snapshot = await store.getSnapshot(taskId);
  if (snapshot.state === "complete" && hasAcceptedWarning(snapshot)) {
    return { snapshot, project, reused: true };
  }
  const report = snapshot.workers?.find(({ id }) => id === "implementer")?.report;
  const tests = report?.tests || [];
  const failed = tests.filter(({ result }) => /\b(?:fail|failed|error)\b/iu.test(result) &&
    !/\b0\s+(?:failures?|failed)\b/iu.test(result));
  if (failed.length > 0) throw new Error("A reported local check failed; its result cannot be waived as a browser-only warning");
  snapshot = await store.recordEvidence({
    taskId, actor, kind: "accepted-demo-validation-warning",
    value: JSON.stringify({
      approvedBy: "human", warning, localTests: tests,
      mode: "local-only-demo", remoteOperations: false,
    }),
    eventId: `${taskId}:accepted-demo-warning:v1`,
  });
  snapshot = await advanceWithoutDispatch({ store, snapshot, taskId, actor });
  const updated = await projectStore.updateTaskStatus({
    projectId: context.projectId, planTaskId: context.planTaskId, status: "completed",
  });
  return { snapshot, project: updated, reused: false };
}

export function hasAcceptedWarning(snapshot) {
  return snapshot?.evidence?.some(({ kind }) => kind === "accepted-demo-validation-warning") === true;
}

async function advanceWithoutDispatch({ store, snapshot, taskId, actor }) {
  const paths = {
    clarified: ["approved_for_dispatch", "preparing", "running", "validating", "cleaning", "complete"],
    approved_for_dispatch: ["preparing", "running", "validating", "cleaning", "complete"],
    preparing: ["running", "validating", "cleaning", "complete"],
    blocked: ["running", "validating", "cleaning", "complete"],
    recovery_required: ["running", "validating", "cleaning", "complete"],
    running: ["validating", "cleaning", "complete"],
    awaiting_worker: ["validating", "cleaning", "complete"],
    validating: ["cleaning", "complete"],
    cleaning: ["complete"],
  };
  const transitions = paths[snapshot.state];
  if (!transitions) throw new Error(`Task ${taskId} cannot accept a demo warning from state ${snapshot.state}`);
  for (const to of transitions) {
    const from = snapshot.state;
    snapshot = await store.transition({
      taskId, from, to, actor,
      reason: demoReason(to),
      eventId: `${taskId}:accepted-demo-warning-${to}:v1`,
    });
  }
  return snapshot;
}

function demoReason(state) {
  if (state === "running") return "Resuming the existing task without dispatching another worker";
  if (state === "validating") return "Applying previously supplied human approval to existing local evidence";
  if (state === "cleaning") return "Browser-related residual warning accepted in local-only demo mode";
  if (state === "complete") return "Existing task reconciled without retry or remote operations";
  return "Administrative reconciliation of the existing demo task";
}
