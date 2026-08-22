import { renderWorkflowRun } from "./projection.js";

export function workflowProgressMessage(event, run = null) {
  if (!event || typeof event.type !== "string") return null;
  if (run && new Set([
    "worker.launched", "validation.requested",
    "validation.review_requested", "workflow.completed", "workflow.blocked",
  ]).has(event.type)) return renderWorkflowRun(run);
  switch (event.type) {
    case "workflow.created":
      return null;
    case "worker.launched":
      return "Status: Working\nNext: No action needed; First Mate is monitoring the isolated Implementer.\nWhy: The Implementer is active in the isolated workspace.";
    case "validation.requested":
      return "Status: Validating\nNext: No action needed; First Mate is monitoring no-mistakes for the exact candidate result.\nWhy: The Implementer finished, and no-mistakes is validating that exact isolated candidate.";
    case "validation.review_requested": {
      const summary = clean(event.data?.review?.summary);
      return summary
        ? `Status: Awaiting your approval\nNext: Choose whether to accept this validation risk or stop safely.\nWhy: ${summary}`
        : "Status: Awaiting your approval\nNext: Choose whether to accept this validation risk or stop safely.\nWhy: No-mistakes found a risk that requires human judgment.";
    }
    case "workflow.completed":
      return run
        ? renderWorkflowRun(run)
        : "Completed. The Implementer created the code, and no-mistakes tested and validated that exact isolated candidate.";
    case "workflow.blocked":
      return "Status: Blocked safely\nNext: Resolve the stated issue, then ask First Mate to try the request again.\nWhy: The workflow stopped without risking additional changes.";
    default:
      return null;
  }
}

function clean(value) {
  if (typeof value !== "string") return "";
  return value.replaceAll(/\s+/gu, " ").trim().slice(0, 300);
}
