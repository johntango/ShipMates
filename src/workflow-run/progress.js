import { renderWorkflowRun } from "./projection.js";

export const VALIDATION_PROGRESS_HEARTBEAT_MS = 60_000;
export const VALIDATION_STALL_MS = 5 * 60_000;

export class ValidationProgressReporter {
  constructor({ clock = () => new Date(), heartbeatMs = VALIDATION_PROGRESS_HEARTBEAT_MS,
    stallMs = VALIDATION_STALL_MS } = {}) {
    this.clock = clock;
    this.heartbeatMs = heartbeatMs;
    this.stallMs = stallMs;
    this.lastStage = null;
    this.lastMessageAt = 0;
  }

  message(activity, { visibility = null } = {}) {
    if (!activity || activity.status !== "running") return null;
    const now = this.clock().getTime();
    const changed = activity.stage !== this.lastStage;
    if (!changed && now - this.lastMessageAt < this.heartbeatMs) return null;
    this.lastStage = activity.stage;
    this.lastMessageAt = now;
    return renderValidationActivity(activity, { now, stallMs: this.stallMs, visibility });
  }
}

export function validationActivity(message, previous = null, { clock = () => new Date() } = {}) {
  const now = clock().toISOString();
  const stage = validationStage(message) || previous?.stage || "starting";
  return Object.freeze({
    schemaVersion: 1, status: "running", stage,
    startedAt: previous?.startedAt || now, updatedAt: now,
  });
}

export function renderValidationActivity(activity, { now = Date.now(), stallMs = VALIDATION_STALL_MS,
  visibility = null } = {}) {
  if (!activity || activity.status !== "running") return null;
  const started = Date.parse(activity.startedAt);
  const updated = Date.parse(activity.updatedAt);
  const elapsed = Number.isFinite(started) ? Math.max(0, now - started) : null;
  const stale = Number.isFinite(updated) && now - updated >= stallMs;
  const elapsedText = elapsed === null ? "" : ` (${formatElapsed(elapsed)})`;
  const visibilityText = visibility?.available === false
    ? " Herder visibility is unavailable, but validation continues independently."
    : "";
  if (stale) {
    return `Validation may be stalled — no new durable stage has appeared${elapsedText}. Next: no action is needed yet; First Mate is still monitoring and will block safely if validation times out.${visibilityText}`;
  }
  const stage = activity.stage === "test" ? "running the tests" :
    activity.stage === "lint" ? "checking code quality" :
      activity.stage === "review" ? "reviewing the candidate" :
        activity.stage === "starting" ? "preparing the checks" : "running the checks";
  return `Still working — no-mistakes is ${stage}${elapsedText}. No action is needed.${visibilityText}`;
}

function validationStage(message) {
  const text = String(message || "");
  if (/\btests?|testing\b/iu.test(text)) return "test";
  if (/\blint|code quality|format(?:ting)?\b/iu.test(text)) return "lint";
  if (/\breview|finding|approval\b/iu.test(text)) return "review";
  if (/\bstart|prepar|initializ/iu.test(text)) return "starting";
  return "checks";
}

function formatElapsed(milliseconds) {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "under a minute elapsed";
  return `${minutes} minute${minutes === 1 ? "" : "s"} elapsed`;
}

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
