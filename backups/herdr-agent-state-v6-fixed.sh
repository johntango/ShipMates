#!/bin/sh
# installed by herdr
# managed by herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# HERDR_INTEGRATION_ID=codex
# HERDR_INTEGRATION_VERSION=6

set -eu

action="${1:-}"
action="$(printf '%s' "$action" | tr '[:upper:]' '[:lower:]')"
hook_input_file="$(mktemp "${TMPDIR:-/tmp}/herdr-codex-hook.XXXXXX")" || exit 0
trap 'rm -f "$hook_input_file"' EXIT HUP INT TERM
cat >"$hook_input_file" 2>/dev/null || true

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

HERDR_ACTION="$action" HERDR_HOOK_INPUT_FILE="$hook_input_file" HERDR_ENV_NAME="HERDR" python3 - <<'PY'
import json
import os
import random
import socket
import time

source = "herdr:codex"
action = os.environ.get("HERDR_ACTION", "")
pane_id = os.environ.get("HERDR_PANE_ID")
socket_path = os.environ.get("HERDR_SOCKET_PATH")
hook_input_file = os.environ.get("HERDR_HOOK_INPUT_FILE")


def log(msg):
    path = os.path.expanduser("~/.config/herdr/herdr-codex-hook.log")
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass

if not pane_id or not socket_path:
    raise SystemExit(0)

hook_input = {}
raw = ""
if hook_input_file:
    try:
        with open(hook_input_file, encoding="utf-8") as handle:
            raw = handle.read()
        if raw.strip():
            hook_input = json.loads(raw)
    except Exception:
        hook_input = {}


def coalesce(*names):
    for name in names:
        value = hook_input.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()

    session = hook_input.get("session")
    if isinstance(session, dict):
        for key in ("id", "session_id", "sessionId"):
            value = session.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None

hook_event_name = (
    hook_input.get("hook_event_name")
    or hook_input.get("event_name")
    or hook_input.get("event")
    or ""
)
normalized_event = (
    str(hook_event_name)
    .replace("_", "")
    .replace("-", "")
    .replace(".", "")
    .replace(" ", "")
    .lower()
)

log(f"herdr-hook-run action={action} event={normalized_event} raw={raw[:200]}")

request_id = f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
report_seq = time.time_ns()

agent_session_id = coalesce("session_id", "sessionId", "session", "id")
session_start_source = coalesce("source")

params = {
    "pane_id": pane_id,
    "source": source,
    "agent": "codex",
    "seq": report_seq,
}
if agent_session_id:
    params["agent_session_id"] = agent_session_id
if session_start_source:
    params["session_start_source"] = session_start_source

request_session = {
    "id": request_id,
    "method": "pane.report_agent_session",
    "params": params,
}

request_agent = {
    "id": f"{request_id}:agent",
    "method": "pane.report_agent",
    "params": {
        "pane_id": pane_id,
        "source": source,
        "agent": "codex",
        "state": "working",
        "seq": report_seq,
    },
}

for request in (request_session, request_agent):
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(1.0)
        client.connect(socket_path)
        client.sendall((json.dumps(request) + "\n").encode())
        response = client.recv(4096)
        client.close()
        log(f"herdr-hook-ok method={request['method']} pane={pane_id} response={response[:120]!r}")
    except Exception as exc:
        log(f"herdr-hook-fail method={request['method']} pane={pane_id} err={exc!r}")
        continue

PY
