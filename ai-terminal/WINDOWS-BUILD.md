# Windows desktop build

The Android build ships FCM push (Firebase). The **desktop build strips Firebase**:
FCM is mobile-only, and the Firebase C++ SDK's bundled flatbuffers fails to link
on Windows MSVC (`LNK2019: unresolved external symbol __std_find_first_of_trivial_pos_1`).
Push is guarded off on desktop anyway (`pushSupported` in `lib/main.dart`), so
Firebase is pure dead weight there.

Rather than fork `pubspec.yaml`, the desktop build is done in a **detached git
worktree** so the main tree keeps Firebase for Android.

## Prerequisites
- Windows Developer Mode ON (Settings → Privacy & security → For developers).
  Flutter plugin symlinks need it. If off:
  `reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f` (elevated)
- Visual Studio 2022 with "Desktop development with C++".

## Build (in a throwaway worktree)
```bash
cd C:/dev/ai-terminal
git worktree add -f C:/dev/ai-terminal-win HEAD
cd C:/dev/ai-terminal-win

# 1. Remove firebase_core + firebase_messaging from pubspec.yaml dependencies.
# 2. In lib/main.dart, drop the firebase_core + services/push_service imports and
#    the `if (pushSupported) { Firebase.initializeApp(); PushService.init(); }`
#    block (pushSupported is always false on desktop, so nothing is lost).
# 3. Copy the gitignored config the app needs:
cp C:/dev/ai-terminal/lib/spike_config.dart lib/spike_config.dart

flutter pub get
flutter build windows --release
# -> build/windows/x64/runner/Release/  (ai_terminal.exe + flutter_windows.dll + data/)
```

## Install (per-user, no admin)
Copy the whole `Release/` folder to `%LOCALAPPDATA%\Programs\AiTerminal\` and make
Desktop + Start-menu shortcuts to `ai_terminal.exe` (see the PowerShell used at
install time). The exe needs the sibling DLLs + `data/` — copy the folder, not
just the exe.

## Notes
- The main tree (Android) is untouched — Firebase stays for FCM.
- Re-run the same steps to rebuild after app changes; the worktree can be kept
  between builds (`git worktree remove C:/dev/ai-terminal-win` to discard).
