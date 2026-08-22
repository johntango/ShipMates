import path from "node:path";
import { pathToFileURL } from "node:url";

import { renderCapabilitySummary } from "./capability-pack.js";
import { renderProjectRoadmap } from "./project-cycle-pack.js";

export function projectWorkflowRun(run) {
  const [phase, nextAction, why] = evidenceStatus(run);
  return Object.freeze({
    outcome: phase, nextAction, why, phase,
    details: humanEvidence(run),
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
  const baseline = humanBaselineEvidence(run);
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
      summary: validatorStatus === "Passed" ? `No-mistakes passed the exact isolated candidate.${baseline.length ? ` ${baseline.join(" ")}` : ""}${compactValidationEvidence(run.validation.report).length ? ` ${compactValidationEvidence(run.validation.report).join(" ")}` : ""}` :
        validatorStatus === "Validating" ? run.validationActivityMessage || validationActivitySummary(run.validationActivity) :
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

export function renderWorkflowRun(run, { technical = false } = {}) {
  const view = projectWorkflowRun(run);
  const candidate = workflowCandidateArtifacts(run);
  const pageLine = candidate.pageUrl ? `Candidate page: ${candidate.pageUrl}` : null;
  return [
    `Status: ${view.phase}`,
    ...(view.nextAction ? [`Next: ${view.nextAction}`] : []),
    `Why: ${view.why}`,
    ...(pageLine ? [pageLine] : []),
    ...view.details.filter((detail) => detail !== pageLine),
    ...(technical ? ["Technical evidence:", ...workflowTechnicalEvidence(run)] : []),
  ].join("\n");
}

export function workflowCandidateArtifacts(run) {
  const workspacePath = typeof run.worker?.workspacePath === "string" &&
    path.isAbsolute(run.worker.workspacePath) ? path.resolve(run.worker.workspacePath) : null;
  const reported = Array.isArray(run.worker?.report?.files) ? run.worker.report.files : [];
  const files = workspacePath ? reported.flatMap((file) => {
    if (typeof file !== "string" || !file.trim() || path.isAbsolute(file)) return [];
    const segments = file.split(/[\\/]/u);
    if (segments.includes("..") || segments.includes(".")) return [];
    const relativePath = segments.join("/");
    return [{
      relativePath,
      path: path.join(workspacePath, ...segments),
      html: /\.html?$/iu.test(relativePath),
    }];
  }) : [];
  return Object.freeze({
    workspacePath,
    files: Object.freeze(files),
    pageUrl: workspacePath ? staticEntry(workspacePath, files.map(({ relativePath }) => relativePath)) : null,
  });
}

function evidenceStatus(run) {
  if (run.phase === "blocked") {
    return [
      "Blocked safely",
      blockedNextAction(run.blocker),
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
      run.validationActivityMessage || validationActivitySummary(run.validationActivity),
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

function validationActivitySummary(activity) {
  const stage = activity?.stage === "test" ? "running the tests" :
    activity?.stage === "lint" ? "checking code quality" :
      activity?.stage === "review" ? "reviewing the exact isolated candidate" :
        activity?.stage === "starting" ? "preparing the checks" : "running the checks";
  return `Still working — no-mistakes is ${stage}. No action is needed.`;
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

function compactValidationEvidence(report) {
  if (!report || typeof report !== "object") return [];
  const generated = integerMetric(report, ["generatedTestCount", "testsGenerated"]);
  const testCases = integerMetric(report, ["executedTestCaseCount", "testCasesExecuted", "testCount"]);
  const checks = Array.isArray(report.steps)
    ? report.steps.filter(({ step, status }) => status === "completed" &&
      new Set(["test", "lint", "review"]).has(step)).map(({ step }) =>
      step === "test" ? "tests" : step)
    : [];
  return [
    ...(checks.length ? [
      `No-mistakes completed ${checks.length} check${checks.length === 1 ? "" : "s"}: ${checks.join(" and ")}.`,
    ] : []),
    ...(generated === null ? [] : [generated === 0
      ? "No-mistakes generated no new project tests."
      : `No-mistakes generated ${generated} project test${generated === 1 ? "" : "s"}.`]),
    ...(testCases === null ? [] : [
      `It ran ${testCases} recorded test case${testCases === 1 ? "" : "s"}.`,
    ]),
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

function humanEvidence(run) {
  if (!new Set(["awaiting_validation_decision", "completed", "blocked"]).has(run.phase) &&
    !run.retries?.length) return [...renderCapabilitySummary(run), ...projectCycleSummary(run)];
  const candidate = workflowCandidateArtifacts(run);
  const files = candidate.files.map(({ relativePath }) => relativePath);
  const lines = [];
  if (run.worker?.report?.status === "completed") {
    const summary = cleanHumanText(run.worker.report.summary);
    lines.push(`Created: The Implementer created the code in the isolated candidate${summary ? ` — ${summary}` : "."}`);
  }
  if (run.phase === "completed" && run.validation?.report) {
    lines.push("Checked: No-mistakes tested this exact isolated candidate, and it passed.");
    lines.push(...compactValidationEvidence(run.validation.report));
    if (run.projectCycle?.nextRoadmap) {
      const proposed = run.projectCycle.nextRoadmap.content.nextSlice;
      lines.push(`Proposed next slice: ${proposed.title} — ${proposed.objective} It is not approved or scheduled.`);
    }
  }
  if (run.phase === "awaiting_validation_decision") {
    lines.push("Decision needed: validation found a risk that needs your judgment.");
    lines.push("Choices: accept the stated risk and continue checking, or stop and keep the isolated candidate unchanged.");
    lines.push("Default: stop safely unless you explicitly accept the stated risk.");
  }
  if (run.retries?.length) {
    lines.push("Recovery: First Mate made one safe retry without repeating the implementation.");
  }
  if (candidate.workspacePath) {
    lines.push("Delivery: The candidate is preserved in its isolated workspace; it has not been copied or merged into the shared checkout.");
    const entry = candidate.pageUrl;
    if (entry) lines.push(`Candidate page: ${entry}`);
    else lines.push(`Candidate workspace: ${candidate.workspacePath}`);
  }
  if (files.length) lines.push(`Files: ${files.join(", ")}`);
  const artifacts = durableArtifacts(run);
  if (artifacts.length) lines.push(`Durable preview evidence: ${artifacts.join(", ")}`);
  lines.push(...humanBaselineEvidence(run));
  lines.push(...projectCycleSummary(run));
  return lines;
}

function projectCycleSummary(run) {
  const roadmap = run.projectCycle?.roadmap?.content;
  if (!roadmap) return [];
  return [
    `Project cycle: ${roadmap.currentCycle.name} — ${roadmap.currentCycle.whyNow}`,
    `Current bounded slice: ${roadmap.nextSlice.title}.`,
    `Exit criteria: ${roadmap.currentCycle.exitCriteria.join("; ")}`,
    ...(roadmap.currentCycle.risksAndDependencies.length
      ? [`Risks or decisions: ${roadmap.currentCycle.risksAndDependencies.join("; ")}`] : []),
  ];
}

export function workflowTechnicalEvidence(run) {
  const candidate = workflowCandidateArtifacts(run);
  const files = candidate.files.map(({ relativePath }) => relativePath);
  return [
    ...renderCapabilitySummary(run),
    ...(run.projectCycle ? renderProjectRoadmap(run).split("\n") : []),
    ...visibilityEvidence(run),
    ...(candidate.workspacePath ? [`Candidate workspace: ${candidate.workspacePath}`] : []),
    ...(files.length ? [`Changed files: ${files.join(", ")}`] : []),
    ...(run.worker?.report?.tests?.length ? workerVerificationEvidence(run.worker.report.tests) : []),
    ...(run.validation?.report ? validationEvidenceSummary(run.validation.report) : []),
    ...(run.validation?.report ? baselineEvidenceSummary(run.validation.report) : []),
  ];
}

function humanBaselineEvidence(run) {
  const structured = run.validation?.report ? baselineEvidenceSummary(run.validation.report) : [];
  if (structured.length) return structured.map((line) => line
    .replace(/^Base-head baseline recorded/iu, "Pre-existing baseline issues:")
    .replace(/^Candidate validation recorded/iu, "Candidate regressions:"));
  const results = Array.isArray(run.worker?.report?.tests)
    ? run.worker.report.tests.map(({ result }) => result).filter((value) => typeof value === "string")
    : [];
  return results.some((value) => /baseline|pre-existing|environment failure/iu.test(value))
    ? ["Baseline/environment: pre-existing issues were recorded separately from candidate regressions."]
    : [];
}

function cleanHumanText(value) {
  if (typeof value !== "string") return "";
  return value.replaceAll(/`([^`]+)`/gu, "$1")
    .replaceAll(/\b(?:Changes remain uncommitted|No commit[^.]*|No publication[^.]*)\.?/giu, "")
    .replaceAll(/\s+/gu, " ").trim().replace(/\.?$/u, ".").slice(0, 500);
}

function staticEntry(workspacePath, files) {
  const htmlFiles = files.filter((file) => /\.html?$/iu.test(file));
  const relative = htmlFiles.find((file) => /(?:^|\/)index\.html$/iu.test(file)) ||
    (htmlFiles.length === 1 ? htmlFiles[0] : null);
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) return null;
  return pathToFileURL(path.join(workspacePath, relative)).href;
}

function workerVerificationEvidence(tests) {
  return tests.flatMap(({ command, result }) => {
    if (typeof command !== "string" || typeof result !== "string") return [];
    const cleanCommand = command.replaceAll(/\s+/gu, " ").trim().slice(0, 180);
    const cleanResult = result.replaceAll(/\s+/gu, " ").trim().slice(0, 300);
    return [`Implementer verification — ${cleanCommand}: ${cleanResult}`];
  });
}

function blockedNextAction(blocker) {
  if (/exceeded its safe time limit|timed out/iu.test(blocker || "")) {
    return "Keep the isolated candidate unchanged, check local validator availability, then retry validation only.";
  }
  if (/validation remote/iu.test(blocker || "")) {
    return "Inspect or repair the isolated workspace's managed validator binding; keep the candidate unchanged until that safety check succeeds.";
  }
  if (/initialize.*no-mistakes/iu.test(blocker || "")) {
    return "Check the pinned local no-mistakes installation, then retry validation without rerunning implementation.";
  }
  return "Review the stated cause, preserve the isolated candidate, and retry only the blocked step when it is safe.";
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
