#!/usr/bin/env bash
# Backward-compatible entry point. The canonical diagnostic lives in
# diagnose-websocket.sh so there is one source of truth for Socket.IO checks.

set -euo pipefail
exec "$(dirname "$0")/diagnose-websocket.sh" "$@"
