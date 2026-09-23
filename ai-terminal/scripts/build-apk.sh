#!/usr/bin/env bash
# Build the Android AiTerminal release APK from the in-repo source.
#
# Android builds straight from the canonical tree (Firebase/FCM is Android-only). This
# script exists so the APK goes through the SAME release preflight as Windows (#278):
# the version comes from pubspec.yaml only, and a checkout behind origin/master is
# refused. A bare `flutter build apk --build-name=...` is how a 1.66.9 tree shipped
# labelled 1.66.12.
#
# Usage:  scripts/build-apk.sh [--allow-stale]
# Output: build/app/outputs/flutter-apk/app-release.apk
# Requires flutter on PATH (Git Bash:  export PATH="/c/src/flutter/bin:$PATH").
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # ai-terminal/
source "$SRC/scripts/release-preflight.sh" "$@"   # sets RELEASE_VERSION, or exits
cd "$SRC"
flutter build apk --release   # version from pubspec.yaml, never overridden (#278)
echo ""
echo "== DONE. $RELEASE_VERSION -> $SRC/build/app/outputs/flutter-apk/app-release.apk"
