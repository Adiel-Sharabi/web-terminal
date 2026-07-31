#!/usr/bin/env bash
# Build the Windows AiTerminal release from the in-repo source.
#
# Why a script (and not just `flutter build windows`): firebase_core's Windows
# plugin tries to download+extract the firebase C++ SDK and fails ("Unable to
# generate build files"), and firebase_messaging has no Windows support at all.
# So Windows must build WITHOUT firebase. This copies the tree to a scratch dir,
# strips the (fully isolated) firebase bits, and builds there — leaving the
# canonical tree untouched. Android builds directly from the canonical tree.
#
# Usage:  scripts/build-windows.sh <version-name> <version-code>
#   e.g.  scripts/build-windows.sh 1.0.9 10
#
# Output: <scratch>/build/windows/x64/runner/Release/  (path printed at the end)
# Requires flutter on PATH (Git Bash:  export PATH="/c/src/flutter/bin:$PATH").
set -euo pipefail

NAME="${1:?usage: build-windows.sh <version-name> <version-code>}"
CODE="${2:?usage: build-windows.sh <version-name> <version-code>}"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # ai-terminal/
# Scratch stripped tree. Asked for rather than hard-coded, so this and the rig and the
# probe all move together when the location changes (#80): scripts/scratch-dirs.js.
OUT="$(node "$SRC/../scripts/scratch-dirs.js" winbuild --posix)"

echo "== source: $SRC"
echo "== scratch build dir: $OUT"

# Fresh copy of the working tree (incl. local gitignored spike_config.dart), minus
# build artifacts. Fresh each run = reproducible; ~2 min full build.
rm -rf "$OUT"; mkdir -p "$OUT"
( cd "$SRC" && tar \
    --exclude=./build --exclude=./.dart_tool --exclude=./android/.gradle \
    --exclude=./scripts --exclude='*.log' -cf - . ) | tar -xf - -C "$OUT"

# Strip firebase (fully isolated to these lines — see the firebase refs in
# main.dart + push_service.dart, which becomes unreferenced and so uncompiled).
# Removing the two call-lines leaves a harmless empty `if (pushSupported) {}`.
sed -i \
  -e "\#import 'package:firebase_core/firebase_core.dart';#d" \
  -e "\#import 'services/push_service.dart';#d" \
  -e '/Firebase.initializeApp()/d' \
  -e '/PushService.init()/d' \
  "$OUT/lib/main.dart"
sed -i -e '/^  firebase_core:/d' -e '/^  firebase_messaging:/d' "$OUT/pubspec.yaml"

echo "== firebase stripped; building Windows $NAME+$CODE"
cd "$OUT"
flutter pub get
flutter build windows --release --build-name="$NAME" --build-number="$CODE"

echo ""
echo "== DONE. Release output:"
echo "   $OUT/build/windows/x64/runner/Release/"
ls -la "$OUT/build/windows/x64/runner/Release/ai_terminal.exe"
