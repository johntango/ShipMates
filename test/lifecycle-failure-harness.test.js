import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  InjectedLifecycleTermination, LifecycleFailureHarness,
  LIFECYCLE_OPERATIONS, TERMINATION_PHASES,
} from "../src/testing/lifecycle-failure-harness.js";

const run = promisify(execFile);

test("completes the disposable lifecycle exactly once", async (t) => {
  const fixture = await createFixture(t);
  const result = await fixture.harness.resume();
  assertCompletion(result);
});

test("restarts safely at every durable intent and external action boundary", async (t) => {
  for (const operation of LIFECYCLE_OPERATIONS) {
    for (const phase of TERMINATION_PHASES) {
      await t.test(`${operation}:${phase}`, async (child) => {
        const fixture = await createFixture(child);
        const point = `${operation}:${phase}`;
        const interrupted = new LifecycleFailureHarness({
          ...fixture.options,
          inject(candidate) { if (candidate === point) throw new InjectedLifecycleTermination(point); },
        });
        await assert.rejects(() => interrupted.resume(), (error) => error.point === point);
        const restarted = new LifecycleFailureHarness(fixture.options);
        assertCompletion(await restarted.resume());
      });
    }
  }
});

function assertCompletion(result) {
  assert.equal(result.completed, true);
  assert.equal(result.destinationHead, result.sourceHead);
  assert.deepEqual(result.counts, {
    attempts: 1, workerArtifacts: 1, commits: 1, validationRuns: 1, approvals: 1, deliveries: 1,
  });
  assert.equal(Object.keys(result.operations).length, LIFECYCLE_OPERATIONS.length);
  assert.equal(Object.values(result.operations).every(({ intent, receipt }) => intent && receipt), true);
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipmates-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destinationRepo = path.join(root, "destination");
  const sourceRepo = path.join(root, "source");
  const stateRoot = path.join(root, "state");
  await mkdir(destinationRepo);
  await run("git", ["init", "--quiet"], { cwd: destinationRepo });
  await run("git", ["checkout", "--quiet", "-b", "main"], { cwd: destinationRepo });
  await run("git", ["config", "user.name", "ShipMates Harness"], { cwd: destinationRepo });
  await run("git", ["config", "user.email", "harness@shipmates.local"], { cwd: destinationRepo });
  await writeFile(path.join(destinationRepo, "README.md"), "harness\n");
  await run("git", ["add", "README.md"], { cwd: destinationRepo });
  await run("git", ["commit", "--quiet", "-m", "Harness base"], { cwd: destinationRepo });
  const options = { stateRoot, destinationRepo, sourceRepo };
  return { options, harness: new LifecycleFailureHarness(options) };
}
