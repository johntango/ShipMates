export function projectWorkflowRun(run) {
  const values = {
    awaiting_approval: ["Blocked safely", "Approve the short plan to begin local work.", "No files will change until you approve."],
    approved: ["In progress", null, "The approved local work is starting."],
    launching: ["In progress", null, "One isolated Implementer is being started."],
    implementing: ["In progress", null, "The Implementer is working in an isolated workspace."],
    worker_complete: ["In progress", null, "Implementation finished; exact-head validation is starting."],
    validating: ["In progress", null, "No-mistakes is validating the exact implemented Git head."],
    validated: ["In progress", null, "Validation passed; completion is being recorded."],
    completed: ["Passed", null, "Implementation and exact-head local validation completed."],
    blocked: ["Blocked safely", "Review the recorded blocker before retrying.", run.blocker || "The workflow stopped without risking additional changes."],
  };
  const [outcome, nextAction, why] = values[run.phase] || ["Failed", "Inspect diagnostic evidence.", "The workflow is in an unknown state."];
  return Object.freeze({ outcome, nextAction, why, phase: run.phase });
}

export function renderWorkflowRun(run) {
  const view = projectWorkflowRun(run);
  return [
    `Outcome: ${view.outcome}`,
    ...(view.nextAction ? [`Next: ${view.nextAction}`] : []),
    `Why: ${view.why}`,
  ].join("\n");
}
