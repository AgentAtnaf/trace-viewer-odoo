#!/usr/bin/env bash
# trace.sh — run an interactive or piped trace session
#
# Usage:
#   ./trace.sh <task_label> [target_url]           # interactive REPL
#   ./trace.sh <task_label> [target_url] < flow.txt  # pipe commands
#
# Examples:
#   ./trace.sh DEMO http://localhost:8069/web/login
#   ./trace.sh SO-FLOW http://192.168.64.3:8069/web/login < flows/so-invoice-payment.txt
#
# Output: traces/<task_label>.zip
# View:   npx playwright show-trace traces/<task_label>.zip

set -euo pipefail

TASK_LABEL="${1:-}"
TARGET_URL="${2:-http://localhost:8069/web/login}"

if [[ -z "$TASK_LABEL" ]]; then
  echo "ERROR: task label required"
  echo "Usage: $0 <task_label> [target_url]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Support globally-installed playwright or local node_modules
if [[ -d "$SCRIPT_DIR/node_modules" ]]; then
  export PLAYWRIGHT_BROWSERS_PATH="$SCRIPT_DIR/node_modules/.cache/ms-playwright"
else
  export NODE_PATH="$(npm root -g 2>/dev/null || true)"
  export PLAYWRIGHT_BROWSERS_PATH="${HOME}/.cache/ms-playwright"
fi

exec node "$SCRIPT_DIR/pw_trace.js" "$TASK_LABEL" "$TARGET_URL"
