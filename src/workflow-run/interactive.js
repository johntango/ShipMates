import { renderWorkflowRun } from "./projection.js";
import {
  artifact, parseCapabilityIntent, prepareCapabilityBundle, renderCapabilitySummary,
} from "./capability-pack.js";
import { renderProjectRoadmap } from "./project-cycle-pack.js";

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
    const capabilityIntent = parseCapabilityIntent(message);
    if (capabilityIntent) return this.#capability(capabilityIntent);
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
    if (/^(?:\/status\s+workspaces?|show|check) (?:the )?(?:workspace|cleanup) (?:status|inventory)[.!]?$/iu.test(normalized)) {
      const context = await repository();
      return this.maintenance.render(await this.maintenance.inventory({ repoPath: context.repoPath }));
    }
    if (/^(?:preview|dry-run) clean project[.!]?$/iu.test(normalized)) {
      const context = await repository();
      return this.maintenance.renderClean(await this.maintenance.clean({ repoPath: context.repoPath, dryRun: true }));
    }
    if (/^(?:\/clean|clean project)[.!]?$/iu.test(normalized)) {
      const context = await repository();
      return this.maintenance.renderClean(await this.maintenance.clean({ repoPath: context.repoPath }));
    }
    const wipe = normalized.match(/^(?:\/wipe-clean|wipe-clean project) (.+)$/iu);
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
    const capabilityBundle = await prepareCapabilityBundle({ repository, request: message });
    const run = await this.store.create({
      request: message, plan, repoPath: repository.repoPath,
      baseHeadSha: repository.baseSha, authority: "local_write",
      capabilityBundle,
    });
    const lines = [
      "Proposed plan:",
      plan,
      ...renderCapabilitySummary(run),
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

  async #capability({ command, argument }) {
    if (command === "clean" || command === "wipe-clean") {
      return this.#maintenance(command === "clean" ? "/clean" : `/wipe-clean ${argument}`);
    }
    const runs = await this.store.list();
    const active = runs.find(({ phase }) => !new Set(["completed", "blocked"]).has(phase));
    const latest = runs[0] || null;
    if (command === "cycle" && !active && argument) {
      const selected = argument.match(/^(greenfield|brownfield)\s+(.+)$/iu);
      if (!selected) return "Choose a project cycle before approval: /cycle greenfield <goal> or /cycle brownfield <goal>.";
      return this.#prepareCapabilityRequest(selected[2], selected[1].toLowerCase());
    }
    if (command === "spec" && !active && argument) {
      const override = argument.match(/^--mode\s+(brownfield|greenfield)\s+(.+)$/iu);
      const request = override?.[2] || argument;
      return this.#prepareCapabilityRequest(request, override?.[1]?.toLowerCase() || null);
    }
    if (!latest) {
      return command === "spec" || command === "cycle"
        ? "Describe the goal after /spec. First Mate will capture read-only context and propose one bounded slice."
        : "No local capability workflow has been recorded yet. Start with /spec followed by the goal.";
    }
    if (command === "status") return renderWorkflowRun(latest);
    if (command === "roadmap" || command === "cycle") return renderProjectRoadmap(latest);
    if (command === "details") return renderWorkflowRun(latest, { technical: true });
    if (command === "spec") return renderArtifact("Specification", latest.capability?.spec);
    if (command === "plan") {
      if (argument && latest.phase === "completed" && latest.capability?.slice?.content) {
        const proposed = artifact("slice.followup_proposed", {
          ...latest.capability.slice.content,
          title: "Proposed follow-up slice",
          objective: argument,
          acceptanceChecks: ["The follow-up behavior is observable in a new isolated candidate.", "Exact-head local validation passes."],
        });
        const updated = await this.store.append(latest.id, "slice.followup_proposed", {
          artifact: proposed,
        }, `artifact:${proposed.digest}`);
        return [
          renderArtifact("Proposed follow-up slice", updated.capability.followupSlice),
          "This later slice is not approved or scheduled. It requires its own scoped approval before implementation.",
          renderProjectRoadmap(updated),
        ].join("\n");
      }
      return renderSlice(latest.capability, latest.phase);
    }
    if (command === "build") {
      if (!active) return "No approved slice is waiting to build. Use /spec to propose a new bounded slice.";
      if (active.phase === "awaiting_approval") {
        return `${renderWorkflowRun(active)}\nApprove the displayed specification and slice once; /build never bypasses approval.`;
      }
      return renderWorkflowRun(await this.controller.advance(active.id));
    }
    if (command === "test") {
      if (!active) return `${renderWorkflowRun(latest)}\nNo validation was started or rerun by this status request.`;
      return renderWorkflowRun(await this.controller.advance(active.id));
    }
    if (command === "review") return this.#review(latest);
    if (command === "ship") return this.#shipPreview(latest);
    return "That capability command is not available in the current workflow phase.";
  }

  async #prepareCapabilityRequest(request, modeOverride) {
    if (this.planningPromise) return "Firstmate is still preparing the current short plan. No second request was started.";
    const active = await this.#active();
    if (active) return `${renderWorkflowRun(active)}\nFinish or resolve this workflow before starting another.`;
    this.planningPromise = (async () => {
      const repository = await this.context();
      const decision = await this.planner(request, repository);
      if (decision.action === "answer" || decision.action === "control") {
        return "Blocked safely: First Mate could not produce a local implementation specification from that request. No plan was saved; clarify the local change you want to make.";
      }
      if (!isLocalImplementation(decision)) {
        return "Blocked safely: this request requires publication, destructive work, or authority beyond local implementation. /spec did not save or approve a plan.";
      }
      const plan = shortPlan(decision);
      const capabilityBundle = await prepareCapabilityBundle({ repository, request, modeOverride });
      const run = await this.store.create({
        request, plan, repoPath: repository.repoPath, baseHeadSha: repository.baseSha,
        authority: "local_write", capabilityBundle,
      });
      return [
        "Specification and bounded slice proposed.",
        "No files have changed. Reply “I approve the plan” once to authorize only this first slice.",
        renderWorkflowRun(run),
      ].join("\n");
    })();
    try { return await this.planningPromise; }
    finally { this.planningPromise = null; }
  }

  async #review(run) {
    const summary = run.phase === "completed"
      ? "Quality review: the exact isolated candidate passed its selected validation policy."
      : run.phase === "blocked"
        ? "Quality review: the workflow is blocked safely; no delivery is recommended."
        : "Quality review: implementation or exact-head validation is not terminal yet.";
    const evidence = [
      `Current phase: ${run.phase}.`,
      reviewWorkerEvidence(run),
      run.validation?.report?.outcome ? `Validation outcome: ${run.validation.report.outcome}.` : "No terminal validation outcome is available.",
    ];
    if (run.capability) {
      const record = artifact("review.recorded", {
        schemaVersion: 1, summary, evidence, mutatesState: false, externalDelivery: false,
      });
      await this.store.append(run.id, "review.recorded", { artifact: record }, `artifact:${record.digest}`);
    }
    return `${summary}\n${evidence.join("\n")}\nThis review is advisory and did not modify the candidate or workflow authority.`;
  }

  async #shipPreview(run) {
    const summary = run.phase === "completed"
      ? "Delivery preview: the validated isolated candidate could be proposed for a separate delivery approval."
      : "Delivery preview blocked: only a completed exact-head validated candidate can be considered.";
    const evidence = [
      "No push, pull request, merge, publication, or shared-checkout change was performed.",
      run.worker?.workspacePath ? "The candidate remains in its isolated workspace." : "No verified candidate workspace is available.",
    ];
    if (run.capability) {
      const record = artifact("ship.previewed", {
        schemaVersion: 1, summary, evidence, mutatesState: false, externalDelivery: false,
      });
      await this.store.append(run.id, "ship.previewed", { artifact: record }, `artifact:${record.digest}`);
    }
    return `${summary}\n${evidence.join("\n")}\nA future explicit delivery approval is required before any external action.`;
  }
}

