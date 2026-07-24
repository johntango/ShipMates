const finalSequence = 2_147_483_647;

export class HerdrRepositoryPurgeObserver {
  constructor({ client, onWarning = console.error } = {}) {
    if (!client) throw new TypeError("Herdr repository purge observer requires a client");
    this.client = client;
    this.onWarning = onWarning;
  }

  async release(preview) {
    let panes;
    try { panes = await this.client.list(); }
    catch (error) {
      this.onWarning?.(`Herdr purge cleanup unavailable (${error.name || "Error"})`);
      return;
    }
    const releases = [];
    for (const project of preview.projects) {
      releases.push({
        source: `shipmates:project:${project.id}`,
        agent: `ShipMates Project: ${project.name}`,
      });
    }
    for (const taskId of preview.taskIds) {
      releases.push(
        { source: `shipmates:no-mistakes:${taskId}`, agent: `ShipMates no-mistakes: ${taskId}` },
        { source: `shipmates:firstmate:${taskId}`, agent: "ShipMates Firstmate" },
      );
      for (const worker of ["scout-1", "scout-2", "implementer"]) {
        releases.push({
          source: `shipmates:worker:${taskId}:${worker}`,
          agent: `ShipMates ${worker}`,
        });
      }
    }
    for (const release of releases) {
      for (const pane of panes.filter(({ agent }) => agent === release.agent)) {
        await this.client.reportMetadata?.({
          paneId: pane.paneId,
          source: release.source,
          appliesToSource: "herdr:codex",
          clearDisplayAgent: true,
          clearCustomStatus: true,
          clearStateLabels: true,
          seq: finalSequence,
        }).catch(() => {});
        await this.client.releaseAgent({
          paneId: pane.paneId,
          ...release,
          seq: finalSequence,
        }).catch(() => {});
      }
    }
  }
}
