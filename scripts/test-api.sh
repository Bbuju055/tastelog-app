#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/api"
VENV_DIR="$API_DIR/.venv"

cd "$ROOT_DIR"

# Create venv if missing or broken
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "Creating venv at $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi

# Activate venv
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Ensure venv has the tooling needed to run make sync-dev deterministically
python -m pip install --upgrade pip >/dev/null
python -m pip install --upgrade pip-tools >/dev/null

# Install dev deps from requirements-dev.txt (compiled via pip-tools)
make sync-dev

# Run API tests via venv python (never rely on global pytest).
# Both real test roots are the canonical gate (Issue 3, ruling 13).
python -m pytest "$ROOT_DIR/tests" "$ROOT_DIR/api/tests" -q "$@"
