#!/usr/bin/env bash
# Runs the Node test suite on Linux in a throwaway Docker container, so a change can be checked without a Linux
# machine. Needs Docker running. Nothing from your home folder goes in: the container gets a copy of this folder
# (without build output, the generated Xcode project or node_modules) and its own empty HOME.
#
#   ./Scripts/test-linux.sh                 # node:22-slim (Debian), the default
#   ./Scripts/test-linux.sh node:22         # another image
#
# The tests that need a Swift compiler, the MCP server's npm packages or Windows are skipped there, and say so.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${1:-node:22-slim}"
command -v docker >/dev/null || { echo "Docker not found. Start Docker Desktop first."; exit 1; }
docker info >/dev/null 2>&1 || { echo "The Docker engine is not running. Start Docker Desktop first."; exit 1; }
docker run --rm --memory 1g --cpus 2 -v "$ROOT":/src:ro -e HOME=/tmp/home "$IMAGE" sh -c '
  set -e
  mkdir -p /tmp/home /work
  tar -C /src --exclude=./dist --exclude=./Votive.xcodeproj --exclude=node_modules -cf - . | tar -C /work -xf -
  cd /work
  echo "node $(node -v) on $(uname -sm), $(. /etc/os-release; echo $PRETTY_NAME)"
  node --test tests/*.test.js 2>&1 | grep -E "^# (tests|pass|fail|skipped)|^not ok"
'
