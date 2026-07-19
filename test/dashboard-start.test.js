import assert from "node:assert/strict";
import test from "node:test";

import { startDashboardWithFallback } from "../src/dashboard/start.js";

test("moves the Firstmate dashboard to the next port when the preferred port is occupied", async () => {
  const attempted = [];
  const server = {
    port: 4390,
    async start() {
      attempted.push(this.port);
      if (this.port === 4390) throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
      return `http://127.0.0.1:${this.port}`;
    },
  };

  assert.deepEqual(await startDashboardWithFallback(server), {
    url: "http://127.0.0.1:4391", requestedPort: 4390, port: 4391, fallback: true,
  });
  assert.deepEqual(attempted, [4390, 4391]);
});

test("does not hide dashboard startup errors other than an occupied port", async () => {
  const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await assert.rejects(() => startDashboardWithFallback({
    port: 4390, start: async () => { throw failure; },
  }), (error) => error === failure);
});
