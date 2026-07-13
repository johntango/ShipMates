#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${HERDR_PANE_ID:-}" || -z "${HERDR_SOCKET_PATH:-}" || "${HERDR_ENV:-}" != "1" ]]; then
  echo "[codex-headr] Herdr tracking env is missing." >&2
  echo "Start this command inside a Herdr pane (or pass HERDR_* vars through herdr) for status tracking." >&2
  echo "Example: herdr pane run <pane_id> ./codex-headr.sh" >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "[codex-headr] codex binary not found in PATH." >&2
  exit 1
fi

HERDR_PANE_ID="$HERDR_PANE_ID" \
HERDR_SOURCE="${HERDR_SOURCE:-herdr:codex-headr}" \
HERDR_AGENT="${HERDR_AGENT:-Codex}" \
HERDR_POLL_IDLE_SECONDS="${HERDR_POLL_IDLE_SECONDS:-1.5}" \
python3 - "$@" <<'PY'
import os
import sys
import pty
import fcntl
import subprocess
import selectors
import time
import shutil
import signal
import struct
from typing import Optional

HERDR_PANE_ID = os.environ["HERDR_PANE_ID"]
HERDR_SOURCE = os.environ.get("HERDR_SOURCE", "herdr:codex-headr")
HERDR_AGENT = os.environ.get("HERDR_AGENT", "Codex")
HERDR_POLL_IDLE_SECONDS = float(os.environ.get("HERDR_POLL_IDLE_SECONDS", "1.5"))
HERDR_IDLE_STATUS = os.environ.get("HERDR_IDLE_STATUS", "ready")
HERDR_WORKING_STATUS = os.environ.get("HERDR_WORKING_STATUS", "running codex")


def report_to_herdr(state: str, status: str) -> None:
    herdr_bin = shutil.which("herdr") or "herdr"
    cmd = [
        herdr_bin,
        "pane",
        "report-agent",
        HERDR_PANE_ID,
        "--source",
        HERDR_SOURCE,
        "--agent",
        HERDR_AGENT,
        "--state",
        state,
        "--message",
        "Codex CLI",
        "--custom-status",
        status,
        "--seq",
        str(int(time.time() * 1000)),
    ]
    try:
        subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def _set_pty_window_size(fd_master: int, fd_stdin: int) -> None:
    try:
        TIOCGWINSZ = 0x5413
        winsize = fcntl.ioctl(fd_stdin, TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
        fcntl.ioctl(fd_master, 0x5414, winsize)
    except Exception:
        return


def _make_nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


current_state: Optional[str] = None
last_input_time = 0.0
last_output_time = 0.0


def maybe_set_state(state: str, status: str) -> None:
    global current_state
    if current_state != state:
        current_state = state
        report_to_herdr(state, status)


def release_from_herdr() -> None:
    herdr_bin = shutil.which("herdr") or "herdr"
    cmd = [
        herdr_bin,
        "pane",
        "release-agent",
        HERDR_PANE_ID,
        "--source",
        HERDR_SOURCE,
        "--agent",
        HERDR_AGENT,
    ]
    try:
        subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def handle_sigwinch(*_):
    _set_pty_window_size(master_fd, sys.stdin.fileno())


master_fd, slave_fd = pty.openpty()
try:
    _set_pty_window_size(master_fd, sys.stdin.fileno())
except Exception:
    pass

cmd = ["codex", *sys.argv[1:]]
proc = subprocess.Popen(
    cmd,
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    close_fds=False,
)

os.close(slave_fd)

_make_nonblocking(master_fd)
_make_nonblocking(sys.stdin.fileno())

signal.signal(signal.SIGWINCH, handle_sigwinch)

selector = selectors.DefaultSelector()
selector.register(sys.stdin, selectors.EVENT_READ)
selector.register(master_fd, selectors.EVENT_READ)

maybe_set_state("idle", HERDR_IDLE_STATUS)

try:
    while True:
        events = selector.select(0.1)
        now = time.time()

        for key, _ in events:
            fd = key.fileobj
            if fd == sys.stdin:
                try:
                    data = os.read(sys.stdin.fileno(), 4096)
                except BlockingIOError:
                    continue
                except OSError:
                    data = b""

                if not data:
                    continue

                try:
                    os.write(master_fd, data)
                except OSError:
                    pass
                last_input_time = now
                maybe_set_state("working", HERDR_WORKING_STATUS)
            elif fd == master_fd:
                try:
                    data = os.read(master_fd, 4096)
                except BlockingIOError:
                    continue
                except OSError:
                    data = b""

                if data:
                    os.write(sys.stdout.fileno(), data)
                    last_output_time = now
                    maybe_set_state("working", HERDR_WORKING_STATUS)
                else:
                    if proc.poll() is not None:
                        break

        if proc.poll() is not None:
            break

        if current_state == "working":
            last_active = max(last_input_time, last_output_time)
            if last_active and now - last_active > HERDR_POLL_IDLE_SECONDS:
                maybe_set_state("idle", HERDR_IDLE_STATUS)
finally:
    # Finalize state transitions and allow child to inherit signals.
    if proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=1)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=1)
        except Exception:
            pass
    release_from_herdr()
    try:
        os.close(master_fd)
    except Exception:
        pass
PY
