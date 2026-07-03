#!/usr/bin/env bash
# trace.sh — run an interactive or piped trace session
#
# Usage:
#   ./trace.sh <name> [target_url]
#   ./trace.sh <task> <name> [target_url]      # task number saved in filename
#
# Examples:
#   ./trace.sh so-flow http://localhost:8069/web/login
#   ./trace.sh T26-12345 so-flow http://localhost:8069/web/login < flows/so-invoice-payment.txt
#
# Output:
#   If run from inside an odoo-* directory tree → <odoo-dir>/Record_task/<task> <name> <date>.zip
#   Otherwise → ./traces/<name>.zip
#
# View:  npx playwright show-trace <path>.zip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect optional task number as first arg (e.g. T26-12345)
TASK=""
if [[ "${1:-}" =~ ^[A-Za-z][A-Za-z0-9]+-[0-9]+$ ]]; then
  TASK="$1"; shift
fi

NAME="${1:-}"
TARGET_URL="${2:-http://localhost:8069/web/login}"

if [[ -z "$NAME" ]]; then
  echo "ERROR: name required"
  echo "Usage: $0 [task] <name> [target_url]"
  exit 1
fi

# Build label: "<task> <name> <date>" or "<name> <date>"
DATE="$(date +%Y-%m-%d)"
if [[ -n "$TASK" ]]; then
  LABEL="${TASK} ${NAME} ${DATE}"
else
  LABEL="${NAME} ${DATE}"
fi

# Walk up from $PWD to find the nearest odoo-* directory
RECORD_DIR=""
DIR="$PWD"
while [[ "$DIR" != "/" ]]; do
  if [[ "$(basename "$DIR")" =~ ^odoo-[0-9] ]]; then
    RECORD_DIR="$DIR/Record_task"
    break
  fi
  DIR="$(dirname "$DIR")"
done

# Fall back to script-local traces/ if not inside an odoo-* tree
if [[ -z "$RECORD_DIR" ]]; then
  RECORD_DIR="$SCRIPT_DIR/traces"
fi
mkdir -p "$RECORD_DIR"
export TRACE_OUT_DIR="$RECORD_DIR"

# Use local node_modules if present (preferred), else fall back to global
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  export NODE_PATH="$(npm root -g 2>/dev/null || true)"
fi
: "${PLAYWRIGHT_BROWSERS_PATH:=${HOME}/.cache/ms-playwright}"
export PLAYWRIGHT_BROWSERS_PATH

exec node "$SCRIPT_DIR/pw_trace.js" "$LABEL" "$TARGET_URL"
