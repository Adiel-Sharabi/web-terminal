# Voice Integration — Design & Architecture

> **Status: RESEARCH / DESIGN ONLY. Nothing here is implemented.**
> This document is the plan. It deliberately stops short of code.
> Tracking issue: **#70** — https://github.com/Adiel-Sharabi/web-terminal/issues/70

---

## 1. What this is

Two capabilities, one feature:

1. **Dictate** — speak a prompt, it lands in the compose bar and submits to the agent.
2. **Hear** — the agent's output is read aloud, **filtered**: tool calls, tool output, and
   plumbing are *not* spoken. Only what the user actually needs to know, when they need it.

The second half is the hard half, and it is not a speech problem — it is a **knowledge**
problem. "Read the terminal aloud" is useless: a Claude session emits ANSI redraws, spinner
frames, 4 KB tool results, and diff blobs. A voice feature that speaks that is unusable. The
value is entirely in *deciding what is worth speaking*.

**Non-goal:** narrating the raw PTY stream. **Non-goal:** a voice assistant that answers
questions about the app. **Non-goal:** replacing the UI — voice augments the existing lenses.

---

## 2. The key finding: the knowledge layer already exists

The single most important research result. **We do not need to build a parser to "filter out
the tools" — `lib/transcript.js` already does exactly that**, and it is already the SSOT that
both clients render from.

`parseTranscriptTurn` (`lib/transcript.js`, ~line 231) is role-gated and yields a typed turn
that already separates the three streams a voice filter cares about:

| Stream | How it's produced | Voice treatment |
|---|---|---|
| **Assistant prose** | `_assistantText` — only blocks where `type === 'text'` | **This is what gets spoken.** |
| **Tool calls** | `extractToolUses` — `tool_use` blocks as compact chips (`TOOL_INPUT_CAP` 2000) | Not spoken. Optionally *summarized* ("ran 3 commands"). |
| **Tool results** | `extractToolResults` — pairs `tool_result` → `tool_use` by id (`TOOL_RESULT_CAP` 4000) | Not spoken. It is explicitly documented in-file as *"plumbing (not conversation)"*. |

Two more properties that matter for TTS specifically:

- **`stripAnsi` (~line 76)** already removes CSI/control sequences. Critical: without it TTS
  reads escape codes aloud. This is already solved.
- A user line carrying **only** `tool_result` blocks yields `''` and is skipped by the caller —
  so the "conversation" view is already free of plumbing turns.

**Architectural consequence:** the voice feature consumes the *existing typed turn*, not the PTY
and not a new parser. Speaking `turn.text` and ignoring `turn.toolUses` is ~80% of "filter out
the tools" for free, and it inherits multi-agent support (Claude + Codex) via the same
`lib/agents.js` registry with **no per-agent branching**.

### Corollary: do not tap the PTY

There are two candidate sources for "what the agent said":

| Source | Verdict |
|---|---|
| Live PTY stream (`app.ws('/ws/:id')` `server.js:3838`, worker `broadcastEvent` `pty-worker.js:642`) | ❌ Raw bytes, ANSI redraws, spinner frames, no turn boundaries. Speaking this is the naive design that fails. |
| Typed transcript (`GET /api/sessions/:id/transcript` `server.js:3189`) | ✅ Already parsed, already ANSI-stripped, already tool-separated, already paginated, already multi-agent. |

**Use the transcript.** The PTY is only relevant for *liveness* (knowing a turn ended), and the
existing hook/status signals already provide that far more cheaply (§4).

---

## 3. Architecture — four layers

