export async function completeFirstmateDemoTask({ store, taskId, actor = "firstmate" } = {}) {
  if (!store || typeof store.getSnapshot !== "function") {
    throw new TypeError("Demo completion requires a task store");
  }
  let snapshot = await store.getSnapshot(taskId);
  let commit = snapshot.gitCommits?.at(-1);
  const implementer = snapshot.workers?.find(({ id }) => id === "implementer");
  const verifiedNoChange = implementer?.status === "reported" &&
    implementer?.report?.status === "completed" && implementer?.verification?.noMutation === true;
  if (snapshot.state === "running" && verifiedNoChange) {
    snapshot = await store.transition({
      taskId, from: "running", to: "validating", actor,
      reason: "Verified no-change demo work is ready for local-only completion",
      eventId: `${taskId}:demo-no-change-validating:v1`,
    });
  }
  commit = snapshot.gitCommits?.at(-1);
  if ((commit?.status !== "completed" && !verifiedNoChange) || snapshot.state !== "validating") {
    if (snapshot.state === "complete" && hasDemoEvidence(snapshot)) {
      return { snapshot, commit: commit?.result || null, reused: true };
    }
    throw new Error("Demo completion requires a controlled commit or verified no-change work awaiting validation");
  }
  snapshot = await store.recordEvidence({
    taskId,
    actor,
    kind: "demo-validation-skipped",
    value: JSON.stringify({
      mode: "local-only-demo",
      validation: "skipped",
      remoteOperations: false,
      headSha: commit?.result?.headSha || snapshot.worktree?.headSha || snapshot.baseSha,
      noChanges: verifiedNoChange,
    }),
    eventId: `${taskId}:demo-validation-skipped:v1`,
  });
  snapshot = await store.transition({
    taskId, from: "validating", to: "cleaning", actor,
    reason: "Local-only demo mode intentionally skips no-mistakes and remote delivery",
    eventId: `${taskId}:demo-cleaning:v1`,
  });
  snapshot = await store.transition({
    taskId, from: "cleaning", to: "complete", actor,
    reason: "Demo task retained locally for dependent project work",
    eventId: `${taskId}:demo-complete:v1`,
  });
  return { snapshot, commit: commit?.result || null, reused: false };
}

export function hasDemoEvidence(snapshot) {
  return snapshot?.evidence?.some(({ kind }) => kind === "demo-validation-skipped") === true;
}
