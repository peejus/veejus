#!/bin/bash
# Double-click to start Veejus on macOS (the Mac counterpart of Start-Veejus.bat).
#   ./Start-Veejus.command       build the latest code, then run the app
#   ./Start-Veejus.command dev   run in development mode with hot reload
# If macOS says it can't be opened, right-click it → Open once, or run: chmod +x Start-Veejus.command

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org and try again."
  read -r -p "Press Return to close."
  exit 1
fi

failed() {
  echo
  echo "Veejus could not start. See the messages above."
  read -r -p "Press Return to close."
  exit 1
}

if [ ! -d "node_modules/electron/dist/Electron.app" ]; then
  echo "First run: installing dependencies, this can take a minute..."
  npm install || failed
  [ -d "node_modules/electron/dist/Electron.app" ] || node node_modules/electron/install.js || failed
fi

if [ "$1" = "dev" ]; then
  exec npm run dev
fi

echo "Building Veejus..."
npm run build >/dev/null || failed
open -a "$PWD/node_modules/electron/dist/Electron.app" --args "$PWD"
