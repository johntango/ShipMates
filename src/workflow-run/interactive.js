import { renderWorkflowRun } from "./projection.js";

export class SimpleWorkflowConversation {
  constructor({ store, controller, planner, context } = {}) {
    if (!store || !controller || typeof planner !== "function" || typeof context !== "function") {
      throw new TypeError("SimpleWorkflowConversation requires store, controller, planner, and context");
    }
    this.store = store;
    this.controller = controller;
    this.planner = planner;
    this.context = context;
    this.planningPromise = null;
    this.approvalQueued = false;
  }

  async handle(message) {
    if (isValidationApproval(message)) {
      const active = await this.#active();
      if (!active || active.phase !== "awaiting_validation_decision") {
        return "No validation concern is awaiting approval.";
      }
      return renderWorkflowRun(await this.controller.approveValidation(active.id));
    }
    if (isApproval(message)) {
      if (this.planningPromise) {
        this.approvalQueued = true;
        return "Firstmate is still preparing the short plan. Your approval is queued and will apply only after that plan is durably saved.";
      }
      const active = await this.#active();
      if (!active || active.phase !== "awaiting_approval") {
        return "No plan is ready for approval yet. Send the development request first; Firstmate will show the short plan when it is durably saved.";
      }
      return renderWorkflowRun(await this.controller.approve(active.id));
    }
    if (isWorkflowFollowUp(message)) {
      if (this.planningPromise) return "Firstmate is still preparing and saving the short plan.";
      const latest = (await this.store.list())[0];
      if (!latest) return "No simple local workflow has been recorded yet.";
      return renderWorkflowRun(latest);
    }
    if (this.planningPromise) {
      return "Firstmate is still preparing the current short plan. No second request was started.";
    }
    this.planningPromise = this.#prepare(message);
    try { return await this.planningPromise; }
    finally { this.planningPromise = null; this.approvalQueued = false; }
  }

  async #prepare(message) {
    const active = await this.#active();
    if (active) {
      return `${renderWorkflowRun(await this.controller.advance(active.id))}\nFinish or resolve this workflow before starting another.`;
    }
    const repository = await this.context();
    const decision = await this.planner(message, repository);
    if (decision.action === "answer") return decision.response;
    if (decision.action === "control") return "No simple local workflow is active.";
    if (!isLocalImplementation(decision)) {
      return "Blocked safely: this simple path only accepts local implementation. Read-only, publication, destructive, and expanded-authority work use a separate explicit path.";
    }
    const plan = shortPlan(decision);
    const run = await this.store.create({
      request: message, plan, repoPath: repository.repoPath,
      baseHeadSha: repository.baseSha, authority: "local_write",
    });
    const lines = [
      "Proposed plan:",
      plan,
    ];
    if (this.approvalQueued) {
      lines.push(
        "The approval you sent while planning was in progress has now been applied to this saved plan.",
        renderWorkflowRun(await this.controller.approve(run.id)),
      );
    } else {
      lines.push(
        "No files have changed. Reply “I approve the plan” to start one isolated Implementer.",
        renderWorkflowRun(run),
      );
    }
    return lines.join("\n");
  }

  async #active() {
    return (await this.store.list()).find(({ phase }) =>
      !new Set(["completed", "blocked"]).has(phase));
  }
}

function isApproval(value) {
  return /^\s*(?:i\s+)?approve(?:\s+(?:the\s+)?plan)?[.!]?\s*$/iu.test(value);
}

function isValidationApproval(value) {
  return /^\s*(?:i\s+)?approve\s+(?:the\s+)?validation(?:\s+(?:risk|warning|concern))?[.!]?\s*$/iu.test(value);
}

function isWorkflowFollowUp(value) {
  const message = String(value).replaceAll(/\s+/gu, " ").trim();
  if (/^(?:show\s+)?status[.!]?$/iu.test(message)) return true;
  if (!/^(?:can\s+you\s+)?(?:show|tell|give|where|what|which|how|did|is|are)\b/iu.test(message)) {
    return false;
  }
  return /\b(?:status|result|outcome|happened|finish(?:ed)?|complete(?:d)?|pass(?:ed)?|fail(?:ed)?|page|url|preview|files?|artifacts?|creat(?:e|ed)|changed|tests?|validation)\b/iu.test(message);
}

function isLocalImplementation(decision) {
  if (decision.action === "dispatch") return decision.requiredAuthority === "local_write";
  return decision.action === "plan" && decision.tasks.length > 0 &&
    decision.tasks.some(({ requiredAuthority }) => requiredAuthority === "local_write") &&
    decision.tasks.every(({ requiredAuthority }) =>
      new Set(["read_only", "local_write"]).has(requiredAuthority));
}

function shortPlan(decision) {
  if (decision.action === "plan") {
    return decision.tasks.slice(0, 3).map(({ title }, index) => `${index + 1}. ${title}`).join("\n");
  }
  return "1. Implement the approved local change in one isolated workspace.\n2. Validate the exact candidate commit with no-mistakes.";
}
