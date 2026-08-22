import path from "node:path";
import { pathToFileURL } from "node:url";

import { renderCapabilitySummary } from "./capability-pack.js";

export function projectWorkflowRun(run) {
  const [phase, nextAction, why] = evidenceStatus(run);
  return Object.freeze({
    outcome: phase, nextAction, why, phase,
    details: [...renderCapabilitySummary(run), ...visibilityEvidence(run), ...terminalEvidence(run)],
  });
}

export function workflowExecutionMilestones(run) {
  const files = Array.isArray(run.worker?.report?.files)
    ? run.worker.report.files.filter((file) => typeof file === "string" && file.trim())
    : [];
  const planApproved = run.phase !== "awaiting_approval" && run.phase !== "planning";
  const workerStatus = run.phase === "blocked" && run.worker?.status !== "completed" ? "Blocked safely" :
    run.worker?.status === "completed" ? "Completed" :
    run.worker?.status === "launched" ? "Working" : run.worker ? "Starting" : "Queued";
  let validatorStatus = "Queued";
  if (run.validation?.status === "passed") validatorStatus = "Passed";
  else if (run.validation?.status === "failed" ||
    (run.phase === "blocked" && run.validation)) validatorStatus = "Blocked safely";
  else if (run.validation?.status === "awaiting_decision") validatorStatus = "Awaiting your approval";
  else if (run.validation) validatorStatus = "Validating";
  const checks = run.validation?.report ? validationEvidenceSummary(run.validation.report) : [];
  const baseline = run.validation?.report ? baselineEvidenceSummary(run.validation.report) : [];
  return Object.freeze([
    {
      label: "Plan", status: planApproved ? "Approved" : "Awaiting your approval",
      summary: planApproved ? "The approved scope is fixed for this local run." :
        "The approved scope is ready; no implementation has started.",
    },
    {
      label: "Implementer", status: workerStatus,
      summary: workerStatus === "Completed"
        ? `The Implementer completed the isolated candidate${files.length ? ` and changed: ${files.join(", ")}` : "."}`
        : workerStatus === "Blocked safely" ? "Implementation stopped without changing the shared checkout."
          : workerStatus === "Working" ? "The Implementer is working in the isolated workspace."
          : workerStatus === "Starting" ? "The isolated Implementer is starting."
            : "Implementation has not started.",
    },
    {
      label: "No-mistakes", status: validatorStatus,
      summary: validatorStatus === "Passed" ? `Exact-candidate validation passed.${baseline.length ? ` ${baseline.join(" ")}` : ""}${checks.length ? ` ${checks.join(" ")}` : ""}` :
        validatorStatus === "Validating" ? "No-mistakes is validating the exact isolated candidate." :
          validatorStatus === "Awaiting your approval" ? "Validation found a risk requiring your decision." :
            validatorStatus === "Blocked safely" ? "Validation stopped without changing or publishing the candidate." :
              "Validation is queued until implementation completes.",
    },
  ]);
}

function visibilityEvidence(run) {
  if (!run.validation) return [];
  const visibility = run.visibility || run.validation.visibility;
  if (visibility?.available) return ["Validation is visible in Herder."];
  return [new Set(["completed", "blocked"]).has(run.phase)
    ? "Herder visibility was unavailable; validation continued independently."
    : "Herder visibility unavailable; validation continues."];
}

export function renderWorkflowRun(run) {
  const view = projectWorkflowRun(run);
  return [
    `Status: ${view.phase}`,
    ...(view.nextAction ? [`Next: ${view.nextAction}`] : []),
    `Why: ${view.why}`,
    ...view.details,
  ].join("\n");
}

