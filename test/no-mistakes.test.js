import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FAST_LOCAL_SKIP_STEPS,
  NoMistakesLocalGate,
  NoMistakesOutputError,
  parseAxiOutput,
  resolvePinnedNoMistakesBinary,
} from "../src/adapters/no-mistakes.js";

const HEAD = "a".repeat(40);
const NOW = new Date("2026-07-13T19:00:00.000Z");
const BINARY = Buffer.from("pinned-no-mistakes-test-binary");
const PIN = Object.freeze({
  version: "v1.41.1",
  sourceCommit: "4a692bd336c37e9ac36761ee82e558865402abba",
  binarySha256: createHash("sha256").update(BINARY).digest("hex"),
});
const PIN_OPTIONS = Object.freeze({
  binaryReader: async () => BINARY,
  pin: PIN,
});

test("resolves only an installed binary matching the immutable pin", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const reads = [];
  const resolved = await resolvePinnedNoMistakesBinary({
    pin: PIN,
    candidatePaths: ["/missing/no-mistakes", "/wrong/no-mistakes", "/pinned/no-mistakes"],
    binaryReader: async (candidate) => {
      reads.push(candidate);
      if (candidate === "/missing/no-mistakes") throw missing;
      return candidate === "/pinned/no-mistakes" ? BINARY : Buffer.from("wrong");
    },
  });
  assert.equal(resolved, "/pinned/no-mistakes");
  assert.deepEqual(reads, ["/missing/no-mistakes", "/wrong/no-mistakes", "/pinned/no-mistakes"]);
});

test("rejects an explicit binary that does not match the pin", async () => {
  await assert.rejects(() => resolvePinnedNoMistakesBinary({
    explicitPath: "/custom/no-mistakes",
    pin: PIN,
    binaryReader: async () => Buffer.from("wrong"),
  }), /does not match the pinned binary digest/u);
});

test("keeps the validation profile separate from immutable binary pin evidence", () => {
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    skipSteps: FAST_LOCAL_SKIP_STEPS,
    ...PIN_OPTIONS,
  });
  assert.equal("skipSteps" in gate.pinEvidence(), false);
  assert.equal(FAST_LOCAL_SKIP_STEPS.includes("test"), false);
  assert.equal(FAST_LOCAL_SKIP_STEPS.includes("lint"), false);
  assert.equal(FAST_LOCAL_SKIP_STEPS.includes("review"), true);
});

test("runs a passing validator with remote-capable steps disabled", async () => {
  const calls = [];
  const progress = [];
  const visibility = [];
  const runner = fakeRunner({ calls, output: passingOutput() });
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    stateRoot: path.join(tmpdir(), "shipmates-no-mistakes-test"),
    runner,
    onProgress: (message) => progress.push(message),
    observer: { started: async (context) => visibility.push(context) },
    clock: () => NOW,
    ...PIN_OPTIONS,
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
  assert.deepEqual(report.tool, {
    name: "no-mistakes",
    binary: "/private/tmp/no-mistakes",
    pinned: true,
    ...PIN,
  });
  const invocation = calls.find(({ args }) => args[0] === "axi");
  assert.equal(calls.some(({ args }) => args[0] === "init"), true);
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
  assert.deepEqual(progress, ["Starting validation pipeline", "Running tests"]);
  assert.deepEqual(visibility, [{
    taskId: "validation-001",
    binaryPath: "/private/tmp/no-mistakes",
    runtimeHome: path.join(tmpdir(), "shipmates-no-mistakes-test", "runtime"),
    worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD,
  }]);
});

test("reuses the managed runtime already bound to the repository remote", async () => {
  const calls = [];
  const stateRoot = path.join(tmpdir(), "shipmates-no-mistakes-existing");
  const existingRoot = path.join(stateRoot, "earlier-task");
  const baseRunner = fakeRunner({ calls, output: passingOutput() });
  const runner = async (command, args, options) => {
    if (command === "git" && args[0] === "remote") {
      calls.push({ command, args, options });
      return {
        exitCode: 0,
        stdout: `${path.join(existingRoot, "repos", "gate.git")}\n`,
        stderr: "",
      };
    }
    return baseRunner(command, args, options);
  };
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    stateRoot,
    runner,
    clock: () => NOW,
    ...PIN_OPTIONS,
  });

  await gate.run({
    taskId: "validation-002",
    worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD,
    intent: "Reuse the existing local gate",
  });

  const init = calls.find(({ args }) => args[0] === "init");
  assert.equal(init.options.env.NM_HOME, existingRoot);
});

test("rebinds a stale ShipMates-managed remote from a recycled worktree", async () => {
  const calls = [];
  const stateRoot = path.join(tmpdir(), "shipmates-firstmate-current", "no-mistakes");
  const staleRemote = path.join(
    tmpdir(), "shipmates-firstmate-prior", "no-mistakes", "runtime",
    "0123456789abcdef", "repos", "gate.git",
  );
  const baseRunner = fakeRunner({ calls, output: passingOutput() });
  const runner = async (command, args, options) => {
    if (command === "git" && args.join(" ") === "remote get-url no-mistakes") {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: `${staleRemote}\n`, stderr: "" };
    }
    if (command === "git" && args.join(" ") === "remote remove no-mistakes") {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args.join(" ") === "remote get-url origin") {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "git@github.com:owner/repo.git\n", stderr: "" };
    }
    return baseRunner(command, args, options);
  };
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes", stateRoot, runner,
    clock: () => NOW, ...PIN_OPTIONS,
  });

  await gate.run({
    taskId: "validation-recycled", worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD, intent: "Validate the recycled worktree",
  });

  assert.equal(calls.some(({ args }) => args.join(" ") === "remote remove no-mistakes"), true);
  const init = calls.find(({ args }) => args[0] === "init");
  assert.notEqual(init.options.env.NM_HOME, path.dirname(path.dirname(staleRemote)));
  assert.match(init.options.env.NM_HOME, /shipmates-no-mistakes-runtime\/[a-f0-9]{16}$/u);
});

