import { taskArtifactSummary } from "./firstmate-follow-up.js";

export class FirstmateProjectContext {
  constructor({ store } = {}) {
    if (!store || typeof store.getSnapshot !== "function" ||
      typeof store.rootDir !== "string") {
      throw new TypeError("FirstmateProjectContext requires a task store");
    }
    this.store = store;
    this.activeTaskId = null;
  }

  async load() {
    if (!this.activeTaskId) return null;
    try {
      const snapshot = await this.store.getSnapshot(this.activeTaskId);
      return snapshot.state !== "complete" && taskArtifactSummary(snapshot).ready
        ? snapshot.id : null;
    } catch {
      return null;
    }
  }

  async save(snapshot) {
    if (!taskArtifactSummary(snapshot).ready) {
      throw new TypeError("Active project must contain implementation artifacts");
    }
    this.activeTaskId = snapshot.id;
    return snapshot.id;
  }
}
