# Local no-mistakes validation gate

ShipMates invokes pinned `no-mistakes v1.48.0` through a typed local-only
adapter. The upstream Darwin ARM64 release archive used for the exercise has
SHA-256:

```text
af6bfaffec8f961282aa19333e64f0cf82d1be95bab34ae2290ae6d570032279
```

The binary reports source commit `2ac3769`, matching the inspected
`kunchenguid/no-mistakes` commit
`2ac37698d441b4318867179e567a9f9dadb345fb`.

The extracted Darwin ARM64 executable is independently pinned at runtime with
SHA-256:

```text
ae9b455177bc38e9ab45e853f61f2172a5760105ea552cf3dceb55b3c9f39ad3
```

Firstmate verifies the binary digest, reported version, and source commit
before acquiring a local-write lease and again when validation begins.
It resolves the pinned executable from `NO_MISTAKES_BIN`, the standard
user-local installation paths, or the legacy temporary development path. A
candidate is never selected unless its executable digest matches this pin.

## Capability boundary

The adapter starts validation with:

```text
no-mistakes axi run --intent INTENT --skip rebase,push,pr,ci
```

Callers cannot change the skipped steps or add `--yes`. The child environment:

- uses a task-specific `NM_HOME`;
- disables telemetry and update checks;
- points GitHub and GitLab CLI configuration at empty task directories;
- removes ambient GitHub, GitLab, Bitbucket, Azure DevOps, and OpenAI API
  tokens.

If that run parks at an approval gate, the task-bound approval path first
inspects the existing run and calls `axi respond --action approve` only while
it is nonterminal. It then inspects the same run again. A terminal status from
the first inspection is reconciled directly, covering the crash window after
no-mistakes completed but before ShipMates recorded the result; neither path
starts a second validation run.

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
NO_MISTAKES_BIN=/absolute/path/to/the/pinned/no-mistakes \
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