test("continues to reject an arbitrary external no-mistakes remote", async () => {
  const runner = async (command, args, options) => {
    if (command === "git" && args.join(" ") === "remote get-url no-mistakes") {
      return { exitCode: 0, stdout: "/opt/unmanaged/gate.git\n", stderr: "" };
    }
    return fakeRunner({ output: passingOutput() })(command, args, options);
  };
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    stateRoot: path.join(tmpdir(), "shipmates-current", "no-mistakes"),
    runner, clock: () => NOW, ...PIN_OPTIONS,
  });

  await assert.rejects(gate.run({
    taskId: "validation-unmanaged", worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD, intent: "Validate safely",
  }), /outside the managed validation state/u);
});

test("uses an origin-specific runtime when Git reports an absent no-mistakes remote as 128", async () => {
  const calls = [];
  const stateRoot = path.join(tmpdir(), "shipmates-no-mistakes-multi-repo");
  const baseRunner = fakeRunner({ calls, output: passingOutput() });
  const runner = async (command, args, options) => {
    if (command === "git" && args.join(" ") === "remote get-url no-mistakes") {
      calls.push({ command, args, options });
      return { exitCode: 128, stdout: "", stderr: "fatal: No such remote 'no-mistakes'\n" };
    }
    if (command === "git" && args.join(" ") === "remote get-url origin") {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "git@github.com:owner/second-repo.git\n", stderr: "" };
    }
    return baseRunner(command, args, options);
  };
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes", stateRoot, runner,
    clock: () => NOW, ...PIN_OPTIONS,
  });

  await gate.run({
    taskId: "validation-multi", worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD, intent: "Validate the second repository",
  });

  const init = calls.find(({ args }) => args[0] === "init");
  assert.match(init.options.env.NM_HOME, /runtime\/[a-f0-9]{16}$/u);
});

test("records an approval gate as not passed without advancing remote steps", async () => {
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    runner: fakeRunner({ output: gateOutput() }),
    clock: () => NOW,
    ...PIN_OPTIONS,
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

test("approves the existing gate and returns its terminal passing result", async () => {
  const calls = [];
  const base = fakeRunner({ output: passingOutput(), calls });
  let statusReads = 0;
  const runner = async (command, args, options) => {
    if (command.endsWith("no-mistakes") && args.join(" ") === "axi status" &&
      statusReads++ === 0) {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: gateOutput(), stderr: "" };
    }
    return base(command, args, options);
  };
  const gate = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes", runner,
    clock: () => NOW, ...PIN_OPTIONS,
  });

  const report = await gate.respond({
    taskId: "validation-001", worktreePath: "/private/tmp/worktree",
    expectedHeadSha: HEAD, intent: "Validate locally", action: "approve",
  });

  assert.equal(report.passed, true);
  assert.deepEqual(calls.find(({ args }) => args[1] === "respond")?.args,
    ["axi", "respond", "--action", "approve"]);
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
    ...PIN_OPTIONS,
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
    ...PIN_OPTIONS,
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

test("rejects an unpinned binary digest or reported version before validation", async () => {
  const wrongDigest = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    runner: fakeRunner({ output: passingOutput() }),
    binaryReader: async () => Buffer.from("wrong"),
    pin: PIN,
  });
  await assert.rejects(
    wrongDigest.run({
      taskId: "validation-001",
      worktreePath: "/private/tmp/worktree",
      expectedHeadSha: HEAD,
      intent: "Validate locally",
    }),
    /binary digest does not match/u,
  );

  const wrongVersion = new NoMistakesLocalGate({
    binaryPath: "/private/tmp/no-mistakes",
    runner: async (command, args, options) => {
      if (args[0] === "--version") {
        return {
          exitCode: 0,
          stdout: "no-mistakes version v9.9.9 (78e4dcb) test\n",
          stderr: "",
        };
      }
      return fakeRunner({ output: passingOutput() })(command, args, options);
    },
    ...PIN_OPTIONS,
  });
  await assert.rejects(
    wrongVersion.run({
      taskId: "validation-001",
      worktreePath: "/private/tmp/worktree",
      expectedHeadSha: HEAD,
      intent: "Validate locally",
    }),
    /version does not match/u,
  );
});

function fakeRunner({ calls = [], output, afterHead = HEAD }) {
  let inspections = 0;
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "--version") {
      return {
        exitCode: 0,
        stdout: "no-mistakes version v1.41.1 (4a692bd) test\n",
        stderr: "",
      };
    }
    if (command.endsWith("no-mistakes")) {
      if (args[0] === "axi") options.onStderrLine?.("Running tests");
      return { exitCode: 0, stdout: output, stderr: "" };
    }
    if (args[0] === "remote") {
      return { exitCode: 2, stdout: "", stderr: "remote not found" };
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
