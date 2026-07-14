# Local no-mistakes validation gate

ShipMates invokes pinned `no-mistakes v1.37.0` through a typed local-only
adapter. The upstream Darwin ARM64 release archive used for the exercise has
SHA-256:

```text
8f2ac871c0ca35dae957bf3e20eb7cafcfd5fc7de622c46e5e519081924749a1
```

The binary reports source commit `78e4dcb`, matching the inspected
`johntango/no-mistakes` commit
`78e4dcb234274199717acafa90abca5cf7013993`.

The extracted Darwin ARM64 executable is independently pinned at runtime with
SHA-256:

```text
d4558d241100cb48196a00864157fb70bb5aa241ac376bcbf48dda88fb033e34
```

Firstmate verifies the binary digest, reported version, and source commit
before acquiring a local-write lease and again when validation begins.

## Capability boundary

The adapter always calls:

```text
no-mistakes axi run --intent INTENT --skip rebase,push,pr,ci
```

Callers cannot change the skipped steps or add `--yes`. The child environment:

- uses a task-specific `NM_HOME`;
- disables telemetry and update checks;
- points GitHub and GitLab CLI configuration at empty task directories;
- removes ambient GitHub, GitLab, Bitbucket, Azure DevOps, and OpenAI API
  tokens.

The initial `axi` trigger pushes the commit only into no-mistakes' local bare
gate repository. Rebase, branch push, pull-request, and CI steps must be
`skipped` in terminal output. Any one of those steps running makes the evidence
invalid.

## Evidence and refusal behavior

Before execution, Firstmate records durable validation intent and independently
requires the leased worktree to be
clean at the recorded full SHA. After execution, it re-reads the branch, full
SHA, and worktree status. A changed branch, dirty worktree, malformed TOON
output, output/Git SHA disagreement, approval gate, failed step, or validator
commit cannot count as a passing local gate.

The ledger stores normalized step states, findings count, exact command
arguments, initial and final SHAs, process exit status, and SHA-256 digests of
stdout and stderr. Raw terminal output is not authoritative evidence. A
request without a result is not automatically rerun after restart.

Run an already-initialized, actively leased task in `validating` state with:

```sh
NO_MISTAKES_BIN=/private/tmp/shipmates-no-mistakes-v1.37.0/no-mistakes \
node scripts/local-validation.js run TASK_ID "the original user intent"
```

## Verified exercise

Before invoking AXI, the adapter idempotently initializes the repository in the
isolated no-mistakes state. On macOS, deeply nested ledger paths can exceed the
Unix-domain socket limit. ShipMates keeps authoritative state under the task
ledger but supplies no-mistakes with a short temporary symlink to that exact
directory. A pre-existing link is accepted only when it resolves to the
expected target.

If durable validation intent exists without a result, normal execution refuses
to repeat it. After inspecting the pinned head, branch, intent, and tool binding,
an operator can explicitly resume that same request with:

```sh
SHIPMATES_STATE_DIR=/absolute/state/root \
NO_MISTAKES_BIN=/absolute/pinned/no-mistakes \
node scripts/local-validation.js reconcile TASK_ID "ORIGINAL INTENT"
```

The July 14 practice run recovered `validation-v1` this way. Run
`01KXGPDYQT138Z3RMPH3Y9ANNZ` passed at exact head
`4adfed664b1c00d6d1fd879f9cd906d7a4840b5c` with zero findings and all
remote-capable steps skipped.

Task `local-validation-20260713` exercised the pinned binary against a
disposable clone of `johntango/Shipmates-Practice` at
`4894811cf35e6e7b6559d4d75f2da78d24791c92`.

- run: `01KXEEDJKSY306KE9RWK47XMWB`;
- outcome: `passed` with zero findings;
- initial and final Git SHA: identical;
- review, test, document, and lint: completed;
- rebase, push, PR, and CI: skipped;
- GitHub `main`: unchanged;
- matching remote exercise branches: zero;
- repository pull-request count: still two.

The isolated daemon was stopped after verification. The operational report is
stored under the ignored `.shipmates/tasks/local-validation-20260713/` ledger.
