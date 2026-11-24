#!/bin/bash
# Installs the newest published MR Studio release on this Mac, in one command (#258).
#
#   bash scripts/install-latest-mac.sh            # the latest release
#   bash scripts/install-latest-mac.sh v0.15.0    # a given release
#
# It downloads the macOS dmg from GitHub, quits a running MR Studio, replaces
# "/Applications/MR Studio.app" and clears the download quarantine, so the app opens
# without the right click, Open step. Tables in ~/Documents/MR Studio are not touched.
# Written for the bash 3.2 that ships with macOS.

set -euo pipefail

REPO="snjsomnath/mr-studio"
APP="/Applications/MR Studio.app"
TAG="${1:-}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS. On Windows, run the setup .exe from the release page." >&2
  exit 1
fi

if [ -n "$TAG" ]; then
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
  API="https://api.github.com/repos/$REPO/releases/latest"
fi

echo "Asking GitHub for the release…"
JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" || {
  echo "Could not reach GitHub ($API)." >&2
  exit 1
}

VERSION="$(printf '%s' "$JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
URL="$(printf '%s' "$JSON" | grep '"browser_download_url"' | grep -E '\.dmg"' | head -n1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')"
if [ -z "$URL" ]; then
  echo "Release $VERSION has no macOS dmg yet. Its build may still be running; try again in a few minutes." >&2
  exit 1
fi

INSTALLED=""
if [ -f "$APP/Contents/Info.plist" ]; then
  INSTALLED="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || true)"
fi
if [ -n "$INSTALLED" ] && [ "v$INSTALLED" = "$VERSION" ]; then
  echo "MR Studio $VERSION is already installed."
  exit 0
fi

WORK="$(mktemp -d -t mrstudio-install)"
MOUNT="$WORK/mount"
cleanup() {
  if [ -d "$MOUNT" ]; then hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Downloading $VERSION…"
curl -fL --progress-bar -o "$WORK/MR-Studio.dmg" "$URL"

mkdir -p "$MOUNT"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$WORK/MR-Studio.dmg"
SOURCE="$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -n1)"
if [ -z "$SOURCE" ]; then
  echo "The dmg holds no app." >&2
  exit 1
fi

if pgrep -x "mr-studio" >/dev/null 2>&1 || pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  echo "Quitting MR Studio…"
  osascript -e 'tell application "MR Studio" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1 || break
    sleep 1
  done
  pkill -f "$APP/Contents/MacOS" >/dev/null 2>&1 || true
fi

echo "Installing to $APP…"
rm -rf "$APP"
ditto "$SOURCE" "$APP"
xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true

if [ -n "$INSTALLED" ]; then
  echo "MR Studio $VERSION is installed (was v$INSTALLED)."
else
  echo "MR Studio $VERSION is installed."
fi
