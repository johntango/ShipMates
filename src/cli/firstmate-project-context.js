import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { taskArtifactSummary } from "./firstmate-follow-up.js";

export class FirstmateProjectContext {
  constructor({ store, filename = "active-project.json" } = {}) {
    if (!store || typeof store.getSnapshot !== "function" ||
      typeof store.rootDir !== "string") {
      throw new TypeError("FirstmateProjectContext requires a task store");
    }
    this.store = store;
    this.target = path.join(store.rootDir, filename);
  }

  async load() {
    let record;
    try {
      record = JSON.parse(await readFile(this.target, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    if (record?.schemaVersion !== 1 || typeof record.taskId !== "string") return null;
    try {
      const snapshot = await this.store.getSnapshot(record.taskId);
      return taskArtifactSummary(snapshot).ready ? snapshot.id : null;
    } catch {
      return null;
    }
  }

  async save(snapshot) {
    if (!taskArtifactSummary(snapshot).ready) {
      throw new TypeError("Active project must contain implementation artifacts");
    }
    const temporary = `${this.target}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      schemaVersion: 1,
      taskId: snapshot.id,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.target);
    return snapshot.id;
  }
}
