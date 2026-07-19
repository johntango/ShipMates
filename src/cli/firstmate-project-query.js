const statusPattern = /^(?:(?:give|show|tell) me )?(?:a )?(?:project )?status(?: report)?(?: (?:for|on) (?!each\b|all\b)(.+))?(?: (?:on|for) (?:each|all)(?: project)?s?)?\??$/iu;

export function answerProjectQuery(message, { activeProject, projects }) {
  const input = String(message || "").trim();
  if (!input) return null;

  if (/^(?:what|which) (?:is )?(?:the )?selected (?:project|repo(?:sitory)?)\??$/iu.test(input)) {
    return selectedProject(activeProject);
  }
  if (/^(?:where|what repo(?:sitory)?) (?:are you|am i|is firstmate) (?:working|operating)(?: in)?\??$/iu.test(input)) {
    return selectedProject(activeProject);
  }
  if (/^(?:list|show)(?: me)? (?:all )?projects\??$/iu.test(input)) {
    return renderProjects(projects, activeProject?.id);
  }
  const status = input.match(statusPattern);
  if (status) {
    const selected = status[1] ? matchProject(projects, status[1]) : null;
    return renderProjects(selected ? [selected] : projects, activeProject?.id);
  }
  if (/^(?:what(?:'s| is)|show) (?:the )?(?:next|remaining|planned) tasks?(?: for (.+))?\??$/iu.test(input)) {
    const named = input.match(/ for (.+)\??$/iu)?.[1];
    const project = named ? matchProject(projects, named) : activeProject;
    return project ? renderTasks(project) : "I could not identify that project.";
  }
  return null;
}

export async function enrichProjectBlockers(projects, getSnapshot) {
  if (typeof getSnapshot !== "function") return projects;
  return Promise.all(projects.map(async (project) => ({
    ...project,
    tasks: await Promise.all(project.tasks.map(async (task) => {
      if (task.status !== "blocked" || !task.taskId) return task;
      try {
        return { ...task, blocker: blockerFromSnapshot(await getSnapshot(task.taskId)) };
      } catch {
        return { ...task, blocker: unknownBlocker() };
      }
    })),
  })));
}

export function namedActionProject(message, projects) {
  const input = String(message || "");
  if (!/\b(?:retry|resume|recover|reconcile|unblock|fix|implement|continue|dispatch)\b/iu.test(input)) {
    return null;
  }
  const matches = projects.filter(({ name }) =>
    new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(name)}(?:$|[^a-z0-9])`, "iu").test(input));
  return matches.length === 1 ? matches[0] : null;
}

export function parseProjectSelection(message, projects) {
  const prefix = String(message || "").match(
    /^(?:(?:(?:you\s+can|please|go\s+ahead\s+and)\s+)?(?:switch|select)(?:\s+to)?(?:\s+project)?|(?:now\s+)?(?:operate|work)\s+in)\s+/iu,
  );
  if (!prefix) return null;
  const tail = String(message).slice(prefix[0].length);
  const matches = projects
    .filter(({ name }) => new RegExp(`^${escapeRegExp(name)}(?:$|[^a-z0-9])`, "iu").test(tail))
    .sort((left, right) => right.name.length - left.name.length);
  if (matches.length === 0) return { project: null, remainder: "" };
  const project = matches[0];
  const remainder = tail.slice(project.name.length)
    .replace(/^\s*(?:,?\s*(?:and\s+)?then|,|and)\s*/iu, "")
    .trim();
  return { project, remainder };
}

export function parseProjectBlockedCommand(message, projects) {
  const match = String(message || "").trim().match(
    /^mark (.+?) (?:as )?blocked because (.+)$/iu,
  );
  if (!match) return null;
  const project = matchProject(projects, match[1]);
  if (!project) return { project: null, task: null, reason: match[2].trim() };
  const active = project.tasks.filter(({ status }) => new Set(["claimed", "dispatched"]).has(status));
  return {
    project,
    task: active.length === 1 ? active[0] : null,
    activeTaskCount: active.length,
    reason: match[2].trim(),
  };
}

export function isExplicitProjectPlanningRequest(message) {
  const input = String(message || "").trim();
  return /^(?:please\s+)?plan\b/iu.test(input) ||
    /\b(?:save|create|draft|prepare)\s+(?:a\s+)?(?:clear\s+|dependency-aware\s+)?project plan\b/iu.test(input) ||
    /\bdo not dispatch\b|\bdon't dispatch\b|\bwithout dispatching\b/iu.test(input);
}

function selectedProject(project) {
  if (!project) return "No project is currently selected.";
  return `The selected project is ${project.name} in ${project.repo}, located at ${project.repoPath}.`;
}

function renderProjects(projects, activeId) {
  if (!projects?.length) return "No projects are registered yet.";
  return projects.map((project) => {
    const completed = project.tasks.filter(({ status }) => status === "completed").length;
    const working = project.tasks.filter(({ status }) => new Set(["claimed", "dispatched"]).has(status)).length;
    const blocked = project.tasks.filter(({ status }) => status === "blocked").length;
    const remaining = project.tasks.length - completed - blocked;
    const selection = project.id === activeId ? " (selected)" : "";
    const progress = project.tasks.length === 0
      ? "no plan yet"
      : `${completed}/${project.tasks.length} tasks completed, ${working} working, ${remaining} remaining${blocked ? `, ${blocked} blocked` : ""}`;
    const lines = [`${project.name}${selection}: ${project.status}; ${progress}. Repository: ${project.repo}.`];
    const blockedTasks = project.tasks.filter(({ status }) => status === "blocked");
    if (blockedTasks.length > 0) {
      lines.push("Blocked tasks:");
      for (const task of blockedTasks) {
        const blocker = task.blocker || unknownBlocker();
        lines.push(`- ${project.name} — ${task.title}: ${blocker.reason} Suggested solution for ${project.name}: ${blocker.suggestion}`);
      }
    }
    const next = nextReady(project);
    if (next) lines.push(`Next ready task for ${project.name}: ${next.title}.`);
    else if (project.tasks.length > 0 && completed < project.tasks.length) {
      lines.push(blockedTasks.length > 0
        ? `No task in ${project.name} is dependency-ready; resolve ${project.name}'s blocked work above first.`
        : `No task in ${project.name} is dependency-ready right now.`);
    }
    return lines.join("\n");
  }).join("\n");
}

