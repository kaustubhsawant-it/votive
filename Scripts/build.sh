#!/usr/bin/env bash
# Fast debug build (regenerate project + compile). Pass extra xcodebuild args through.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v xcodegen >/dev/null || { echo "xcodegen not found — brew install xcodegen"; exit 1; }

xcodegen generate
xcodebuild \
  -project Votive.xcodeproj \
  -scheme Votive \
  -configuration Debug \
  ONLY_ACTIVE_ARCH=YES \
  build "$@"

DD=$(xcodebuild -project Votive.xcodeproj -scheme Votive -configuration Debug \
      -showBuildSettings 2>/dev/null | awk -F' = ' '/ BUILT_PRODUCTS_DIR /{print $2; exit}')
echo "Built: $DD/Votive.app"
