import path from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";

import { shellQuote } from "./herdr-pane.js";

export class HerdrNoMistakesObserver {
  constructor({
    client,
    currentPaneId = process.env.HERDR_PANE_ID,
    watcherScript,
    nodePath = process.execPath,
    onWarning = console.error,
    displayTaskId = true,
    visibilityRoot = null,
  } = {}) {
    if (!client || !watcherScript) {
      throw new TypeError("HerdrNoMistakesObserver requires client and watcherScript");
    }
    this.client = client;
    this.currentPaneId = currentPaneId || null;
    this.watcherScript = path.resolve(watcherScript);
    this.nodePath = nodePath;
    this.onWarning = onWarning;
    this.displayTaskId = displayTaskId;
    this.visibilityRoot = visibilityRoot ? path.resolve(visibilityRoot) : null;
    this.sequence = 0;
  }

  async started({ taskId, binaryPath, runtimeHome, worktreePath, expectedHeadSha }) {
    const visibilityPath = this.#visibilityPath(taskId);
    if (!this.currentPaneId) {
      await writeHerdrVisibilityReceipt(visibilityPath, {
        available: false, state: "unavailable",
        summary: "Herder visibility unavailable; validation continues.",
      });
      return null;
    }
    try {
      const agent = this.displayTaskId ? `ShipMates no-mistakes: ${taskId}` : "ShipMates no-mistakes";
      const existing = (await this.client.list()).find((pane) => pane.agent === agent);
      const paneId = existing?.paneId || (await this.client.split({
        paneId: this.currentPaneId,
        cwd: worktreePath,
      })).paneId;
      await writeHerdrVisibilityReceipt(visibilityPath, {
        available: true, state: "pane_created", paneId,
        summary: "Validation is visible in Herder.",
      });
      const source = `shipmates:no-mistakes:${taskId}`;
      await this.client.reportAgent({
        paneId,
        source,
        agent,
        state: "working",
        message: "Attaching live no-mistakes TUI",
        customStatus: "validating",
        seq: ++this.sequence,
        agentSessionId: taskId,
        agentSessionPath: worktreePath,
      });
      if (typeof this.client.reportMetadata === "function") {
        await this.client.reportMetadata({
          paneId,
          source,
          appliesToSource: "herdr:codex",
          displayAgent: agent,
          customStatus: "validating",
          stateLabels: {
            unknown: "attaching", idle: "complete", working: "validating", blocked: "blocked",
          },
          seq: this.sequence,
        });
      }
      await this.client.run({
        paneId,
        command: [
          this.nodePath,
          this.watcherScript,
          binaryPath,
          runtimeHome,
          worktreePath,
          paneId,
          source,
          agent,
          expectedHeadSha,
          ...(visibilityPath ? [visibilityPath] : []),
        ].map(shellQuote).join(" "),
      });
      await writeHerdrVisibilityReceipt(visibilityPath, {
        available: true, state: "attach_started", paneId,
        summary: "Validation is visible in Herder.",
      });
      return paneId;
    } catch (error) {
      await writeHerdrVisibilityReceipt(visibilityPath, {
        available: false, state: "attach_failed",
        summary: "Herder visibility unavailable; validation continues.",
      });
      this.onWarning?.(`no-mistakes Herdr visibility unavailable (${error.name || "Error"})`);
      return null;
    }
  }

  #visibilityPath(taskId) {
    if (!this.visibilityRoot || typeof taskId !== "string" ||
      !/^workflow-[a-f0-9]{24}$/u.test(taskId)) return null;
    return path.join(this.visibilityRoot, taskId.slice("workflow-".length), "herdr-visibility.json");
  }
}

export async function writeHerdrVisibilityReceipt(target, value) {
  if (!target) return;
  try {
    const receipt = {
      schemaVersion: 1,
      available: value.available === true,
      state: String(value.state || "unavailable"),
      summary: String(value.summary || "").replaceAll(/\s+/gu, " ").trim().slice(0, 200),
      ...(value.paneId ? { paneId: String(value.paneId) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } catch {
    // Visibility evidence must never affect validation authority or execution.
  }
}

export function retainedValidationSummary(projection) {
  if (projection?.terminal && projection.state === "idle") {
    return "Validation passed. This pane is retained as read-only evidence.";
  }
  if (projection?.terminal) {
    return `Validation ${projection.stage || "finished"}. This pane is retained as read-only evidence.`;
  }
  return "Validation finished. See First Mate for the authoritative outcome.";
}

export function parseAxiRunId(output) {
  return /^  id:\s*"?([^"\s]+)"?\s*$/mu.exec(String(output || ""))?.[1] || null;
}

export function matchesExpectedAxiRun(output, expectedHeadSha) {
  const text = String(output || "");
  const runId = parseAxiRunId(text);
  const head = /^  head:\s*"?([a-f0-9]+)"?\s*$/mu.exec(text)?.[1] || null;
  const outcome = /^outcome:\s*([^\s]+)\s*$/mu.exec(text)?.[1] || null;
  return Boolean(runId && head && !outcome &&
    typeof expectedHeadSha === "string" && expectedHeadSha.startsWith(head));
}

const stageLabels = Object.freeze({
  intent: "checking intent",
  rebase: "rebasing",
  review: "reviewing",
  test: "testing",
  document: "documenting",
  lint: "linting",
  push: "pushing",
  pr: "opening PR",
  ci: "waiting for CI",
});

export function projectNoMistakesHerdrStatus(output, { elapsedMs = 0 } = {}) {
  const text = String(output || "");
  const outcome = /^outcome:\s*([^\s]+)\s*$/mu.exec(text)?.[1] || null;
  const elapsed = formatElapsed(elapsedMs);
  if (outcome) {
    const passed = new Set(["passed", "checks-passed"]).has(outcome);
    const label = outcome === "checks-passed" ? "checks passed" : outcome;
    return {
      state: passed ? "idle" : "blocked",
      stage: label,
      customStatus: `${label} · ${elapsed}`,
      message: passed ? `Validation ${label}` : `Validation ${label}; open the pane for details`,
      terminal: true,
    };
  }

  const rows = [...text.matchAll(/^\s{4}([^,\s]+),([^,\s]+),/gmu)];
  const active = rows.find((match) =>
    new Set(["running", "fixing", "awaiting_approval", "fix_review"]).has(match[2]),
  );
  const step = active?.[1] || null;
  const stepStatus = active?.[2] || null;
  const awaiting = stepStatus === "awaiting_approval" || stepStatus === "fix_review" ||
    /^\s*awaiting_agent:/mu.test(text);
  const stage = awaiting ? "awaiting approval" : (stageLabels[step] || "queued");
  return {
    state: awaiting ? "blocked" : "working",
    stage,
    customStatus: `${stage} · ${elapsed}`,
    message: awaiting ? `Validation needs attention during ${step || "the pipeline"}` :
      `Validation ${stage}`,
    terminal: false,
  };
}

function formatElapsed(elapsedMs) {
  const seconds = Math.max(0, Math.floor(Number(elapsedMs) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