function renderArtifact(label, value) {
  if (!value?.content) return `${label}: no typed artifact has been recorded.`;
  return `${label}:\n${JSON.stringify(value.content, null, 2)}\nThis is advisory evidence inside the current WorkflowRun; it grants no authority.`;
}

function renderSlice(capability, phase) {
  const slice = capability?.slice?.content;
  const spec = capability?.spec?.content;
  if (!slice || !spec) return "Selected slice: no typed artifact has been recorded.";
  return [
    `Selected slice: ${slice.title}`,
    `Objective: ${slice.objective}`,
    `Non-goals: ${spec.nonGoals.join("; ")}`,
    `Acceptance checks: ${slice.acceptanceChecks.join("; ")}`,
    `Validation: exact candidate head; ${slice.validationPolicy.baselineAtBase ? "record base-head behavior separately" : "use the approved acceptance policy as baseline"}; no remote delivery.`,
    phase === "awaiting_approval"
      ? "Next: Reply “I approve the plan” once to authorize this bounded slice."
      : "Next: Ask for status to see the current execution evidence.",
    "Detailed typed artifact remains available in durable diagnostic evidence.",
  ].join("\n");
}

function reviewWorkerEvidence(run) {
  if (!run.worker?.report) return "No terminal Implementer report is available.";
  const summary = (run.worker.report.summary || "The Implementer produced a candidate result.")
    .replaceAll(/\bNo commit[^.]*\.(?:\s|$)/giu, "")
    .replaceAll(/\s+/gu, " ").trim();
  const preserved = run.worker.headSha
    ? " First Mate preserved the result as the isolated candidate commit used for exact-head validation."
    : "";
  const tests = Array.isArray(run.worker.report.tests) && run.worker.report.tests.length
    ? ` Implementer verification recorded: ${run.worker.report.tests.map(({ command, result }) => `${command}: ${result}`).join("; ")}`
    : "";
  return `${summary}${preserved}${tests}`;
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
