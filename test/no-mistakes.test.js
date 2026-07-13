import assert from "node:assert/strict";
import test from "node:test";

import {
  NoMistakesLocalGate,
  NoMistakesOutputError,
  parseAxiOutput,
} from "../src/adapters/no-mistakes.js";

const HEAD = "a".repeat(40);
const NOW = new Date("2026-07-13T19:00:00.000Z");

test("runs a passing validator with remote-capable steps disabled", async () => {
  const calls = [];
  const runner = fakeRunner({ calls, output: passingOutput() });
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    stateRoot: "/private/tmp/nm-state",
    runner,
    clock: () => NOW,
  });

  const report = await gate.run({
    taskId: "validation-001",
    worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD,
    intent: "Verify the bounded practice change without GitHub operations",
  });

  assert.equal(report.passed, true);
  assert.equal(report.remoteOperations, false);
  assert.equal(report.finalHeadSha, HEAD);
  const invocation = calls.find(({ command }) => command.endsWith("no-mistakes"));
  assert.deepEqual(invocation.args, [
    "axi",
    "run",
    "--intent",
    "Verify the bounded practice change without GitHub operations",
    "--skip",
    "rebase,push,pr,ci",
  ]);
  assert.equal(invocation.options.env.GH_TOKEN, undefined);
  assert.equal(invocation.options.env.GITHUB_TOKEN, undefined);
  assert.equal(invocation.options.env.NO_MISTAKES_TELEMETRY, "0");
  assert.match(invocation.options.env.GH_CONFIG_DIR, /empty-gh$/u);
});

test("records an approval gate as not passed without advancing remote steps", async () => {
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    runner: fakeRunner({ output: gateOutput() }),
    clock: () => NOW,
  });

  const report = await gate.run({
    taskId: "validation-001",
    worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD,
    intent: "Validate locally",
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.gate, {
    step: "review",
    status: "awaiting_approval",
  });
  assert.equal(report.steps.find(({ step }) => step === "push").status, "pending");
});

test("rejects malformed output and a remote-capable step that ran", async () => {
  assert.throws(() => parseAxiOutput("outcome: passed\n"), NoMistakesOutputError);
  const output = passingOutput().replace(
    "    push,skipped,0,0",
    "    push,completed,0,1",
  );
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    runner: fakeRunner({ output }),
    clock: () => NOW,
  });
  await assert.rejects(
    gate.run({
      taskId: "validation-001",
      worktreePath: "/private/tmp/worktree",
      expectedHeadSha: HEAD,
      intent: "Validate locally",
    }),
    /Remote-capable step push was not skipped/u,
  );
});

test("does not accept a changed head as a passing local validation", async () => {
  const changed = "b".repeat(40);
  const output = passingOutput().replace("head: aaaaaaaa", "head: bbbbbbbb");
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    runner: fakeRunner({ output, afterHead: changed }),
    clock: () => NOW,
  });
  const report = await gate.run({
    taskId: "validation-001",
    worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD,
    intent: "Validate locally",
  });

  assert.equal(report.headChanged, true);
  assert.equal(report.passed, false);
});

function fakeRunner({ calls = [], output, afterHead = HEAD }) {
  let inspections = 0;
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (command.endsWith("no-mistakes")) {
      return { exitCode: 0, stdout: output, stderr: "" };
    }
    if (args[0] === "rev-parse") {
      inspections += 1;
      return {
        exitCode: 0,
        stdout: `${inspections === 1 ? HEAD : afterHead}\n`,
        stderr: "",
      };
    }
    if (args[0] === "symbolic-ref") {
      return { exitCode: 0, stdout: "feature/local-gate\n", stderr: "" };
    }
    if (args[0] === "status") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

function passingOutput() {
  return `run:
  id: run-local-1
  branch: feature/local-gate
  status: completed
  head: aaaaaaaa
  findings: none
  steps[9]{step,status,findings,duration_ms}:
    intent,completed,0,1
    rebase,skipped,0,0
    review,completed,0,2
    test,completed,0,3
    document,completed,0,4
    lint,completed,0,5
    push,skipped,0,0
    pr,skipped,0,0
    ci,skipped,0,0
outcome: passed
help[1]: "Summarize this pipeline run"
`;
}

function gateOutput() {
  return `run:
  id: run-local-2
  branch: feature/local-gate
  status: running
  head: aaaaaaaa
  findings: "1 blocking"
  steps[9]{step,status,findings,duration_ms}:
    intent,completed,0,1
    rebase,skipped,0,0
    review,awaiting_approval,1,2
    test,pending,0,0
    document,pending,0,0
    lint,pending,0,0
    push,pending,0,0
    pr,pending,0,0
    ci,pending,0,0
gate:
  step: review
  status: awaiting_approval
  findings: "1 blocking"
`;
}
