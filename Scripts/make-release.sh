#!/usr/bin/env bash
# Builds the downloadable release: dist/Votive-<version>-mac.zip (the app, the scripts and an installer
# that needs only Node.js) and dist/SHA256SUMS.txt. Run it from a checkout. It builds a universal
# (Apple Silicon and Intel) Release app, ad-hoc signed like every build here. It is NOT notarized: there is
# no Apple Developer ID, so the installer, not a double-click, is the supported way to open it.
#
#   ./Scripts/make-release.sh
#   VOTIVE_APP=/path/to/Votive.app ./Scripts/make-release.sh   # package an app that is already built (tests)
#   VOTIVE_RELEASE_OUT=/some/folder ./Scripts/make-release.sh  # write somewhere other than ./dist
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION=$(sed -n 's/.*MARKETING_VERSION: "\(.*\)"/\1/p' project.yml)
[ -n "$VERSION" ] || { echo "Could not read the version from project.yml"; exit 1; }
OUT="${VOTIVE_RELEASE_OUT:-$ROOT/dist}"
NAME="Votive-$VERSION"
WORK="$(mktemp -d)"
STAGE="$WORK/$NAME"

if [ -n "${VOTIVE_APP:-}" ]; then
  APP="$VOTIVE_APP"
else
  for tool in xcodegen xcodebuild; do
    command -v "$tool" >/dev/null || { echo "Missing '$tool' (see Requirements in README.md)"; exit 1; }
  done
  echo "==> Building Release (universal)…"
  xcodegen generate >/dev/null
  # A fresh folder each time, so no earlier build can leak into the release.
  xcodebuild -project Votive.xcodeproj -scheme Votive -configuration Release \
    -derivedDataPath "$WORK/build" ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO build >/dev/null
  APP="$WORK/build/Build/Products/Release/Votive.app"
fi
[ -d "$APP" ] || { echo "App not found: $APP"; exit 1; }
echo "==> App architectures: $(lipo -archs "$APP/Contents/MacOS/Votive" 2>/dev/null || echo unknown)"
codesign --verify --deep "$APP" || { echo "The app's signature does not verify"; exit 1; }

echo "==> Staging ${NAME}…"
mkdir -p "$STAGE/mcp-server" "$STAGE/docs"
cp -R "$APP" "$STAGE/Votive.app"
cp -R Scripts "$STAGE/Scripts"
cp mcp-server/index.js mcp-server/package.json mcp-server/package-lock.json "$STAGE/mcp-server/"
cp README.md LICENSE PRIVACY.md SECURITY.md CHANGELOG.md "$STAGE/"
[ -f docs/Votive-Quick-Guide.pdf ] && cp docs/Votive-Quick-Guide.pdf "$STAGE/docs/"
[ -f docs/INSTALLATION.md ] && cp docs/INSTALLATION.md "$STAGE/docs/"
cat > "$STAGE/INSTALL.txt" <<EOF
Votive $VERSION for Mac

1. You need macOS 14 or newer and Node.js (brew install node, or nodejs.org).
2. Open Terminal, go into this folder, and run:

     ./Scripts/install.sh

3. Look at the right side of your menu bar.

Do not double-click Votive.app. It is not notarized by Apple, so macOS will refuse it.
The installer opens it the right way. The picture guide is in docs/Votive-Quick-Guide.pdf
EOF
chmod +x "$STAGE"/Scripts/*.sh

mkdir -p "$OUT"
ZIP="$OUT/$NAME-mac.zip"
# Written next to the final name and moved into place, so a half-written file is never left behind.
( cd "$WORK" && ditto -c -k --keepParent "$NAME" "$WORK/$NAME-mac.zip" )
mv -f "$WORK/$NAME-mac.zip" "$ZIP"
( cd "$OUT" && shasum -a 256 "$NAME-mac.zip" > SHA256SUMS.txt )
echo "==> Wrote $ZIP ($(du -h "$ZIP" | cut -f1))"
cat "$OUT/SHA256SUMS.txt"
