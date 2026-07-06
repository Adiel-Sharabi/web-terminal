# Building AiTerminal (Android + Windows)

AiTerminal lives in `web-terminal/ai-terminal/` and builds from here — no
separate repo/worktree. Keep the Windows and Android builds **version-matched**
and deploy **both** after any change.

## Local files the build needs (gitignored — never committed)
These are not in git; they must exist in your working tree to build:
- `lib/spike_config.dart` — seed server list (imported by `server_store.dart`).
- `android/app/google-services.json` — FCM config for the **Android** build only.

If you clone fresh, recreate these two before building.

## Android (FCM / Firebase)
Builds straight from this directory — Firebase is Android-only:
```bash
export PATH="/c/src/flutter/bin:$PATH"
flutter build apk --release --build-name=<X.Y.Z> --build-number=<N>
# -> build/app/outputs/flutter-apk/app-release.apk
adb -s <device> install -r build/app/outputs/flutter-apk/app-release.apk
```

## Windows (Firebase stripped)
`firebase_core`'s Windows plugin tries to download+extract the Firebase C++ SDK
and fails (`Unable to generate build files` / `firebase_cpp_sdk_windows_*.zip`),
and `firebase_messaging` has no Windows support. Push is guarded off on desktop
anyway (`pushSupported` in `lib/main.dart`), so Firebase is dead weight there.

`scripts/build-windows.sh` copies the tree to a scratch dir
(`C:\dev\ai-terminal-winbuild`), strips the (fully isolated) Firebase bits, and
builds — the canonical tree is never modified:
```bash
export PATH="/c/src/flutter/bin:$PATH"
bash scripts/build-windows.sh <X.Y.Z> <N>
# -> C:/dev/ai-terminal-winbuild/build/windows/x64/runner/Release/
```
The strip is line-based (two imports + two call-lines in `main.dart`, two
`pubspec.yaml` deps); it leaves a harmless empty `if (pushSupported) {}`.

### Prerequisites
- Windows Developer Mode ON (Flutter plugin symlinks need it):
  `reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f` (elevated).
- Visual Studio 2022 with "Desktop development with C++".

### Install (per-user, no admin)
Copy the whole `Release/` folder (exe + sibling DLLs + `data/`) to
`%LOCALAPPDATA%\Programs\AiTerminal\`, then relaunch `ai_terminal.exe`. The Dart
AOT lives in `data/app.so` — check its timestamp to confirm a fresh build.
