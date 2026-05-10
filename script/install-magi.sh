#!/usr/bin/env sh
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v bun >/dev/null 2>&1; then
  exec bun "$DIR/install-magi.ts" "$@"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes bun "$DIR/install-magi.ts" "$@"
fi

echo "Bun is required to install Magi. Install Bun or make npx available." >&2
exit 127
