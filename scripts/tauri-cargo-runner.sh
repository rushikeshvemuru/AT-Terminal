#!/usr/bin/env bash
set -euo pipefail

exec env -i \
  HOME="${HOME:-}" \
  USER="${USER:-}" \
  LOGNAME="${LOGNAME:-}" \
  PATH="${PATH:-/usr/bin:/bin}" \
  SHELL="${SHELL:-/bin/sh}" \
  DISPLAY="${DISPLAY:-}" \
  WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
  XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-}" \
  cargo "$@"
