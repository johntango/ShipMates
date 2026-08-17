const safeBlocker = /\b(?:approval|authority|permission|sandbox|capabilit|environment|eperm|eacces|unavailable|missing tool|not installed|read-only|read only)\b/iu;

export function projectTaskPresentation(snapshot, {
  reconciliation = null, humanAction = null, execution = null,
} = {}) {
  const readOnlyTerminal = parsedEvidence(snapshot, "read-only-inspection-terminal");
  const workers = (snapshot.workers?.length ? snapshot.workers : executionWorkers(execution));
  const validation = snapshot.validationRuns?.at(-1) || null;
  const classification = snapshot.firstmateRuns?.at(-1)?.classification || null;
  const failures = [
    ...workers.flatMap((worker) => workerFailureText(worker)),
    execution?.failure?.message,
  ].filter(Boolean);
  const failedValidation = validation && validation.passed === false &&
    validation.gate?.status !== "awaiting_approval";
  const safeFailure = failures.some((failure) => safeBlocker.test(failure));
  const unsafeFailure = failures.some((failure) => !safeBlocker.test(failure));
  const safelyBlocked = safeFailure || new Set(["awaiting_human", "recovery_required", "blocked"])
    .has(snapshot.state);
  const explicitlyFailed = !safeFailure && (snapshot.state === "failed" || execution?.status === "failed" || failedValidation ||
    unsafeFailure || readOnlyTerminal?.status === "failed");
  const passed = snapshot.state === "complete" || validation?.passed === true ||
    readOnlyTerminal?.status === "completed" ||
    new Set(["inspected", "completed", "demo_complete"]).has(execution?.status) ||
    (classification?.requiredAuthority === "read_only" && workers.length > 0 &&
      workers.every(workerCompleted));

  const status = explicitlyFailed ? "Failed" : safelyBlocked ? "Blocked safely" :
    passed ? "Passed" : "Blocked safely";
  const nextAction = humanAction || nextActionFor({ status, snapshot, reconciliation });
  const why = whyFor({ status, snapshot, validation, failures, reconciliation });
  const metrics = availableMetrics(snapshot, validation);

  return {
    status,
    nextAction,
    why,
    workBreakdown: {
      agents: workers.map((worker) => ({
        id: worker.id,
        status: worker.status || worker.report?.status || "unknown",
        mode: worker.mode || null,
        summary: worker.report?.summary || null,
      })),
      tasks: progressItems(snapshot),
      tests: workers.flatMap((worker) => (worker.report?.tests || []).map((test) => ({
        agent: worker.id, command: test.command, result: test.result,
      }))),
      decisions: decisionItems({ snapshot, validation, reconciliation, humanAction }),
    },
    evidence: {
      artifacts: workers.flatMap((worker) => worker.report?.files || []),
      ledger: {
        taskId: snapshot.id,
        eventsCount: snapshot.eventsCount,
        lastEventAt: snapshot.lastEventAt || null,
        evidenceCount: snapshot.evidence?.length || 0,
      },
      logs: failures,
      metrics,
    },
  };
}

function parsedEvidence(snapshot, kind) {
  const item = (snapshot.evidence || []).findLast((evidence) => evidence.kind === kind);
  if (!item) return null;
  try { return JSON.parse(item.value); } catch { return null; }
}

export function projectFirstmateOneShotPresentation({ snapshot, execution, classification }) {
  const presentation = projectTaskPresentation(snapshot, { execution });
  if (execution) return presentation;
  return {
    ...presentation,
    status: "Passed",
    nextAction: classification?.recommendedNextStep || null,
    why: "The request was classified successfully; no worker was launched.",
  };
}

