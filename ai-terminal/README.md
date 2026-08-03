# AiTerminal — the Web Terminal companion app

A native [Flutter](https://flutter.dev) client for [Web Terminal](../README.md), built for **Android and Windows**. It talks to the same REST/WebSocket API the browser app uses, so it is a second *client*, never a second server — anything the server derives (status, usage metrics, transcripts, recaps, the agent catalogue) reaches the app from the same endpoints, and adding an agent or a field needs no app release.

The browser app needs nothing installed and remains the primary client. Install this one for what a browser tab structurally cannot do.

## What it adds over the browser

- **Chat lens** — the reason the app exists. It renders the agent's transcript as a conversation instead of a screen scrape: prose separated from tool calls, rich cards for shell commands / file edits / web searches, a live drill-in to running subagents, the agent's task list pinned above the thread, and a banner naming what a blocked session is waiting for. Runs of purely mechanical tool turns fold into one marker so prompts and replies stay readable. Both server-side transcript parsers emit one typed turn shape, so Claude and Codex render identically with no per-agent code here.
- **Push while the app is closed** — a browser can only notify while a tab is alive. The app registers an FCM device token with the server and receives **data-only, content-free** wake-ups; the message text is fetched from your server over your own private network afterwards. Google sees a device token and a timestamp, never the conversation. Android only — push is guarded off on the Windows build (`pushSupported` in `lib/main.dart`).
- **Terminal lens** — the live PTY, on every platform, drivable (not read-only) including on a phone.
- **Read-aloud** through Android's own offline `TextToSpeech`, via a hand-rolled `wt/speech` MethodChannel in `MainActivity.kt`. Deliberately not the `flutter_tts` package: its Windows build needs `nuget.exe`, and this project still ships a Windows desktop build.

## Layout

| Path | Contents |
|---|---|
| `lib/api/` | REST + WebSocket client and the typed models the server publishes |
| `lib/screens/` | Dashboard, session, settings |
| `lib/widgets/` | Chat lens, compose bar, session cards, meta bar, overlays |
| `lib/services/` | Server store, favourites, notifications, speech |
| `test/` | Dart tests — run with `flutter test` (separate from the repo's Playwright suite) |
| `tool/` | Probe harnesses driven by real OS input events (see below) |
| `third_party/xterm/` | Vendored, patched xterm — read the warning below before touching |

## Building

Full instructions, prerequisites, and install steps: **[WINDOWS-BUILD.md](WINDOWS-BUILD.md)**.

Two **gitignored** local files must exist in your working tree before a build — recreate them after a fresh clone:

- `lib/spike_config.dart` — seed server list, imported by `server_store.dart`. **Copy the committed template:** `cp lib/spike_config.example.dart lib/spike_config.dart`. Empty values are supported — the app just starts with no servers and you add them in the UI. The real file is gitignored because it holds bearer tokens
- `android/app/google-services.json` — FCM config, **Android build only**

```bash
# Android
flutter build apk --release --build-name=<X.Y.Z> --build-number=<N>

# Windows — builds from a scratch copy with the Firebase bits stripped
# (firebase_core has no working Windows build); the canonical tree is untouched
bash scripts/build-windows.sh <X.Y.Z> <N>
```

Windows additionally needs **Developer Mode ON** (Flutter's plugin symlinks require it) and Visual Studio 2022 with "Desktop development with C++".

**Keep the Android and Windows builds version-matched** and deploy both after any change. The version lives in [`pubspec.yaml`](pubspec.yaml).

## The vendored xterm patch — do not undo it

`third_party/xterm/` is stock `xterm` 4.0.0 **plus one fix**, wired in through `dependency_overrides`. Upstream's `Buffer.scrollUp` / `scrollDown` / `deleteLines` shifted a line by copying the *reference*, leaving the same line in two slots; the next iteration then detached the line the previous one had just moved. Detached lines still paint, so the visible symptom was subtle — text you could see but not select — while a later move on such a line threw out of `Terminal.write` in **release** builds (the debug `assert` is compiled out) and blanked the terminal.

Every changed hunk is marked `WEB-TERMINAL PATCH (#81)`. **Grep for that marker before re-vendoring or "upgrading"**: 4.0.0 is the latest release, so a bare re-vendor silently restores the bug. Verification recipe — run upstream's own suite against pristine and patched copies and compare — is in [`third_party/xterm/README-PATCH.md`](third_party/xterm/README-PATCH.md).

## Testing

```bash
flutter test
```

Widget tests cannot prove input behaviour: synthetic key and pointer events never traverse the OS text-input path, so a widget test passes while the shipped app is broken. Anything touching keyboard submit or mouse selection must be verified with real injected OS events — see the probe harnesses in `tool/` and their PowerShell drivers under `../scripts/rig/`.

## Contributing

The same gates apply as for the server — see [CONTRIBUTING.md](../CONTRIBUTING.md).