function evidenceStatus(run) {
  if (run.phase === "blocked") {
    return [
      "Blocked safely",
      "Resolve the stated issue, then ask First Mate to try the request again.",
      run.blocker || "The workflow stopped without risking additional changes.",
    ];
  }
  if (run.phase === "completed") {
    const exactPass = run.worker?.status === "completed" &&
      run.validation?.status === "passed" &&
      run.validation?.headSha === run.worker?.headSha;
    return exactPass
      ? [
          "Passed",
          "Review the isolated candidate. Sharing it remains a separate explicit decision.",
          "The Implementer created the code, and no-mistakes tested and validated that exact isolated candidate.",
        ]
      : [
          "Blocked safely",
          "Ask First Mate to inspect the stored evidence before any delivery.",
          "The recorded completion is missing matching worker or exact-head validation evidence.",
        ];
  }
  if (run.phase === "awaiting_validation_decision" ||
    run.validation?.status === "awaiting_decision") {
    return [
      "Awaiting your approval",
      "Choose whether to accept this validation risk or stop safely.",
      run.validation?.review?.summary || "No-mistakes found a risk that requires human judgment.",
    ];
  }
  if (run.validation || run.worker?.status === "completed") {
    return [
      "Validating",
      "No action needed; First Mate is monitoring no-mistakes for the exact candidate result.",
      "The Implementer finished, and no-mistakes is validating that exact isolated candidate.",
    ];
  }
  if (run.worker || new Set(["approved", "launching", "implementing"]).has(run.phase)) {
    return [
      "Working",
      "No action needed; First Mate is monitoring the isolated Implementer.",
      run.worker?.receipt
        ? "The Implementer is active in the isolated workspace."
        : "The approved Implementer is being started in the isolated workspace.",
    ];
  }
  if (run.phase === "awaiting_approval") {
    return [
      "Awaiting your approval",
      "Approve the short plan to begin local work, or stop without changing files.",
      "The short plan is ready; no files have changed.",
    ];
  }
  if (run.phase === "planning") {
    return [
      "Planning",
      "No action needed; First Mate is preparing a short plan.",
      "First Mate is turning the request into a bounded local plan.",
    ];
  }
  return [
    "Blocked safely",
    "Ask First Mate to inspect the stored evidence before continuing.",
    "The durable workflow evidence does not identify a safe current phase.",
  ];
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

export function baselineEvidenceSummary(report) {
  const baseline = report?.baseline;
  const candidate = report?.candidate;
  if (!baseline || !candidate) return [];
  const existing = Number.isSafeInteger(baseline.failures) ? baseline.failures : null;
  const introduced = Number.isSafeInteger(candidate.introducedFailures) ? candidate.introducedFailures : null;
  if (existing === null || introduced === null) return [];
  return [
    `Base-head baseline recorded ${existing} existing failure${existing === 1 ? "" : "s"}.`,
    `Candidate validation recorded ${introduced} introduced regression${introduced === 1 ? "" : "s"}.`,
  ];
}

function terminalEvidence(run) {
  if (!new Set(["awaiting_validation_decision", "completed", "blocked"]).has(run.phase) &&
    !run.retries?.length) return [];
  const files = Array.isArray(run.worker?.report?.files)
    ? run.worker.report.files.filter((file) => typeof file === "string" && file.trim())
    : [];
  const lines = [];
  if (run.worker?.report?.status === "completed") {
    lines.push("Created by: The Implementer created the code in this candidate.");
  }
  if (run.phase === "completed" && run.validation?.report) {
    lines.push("Validated by: No-mistakes tested and validated this exact isolated candidate.");
  }
  if (run.phase === "awaiting_validation_decision") {
    lines.push("Decision needed: No-mistakes reported a validation risk that First Mate cannot decide silently.");
    lines.push("Choices: approve this stated risk and continue validation, or stop and keep the isolated candidate unchanged.");
    lines.push("Default: stop safely unless you explicitly approve the stated risk.");
  }
  if (run.retries?.length) {
    lines.push("Recovery: First Mate used its one safe automatic setup retry and did not duplicate work.");
  }
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
  if (run.validation?.report) lines.push(...baselineEvidenceSummary(run.validation.report));
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
