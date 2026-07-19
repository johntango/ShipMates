import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalDeliveryError,
  LocalDeliveryWorkflow,
  canDeliverLocally,
} from "../src/workflows/local-delivery.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

test("fast-forwards a clean local checkout to the exact validated commit", async () => {
  const store = new MemoryStore(snapshot());
  let destinationHead = BASE;
  const calls = [];
  const workflow = new LocalDeliveryWorkflow({
    store,
    runGit: async (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse") return `${cwd === "/repo" ? destinationHead : HEAD}\n`;
      if (args[0] === "merge") {
        assert.deepEqual(args, ["merge", "--ff-only", HEAD]);
        destinationHead = HEAD;
        return "fast-forwarded";
      }
      throw new Error("unexpected git call");
    },
  });

  const result = await workflow.deliver({ taskId: "task-001" });

  assert.equal(result.reused, false);
  assert.equal(result.snapshot.state, "complete");
  assert.equal(JSON.parse(result.snapshot.evidence[0].value).headSha, HEAD);
  assert.ok(calls.some((call) => call.join(" ") === `/repo merge --ff-only ${HEAD}`));
});

test("refuses delivery when the destination checkout is dirty", async () => {
  const store = new MemoryStore(snapshot());
  const workflow = new LocalDeliveryWorkflow({
    store,
    runGit: async (_cwd, args) => args[0] === "rev-parse" ? `${BASE}\n` : " M README.md\0",
  });

  await assert.rejects(
    workflow.deliver({ taskId: "task-001" }),
    (error) => error instanceof LocalDeliveryError && /uncommitted/u.test(error.message),
  );
  assert.equal(store.value.state, "validating");
});

test("only offers local delivery for an exact passing validation", () => {
  const value = snapshot();
  assert.equal(canDeliverLocally(value), true);
  value.validationRuns[0].finalHeadSha = "c".repeat(40);
  assert.equal(canDeliverLocally(value), false);
});

class MemoryStore {
  constructor(value) {
    this.value = value;
  }

  async getSnapshot() {
    return this.value;
  }

  async recordEvidence({ kind, value, eventId, actor }) {
    this.value.evidence.push({ kind, value, eventId, actor });
    return this.value;
  }

  async transition({ from, to }) {
    assert.equal(this.value.state, from);
    this.value.state = to;
    return this.value;
  }
}

function snapshot() {
  return {
    id: "task-001",
    state: "validating",
    baseSha: BASE,
    evidence: [],
    worktree: {
      status: "leased",
      repoPath: "/repo",
      worktreePath: "/treehouse/task-001",
      headSha: HEAD,
    },
    gitCommits: [{
      status: "completed",
      result: { baseHeadSha: BASE, headSha: HEAD },
    }],
    validationRuns: [{ passed: true, finalHeadSha: HEAD }],
  };
}
