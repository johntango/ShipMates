const activeStates = new Set([
  "preparing", "running", "awaiting_worker", "validating", "awaiting_human",
]);

export function classifyTaskRecovery(snapshot) {
  if (!snapshot || typeof snapshot.id !== "string") {
    throw new TypeError("Recovery classification requires a task snapshot");
  }
  if (snapshot.state === "complete") {
    return decision("complete", "none", "Task is already complete", true);
  }
  const failedIntake = snapshot.firstmateRuns?.at(-1);
  if (snapshot.state === "proposed" && failedIntake?.status === "failed") {
    return decision(
      "intake_failed",
      "retry_intake",
      failedIntake.failure?.message || "FirstMate intake failed before task classification",
      false,
    );
  }
  const implementer = snapshot.workers?.find(({ id }) => id === "implementer") || null;
  const validation = snapshot.validationRuns?.at(-1) || null;
  if (validation?.gate?.status === "awaiting_approval") {
    return decision(
      "validation_approval_required",
      "request_validation_approval",
      `Local validation awaits human approval at ${validation.gate.step}`,
      false,
    );
  }
  if (validation?.passed === true) {
    return decision("validation_passed", "finish_existing", "Passing validation is already recorded", true);
  }
  if (validation?.passed === false) {
    return decision("validation_failed", "repair_existing", validationReason(validation), false);
  }
  if (snapshot.validationRequests?.at(-1)?.status === "requested") {
    return decision("validation_uncertain", "reconcile_validation", "Validation intent has no terminal result", true);
  }
  if (implementer?.report?.status === "completed" && implementer?.verification?.noMutation === true) {
    return decision("verified_no_change", "finish_demo_no_change", "Requested behavior exists and checks passed without changes", true);
  }
  if (implementer?.report?.status === "blocked") {
    const browserOnly = browserCapabilityOnly(implementer.report);
    return browserOnly
      ? decision("capability_warning", "accept_or_run_capability", implementer.report.summary, true)
      : decision("worker_blocked", "repair_existing", implementer.report.summary, false);
  }
  if (implementer?.status === "reported" && implementer?.verification?.dirty === true) {
    return decision("preserved_changes", "validate_existing_changes", "Verified workspace changes are preserved", true);
  }
  if (new Set(["dispatch_requested", "started"]).has(implementer?.status)) {
    return decision("worker_uncertain", "reconcile_worker", "Worker intent has no terminal report", true);
  }
  if (snapshot.state === "recovery_required") {
    return decision("recovery_required", "inspect_preserved_workspace", "Task requires evidence-based workspace recovery", false);
  }
  if (activeStates.has(snapshot.state)) {
    return decision("stale_active", "inspect_live_process", "Task is active without conclusive terminal evidence", false);
  }
  return decision("human_review", "inspect_evidence", `No automatic recovery policy covers ${snapshot.state}`, false);
}

function decision(category, action, reason, safeToAutomate) {
  return { category, action, reason: reason || category, safeToAutomate };
}

function validationReason(validation) {
  return validation.findings?.find?.(({ message }) => message)?.message ||
    `Validation ${validation.outcome || "failed"}`;
}

function browserCapabilityOnly(report) {
  const text = [report.summary, ...(report.risks || [])].join(" ");
  const tests = report.tests || [];
  const localFailure = tests.some(({ result }) => /\b(?:failed|failure|error)\b/iu.test(result) &&
    !/\b0\s+(?:failed|failures?)\b/iu.test(result) && !/browser|chrome|playwright|permission/iu.test(result));
  return !localFailure && /browser|chrome|playwright|assistive|visual/iu.test(text);
}
