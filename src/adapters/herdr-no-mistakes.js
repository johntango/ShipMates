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
