import path from "node:path";

import { shellQuote } from "./herdr-pane.js";

export class HerdrWorkflowRunObserver {
  constructor({ client, currentPaneId = process.env.HERDR_PANE_ID, watcherScript,
    nodePath = process.execPath, onWarning = console.error } = {}) {
    if (!client || !watcherScript) {
      throw new TypeError("HerdrWorkflowRunObserver requires client and watcherScript");
    }
    this.client = client;
    this.currentPaneId = currentPaneId || null;
    this.watcherScript = path.resolve(watcherScript);
    this.nodePath = nodePath;
    this.onWarning = onWarning;
  }

  async started({ repoPath, operationDirectory }) {
    if (!this.currentPaneId) return null;
    try {
      const paneId = (await this.client.split({
        paneId: this.currentPaneId, cwd: repoPath,
      })).paneId;
      const source = "shipmates:simple-implementer";
      await this.client.reportAgent({
        paneId,
        source,
        agent: "ShipMates Implementer",
        state: "working",
        message: "Implementing in an isolated workspace",
        customStatus: "implementing",
        seq: 1,
        agentSessionPath: repoPath,
      });
      await this.client.run({
        paneId,
        command: [this.nodePath, this.watcherScript, operationDirectory, paneId, source]
          .map(shellQuote).join(" "),
      });
      return paneId;
    } catch (error) {
      this.onWarning?.(`Implementer Herdr visibility unavailable (${error.name || "Error"})`);
      return null;
    }
  }
}
