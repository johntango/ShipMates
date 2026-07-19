import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { canDeliverLocally } from "../workflows/local-delivery.js";

export class LavishTaskDashboard {
  constructor({ stateRoot = path.resolve(".shipmates") } = {}) {
    this.stateRoot = path.resolve(stateRoot);
  }

  async write(snapshot) {
    requireSnapshot(snapshot);
    const directory = path.join(this.stateRoot, "tasks", snapshot.id, "lavish");
    const target = path.join(directory, "dashboard.html");
    const actionsTarget = path.join(directory, "dashboard-actions.js");
    const temporary = `${target}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, renderLavishTaskDashboard(snapshot), {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(actionsTarget, renderDashboardActionsScript(), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
    return target;
  }
}

export function renderLavishTaskDashboard(snapshot) {
  requireSnapshot(snapshot);
  const workers = snapshot.workers || [];
  const implementation = workers.find(({ id }) => id === "implementer") || null;
  const workspace = snapshot.worktree?.worktreePath || null;
  const files = (implementation?.report?.files || []).map((filename) => ({
    filename,
    location: workspace ? path.join(workspace, filename) : filename,
  }));
  const validation = snapshot.validationRuns?.at(-1) || null;
  const classification = snapshot.firstmateRuns?.at(-1)?.classification || null;
  const implementationExpected = classification?.requiredAuthority === "local_write";
  const implementationActive = implementationExpected && new Set([
    "approved_for_dispatch", "preparing", "running", "awaiting_worker",
  ]).has(snapshot.state);
  const stateTone = tone(snapshot.state);
  const workerCards = workers.length === 0
    ? '<p class="empty">No workers have reported yet.</p>'
    : workers.map((worker) => `
      <article class="worker">
        <div><strong>${escapeHtml(worker.id)}</strong><span class="badge ${tone(worker.status)}">${escapeHtml(worker.status)}</span></div>
        <p>${escapeHtml(worker.report?.summary || worker.failure?.name || "Work is in progress.")}</p>
      </article>`).join("");
  const fileRows = files.length === 0
    ? `<p class="empty">${implementationActive
      ? "The implementation is still running; files are not ready yet."
      : implementationExpected
        ? "This implementation ended without reporting any files."
        : "This request did not create or modify any files."}</p>`
    : `<div class="files">${files.map(({ filename, location }, index) => `
        <div class="file"><strong>${escapeHtml(filename)}</strong><code>${escapeHtml(location)}</code>${/\.html?$/iu.test(filename) ? `<button type="button" data-shipmates-review-file="${index}">Review page</button>` : ""}</div>`).join("")}</div>`;
  const validationText = validation === null
    ? "Not completed"
    : validation.gate?.status === "awaiting_approval"
      ? `Awaiting approval at ${escapeHtml(validation.gate.step)}`
      : validation.passed ? "Passed" : escapeHtml(validation.outcome || "Did not pass");
  const decisionOptions = [
    ...(canDeliverLocally(snapshot) ? [{ value: "deliver_changes", label: "Deliver changes to this checkout" }] : []),
    ...(files.length > 0 ? [{ value: "review_files", label: "Review the created files" }] : []),
    ...(validation !== null ? [{ value: "review_validation", label: "Review validation details" }] : []),
    { value: "no_action", label: "No further action right now" },
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data:">
  <title>ShipMates ${escapeHtml(snapshot.id)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #09111f; color: #e7edf7; }
    * { box-sizing: border-box; min-width: 0; }
    body { margin: 0; background: radial-gradient(circle at top right, #17345b 0, #09111f 42rem); }
    main { width: min(1040px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
    header, section { border: 1px solid #29405e; background: #0d192aeb; border-radius: 18px; box-shadow: 0 18px 60px #0005; }
    header { padding: 30px; }
    section { margin-top: 18px; padding: 24px; }
    .eyebrow { color: #83b7ff; font-size: .78rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 8px 0 10px; padding-block: .08em; font-size: clamp(1.8rem, 5vw, 3.4rem); line-height: 1.15; overflow-wrap: anywhere; }
    h2 { margin: 0 0 16px; font-size: 1.15rem; }
    p { color: #adbbcf; line-height: 1.55; }
    .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 22px; }
    .metric { padding: 14px; border-radius: 12px; background: #14243a; }
    .metric span { display: block; color: #8fa2bd; font-size: .78rem; margin-bottom: 5px; }
    .metric strong { overflow-wrap: anywhere; }
    .badge { float: right; border-radius: 999px; padding: 5px 10px; font-size: .72rem; line-height: 1.3; text-transform: uppercase; letter-spacing: .06em; }
    .good { color: #8ff0ba; background: #113b2b; } .working { color: #9cc8ff; background: #15365b; }
    .warn { color: #ffd38c; background: #4a3214; } .bad { color: #ff9da8; background: #4b1d27; }
    .workers { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .worker { border: 1px solid #263b57; border-radius: 12px; padding: 16px; background: #101e31; }
    .worker > div { display: flex; align-items: center; gap: 10px; }
    .worker .badge { float: none; margin-left: auto; flex: 0 0 auto; }
    .worker p { margin-bottom: 0; }
    .files { display: grid; gap: 10px; }
    .file { display: grid; grid-template-columns: minmax(120px, .3fr) minmax(0, 1fr) auto; gap: 14px; align-items: center; border-bottom: 1px solid #263b57; padding: 11px 0; }
    code { color: #aad1ff; overflow-wrap: anywhere; white-space: normal; }
    .empty { margin: 0; font-style: italic; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    button { appearance: none; border: 1px solid #4873a8; border-radius: 10px; background: #17365c; color: #e7f2ff; padding: 11px 15px; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #214b7d; } button:focus-visible { outline: 3px solid #83b7ff; outline-offset: 2px; }
    #action-status { min-height: 1.5em; }
    .decision-options { display: grid; gap: 9px; margin-bottom: 14px; }
    .decision-options label { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid #29405e; border-radius: 10px; cursor: pointer; }
    .decision-options label:has(input:checked) { border-color: #83b7ff; background: #142d4c; }
    @media (max-width: 650px) { .summary { grid-template-columns: 1fr; } .file { grid-template-columns: 1fr; gap: 5px; } main { padding-top: 20px; } }
  </style>
</head>
<body><main>
  <header>
    <div class="eyebrow">ShipMates task dashboard</div>
    <span class="badge ${stateTone}">${escapeHtml(snapshot.state)}</span>
    <h1>${escapeHtml(snapshot.id)}</h1>
    <p>${escapeHtml(latestSummary(snapshot) || "Firstmate is coordinating this task.")}</p>
    <div class="summary">
      <div class="metric"><span>Repository</span><strong>${escapeHtml(snapshot.repo)}</strong></div>
      <div class="metric"><span>Workers</span><strong>${workers.length}</strong></div>
      <div class="metric"><span>Validation</span><strong>${validationText}</strong></div>
    </div>
  </header>
  <section><h2>Workers</h2><div class="workers">${workerCards}</div></section>
  <section><h2>Files</h2>${fileRows}</section>
  <section data-lavish-question="task-action"><h2>Ask Firstmate</h2>
    <p class="recipient"><strong>Recipient: Firstmate.</strong> Lavish’s generic “Send to Agent” control sends messages to Firstmate only.</p>
    <div class="actions">
      <button type="button" data-shipmates-action="show_files">Show files</button>
      <button type="button" data-shipmates-action="show_status">Show status</button>
      <button type="button" data-shipmates-action="show_validation">Show validation</button>
    </div>
    <p id="action-status" aria-live="polite">Actions are read-only.</p>
  </section>
  <section><h2>What next?</h2>
    <form id="task-decision" data-lavish-question="next-step">
      <div class="decision-options">${decisionOptions.map(({ value, label }) => `<label><input type="radio" name="decision" value="${value}"> ${escapeHtml(label)}</label>`).join("")}</div>
      <button type="submit">Submit choice</button>
      <p id="decision-status" aria-live="polite">Select one option, then submit it.</p>
    </form>
  </section>
  <script src="dashboard-actions.js" data-task-id="${escapeHtml(snapshot.id)}"></script>
</main></body>
</html>\n`;
}

export function renderDashboardActionsScript() {
  return `(() => {
  const script = document.currentScript;
  const taskId = script?.dataset.taskId || "";
  const status = document.querySelector("#action-status");
  const allowed = new Set(["show_files", "show_status", "show_validation"]);
  for (const button of document.querySelectorAll("[data-shipmates-action]")) {
    button.addEventListener("click", () => {
      const action = button.dataset.shipmatesAction;
      if (!allowed.has(action) || !/^task-[a-z0-9]+$/.test(taskId)) return;
      if (!window.lavish?.queuePrompt) {
        status.textContent = "Open this dashboard through Lavish to contact Firstmate.";
        return;
      }
      const prompt = "shipmates-action:v1:" + action + ":" + taskId;
      window.lavish.queuePrompt(prompt, {
        tag: "shipmates-action",
        text: button.textContent.trim(),
        element: button,
        queueKey: "shipmates-task-action:" + taskId,
      });
      window.lavish.sendQueuedPrompts?.();
      status.textContent = button.textContent.trim() + " queued. Firstmate will reply in Conversation.";
    });
  }
  for (const button of document.querySelectorAll("[data-shipmates-review-file]")) {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.shipmatesReviewFile);
      if (!Number.isSafeInteger(index) || index < 0 || !window.lavish?.queuePrompt) return;
      const prompt = "shipmates-action:v1:review_file_" + index + ":" + taskId;
      window.lavish.queuePrompt(prompt, {
        tag: "shipmates-action",
        text: "Review " + button.closest(".file")?.querySelector("strong")?.textContent,
        element: button,
        queueKey: "shipmates-review-file:" + taskId,
      });
      window.lavish.sendQueuedPrompts?.();
      status.textContent = "Visual review request queued for Firstmate.";
    });
  }
  const decisionForm = document.querySelector("#task-decision");
  decisionForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const decision = new FormData(decisionForm).get("decision");
    const allowedDecisions = new Set(["deliver_changes", "review_files", "review_validation", "no_action"]);
    const decisionStatus = document.querySelector("#decision-status");
    if (!allowedDecisions.has(decision)) {
      decisionStatus.textContent = "Select an available option first.";
      return;
    }
    if (!window.lavish?.queuePrompt) {
      decisionStatus.textContent = "Open this dashboard through Lavish to contact Firstmate.";
      return;
    }
    const prompt = "shipmates-decision:v1:" + decision + ":" + taskId;
    window.lavish.queuePrompt(prompt, {
      tag: "shipmates-decision",
      text: "Next step: " + decision.replaceAll("_", " "),
      element: decisionForm,
      queueKey: "shipmates-next-step:" + taskId,
    });
    window.lavish.sendQueuedPrompts?.();
    decisionStatus.textContent = "Choice queued. Firstmate will reply in Conversation.";
  });
})();\n`;
}

function latestSummary(snapshot) {
  return snapshot.workers?.find(({ id }) => id === "implementer")?.report?.summary ||
    snapshot.firstmateRuns?.at(-1)?.classification?.summary || null;
}

function tone(value) {
  if (new Set(["complete", "completed", "reported", "awaiting_human"]).has(value)) return "good";
  if (new Set(["failed", "blocked", "cancelled", "recovery_required"]).has(value)) return "bad";
  if (new Set(["validating", "awaiting_worker", "started", "dispatch_requested", "running"]).has(value)) return "working";
  return "warn";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function requireSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.id !== "string" ||
    typeof snapshot.repo !== "string" || typeof snapshot.state !== "string" ||
    !Array.isArray(snapshot.workers)) {
    throw new TypeError("Lavish dashboard requires a task snapshot");
  }
}
