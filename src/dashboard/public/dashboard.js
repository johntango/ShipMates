(() => {
  const root = document.documentElement;
  const theme = document.querySelector("#theme");
  const preferred = localStorage.getItem("shipmates-theme") || "system";
  theme.value = preferred;
  const applyTheme = (value) => {
    const dark = value === "dark" || (value === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.bsTheme = dark ? "dark" : "light";
  };
  applyTheme(preferred);
  theme.addEventListener("change", () => {
    localStorage.setItem("shipmates-theme", theme.value);
    applyTheme(theme.value);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme.value === "system") applyTheme("system");
  });

  const escape = (value) => String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const taskTone = (task) => {
    if (task.presentation?.status === "Failed") return "attention";
    if (task.presentation?.status === "Blocked safely") return "working";
    if (["failed", "blocked", "recovery_required"].includes(task.state)) return "attention";
    if (["running", "awaiting_worker", "validating", "preparing"].includes(task.state)) return "working";
    return "done";
  };
  const render = (state) => {
    document.querySelector("#updated").textContent = `Updated ${new Date(state.generatedAt).toLocaleTimeString()}`;
    const alerts = state.watchdog?.alerts || [];
    const historical = state.watchdog?.historical || [];
    document.querySelector("#watchdog").innerHTML = `${alerts.length ? `<section class="alert alert-warning shadow-sm mb-4">
      <h2 class="h5">Firstmate attention required</h2>
      <p class="mb-2">${alerts.length} task${alerts.length === 1 ? " has" : "s have"} exceeded the ${escape(state.watchdog.thresholdMinutes)} minute monitoring limit.</p>
      <div class="vstack gap-2">${alerts.map((alert) => `<div><strong>${escape(alert.projectName)} — ${escape(alert.taskName)}</strong><br><span>${escape(alert.status)} (${escape(alert.ageMinutes)} minutes).</span><br><span class="small">${escape(alert.remedy)}</span></div>`).join("")}</div>
    </section>` : ""}${historical.length ? `<details class="alert alert-secondary mb-4"><summary>${historical.length} historical ledger record${historical.length === 1 ? "" : "s"} need cleanup (not live processes)</summary><div class="vstack gap-2 mt-3">${historical.map((item) => `<div><strong>${escape(item.projectName)} — ${escape(item.taskName)}</strong><br><span class="small">Recorded ${escape(item.state)} · ${escape(item.ageMinutes)} minutes old. ${escape(item.remedy)}</span></div>`).join("")}</div></details>` : ""}`;
    const simpleRuns = state.workflowRuns || [];
    const maintenance = state.workspaceMaintenance;
    const maintenanceCard = maintenance ? `<article class="card shadow-sm task-card">
      <div class="card-body"><h2 class="h5">Workspace maintenance</h2>
      <p class="mb-2">${escape(maintenance.summary)}</p>
      <p class="small text-body-secondary">Clean is safe maintenance. It preserves candidates, history, dirty or uncertain work, and the shared checkout. Wipe-clean is a separate named and confirmed reset.</p>
      <button class="btn btn-outline-primary btn-sm" data-workflow-intent="clean">Clean safely</button></div>
    </article>` : "";
    const simpleRunCards = simpleRuns.map((run) => `
      <article class="card shadow-sm task-card" data-state="${run.presentation.outcome === "Passed" ? "done" : run.presentation.outcome === "Blocked safely" ? "working" : "attention"}">
        <div class="card-body">
          <div class="d-flex flex-wrap justify-content-between gap-2"><h2 class="h5 mb-0">${escape(run.request)}</h2><span class="badge text-bg-secondary">${escape(run.phase)}</span></div>
          <div class="alert ${run.presentation.outcome === "Passed" ? "alert-success" : "alert-warning"} mt-3 mb-0">
            <div class="h5 mb-1">${escape(run.presentation.outcome)}</div>
            ${run.presentation.nextAction ? `<div><strong>Next action:</strong> ${escape(run.presentation.nextAction)}</div>` : '<div><strong>Next action:</strong> None.</div>'}
            <div class="small mt-1"><strong>Why:</strong> ${escape(run.presentation.why)}</div>
            ${run.presentation.details?.length ? `<div class="small mt-2">${run.presentation.details.map((detail) => `<div>${escape(detail)}</div>`).join("")}</div>` : ""}
            ${run.action === "approve" ? '<button class="btn btn-success btn-sm mt-2" data-workflow-intent="approve">Approve plan</button>' : run.action === "approve_validation" ? '<button class="btn btn-warning btn-sm mt-2" data-workflow-intent="approve_validation">Review decision</button>' : ""}
          </div>
          <details class="small mt-2"><summary>Approved scope</summary><div class="mt-2">${escape(run.plan)}</div></details>
          <section class="small mt-3" aria-label="Actual execution milestones">
            <strong>Actual execution</strong>
            <ol class="mt-2 mb-0">${(run.milestones || []).map((milestone) => `<li class="mb-2"><strong>${escape(milestone.label)} — ${escape(milestone.status)}</strong><div class="text-body-secondary">${escape(milestone.summary)}</div></li>`).join("")}</ol>
          </section>
        </div>
      </article>`).join("");
    const legacyTaskCards = state.tasks.map((task) => `
      <article class="card shadow-sm task-card" data-state="${taskTone(task)}">
        <div class="card-body">
          <div class="d-flex flex-wrap align-items-start justify-content-between gap-2">
            <div><div class="d-flex gap-2 align-items-center"><h2 class="h5 mb-0">${escape(task.summary)}</h2>${task.activeProject ? '<span class="badge text-bg-primary">Active project</span>' : ""}</div><div class="small text-body-secondary mt-1">${escape(task.state.replaceAll("_", " "))}</div></div>
            <span class="badge text-bg-secondary">${escape(task.authority.replaceAll("_", " "))}</span>
          </div>
          ${task.presentation ? `<section class="mt-3" aria-label="Human-readable task outcome">
            <div class="alert ${task.presentation.status === "Passed" ? "alert-success" : task.presentation.status === "Failed" ? "alert-danger" : "alert-warning"} mb-2">
              <div class="h5 mb-1">${escape(task.presentation.status)}</div>
              ${task.presentation.nextAction ? `<div><strong>Next action:</strong> ${escape(task.presentation.nextAction)}</div>` : '<div><strong>Next action:</strong> None.</div>'}
              <div class="small mt-1"><strong>Why:</strong> ${escape(task.presentation.why)}</div>
            </div>
            <details class="small"><summary>Work breakdown and detailed evidence</summary>
              <div class="mt-2"><strong>Work breakdown:</strong> ${escape(task.presentation.workBreakdown.agents.length)} agent(s), ${escape(task.presentation.workBreakdown.tasks.length)} task step(s), ${escape(task.presentation.workBreakdown.tests.length)} test result(s), ${escape(task.presentation.workBreakdown.decisions.length)} decision(s).</div>
              ${task.workers.length ? `<div class="d-flex flex-wrap gap-2 mt-2">${task.workers.map((worker) => `<span class="badge rounded-pill text-bg-info worker-badge">${escape(worker.id)} · ${escape(worker.status)}</span>`).join("")}</div>` : ""}
              ${task.files.length ? `<div class="list-group list-group-flush mt-2">${task.files.map((file) => `<div class="list-group-item px-0"><strong>${escape(file.filename)}</strong><div class="text-body-secondary font-monospace file-path">${escape(file.path)}</div></div>`).join("")}</div>` : '<div class="text-body-secondary mt-2">No artifacts recorded.</div>'}
              ${task.taskProgress?.length ? `<ol class="mt-2 mb-0">${task.taskProgress.map((step) => `<li><strong>${escape(step.phase)}:</strong> ${escape(step.message)}</li>`).join("")}</ol>` : ""}
              <div class="text-body-secondary mt-2">${escape(task.presentation.evidence.ledger.evidenceCount)} evidence record(s)${task.presentation.evidence.metrics.tokens ? ` · ${escape(task.presentation.evidence.metrics.tokens.total)} tokens` : ""}${Number.isFinite(task.presentation.evidence.metrics.validationDurationMs) ? ` · ${escape(task.presentation.evidence.metrics.validationDurationMs)} ms validation` : ""}</div>
            </details>
          </section>` : ""}
          ${task.humanAction ? `<div class="alert alert-warning py-2 mt-3 mb-0" role="alert"><strong>Human input required.</strong> Send this exact command to Firstmate:<br><code>${escape(task.humanAction)}</code></div>` : ""}
          ${task.validation ? `<div class="alert ${task.validation.passed ? "alert-success" : "alert-warning"} py-2 mt-3 mb-0">Validation ${task.validation.passed ? "passed" : "did not pass"}: ${escape(task.validation.outcome || "unknown")}</div>` : ""}
        </div>
      </article>`).join("");
    document.querySelector("#tasks").innerHTML = maintenanceCard + simpleRunCards + legacyTaskCards || '<div class="alert alert-secondary">No tasks recorded yet.</div>';
    const projects = state.projects || [];
    document.querySelector("#projects").innerHTML = projects.map((project) => {
      const percent = project.progress.total
        ? Math.round(project.progress.completed * 100 / project.progress.total) : 0;
      return `<article class="card shadow-sm project-card">
        <div class="card-body">
          <div class="d-flex flex-wrap justify-content-between gap-2">
            <div><div class="d-flex gap-2 align-items-center"><h2 class="h4 mb-1">${escape(project.name)}</h2>${project.selected ? '<span class="badge text-bg-info">Selected</span>' : ""}</div><div class="text-body-secondary">${escape(project.repo)}</div></div>
            <span class="badge text-bg-primary align-self-start">${escape(project.status)}</span>
          </div>
          <p class="mt-3 mb-2">${escape(project.objective || "No project objective has been planned yet.")}</p>
          ${project.owner ? `<div class="alert alert-info py-2 small"><strong>Owner:</strong> ${escape(project.owner.name)} · ${escape(project.owner.branch)}<br><span class="font-monospace">${escape(project.owner.worktreePath)}</span></div>` : ""}
          <div class="d-flex gap-3 small text-body-secondary mb-2"><span>${project.progress.active} active</span><span>${project.progress.planned} planned</span><span>${project.progress.completed} completed</span></div>
          <div class="progress mb-3" role="progressbar" aria-label="Project progress" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${percent}%">${percent}%</div></div>
          <div class="d-flex flex-wrap gap-2 mb-4 project-actions">
            <button class="btn ${project.selected ? "btn-info" : "btn-outline-info"} btn-sm" data-project-action="select" data-project-id="${escape(project.id)}" ${project.selected ? "disabled" : ""}>${project.selected ? "Selected project" : `Select ${escape(project.name)}`}</button>
            ${project.status === "planning" ? `<button class="btn btn-success btn-sm" data-project-action="approve" data-project-id="${escape(project.id)}">Approve plan</button>` : ""}
            ${project.status === "paused"
              ? `<button class="btn btn-outline-primary btn-sm" data-project-action="resume" data-project-id="${escape(project.id)}">Resume project</button>`
              : `<button class="btn btn-outline-secondary btn-sm" data-project-action="pause" data-project-id="${escape(project.id)}">Pause project</button>`}
            <button class="btn btn-primary btn-sm" data-project-action="dispatch_next" data-project-id="${escape(project.id)}" ${project.status !== "approved" ? "disabled" : ""}>Dispatch next ready task</button>
          </div>
          <div class="project-plan">${project.tasks.map((item) => `<div class="plan-item d-flex gap-3">
            <span class="plan-node" data-status="${escape(item.status)}"></span>
            <div class="flex-grow-1 pb-3"><div class="d-flex justify-content-between gap-2"><strong>${escape(item.title)}</strong><span class="badge text-bg-secondary">${escape(item.status.replaceAll("_", " "))}</span></div>
            ${item.description ? `<div class="small text-body-secondary mt-1">${escape(item.description)}</div>` : ""}
            ${item.blockingReason ? `<div class="alert alert-danger py-1 px-2 small mt-2 mb-0"><strong>Blocked:</strong> ${escape(item.blockingReason)}</div>` : ""}
            ${item.status === "blocked" ? `<button class="btn btn-warning btn-sm mt-2" data-project-action="retry_blocked" data-project-id="${escape(project.id)}" data-plan-task-id="${escape(item.id)}">Retry blocked task</button>` : ""}
            ${item.attempts?.length ? `<details class="small mt-2"><summary>${item.attempts.length} execution attempt${item.attempts.length === 1 ? "" : "s"}</summary><ol class="mt-2 mb-0">${item.attempts.map((attempt) => `<li><span class="font-monospace">${escape(attempt.taskId)}</span> · ${escape(attempt.status.replaceAll("_", " "))}${attempt.current ? " · current" : ""}${attempt.blockingReason ? `<div class="text-danger">${escape(attempt.blockingReason)}</div>` : ""}</li>`).join("")}</ol></details>` : ""}
            ${item.dependsOn.length ? `<div class="small mt-1">Depends on: ${escape(item.dependsOn.join(", "))}</div>` : ""}
            ${new Set(["planned", "ready"]).has(item.status) ? `<div class="btn-group btn-group-sm mt-2" role="group" aria-label="Change priority for ${escape(item.title)}"><button class="btn btn-outline-secondary" data-project-action="priority_up" data-project-id="${escape(project.id)}" data-plan-task-id="${escape(item.id)}" title="Move earlier">↑</button><button class="btn btn-outline-secondary" data-project-action="priority_down" data-project-id="${escape(project.id)}" data-plan-task-id="${escape(item.id)}" title="Move later">↓</button></div>` : ""}</div>
          </div>`).join("") || '<div class="text-body-secondary">Ask Firstmate to plan this project.</div>'}</div>
        </div></article>`;
    }).join("") || '<div class="alert alert-secondary">No projects registered yet.</div>';
    if (reviewState) {
      for (const button of document.querySelectorAll("[data-project-action]")) button.disabled = true;
    }
  };
  document.querySelector("#projects").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-project-action]");
    if (!button || button.disabled || reviewState) return;
    button.disabled = true;
    const status = document.querySelector("#project-action-status");
    status.className = "alert alert-info mt-3";
    status.textContent = `Sending ${button.textContent.trim()} to Firstmate…`;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(button.dataset.projectId)}/actions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: button.dataset.projectAction, planTaskId: button.dataset.planTaskId || null }),
      });
      const result = await response.json();
      status.className = `alert ${result.accepted ? "alert-success" : "alert-warning"} mt-3`;
      status.textContent = result.accepted ? "Firstmate accepted the project action." : (result.error || "Project action was refused.");
    } catch {
      status.className = "alert alert-danger mt-3";
      status.textContent = "Could not contact Firstmate.";
    } finally { button.disabled = false; }
  });
  document.querySelector("#tasks").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-workflow-intent]");
    if (!button || button.disabled || reviewState) return;
    button.disabled = true;
    try {
      await fetch("/api/workflow/actions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: button.dataset.workflowIntent }),
      });
    } finally { button.disabled = false; }
  });
  const reviewState = window.SHIPMATES_REVIEW_STATE;
  if (reviewState) {
    render(reviewState);
    const badge = document.querySelector("#connection");
    badge.className = "badge text-bg-info";
    badge.textContent = "Visual review";
    const input = document.querySelector("#command");
    input.disabled = true;
    input.placeholder = "Commands are disabled in visual review";
    document.querySelector("#command-form button").disabled = true;
    document.querySelector("#command-status").textContent =
      "Visual review only — return to the live dashboard to contact Firstmate.";
  } else {
    fetch("/api/state").then((response) => response.json()).then(render);
    const events = new EventSource("/api/events");
    events.addEventListener("open", () => {
      const badge = document.querySelector("#connection");
      badge.className = "badge text-bg-success";
      badge.textContent = "Live";
    });
    events.addEventListener("state", (event) => render(JSON.parse(event.data)));
    events.addEventListener("error", () => {
      const badge = document.querySelector("#connection");
      badge.className = "badge text-bg-warning";
      badge.textContent = "Reconnecting";
    });
  }
  document.querySelector("#command-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (reviewState) return;
    const input = document.querySelector("#command");
    const status = document.querySelector("#command-status");
    status.textContent = "Sending to Firstmate…";
    const response = await fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input.value }),
    });
    const result = await response.json();
    status.textContent = result.accepted ? "Firstmate accepted the instruction." : (result.error || "Instruction was not accepted.");
    if (result.accepted) input.value = "";
  });
})();
