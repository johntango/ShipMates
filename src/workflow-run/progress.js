import { renderWorkflowRun } from "./projection.js";

export function workflowProgressMessage(event, run = null) {
  if (!event || typeof event.type !== "string") return null;
  switch (event.type) {
    case "workflow.created":
      return "Short plan ready. First Mate is waiting for your approval.";
    case "worker.launched":
      return "Plan approved. One Implementer started in an isolated workspace.";
    case "validation.requested":
      return "Implementation finished. No-mistakes started validating the exact candidate.";
    case "validation.review_requested": {
      const summary = clean(event.data?.review?.summary);
      return summary
        ? `Validation needs one decision: ${summary}`
        : "Validation needs one decision before it can continue.";
    }
    case "workflow.completed":
      return run
        ? renderWorkflowRun(run)
        : "Completed. The Implementer created the code, and no-mistakes tested and validated that exact isolated candidate.";
    case "workflow.blocked":
      return "Blocked safely. No further workflow action was taken; review the dashboard for the next step.";
    default:
      return null;
  }
}

function clean(value) {
  if (typeof value !== "string") return "";
  return value.replaceAll(/\s+/gu, " ").trim().slice(0, 300);
}
