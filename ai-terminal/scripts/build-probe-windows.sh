#!/usr/bin/env bash
# Build the COMPOSE PROBE (tool/compose_probe.dart) as a Windows exe.
#
# Same firebase problem as the app: firebase_core's Windows plugin fails to build,
# so — exactly like scripts/build-windows.sh — copy the tree to a scratch dir, strip
# firebase there, and build. The probe hosts the REAL ComposeBar and logs what it
# would actually send, so it can be driven with REAL OS keystrokes (the thing widget
# tests can't do).
#
# Usage:  scripts/build-probe-windows.sh
# Output: <scratch>/build/windows/x64/runner/Release/ai_terminal.exe  (the PROBE)
# Requires flutter on PATH (Git Bash:  export PATH="/c/src/flutter/bin:$PATH").
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # ai-terminal/
OUT="/c/dev/ai-terminal-probe"                            # scratch stripped tree

echo "== source: $SRC"
echo "== scratch probe dir: $OUT"

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
flutter build windows --release --target=tool/compose_probe.dart

EXE="$OUT/build/windows/x64/runner/Release/ai_terminal.exe"
echo ""
echo "== DONE. Probe exe:"
ls -la "$EXE"
echo "$EXE"
