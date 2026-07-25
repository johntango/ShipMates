export const TERMINAL_LIFECYCLE_STATES = Object.freeze(["complete", "failed", "cancelled"]);

const owners = Object.freeze({
  proposed: "human", clarified: "human", approved_for_dispatch: "supervisor",
  preparing: "supervisor", running: "supervisor", awaiting_worker: "supervisor",
  validating: "supervisor", awaiting_human: "human", ready_to_merge: "delivery",
  merging: "delivery", landed: "supervisor", cleaning: "supervisor",
  blocked: "human", recovery_required: "human",
  complete: null, failed: null, cancelled: null,
});

const operationCollections = Object.freeze({
  commit: "gitCommits", validation: "validationRequests", push: "gitPushes",
  draft_pull_request: "githubDraftPullRequests", merge: "githubMerges",
  post_merge: "postMergeAssurances", branch_cleanup: "branchCleanups",
});

export function projectLifecycleV2({ snapshot, projectTask = null } = {}) {
  if (!snapshot || typeof snapshot.id !== "string" || !(snapshot.state in owners)) {
    throw new TypeError("Lifecycle v2 requires a supported task snapshot");
  }
  return Object.freeze({
    schemaVersion: 2,
    taskId: snapshot.id,
    watermark: Object.freeze({
      eventId: snapshot.lastEventId || null, eventsCount: snapshot.eventsCount ?? null,
    }),
    lifecycle: Object.freeze({
      state: snapshot.state,
      owner: owners[snapshot.state],
      terminal: TERMINAL_LIFECYCLE_STATES.includes(snapshot.state),
    }),
    attempts: Object.freeze(projectAttempts(snapshot, projectTask)),
    operations: Object.freeze(projectOperations(snapshot)),
  });
}

export async function migrateLifecycleRecords({ store, projectStore = null, write } = {}) {
  if (!store || typeof store.listTaskIds !== "function" || typeof store.getSnapshot !== "function" ||
    typeof write !== "function") {
    throw new TypeError("Lifecycle migration requires store and write(record)");
  }
  const records = [];
  for (const taskId of await store.listTaskIds()) {
    const snapshot = await store.getSnapshot(taskId);
    const context = projectStore?.describeAttempt
      ? await projectStore.describeAttempt(taskId) : null;
    const record = projectLifecycleV2({ snapshot, projectTask: context?.projectTask || null });
    await write(record);
    records.push(record);
  }
  return records;
}

function projectAttempts(snapshot, projectTask) {
  if (projectTask?.attempts?.length) return projectTask.attempts.map((attempt, index) =>
    Object.freeze({
      attempt: index + 1, taskId: attempt.taskId, status: attempt.status || null,
      current: attempt.taskId === projectTask.taskId,
    }));
  return [Object.freeze({
    attempt: 1, taskId: snapshot.id, status: null, current: true,
  })];
}

function projectOperations(snapshot) {
  const operations = [];
  for (const [kind, collection] of Object.entries(operationCollections)) {
    for (const [index, operation] of (snapshot[collection] || []).entries()) {
      const status = normalizedOperationStatus(kind, operation);
      operations.push(Object.freeze({
        kind, operationId: operation.operationId || `${kind}-${index + 1}`,
        status,
        terminal: new Set(["completed", "failed", "cancelled", "verified"]).has(status),
      }));
    }
  }
  return operations;
}

function normalizedOperationStatus(kind, operation) {
  if (operation.status) return operation.status;
  if (kind === "post_merge") return "verified";
  if (operation.passed === true) return "completed";
  if (operation.passed === false) return "failed";
  return "requested";
}
