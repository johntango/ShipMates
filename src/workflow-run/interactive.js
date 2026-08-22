import { renderWorkflowRun } from "./projection.js";

export class SimpleWorkflowConversation {
  constructor({ store, controller, planner, context, maintenance = null } = {}) {
    if (!store || !controller || typeof planner !== "function" || typeof context !== "function") {
      throw new TypeError("SimpleWorkflowConversation requires store, controller, planner, and context");
    }
    this.store = store;
    this.controller = controller;
    this.planner = planner;
    this.context = context;
    this.maintenance = maintenance;
    this.planningPromise = null;
    this.approvalQueued = false;
  }

  async handle(message) {
    const maintenance = await this.#maintenance(message);
    if (maintenance !== null) return maintenance;
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
      const runs = await this.store.list();
      const latest = runs[0];
      if (!latest) return "No simple local workflow has been recorded yet.";
      const selected = isCompletedResultFollowUp(message)
        ? runs.find(({ phase }) => phase === "completed") || latest
        : latest;
      const lines = [renderWorkflowRun(selected)];
      if (selected !== latest && latest.phase === "blocked") {
        lines.push(
          "Current status note: A newer workflow is blocked safely. That blocker is separate from the completed result above.",
        );
      }
      return lines.join("\n");
    }
    if (this.planningPromise) {
      return "Firstmate is still preparing the current short plan. No second request was started.";
    }
    this.planningPromise = this.#prepare(message);
    try { return await this.planningPromise; }
    finally { this.planningPromise = null; this.approvalQueued = false; }
  }

  async #maintenance(message) {
    if (!this.maintenance) return null;
    const normalized = String(message).replaceAll(/\s+/gu, " ").trim();
    const repository = async () => this.context();
    if (/^(?:show|check) (?:the )?(?:workspace|cleanup) (?:status|inventory)[.!]?$/iu.test(normalized)) {
      const context = await repository();
      return this.maintenance.render(await this.maintenance.inventory({ repoPath: context.repoPath }));
    }
    if (/^(?:preview|dry-run) clean project[.!]?$/iu.test(normalized)) {
      const context = await repository();
      return this.maintenance.renderClean(await this.maintenance.clean({ repoPath: context.repoPath, dryRun: true }));
    }
    if (/^clean project[.!]?$/iu.test(normalized)) {
      const context = await repository();
      return this.maintenance.renderClean(await this.maintenance.clean({ repoPath: context.repoPath }));
    }
    const wipe = normalized.match(/^wipe-clean project (.+)$/iu);
    if (wipe) {
      const context = await repository();
      return this.maintenance.renderWipe(await this.maintenance.previewWipe({
        projectName: wipe[1].trim(), repoPath: context.repoPath,
      }));
    }
    const confirm = normalized.match(/^WIPE-CLEAN ([A-Za-z0-9][A-Za-z0-9._ -]{1,80}) ([a-f0-9]{12})$/u);
    if (confirm) {
      const context = await repository();
      return this.maintenance.renderWipeResult(await this.maintenance.wipe({
        projectName: confirm[1], repoPath: context.repoPath, confirmation: normalized,
      }));
    }
    if (/\bwipe(?:-| )?clean\b/iu.test(normalized)) {
      return "Wipe-clean was not started. Name the project explicitly, for example: wipe-clean project ShipMates. First Mate will show a dry-run manifest before any confirmation is accepted.";
    }
    return null;
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

function isCompletedResultFollowUp(value) {
  const message = String(value).replaceAll(/\s+/gu, " ").trim();
  if (/^(?:show\s+)?status[.!]?$/iu.test(message)) return false;
  return /\b(?:result|outcome|happened|finish(?:ed)?|complete(?:d)?|pass(?:ed)?|page|url|preview|files?|artifacts?|creat(?:e|ed)|changed|tests?|validation)\b/iu.test(message);
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