function renderTasks(project) {
  if (!project.tasks.length) return `${project.name} has no planned tasks yet.`;
  return [`${project.name} tasks:`, ...project.tasks.map((task) =>
    `- ${project.name} — ${task.title}: ${humanStatus(task.status)}`)].join("\n");
}

function humanStatus(status) {
  return ({ claimed: "starting", dispatched: "working" })[status] || status;
}

function nextReady(project) {
  if (project.status !== "approved") return null;
  const completed = new Set(project.tasks.filter(({ status }) => status === "completed").map(({ id }) => id));
  return project.tasks.find((task) => new Set(["planned", "ready"]).has(task.status) &&
    (task.dependsOn || []).every((id) => completed.has(id))) || null;
}

function blockerFromSnapshot(snapshot) {
  const validation = snapshot.validationRuns?.at(-1);
  if (validation?.gate?.status === "awaiting_approval") {
    return {
      reason: `local validation is waiting for human approval at ${validation.gate.step}.`,
      suggestion: "review the validation request and approve or reject it; do not dispatch a repair task.",
    };
  }
  if (validation?.passed === false) {
    const finding = validation.findings?.find?.((item) => item?.message)?.message;
    return {
      reason: finding || `local validation ended with ${validation.outcome || "a failure"}.`,
      suggestion: "ask Firstmate to diagnose the validation result and dispatch a focused repair task.",
    };
  }
  const request = snapshot.validationRequests?.at(-1);
  if (request?.status === "requested" && !validation) {
    return {
      reason: "validation was interrupted before recording a result.",
      suggestion: "ask Firstmate to reconcile this task's validation; it must not start a duplicate run blindly.",
    };
  }
  const implementer = snapshot.workers?.find(({ id }) => id === "implementer");
  if (implementer?.status === "started") {
    return {
      reason: "the implementer started but did not record a terminal report.",
      suggestion: "ask Firstmate to reconcile the implementer, then retry only if no live process or completed artifact exists.",
    };
  }
  if (implementer?.report?.status === "blocked") {
    return {
      reason: `${implementer.report.summary || "the implementer reported a blocker"}`,
      suggestion: suggestionFromRisks(implementer.report.risks),
    };
  }
  if (implementer?.report?.status === "completed" && !validation) {
    return {
      reason: "implementation completed, but validation has not produced a result.",
      suggestion: "ask Firstmate to resume or reconcile validation for the existing implementation.",
    };
  }
  return unknownBlocker();
}

function suggestionFromRisks(risks) {
  const risk = Array.isArray(risks) && risks.find((value) => typeof value === "string" && value.trim());
  return risk
    ? `address this reported risk, then retry the task: ${risk.trim()}`
    : "ask Firstmate to diagnose the task evidence and propose a focused repair.";
}

function unknownBlocker() {
  return {
    reason: "the registry marks this task blocked, but no specific cause was recorded.",
    suggestion: "ask Firstmate to inspect the task evidence, record the cause, and propose a focused repair.",
  };
}

function matchProject(projects, query) {
  const wanted = String(query).replace(/[?.]+$/u, "").trim().toLowerCase();
  const exact = projects.filter(({ name }) => name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = projects.filter(({ name, objective = "" }) =>
    name.toLowerCase().includes(wanted) || objective.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
