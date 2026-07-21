export class HerdrProjectAgentObserver {
  constructor({ client, currentPaneId = process.env.HERDR_PANE_ID, onWarning = console.error } = {}) {
    if (!client) throw new TypeError("HerdrProjectAgentObserver requires a client");
    this.client = client;
    this.currentPaneId = currentPaneId || null;
    this.onWarning = onWarning;
    this.panes = new Map();
    this.sequences = new Map();
  }

  async ensure(project) {
    if (!this.currentPaneId) return null;
    const agent = agentName(project);
    try {
      const existing = (await this.client.list()).find((pane) => pane.agent === agent);
      const paneId = existing?.paneId || (await this.client.split({
        paneId: this.currentPaneId, cwd: project.executionPolicy.worktreePath,
      })).paneId;
      this.panes.set(project.id, paneId);
      await this.stage(project, {
        state: "idle",
        status: project.status === "paused" ? "paused" : "ready",
        message: project.status === "paused" ? "Project paused" : "Project ready",
      });
      return paneId;
    } catch (error) {
      this.onWarning?.(`Project Agent visibility unavailable for ${project.name} (${error.name || "Error"})`);
      return null;
    }
  }

  async stage(project, { state, status, message }) {
    const paneId = this.panes.get(project.id) || await this.#find(project);
    if (!paneId) return;
    try {
      const source = `shipmates:project:${project.id}`;
      const seq = this.#next(project.id);
      await this.client.reportAgent({
        paneId,
        source,
        agent: agentName(project),
        state,
        message: safe(message),
        customStatus: safe(status),
        seq,
        agentSessionId: project.id,
        agentSessionPath: project.executionPolicy.worktreePath,
      });
      if (typeof this.client.reportMetadata === "function") {
        await this.client.reportMetadata({
          paneId,
          source,
          appliesToSource: "herdr:codex",
          displayAgent: agentName(project),
          customStatus: safe(status),
          stateLabels: {
            unknown: safe(status), idle: "ready", working: "working", blocked: "blocked",
          },
          seq,
        });
      }
    } catch (error) {
      this.onWarning?.(`Project Agent stage unavailable for ${project.name} (${error.name || "Error"})`);
    }
  }

  paneIdFor(projectId) {
    return this.panes.get(projectId) || null;
  }

  async #find(project) {
    if (!this.currentPaneId) return null;
    try {
      const pane = (await this.client.list()).find(({ agent }) => agent === agentName(project));
      if (!pane) return null;
      this.panes.set(project.id, pane.paneId);
      return pane.paneId;
    } catch { return null; }
  }

  #next(projectId) {
    const value = (this.sequences.get(projectId) || 0) + 1;
    this.sequences.set(projectId, value);
    return value;
  }
}

function agentName(project) { return `ShipMates Project: ${project.name}`; }
function safe(value) { return String(value || "").replace(/[\p{Cc}\p{Cf}]/gu, "?").slice(0, 120); }
