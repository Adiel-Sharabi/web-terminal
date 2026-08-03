# Companion App — AiTerminal

The optional native client. Build instructions live in [`ai-terminal/WINDOWS-BUILD.md`](../ai-terminal/WINDOWS-BUILD.md);
the client's own overview is [`ai-terminal/README.md`](../ai-terminal/README.md).


The browser app is the primary client and needs nothing installed. **AiTerminal** ([`ai-terminal/`](../ai-terminal/)) is an optional native [Flutter](https://flutter.dev) client for **Android and Windows** that speaks the same REST/WebSocket API — so it is a second client, never a second server. Anything the server derives (status, metrics, transcripts, recaps) reaches both clients from the same endpoint; adding an agent or a field needs no app release.

**What it adds over the browser:**

| | Browser (`app.html`) | AiTerminal (Android + Windows) |
|---|:---:|:---:|
| Terminal lens | ✅ | ✅ |
| **Chat lens** — transcript as conversation, tool cards, subagent drill-in, task list, waiting banner | — | ✅ |
| Multi-server sidebar, favourites, session recap | ✅ | ✅ |
| Push when the app is **closed** | — | ✅ (FCM, Android) |
| Read-aloud | ✅ (browser speech) | ✅ (Android TTS) |
| Interactive-question overlay | ✅ | ✅ |
| Install required | no | yes |

- **Chat lens** — the reason the app exists. It renders the agent's transcript as a conversation rather than a screen scrape: prose separated from tool calls, rich cards for shells / file edits / web searches, a live drill-in to running subagents, the agent's task list pinned above the thread, and a banner naming what a blocked session is waiting for. Runs of purely mechanical tool turns fold into one marker so the prompts and replies stay readable. Because both transcript parsers emit one typed turn shape, Claude and Codex render identically with no per-agent code in the app.
- **Push that survives the app being closed** — the browser can only notify while a tab is alive. The app registers an FCM device token with the server (`push-devices.json`, gitignored) and receives **data-only, content-free** wake-ups; the message text is then fetched from your server over your private network. Google sees a device token and a timestamp, never the conversation. Android only — push is guarded off on the Windows build.
- **Both lenses drive the session.** The compose bar is shared, and the Enter contract is chosen by **platform, not by lens**: hardware keyboard → Enter submits, Ctrl+Enter newlines; soft keyboard → Enter newlines, **Send** submits (Android's IME commits Enter as literal text, so binding submit to it is unreliable by construction).
- **Version parity is a rule, not a preference** — the Android and Windows builds ship together at the same version. Current app version is in [`ai-terminal/pubspec.yaml`](../ai-terminal/pubspec.yaml).

## Building it

Full instructions, including the two gitignored local files a fresh clone must recreate, are in **[`ai-terminal/WINDOWS-BUILD.md`](../ai-terminal/WINDOWS-BUILD.md)**. In short:

```bash
# Android (Firebase/FCM is Android-only)
flutter build apk --release --build-name=<X.Y.Z> --build-number=<N>

# Windows — a helper script builds from a scratch copy with the
# Firebase bits stripped (firebase_core has no working Windows build),
# leaving the canonical tree untouched
bash ai-terminal/scripts/build-windows.sh <X.Y.Z> <N>
```

Windows builds additionally need **Developer Mode ON** (Flutter's plugin symlinks require it) and Visual Studio 2022 with "Desktop development with C++". The Dart tests run via `flutter test`, separately from the Playwright suite.

> **The companion vendors a patched `xterm`** under `ai-terminal/third_party/xterm` via `dependency_overrides` — stock 4.0.0 plus one fix for a buffer-aliasing bug that detached lines on scroll (which broke selection and could blank the terminal in release builds). Every hunk is marked `WEB-TERMINAL PATCH (#81)`; see [`ai-terminal/third_party/xterm/README-PATCH.md`](../ai-terminal/third_party/xterm/README-PATCH.md) before re-vendoring or upgrading — 4.0.0 is the latest release, so a bare re-vendor silently restores the bug.