```
┌─ CLIENT (phone / desktop) ────────────────────────────────┐
│  [1] CAPTURE   mic → audio                                │
│  [4] PLAYBACK  audio → speaker, with barge-in/stop         │
└───────────────┬──────────────────────────────┬────────────┘
                │ audio or text                │ speech text
                ▼                              ▲
┌─ SERVER (web-terminal, the one integration point) ────────┐
│  [2] SPEECH    STT: audio→text   TTS: text→audio          │
│  [3] KNOWLEDGE the Speech Policy Engine — WHAT to speak    │
│         ├── reads the typed transcript (SSOT, §2)         │
│         ├── reads the importance signals (§4)             │
│         └── optional small-LLM summarizer                 │
└───────────────────────────────────────────────────────────┘
                │ dictated text
                ▼
      existing compose submit path (buildComposeSubmission →
      worker submitLine → CR-split contract, #55) — UNCHANGED
```

**Why the split is client-capture / server-brain:**

- Mic and speaker physically exist on the **client**; audio capture and playback must be there.
- The **server** is the only component that holds session state, the transcript, the hook
  signals, and the agent registry. The filtering decision needs all of that, so layer 3 belongs
  server-side. Putting it client-side would fork the logic across web + companion — the exact
  SSOT violation this codebase has repeatedly paid for.
- Layer 2 (the actual STT/TTS model calls) is the genuinely open placement question — see §7.

**The dictation path must not fork the submit contract.** A dictated prompt is just text; it
enters through the *existing* `buildComposeSubmission` (`app.html` ~1615) / `compose_bar.dart`
path and the worker's `submitLine`. Issue #55's CR-split rules apply unchanged. Voice must never
write to the PTY directly.

---

## 4. The Speech Policy Engine — "only what I need to know, when I need it"

This is the feature. Everything else is plumbing. The engine answers one question per event:
**should the user hear something right now, and if so, what sentence?**

### 4.1 Signals already available (no new instrumentation)

The app is already rich in "this moment matters" signals. They are the engine's inputs:

