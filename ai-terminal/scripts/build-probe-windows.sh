#!/usr/bin/env bash
# Build a REAL-PLATFORM PROBE (anything under tool/) as a Windows exe.
#
# Same firebase problem as the app: firebase_core's Windows plugin fails to build,
# so — exactly like scripts/build-windows.sh — copy the tree to a scratch dir, strip
# firebase there, and build. A probe hosts the REAL widgets and logs what they
# actually do, so it can be driven with REAL OS input (the thing widget tests can't
# do, because synthetic events never traverse the platform input path).
#
# Usage:  scripts/build-probe-windows.sh [target]
#   e.g.  scripts/build-probe-windows.sh                          # compose (#55)
#         scripts/build-probe-windows.sh tool/selection_probe.dart # selection (#83)
#
# The target is a PARAMETER rather than a second copy of this script: the scratch +
# firebase-strip recipe is the thing worth having once, and a copied one drifts.
#
# Output: <scratch>/build/windows/x64/runner/Release/ai_terminal.exe  (the PROBE)
# Requires flutter on PATH (Git Bash:  export PATH="/c/src/flutter/bin:$PATH").
set -euo pipefail

TARGET="${1:-tool/compose_probe.dart}"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # ai-terminal/
# Scratch stripped tree — see scripts/scratch-dirs.js, the one place that decides (#80).
OUT="$(node "$SRC/../scripts/scratch-dirs.js" probe --posix)"

echo "== source: $SRC"
echo "== scratch probe dir: $OUT"
echo "== target: $TARGET"

if [ ! -f "$SRC/$TARGET" ]; then
  echo "!! no such target: $SRC/$TARGET" >&2
  exit 1
fi

rm -rf "$OUT"; mkdir -p "$OUT"
( cd "$SRC" && tar \
    --exclude=./build --exclude=./.dart_tool --exclude=./android/.gradle \
    --exclude='*.log' -cf - . ) | tar -xf - -C "$OUT"

# Strip firebase (plugin has no Windows support). main.dart isn't the probe's
# entrypoint, but the PLUGIN is what breaks the build, so the pubspec edit is the
# one that matters; the main.dart edit keeps the tree self-consistent.
sed -i \
  -e "\#import 'package:firebase_core/firebase_core.dart';#d" \
  -e "\#import 'services/push_service.dart';#d" \
  -e '/Firebase.initializeApp()/d' \
  -e '/PushService.init()/d' \
  "$OUT/lib/main.dart"
sed -i -e '/^  firebase_core:/d' -e '/^  firebase_messaging:/d' "$OUT/pubspec.yaml"

echo "== firebase stripped; building the probe"
cd "$OUT"
flutter pub get
flutter build windows --release --target="$TARGET"

EXE="$OUT/build/windows/x64/runner/Release/ai_terminal.exe"
echo ""
echo "== DONE. Probe exe:"
ls -la "$EXE"
echo "$EXE"
