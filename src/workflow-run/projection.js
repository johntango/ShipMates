import path from "node:path";
import { pathToFileURL } from "node:url";

export function projectWorkflowRun(run) {
  const values = {
    awaiting_approval: ["Blocked safely", "Approve the short plan to begin local work.", "No files will change until you approve."],
    approved: ["In progress", null, "The approved local work is starting."],
    launching: ["In progress", null, "One isolated Implementer is being started."],
    implementing: ["In progress", null, "The Implementer is working in an isolated workspace."],
    worker_complete: ["In progress", null, "Implementation finished; exact-head validation is starting."],
    validating: ["In progress", null, "No-mistakes is validating the exact implemented Git head."],
    awaiting_validation_decision: [
      "Blocked safely",
      "Review the validation concern, then approve validation or stop.",
      run.validation?.review?.summary || "Validation needs one human risk decision before it can finish.",
    ],
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
    ...terminalEvidence(run),
  ].join("\n");
}

export function validationEvidenceSummary(report) {
  if (!report || typeof report !== "object") {
    return ["No durable no-mistakes check count is available."];
  }
  const generated = integerMetric(report, ["generatedTestCount", "testsGenerated"]);
  const testCases = integerMetric(report, ["executedTestCaseCount", "testCasesExecuted", "testCount"]);
  const checks = Array.isArray(report.steps)
    ? report.steps.filter(({ step, status }) => status === "completed" &&
      new Set(["test", "lint", "review"]).has(step))
    : [];
  return [
    generated === null
      ? "No generated project tests were recorded by no-mistakes."
      : `No-mistakes generated ${generated} project test${generated === 1 ? "" : "s"}.`,
    testCases === null
      ? "No individual test-case count was recorded."
      : `No-mistakes executed ${testCases} test case${testCases === 1 ? "" : "s"}.`,
    ...(checks.length ? [
      `No-mistakes completed ${checks.length} validation check${checks.length === 1 ? "" : "s"}: ${checks.map(({ step }) => step).join(", ")}.`,
    ] : []),
  ];
}

function terminalEvidence(run) {
  if (!new Set(["completed", "blocked"]).has(run.phase)) return [];
  const files = Array.isArray(run.worker?.report?.files)
    ? run.worker.report.files.filter((file) => typeof file === "string" && file.trim())
    : [];
  const lines = [];
  if (run.worker?.workspacePath) {
    lines.push("Delivery: The candidate is preserved in its isolated workspace; it has not been copied or merged into the shared checkout.");
    const entry = staticEntry(run.worker.workspacePath, files);
    if (entry) lines.push(`Candidate page: ${entry}`);
    else lines.push(`Candidate workspace: ${run.worker.workspacePath}`);
  }
  if (files.length) lines.push(`Files: ${files.join(", ")}`);
  const artifacts = durableArtifacts(run);
  if (artifacts.length) lines.push(`Durable preview evidence: ${artifacts.join(", ")}`);
  if (run.validation?.report) lines.push(...validationEvidenceSummary(run.validation.report));
  return lines;
}

function staticEntry(workspacePath, files) {
  const relative = files.find((file) => /(?:^|\/)index\.html$/iu.test(file));
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) return null;
  return pathToFileURL(path.join(workspacePath, relative)).href;
}

function durableArtifacts(run) {
  const values = [run.worker?.report?.artifacts, run.validation?.report?.artifacts]
    .flatMap((items) => Array.isArray(items) ? items : []);
  return values.flatMap((item) => {
    const value = typeof item === "string" ? item : item?.path || item?.url;
    if (typeof value !== "string" || !value.trim()) return [];
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/iu.test(value)) return [];
    return [value.trim()];
  });
}

function integerMetric(report, names) {
  for (const name of names) {
    if (Number.isSafeInteger(report[name]) && report[name] >= 0) return report[name];
    if (Number.isSafeInteger(report.metrics?.[name]) && report.metrics[name] >= 0) {
      return report.metrics[name];
    }
  }
  return null;
}
