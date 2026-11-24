#!/bin/zsh
# Double-click to start ICC Plus on this Mac and open it in your browser.
# This local copy can use Claude Code (your Claude account) in the Claude sidebar.
# Keep this window open while you work; close it (or press Ctrl+C) to stop ICC Plus.

SCRIPT_DIR="${0:A:h}"            # folder of this script, following any alias/symlink
APP_DIR="$SCRIPT_DIR/ICCPlus"
PORT=5180
URL="http://localhost:$PORT/"

# Finder starts .command files without your usual shell setup, so add the common tool locations.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[[ -s "$HOME/.nvm/nvm.sh" ]] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
[[ -d "$HOME/.volta/bin" ]] && export PATH="$HOME/.volta/bin:$PATH"

pause_and_exit() {
  echo
  read -r "?Press Return to close this window."
  exit "${1:-1}"
}

echo "ICC Plus"
echo "========"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from https://nodejs.org (LTS), then double-click this again."
  pause_and_exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "Can't find the ICCPlus folder next to this script ($APP_DIR)."
  pause_and_exit 1
fi
cd "$APP_DIR" || pause_and_exit 1

# Already running? Just open it.
if curl -fsS --max-time 2 "$URL" 2>/dev/null | grep -q "ICC Plus"; then
  echo "ICC Plus is already running. Opening $URL"
  open "$URL"
  exit 0
fi

# Install or update packages when needed (first run, or after package.json/lockfile changes).
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json || package.json -nt node_modules/.package-lock.json ]]; then
  echo "Installing packages (first run can take a minute)..."
  if ! npm install --no-audit --no-fund; then
    echo "npm install failed. See the messages above."
    pause_and_exit 1
  fi
  # npm may skip install scripts; apply the project's package patches explicitly.
  npx --no-install patch-package || { echo "Applying package patches failed."; pause_and_exit 1; }
fi

if command -v claude >/dev/null 2>&1; then
  echo "Claude Code found: the Claude sidebar can use your Claude account."
else
  echo "Claude Code not found: the Claude sidebar will need an API key (or install Claude Code)."
fi

echo "Starting ICC Plus at $URL ..."
echo "Keep this window open while you work. Close it or press Ctrl+C to stop."
echo

# Open the browser once the server answers.
(
  for _ in {1..120}; do
    if curl -fsS --max-time 1 "$URL" >/dev/null 2>&1; then open "$URL"; exit 0; fi
    sleep 0.5
  done
) &

npx --no-install vite --port "$PORT" --strictPort --clearScreen false --logLevel error
status=$?
if [[ $status -ne 0 && $status -ne 130 ]]; then
  echo
  echo "ICC Plus stopped with an error (code $status). If port $PORT is busy, close the other program using it."
  pause_and_exit $status
fi
