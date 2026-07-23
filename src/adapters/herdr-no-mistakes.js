import path from "node:path";

import { shellQuote } from "./herdr-pane.js";

export class HerdrNoMistakesObserver {
  constructor({
    client,
    currentPaneId = process.env.HERDR_PANE_ID,
    watcherScript,
    nodePath = process.execPath,
    onWarning = console.error,
  } = {}) {
    if (!client || !watcherScript) {
      throw new TypeError("HerdrNoMistakesObserver requires client and watcherScript");
    }
    this.client = client;
    this.currentPaneId = currentPaneId || null;
    this.watcherScript = path.resolve(watcherScript);
    this.nodePath = nodePath;
    this.onWarning = onWarning;
    this.sequence = 0;
  }

  async started({ taskId, binaryPath, runtimeHome, worktreePath }) {
    if (!this.currentPaneId) return null;
    try {
      const agent = `ShipMates no-mistakes: ${taskId}`;
      const existing = (await this.client.list()).find((pane) => pane.agent === agent);
      const paneId = existing?.paneId || (await this.client.split({
        paneId: this.currentPaneId,
        cwd: worktreePath,
      })).paneId;
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
        ].map(shellQuote).join(" "),
      });
      return paneId;
    } catch (error) {
      this.onWarning?.(`no-mistakes Herdr visibility unavailable (${error.name || "Error"})`);
      return null;
    }
  }
}

export function parseAxiRunId(output) {
  return /^  id:\s*"?([^"\s]+)"?\s*$/mu.exec(String(output || ""))?.[1] || null;
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
