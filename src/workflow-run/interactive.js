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
  }

  async handle(message) {
    const active = (await this.store.list()).find(({ phase }) =>
      !new Set(["completed", "blocked"]).has(phase));
    if (isApproval(message)) {
      if (!active || active.phase !== "awaiting_approval") {
        return "There is no short plan awaiting approval.";
      }
      return renderWorkflowRun(await this.controller.approve(active.id));
    }
    if (isStatus(message)) {
      if (!active) return "No simple local workflow is active.";
      return renderWorkflowRun(await this.controller.advance(active.id));
    }
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
    return [
      "Proposed plan:",
      plan,
      "No files have changed. Reply “I approve the plan” to start one isolated Implementer.",
      renderWorkflowRun(run),
    ].join("\n");
  }
}

function isApproval(value) {
  return /^\s*(?:i\s+)?approve(?:\s+(?:the\s+)?plan)?[.!]?\s*$/iu.test(value);
}

function isStatus(value) {
  return /^\s*(?:show\s+)?status[.!]?\s*$/iu.test(value);
}

function isLocalImplementation(decision) {
  if (decision.action === "dispatch") return decision.requiredAuthority === "local_write";
  return decision.action === "plan" && decision.tasks.length > 0 &&
    decision.tasks.every(({ requiredAuthority }) => requiredAuthority === "local_write");
}

function shortPlan(decision) {
  if (decision.action === "plan") {
    return decision.tasks.slice(0, 3).map(({ title }, index) => `${index + 1}. ${title}`).join("\n");
  }
  return "1. Implement the approved local change in one isolated workspace.\n2. Validate the exact candidate commit with no-mistakes.";
}