| Signal | Source | Speak-worthiness |
|---|---|---|
| Session status `waiting` | worker status, hook `PermissionRequest` | **Highest** — agent is blocked on the user. "Claude needs permission to run a command." |
| AskUserQuestion posed | question-overlay detection (#19/#64) | **Highest** — read the question + options aloud. |
| `apiError` | `broadcastEvent('apiError', …)` `pty-worker.js:671` | **High** — "Session stalled on an API error." |
| Status → `idle` (turn ended) | hook `Stop`, subagent-gated per #61 | **High** — the natural moment to speak the answer. |
| `autoResume` armed/fired | `broadcastEvent('autoResume', …)` `pty-worker.js:807` (#69) | Medium — "Resuming after the 5-hour limit reset." |
| Assistant prose turn | transcript `turn.text` | Medium — the actual content, spoken on turn end. |
| Tool call / tool result | `turn.toolUses` | **Never spoken verbatim.** Optionally counted. |
| Compaction in progress | #65 signal | Low — a short status blip at most. |

**Reuse `notifyLevel` — do not invent a parallel setting.** The app already has a per-session
notification level (`off` / `important` / `all`) with server-side storage. Voice verbosity should
be the *same* concept, not a second one the user has to keep in sync. At minimum, a session that
is `off` for notifications should never speak unprompted.

### 4.2 Two modes (they have different rules)

| Mode | Trigger | What is spoken |
|---|---|---|
| **Ambient** (push) | Session events, while the user isn't looking | Terse, event-driven: blocks, questions, errors, "done". This is where "when I need it" lives — it must be *rare*. |
| **On-demand** (pull) | User asks: "read me the last answer", or presses a button | Fuller: the last assistant turn, or a summary of the last N turns. |

Ambient is the one that will annoy the user if it is wrong. Default it conservative
(`waiting` / question / error / done only) and let the user opt into more.

### 4.3 Where the LLM comes in — and where it doesn't

A small LLM is **not** needed to classify events (the signals above are deterministic facts —
use them directly; an LLM here would be slower, costlier, and less reliable). It **is** useful
for exactly one job: **condensing a long assistant turn into a sentence or two worth hearing.**

Reading a 600-word answer aloud is as bad as reading tool output. The summarizer turns
`turn.text` into a spoken-length utterance.

- **Cloud option:** Claude **Haiku 4.5** (`claude-haiku-4-5`, $1/$5 per 1M tokens) — the right
  tier for a cheap, fast summarize/condense step. Cost is negligible at this volume.
- **Local option:** a small local model, for the privacy posture (§7).
- **Zero-LLM fallback:** speak the first N sentences of `turn.text`. Crude but free, offline,
  and a sane v1 — **ship this first** and only add the summarizer if the raw first-sentences
  approach proves insufficient.

---

## 5. Integration points (file:line)

Everything the feature touches, so a runner doesn't have to rediscover it:

**Knowledge (read):**
- `lib/transcript.js` — `parseTranscriptTurn` (~231), `_assistantText` (~46), `extractToolUses`
  (~137), `extractToolResults` (~201), `stripAnsi` (~76), caps `TOOL_INPUT_CAP`/`TOOL_RESULT_CAP` (68-69)
- `server.js:3189` `GET /api/sessions/:id/transcript`; `server.js:3272` subagent transcript
- `lib/agents.js` — per-agent registry (parser, label). Any agent-specific voice behavior is a
  **registry field**, never a branch.

**Signals:**
- `pty-worker.js:642` `broadcastEvent`; `:671` apiError; `:807` autoResume
- session status (`working`/`idle`/`waiting`) + hook events; `getNotifyLevel` / notify-prefs

**Dictation sink (write) — reuse, do not fork:**
- `app.html` ~1615 `buildComposeSubmission`; `ai-terminal/lib/widgets/compose_bar.dart`
- worker `submitLine` + `lib/submit-frames.js` (the #55 CR-split contract)

**Clients:**
- Web: `app.html` (served per-request, `server.js:3790-3809`), settings panel ~244-260
- Companion: `ai-terminal/` (Flutter, Android + Windows desktop; **no iOS**)

**Config:** `config.json` already has `ntfy` (26-30) and `push` (31-36) sections — a `voice`
section follows that established pattern. Local-only endpoints use `isLocalhostReq()`
(`server.js:1034`).

---

## 6. Platform constraints (verified, not assumed)

These are real blockers a plan must account for:

| Constraint | Evidence | Consequence |
|---|---|---|
| **Companion has no audio stack at all** | `ai-terminal/pubspec.yaml:30-52` — no mic/audio/permission packages | Every dep is net-new. |
| **No `RECORD_AUDIO` permission** | `AndroidManifest.xml:2-3` — only `INTERNET`, `POST_NOTIFICATIONS` | Must add permission + runtime request flow. |
| **`flutter_tts` was removed because it broke the Windows build** | `pubspec.yaml:39-40` — *"deferred (voice) … its Windows build needs nuget.exe"* | **This already bit this project once.** Any plan that re-adds `flutter_tts` must solve the Windows/nuget issue or pick a different TTS path for desktop. |
| **Web CSP blocks external speech APIs** | `server.js:1318` — `connect-src 'self' ws: wss:` | A browser→cloud-STT call is blocked today. Either widen CSP (weakens posture) or **proxy through our own server** (preferred — keeps CSP tight and centralizes the key). |
| **`getUserMedia` needs a secure context** | `config.json:23` — tailnet is HTTPS | ✅ Satisfied on the tailnet; also fine on localhost. |
| **No iOS target** | pubspec platforms | Scope is Android + Windows + web only. |

The CSP finding is quietly decisive: it pushes the design toward **server-proxied speech**, which
is also the better architecture anyway (one integration, one key, no per-client divergence).

---

## 7. Voice technology stack (researched July 2026)

### 7.1 The decisive finding: keyterm prompting

Dictation accuracy on **technical speech** is the make-or-break risk (§10), and there is exactly
one feature that addresses it directly: **Deepgram Nova-3 keyterm prompting** — up to 100 terms
injected per request, merged with acoustic logits at inference
([docs](https://developers.deepgram.com/docs/keyterm)).

This matters here more than for a typical app, because **our server can build that keyterm list
per session from data it already holds**: recent filenames, symbols from the transcript, branch
names, `pty-worker.js`, `buildComposeSubmission`. Generic STT renders `pty-worker.js` as
"P.T.Y. worker dot js" every time; keyterms fix precisely that class of error.

This is a strong argument for the server-side brain in §3 — the keyterm list *requires*
server-side session state. No other vendor lets you condition on live session data this cheaply.

### 7.2 STT comparison

| Option | Streaming latency | Technical/code speech | Offline | Cost |
|---|---|---|---|---|
| **Deepgram Nova-3 / Flux** | ~200–300 ms | **Best — keyterm prompting** | No | $0.0077/min |
| ElevenLabs Scribe v2 Realtime | p50 ~150 ms | Strong WER, no jargon hook | No | ~$0.28/hr |
| AssemblyAI Universal-3 Pro | ~760 ms to final | Good; word boost | No | ~$0.006/min |
| OpenAI gpt-4o-transcribe | Not latency-tuned | Good; prompt-steerable | No | ~$0.006/min |
| **Parakeet TDT 0.6B v3** | Near-instant | 6.32% WER (beats Whisper's 7.44%), rarely hallucinates | **Yes** | Free |
| faster-whisper large-v3-turbo | Batch | Decent; hallucinates on silence | **Yes** | Free |
| Web Speech API / Flutter `speech_to_text` | Low | **Weak — mangles identifiers** | Partial | Free |

**Reject Web Speech API / `speech_to_text` as the primary path** — the plugin's own stated target
is *"commands and short phrases,"* not dictation.

### 7.3 TTS comparison — and the `flutter_tts` trap, confirmed

| Option | Naturalness | Latency | Offline | Cost | Windows build risk |
|---|---|---|---|---|---|
| **Deepgram Aura-2** | Good | ~90 ms | No | $30/1M chars | None (server-side) |
| ElevenLabs Flash v2.5 | Best-in-class | ~75 ms | No | up to $206/1M | None |
| **Kokoro-82M** | "Sounds like a real person" | Faster than RT | **Yes** | Free | None (server-side) |
| Piper | Functional, flat | ~40 ms | **Yes** | Free | None (server-side) |
| Browser `SpeechSynthesis` | Robotic | Instant | Yes | Free | None |
| **`flutter_tts`** | OS-dependent | Instant | Yes | Free | **HIGH — do not use** |

**The `flutter_tts` Windows failure is real, current, and unfixed** —
[#489](https://github.com/dlutton/flutter_tts/issues/489) and
[#337](https://github.com/dlutton/flutter_tts/issues/337): the build fails for want of
`NUGET.exe`. The documented workaround (drop `nuget.exe` into `<flutter_home>\tools\bin`) is a
per-machine landmine across three PCs.

**→ Architectural answer: synthesize TTS server-side and ship audio bytes to the client.** The
PWA plays them with `<audio>`; Flutter plays a byte stream. **Zero native TTS plugin, zero
NuGet.** This removes the constraint from §6 entirely rather than working around it. Keep browser
`SpeechSynthesis` as a free offline fallback in the PWA only.

### 7.4 Realtime speech-to-speech — the wrong tool here

2026 has capable S2S (gpt-realtime-2.1, Gemini Live, open-weight Moshi at 200–240 ms full-duplex).
**Use separate STT + TTS anyway**, for three reasons specific to this app:

1. **The prompt goes verbatim into a PTY.** An S2S model paraphrases; we need exact bytes. This
   alone disqualifies it.
2. **The loop is asynchronous**, not conversational — dictate → agent works for minutes → summary
   read back. Full-duplex buys nothing.
3. **Cost:** ~$32/M audio-input and $64/M output tokens vs ~$0.008/min for STT — conversational
   pricing for a non-conversational workload.

(Also reported: Gemini Live latency degrading over long sessions — bad for a long-lived terminal.)

### 7.5 Fully-local stack (privacy posture)

**⚠️ Hardware reality on the serving box (`adiel-0ffice`/Home, measured 2026-07-19):**
Intel UHD 770 **integrated** graphics (2 GB shared) — **no discrete GPU / no CUDA** —
i7-12700K (8P+4E), 64 GB RAM. This rules out the GPU-class recommendations below and
forces a CPU-only stack.

| Component | GPU-class pick (**not viable here**) | **CPU-only pick for this box** |
|---|---|---|
| STT | Parakeet TDT 0.6B v3 (NeMo/CUDA-oriented) | **faster-whisper** `small` / `distil-large-v3`, or **whisper.cpp** — both built for CPU |
| TTS | Kokoro-82M (~2–3 GB VRAM) | **Piper** (designed for CPU, ~40 ms, runs on a Pi); Kokoro-82M is small enough to try on CPU |
| Summarizer | Qwen3 32B / Gemma 3 27B via Ollama | **None — skip it.** A 32B Q4 model *fits* in 64 GB RAM but runs at ~1–3 tok/s on this CPU: unusable for a spoken-latency budget. |

**Consequences of CPU-only:**

- **Drop the LLM summarizer entirely.** §4.3's zero-LLM fallback (speak the first N sentences of
  `turn.text`) stops being a v1 simplification and becomes the *correct* design here. If
  condensing later proves essential, the options are a small 3–8B model on CPU (test latency
  honestly) or a cloud call for that step alone.
- **STT model size is a latency/accuracy dial**, not a free choice. `large-v3` on this CPU will
  not be interactive; `small` / `distil` will be. Measure in Phase 0.
- **CPU contention is real.** This same box runs the web-terminal server, the PTYs, and live
  Claude sessions. Sustained inference competes with actual work. 12 cores gives headroom, but
  voice must never starve a PTY — cap threads and treat it as background priority.

**What local costs you: keyterm prompting (§7.1)** — the single biggest technical-dictation
accuracy win, and it is cloud-only. **Partial mitigation worth verifying in Phase 0:**
`faster-whisper` exposes `initial_prompt` and a `hotwords` parameter, and `whisper.cpp` has
`--prompt`; these bias decoding toward supplied vocabulary. They are weaker than Deepgram's
logit-level keyterm merging, but they accept the *same* server-built term list, so the
architecture (§7.1) is unchanged — only the provider swaps. **Verify the real accuracy delta on
your own audio before concluding.**

**Language: ENGLISH ONLY — decided 2026-07-19.** This removes the Hebrew blocker that would have
forced Whisper, and means STT runs in its best-accuracy configuration. Two consequences:

- **Parakeet TDT 0.6B is back on the table on language grounds** (English is its strongest case,
  and it beats Whisper at 6.32% vs 7.44% WER with fewer silence hallucinations). The open
  question is purely whether a practical **CPU** path exists (it is NeMo/CUDA-oriented; ONNX
  export is the route to test). Worth one timeboxed attempt in Phase 0 — if it doesn't run well
  on CPU quickly, stop and use Whisper.
- **Default remains `faster-whisper` / `whisper.cpp`** — turnkey on CPU, well-trodden, and where
  the `hotwords` / `initial_prompt` vocabulary-biasing lives.

### 7.6 Recommended default stack

- **Capture:** client mic → Opus over the **existing authenticated WebSocket** (no new transport)
- **STT:** Deepgram Nova-3 streaming, keyterms built per-session server-side
- **Filter/summary:** the existing transcript pipeline (§2) — already server-side
- **TTS:** Deepgram Aura-2, server-side, returns audio bytes (one vendor, one key)
- **Playback:** `<audio>` in the PWA; byte-stream player in Flutter — **never `flutter_tts`**
- **Offline mode:** Parakeet + Kokoro + Qwen3 via Ollama, behind a provider flag
- **Not used:** realtime speech-to-speech

**Add `lib/voice.js` — a provider registry mirroring `lib/agents.js`.** One entry per vendor,
cloud and local behind the same interface, **no branching in `server.js` or the clients**. Build
both paths behind it from day one; retrofitting a local option later is materially worse.

### 7.7 Where the voice socket lives — `server.js`, not the worker

A long-lived upstream STT socket is state, and `server.js` is deliberately stateless and
hot-reloadable while `pty-worker.js` owns the PTYs. **Put voice sockets in `server.js`**: a hot
reload then costs at most one dropped dictation, and voice can never block or crash a PTY. This
is the correct trade for this codebase's architecture.

### 7.8 Confidence

Vendor-published figures (Deepgram, ElevenLabs, OpenAI, Google, the GitHub issues) are solid.
Cross-vendor WER/latency *rankings* come from aggregator blogs — **re-verify with real audio from
this user's own voice and vocabulary before committing** (that is Phase 0).

---

## 8. Phasing

Deliberately ordered so each phase is independently useful and independently abandonable.

| Phase | Scope | Why here |
|---|---|---|
| **0** | Decide the stack + privacy posture (§7). Prototype STT accuracy on *real developer dictation*. | The whole feature dies if dictation can't handle identifiers. Test the risk first. |
| **1** | **Read-aloud, on-demand, one client.** Button → speak the last assistant turn (first-N-sentences, no LLM). Server endpoint + the existing transcript. | Proves the knowledge layer end-to-end with the least moving parts. No mic, no permissions, no ambient policy. |
| **2** | **Dictation** into the compose bar, same client. Reuses `buildComposeSubmission`. | Independent of phase 1; the other half of the feature. |
| **3** | **Ambient mode** + the Speech Policy Engine proper (§4) — event-driven, `notifyLevel`-gated. | The genuinely valuable part, but it needs 1+2 working and a real feel for what's annoying. |
| **4** | Second client (companion): `RECORD_AUDIO` permission + a byte-stream audio player. **The Windows/nuget TTS problem does not arise** — §7.3 removes it by synthesizing server-side. | Highest platform risk; do it once the design is settled rather than twice. |
| **5** | Optional: LLM summarizer (Haiku 4.5 or local) if first-N-sentences proves too crude. | Additive, easy to defer. |

---

## 9. Open decisions (must be made deliberately — do not let these be decided by accident)

1. **Privacy posture.** Does session text/audio leave the tailnet? This decides the entire stack
   and cannot be retrofitted. **Ask the user first.**
2. **Ambient verbosity default.** Reuse `notifyLevel`, or a separate voice level? (Recommend:
   reuse.)
3. **Barge-in.** Can the user interrupt speech by talking, or only by pressing stop? Full
   barge-in needs continuous mic capture — a meaningful privacy and battery cost.
4. **Multi-device.** Three servers and four devices exist. If two devices are open on one
   session, do both speak? (Almost certainly not — needs an "active speaker" concept, likely
   tied to which device is foregrounded.)
5. **Wake word / always-listening?** Strongly recommend **no** for v1 — cost, privacy, and
   battery, for little gain over a button.
6. **Does voice cross the cluster?** A session on a peer server — does the local server proxy its
   speech, or does the owning server synthesize? (Prefer: the client's own server synthesizes;
   transcript is already fetchable cross-cluster.)

---

## 10. Risks

- **Annoyance is the top failure mode.** An ambient voice that speaks too often gets turned off
  permanently on day one. Bias every default toward silence.
- **STT on technical speech.** If dictating `pty-worker.js` or `buildComposeSubmission` produces
  garbage, dictation is worthless for this user's actual vocabulary. Phase 0 exists for this.
- **Windows TTS build breakage.** Documented, already-experienced (`pubspec.yaml:39`). Don't
  re-introduce it blindly.
- **Scope creep into a "voice assistant."** This feature reads and dictates. It does not answer
  questions about the app.
- **Two clients diverging.** The policy engine must be server-side, or web and companion will
  drift — the exact class of bug #60/#56 were about.