export function renderFirstmateOneShotOutput({
  taskId, requestId, reused, classification, usage, snapshot, execution, json = false,
}) {
  if (json) {
    return JSON.stringify({
      taskId, requestId, reused, classification, usage,
      ledger: {
        state: snapshot.state,
        eventsCount: snapshot.eventsCount,
        lastEventId: snapshot.lastEventId,
      },
      execution,
    }, null, 2);
  }
  const rendered = renderTaskPresentation(projectFirstmateOneShotPresentation({
    snapshot, execution, classification,
  }), { subject: `Firstmate task ${taskId}` });
  return `${rendered}\nStructured details: rerun this command with --json, or ask Firstmate to show task evidence for ${taskId}.`;
}

export function renderTaskPresentation(presentation, { subject = "Task", detail = false } = {}) {
  const lines = [
    `${subject}: ${presentation.status}`,
    `Next action: ${presentation.nextAction || "None."}`,
    `Why: ${presentation.why}`,
  ];
  const breakdown = presentation.workBreakdown;
  lines.push(`Work breakdown: ${breakdown.agents.length} agent(s), ${breakdown.tasks.length} task step(s), ${breakdown.tests.length} test result(s), ${breakdown.decisions.length} decision(s).`);
  lines.push(`Detailed evidence: ${presentation.evidence.artifacts.length} artifact(s), ${presentation.evidence.ledger.evidenceCount} evidence record(s)${renderMetrics(presentation.evidence.metrics)}. Ask Firstmate to show task evidence for the detailed record.`);
  if (detail) {
    lines.push("", "Work breakdown:");
    appendItems(lines, "Agents", breakdown.agents, (item) => `${item.id}: ${item.status}${item.summary ? ` — ${item.summary}` : ""}`);
    appendItems(lines, "Task steps", breakdown.tasks, (item) => `${item.phase}/${item.step}: ${item.status} — ${item.message}`);
    appendItems(lines, "Tests", breakdown.tests, (item) => `${item.command}: ${item.result} (${item.agent})`);
    appendItems(lines, "Decisions", breakdown.decisions, (item) => `${item.kind}: ${item.outcome}${item.reason ? ` — ${item.reason}` : ""}`);
    lines.push("", "Evidence and metrics:");
    appendItems(lines, "Artifacts", presentation.evidence.artifacts, (item) => typeof item === "string" ? item : (item.path || item.filename || JSON.stringify(item)));
    appendItems(lines, "Logs", presentation.evidence.logs, (item) => item);
    lines.push(`- Ledger: task ${presentation.evidence.ledger.taskId}; ${presentation.evidence.ledger.evidenceCount} evidence record(s); last activity ${presentation.evidence.ledger.lastEventAt || "unavailable"}.`);
    const metricText = renderMetricDetails(presentation.evidence.metrics);
    lines.push(`- Metrics: ${metricText || "unavailable"}.`);
  }
  return lines.join("\n");
}

function appendItems(lines, label, items, format) {
  if (!items.length) return;
  lines.push(`${label}:`);
  for (const item of items) lines.push(`- ${format(item)}`);
}

function workerCompleted(worker) {
  return new Set(["reported", "completed"]).has(worker.status) ||
    worker.report?.status === "completed";
}

function executionWorkers(execution) {
  if (!execution) return [];
  return [
    ...(execution.scouts || []).map(({ workerId, ...worker }) => ({ id: workerId, ...worker })),
    ...(execution.implementation
      ? [{ id: execution.implementation.workerId || "implementer", ...execution.implementation }]
      : []),
  ];
}

function workerFailureText(worker) {
  if (!worker.failure && worker.report?.status !== "failed") return [];
  return [
    typeof worker.failure === "string" ? worker.failure : worker.failure?.message,
    worker.report?.summary,
    ...(worker.report?.risks || []),
  ].filter((value) => typeof value === "string" && value.trim());
}

