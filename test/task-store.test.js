import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TaskStore, TaskStoreError } from "../src/storage/task-store.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../scripts/task-ledger.js", import.meta.url));

test("stores an authoritative event log and rebuilds a damaged snapshot", async (t) => {
  const rootDir = await temporaryState(t);
  const store = new TaskStore({ rootDir });
  await createTask(store);
  await store.transition({
    taskId: "ledger-test-001",
    from: "proposed",
    to: "clarified",
    actor: "firstmate",
    eventId: "transition-1",
  });

  const snapshotPath = path.join(
    rootDir,
    "tasks",
    "ledger-test-001",
    "snapshot.json",
  );
  await writeFile(snapshotPath, "not valid json\n", "utf8");

  const replayed = await store.getSnapshot("ledger-test-001");
  assert.equal(replayed.state, "clarified");
  assert.equal(replayed.eventsCount, 2);

  await store.rebuildSnapshot("ledger-test-001");
  assert.deepEqual(JSON.parse(await readFile(snapshotPath, "utf8")), replayed);
});

test("makes an identical event retry idempotent", async (t) => {
  const rootDir = await temporaryState(t);
  const store = new TaskStore({ rootDir });
  await createTask(store);
  const evidence = {
    taskId: "ledger-test-001",
    actor: "firstmate",
    kind: "test-run",
    value: "pass",
    eventId: "evidence-1",
  };

  await store.recordEvidence(evidence);
  const snapshot = await store.recordEvidence(evidence);

  assert.equal(snapshot.eventsCount, 2);
  assert.equal((await store.readEvents("ledger-test-001")).length, 2);
});

test("rejects reuse of an event id with a different payload", async (t) => {
  const store = new TaskStore({ rootDir: await temporaryState(t) });
  await createTask(store);
  await store.recordEvidence({
    taskId: "ledger-test-001",
    actor: "firstmate",
    kind: "test-run",
    value: "pass",
    eventId: "evidence-1",
  });

  await assert.rejects(
    store.recordEvidence({
      taskId: "ledger-test-001",
      actor: "firstmate",
      kind: "test-run",
      value: "fail",
      eventId: "evidence-1",
    }),
    /reused with a different payload/u,
  );
});

test("serializes writers from separate processes", async (t) => {
  const rootDir = await temporaryState(t);
  const store = new TaskStore({ rootDir });
  await createTask(store);
  const env = { ...process.env, SHIPMATES_STATE_DIR: rootDir };

  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      execFileAsync(
        process.execPath,
        [
          cliPath,
          "evidence",
          "ledger-test-001",
          "worker-report",
          `worker-${index}`,
        ],
        { env },
      ),
    ),
  );

  const snapshot = await store.getSnapshot("ledger-test-001");
  assert.equal(snapshot.eventsCount, 9);
  assert.deepEqual(
    snapshot.evidence.map(({ value }) => value).sort(),
    Array.from({ length: 8 }, (_, index) => `worker-${index}`),
  );
});

test("fails closed on corrupt JSONL", async (t) => {
  const rootDir = await temporaryState(t);
  const store = new TaskStore({ rootDir });
  await createTask(store);
  const eventsPath = path.join(
    rootDir,
    "tasks",
    "ledger-test-001",
    "events.jsonl",
  );
  await writeFile(eventsPath, '{"partial":\n', "utf8");

  await assert.rejects(
    store.getSnapshot("ledger-test-001"),
    /Invalid JSON.*line 1/u,
  );
});

test("times out instead of stealing an existing lock", async (t) => {
  const rootDir = await temporaryState(t);
  const taskDir = path.join(rootDir, "tasks", "ledger-test-001");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "write.lock"), "held\n", "utf8");
  const store = new TaskStore({
    rootDir,
    lockTimeoutMs: 30,
    lockRetryMs: 5,
  });

  await assert.rejects(createTask(store), TaskStoreError);
});

async function createTask(store) {
  return store.createTask({
    taskId: "ledger-test-001",
    kind: "code-change",
    repo: "johntango/Shipmates-Practice",
    baseSha: "abc123",
    actor: "firstmate",
    eventId: "created-1",
  });
}

async function temporaryState(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "shipmates-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
