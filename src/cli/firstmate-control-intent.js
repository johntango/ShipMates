const taskReference = /\btask-[a-z0-9]+\b/iu;

export async function resolveFirstmateControlIntent({ message, projectStore }) {
  if (typeof message !== "string" || !projectStore) return null;
  const taskId = message.match(taskReference)?.[0] || null;
  if (!taskId) return null;
  const context = await projectStore.describeTask(taskId);
  if (!context) return null;
  const block = message.match(/\bblocked?\s+because\s+(.+)$/iu);
  if (/\bmark\b/iu.test(message) && block) {
    return { action: "mark_blocked", taskId, context, reason: block[1].trim() };
  }
  if (/\bretry\s+(?:blocked\s+)?task\b/iu.test(message)) {
    return { action: "retry_blocked", taskId, context };
  }
  if (/\bshow\s+task\s+evidence\b/iu.test(message)) {
    return { action: "show_evidence", taskId, context };
  }
  if (/\breconcile\s+task\b/iu.test(message)) {
    return { action: "reconcile_task", taskId, context };
  }
  const approval = /\b(?:approve|approved|accept|accepted)\b/iu.test(message);
  const warning = /\b(?:warning|residual|risk|browser)\b/iu.test(message);
  const finish = /\b(?:complete|finish|resume|apply|close)\b/iu.test(message);
  if (approval && warning && finish) {
    return { action: "accept_demo_warning", taskId, context };
  }
  if (/\b(?:status|show|report|what happened)\b/iu.test(message)) {
    return { action: "show_status", taskId, context };
  }
  if (/\b(?:recover|reconcile|resume|retry)\b/iu.test(message)) {
    return { action: "resume_existing", taskId, context };
  }
  return null;
}