function nextActionFor({ status, snapshot, reconciliation }) {
  if (status === "Passed") return null;
  if (reconciliation?.action && reconciliation.action !== "no_action") {
    return sentence(reconciliation.action.replaceAll("_", " "));
  }
  if (snapshot.state === "awaiting_human") return "Review the recorded decision and provide the exact requested approval.";
  if (status === "Failed") return "Inspect the failing test or worker evidence, then request a focused repair.";
  if (new Set(["running", "preparing", "awaiting_worker", "validating"]).has(snapshot.state)) {
    return "Wait for the active work to finish; do not launch a duplicate.";
  }
  return "Inspect the durable task evidence before retrying.";
}

function whyFor({ status, snapshot, validation, failures, reconciliation }) {
  if (status === "Passed") {
    if (validation?.passed === true) return "Validation passed against the recorded task state.";
    if (snapshot.state === "complete") return "The durable task lifecycle is complete.";
    return "All assigned read-only agents completed without reporting a mutation or failure.";
  }
  if (failures.length > 0) return sentence(failures[0]);
  if (validation?.gate?.status === "awaiting_approval") {
    return `Validation paused at ${validation.gate.step || "an approval gate"}; no unsafe continuation occurred.`;
  }
  if (validation && validation.passed === false) {
    return `Validation did not pass (${validation.outcome || "unknown outcome"}).`;
  }
  if (reconciliation?.reason) return sentence(reconciliation.reason);
  if (new Set(["running", "preparing", "awaiting_worker", "validating"]).has(snapshot.state)) {
    return "The task has no terminal success evidence yet and remains safely non-terminal.";
  }
  return `The task stopped in ${String(snapshot.state || "unknown").replaceAll("_", " ")} without claiming success.`;
}

function progressItems(snapshot) {
  return (snapshot.evidence || []).filter(({ kind }) => kind === "task-progress")
    .map(({ value, at }) => {
      try {
        const item = JSON.parse(value);
        return { phase: item.phase, step: item.step, status: item.status, message: item.message, at };
      } catch { return null; }
    }).filter(Boolean);
}

function decisionItems({ snapshot, validation, reconciliation, humanAction }) {
  const decisions = [];
  if (validation) decisions.push({ kind: "validation", outcome: validation.outcome || (validation.passed ? "passed" : "not passed") });
  if (reconciliation?.decision) decisions.push({ kind: "reconciliation", outcome: reconciliation.decision, reason: reconciliation.reason || null });
  if (humanAction) decisions.push({ kind: "human_action", outcome: humanAction });
  if (snapshot.state) decisions.push({ kind: "lifecycle", outcome: snapshot.state });
  return decisions;
}

function availableMetrics(snapshot, validation) {
  const metrics = {};
  const usage = snapshot.firstmateRuns?.at(-1)?.usage;
  if (usage && Number.isFinite(usage.totalTokens)) {
    metrics.tokens = {
      input: Number.isFinite(usage.inputTokens) ? usage.inputTokens : undefined,
      output: Number.isFinite(usage.outputTokens) ? usage.outputTokens : undefined,
      total: usage.totalTokens,
    };
  }
  if (Number.isFinite(validation?.durationMs)) metrics.validationDurationMs = validation.durationMs;
  return metrics;
}

function renderMetrics(metrics) {
  const items = [];
  if (metrics.tokens) items.push(`${metrics.tokens.total} tokens`);
  if (Number.isFinite(metrics.validationDurationMs)) items.push(`${metrics.validationDurationMs} ms validation`);
  return items.length ? `, ${items.join(", ")}` : "";
}

function renderMetricDetails(metrics) {
  const items = [];
  if (metrics.tokens) {
    const parts = [`${metrics.tokens.total} total tokens`];
    if (Number.isFinite(metrics.tokens.input)) parts.push(`${metrics.tokens.input} input`);
    if (Number.isFinite(metrics.tokens.output)) parts.push(`${metrics.tokens.output} output`);
    items.push(parts.join(", "));
  }
  if (Number.isFinite(metrics.validationDurationMs)) items.push(`${metrics.validationDurationMs} ms validation`);
  return items.join("; ");
}

function sentence(value) {
  const text = String(value || "").trim();
  if (!text) return "No reason was recorded.";
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}
