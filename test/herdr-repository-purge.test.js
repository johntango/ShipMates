import assert from "node:assert/strict";
import test from "node:test";

import { HerdrRepositoryPurgeObserver } from "../src/adapters/herdr-repository-purge.js";

const preview = {
  projects: [{ id: "project-demo", name: "DemoTest3" }],
  taskIds: [],
};

test("fails purge visibility cleanup when Herdr cannot be inspected", async () => {
  const observer = new HerdrRepositoryPurgeObserver({
    client: {
      list: async () => { throw new Error("offline"); },
      reportMetadata: async () => {},
      releaseAgent: async () => {},
    },
  });

  await assert.rejects(() => observer.release(preview), /offline/u);
});

test("fails purge visibility cleanup when a matching pane cannot be released", async () => {
  const observer = new HerdrRepositoryPurgeObserver({
    client: {
      list: async () => [{ paneId: "pane-1", agent: "ShipMates Project: DemoTest3" }],
      reportMetadata: async () => {},
      releaseAgent: async () => { throw new Error("release failed"); },
    },
  });

  await assert.rejects(() => observer.release(preview), /release failed/u);
});
