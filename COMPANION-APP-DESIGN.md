# Companion App — Design Document

**Status:** Design accepted (pending owner decisions below). Produced 2026-07-05 by a four-agent design panel (architecture, UI/UX, cloud/push, adversarial reviewer); every repo file:line claim was independently spot-verified against the working tree.

## Vision

A native **Android companion app** (Flutter — owner decision 2026-07-05, see Stack Decision) for the web-terminal system. It is **not a terminal emulator** — it is a notification / voice / chat companion. Sessions always run on the servers; the app and the existing web UI are two stateless viewers over the **same REST/WS contract**. The web UI remains the full terminal and the fallback for everything.

**Principles**
- Server is the single source of truth; no parallel "mobile API" — all new endpoints are additive and usable by the web UI too.
- Structured server signals over TUI scraping, always.
- Privacy: Claude content never transits a push relay; pushes are content-free wake-ups, content is fetched over the private network (Tailscale).
- No always-on background sockets on the phone (battery); FCM is the wake channel.
- Solo-dev scope discipline: boring and buildable; every screen earns its existence.

## Stack Decision

**Flutter** (owner decision 2026-07-05, overriding the panel's Kotlin+Compose recommendation — the panel ranked Flutter runner-up).

- Firebase project: `<firebase-project-id>`, applicationId `net.hilashnet.aiTerminal`; `google-services.json` saved at `C:\secrets-dir\google-services.json`.
- Plugins: `firebase_messaging` (FlutterFire, first-party), `flutter_tts`, `speech_to_text`, `flutter_local_notifications` (channels/actions/auto-dismiss), `flutter_secure_storage` (Keystore-backed credentials).
- **Known risk (accepted):** background FCM handlers run in a separate Dart isolate — the "push arrives while app is killed → speak aloud" flow is harder than Kotlin's in-process path. Mitigation: implement in the background isolate first (flutter_local_notifications + flutter_tts both claim background support); if unreliable on the S25, add a small native Kotlin bridge (MethodChannel) for exactly that flow. This is the first thing Phase 1 must prove (build the read-aloud-on-push spike BEFORE the rest of the app).
- Upside: one codebase for Android + **Windows desktop** — the PC client becomes a Flutter build target instead of a separate project. Desktop voice plugins are weak, but desktop was speced voice-less anyway.
- UI spec (COMPANION-APP-UI-SPEC.md) translates ~1:1: Material 3 components map directly (ListItem→ListTile, ModalBottomSheet→showModalBottomSheet, SwitchListTile→SwitchListTile, LargeTopAppBar→SliverAppBar.large); palette/typography/state tables unchanged.

**Desktop:** web UI as Edge PWA remains the zero-work default; a Flutter Windows build is now the cheap native option when wanted.

## Push Pipeline (FCM)

- **Transport:** FCM HTTP v1, data-only messages (no `notification` block) — the app renders its own notifications. Seam: `pushNotify()` in server.js (comment-marked). ntfy retained as a config-selectable fallback (`push.provider: "fcm" | "ntfy" | "both"`).
- **Topology:** every server sends directly (each holds a copy of the service-account key, gitignored outside the repo). No gateway server — no single point of failure.
- **Payload (content-free):** `{serverName, sessionId, kind: approval|apierror|idle|clear, ts, deepLink}`. **No sessionName** (reviewer: names can hint at project content) — the app renders names from a local cache built from its last session-list fetch; off-tailnet fallback is generic ("A session on Home needs approval").
- **Priority:** high for approval/apierror, normal for idle (protects the Android high-priority quota). `collapse_key = session-{id}`; `kind:"clear"` push auto-dismisses when the state resolves (primary mechanism — no periodic background polling).
- **TTL:** approval 300s, apierror 600s, idle 3600s, clear 60s.
- **Device registry:** app POSTs its FCM token to **all** servers (`/api/push/devices`) at startup, on `onNewToken`, on foreground, and on network-regain (covers a server being offline at registration time). Servers prune tokens on UNREGISTERED/INVALID_ARGUMENT send errors.
- **Content fetch:** on wake, app GETs `/api/sessions/:id/attention` over the tailnet for the real content (reason + Claude's last message). If unreachable, generic notification from payload alone — no content leak by construction.

## Server API Additions (the contract)

| # | Endpoint | Purpose | Effort |
|---|---|---|---|
| G1 | `POST/DELETE /api/push/devices` | FCM token registry (gitignored `push-devices.json`) | S |
| G2 | FCM transport in `pushNotify()` | Data-only send via firebase-admin; ntfy fallback | M |
| G3 | `kind:"clear"` push + attention `cleared` | Auto-dismiss | S |
| G4 | `POST /api/sessions/:id/input {text, submit?}` | One-shot dictation send (PTY_IN path exists) | S |
| G5 | `GET /api/sessions/:id/transcript?before&limit` | Paginated, server-parsed JSONL → typed turns for the chat view. Parser stays SERVER-side (schema drift = server fix, not app release). Requires persisting transcriptPath (in-memory today) + path-traversal hardening | M–L |
| G6 | Register `PreToolUse` HTTP hook | Server finally sees `tool_name` + `tool_input` (today "PermissionRequest" is synthesized from Notification prose) → structured approval context in attention | M |
| G7 | `POST /api/sessions/:id/respond {choice, attentionAt, confirm?}` | Approval answering via server-side versioned keystroke map. Guardrails ARE the deliverable: status==='waiting' check, attentionAt optimistic lock, destructive-pattern ⇒ `confirm:true` (SERVER-side authoritative; client patterns are UX hints only), no "allow always" via voice, audit log | M, highest risk |
| G8 | `capabilities:[...]` on `/api/version` | Per-server feature gating during rolling upgrades (never assume the fleet is homogeneous) | S |

Already sufficient today (verified): auth token mint, session CRUD + reorder, cluster-merged list, WS terminal I/O, `/ws/notify` event stream (foreground only), scrollback (sanitized, ranged), notify-level, clipboard-image upload, `/attention` (uncommitted, this branch).

## App UX (post-review)

**Screens (5 max):** Sessions Dashboard (status-first sort, server filter chips) → Session Screen (Conversation tab for Claude sessions / scrollback peek for shell sessions) → Approval Sheet → New Session Sheet → Settings.

- **Conversation view (the centerpiece, Phase 3):** chat-style transcript — assistant prose as markdown bubbles (code blocks, tap-to-copy), collapsed tool-use chips, user turns right-aligned. Native smooth scroll + jump-to-bottom; auto-scroll only when already at bottom. Live update is **event-triggered** off `/ws/notify` (delta tail refetch) + slow backstop poll while working — not blind 2s polling.
- **Terminal:** read-only native scrollback peek (minimal ANSI-color rendering) + **"Open in web"** (Custom Tab → `/app/:id`) for full interactivity. NO embedded WebView terminal in Phase 1 — verified: the `/s/:id` page's WS relies on an HttpOnly cookie the app doesn't have; "zero-work WebView reuse" is false.
- **Input:** compose-first bar, multiline; push-to-talk mic (dictate → review → send; no auto-send); hardcoded small slash-command list (no endpoint).
- **Approvals (Phase 4):** bottom sheet showing real `tool_name` + `tool_input` (from G6), Approve/Deny → G7 `/respond`. Lock-screen actions: **Deny + Open only** until server-side guardrails are live; one-tap Approve only after G6+G7 enforce, never for destructive ops (3s-countdown confirm in-app). Api-error notification action = Open + Dismiss (no "Retry" — the server owns auto-recovery).
- **Voice:** on-device TextToSpeech + SpeechRecognizer (free, private; Hebrew he-IL supported, mixed Hebrew/English tech vocabulary is the weak spot — cloud STT/TTS is a later opt-in, off the $0 target). Read-aloud: per-session opt-in + global driving-mode toggle; works hands-free on push arrival (FCM → fetch attention → TTS, screen off).
- **Notifications:** channels approval=MAX / api_error=HIGH / idle=DEFAULT-silent; mapped to the existing off/important/all bell levels; grouped per session; deep-link into the session screen. Once the app ships, disable the web PWA's phone notifications (avoid doubles).

**Cut from scope (reviewer):** conversation-mode hands-free loop, voice approvals (until G6/G7 trusted), embedded WebView terminal, volume-key send history, 30s WorkManager dismiss-poll, favorites strip in Phase 1, draft/scroll persistence in Phase 1.

## Auth Story

One-time first-run credential capture → store in Android Keystore (EncryptedSharedPreferences) behind an optional biometric app-lock. Mint bearer tokens on demand; silent re-mint on 401 (tokens expire after 90 days); the stored credential also enables cookie login for "Open in web". A token-only approach breaks at 90 days and can't do web handoff.

## Privacy Model

Google sees: project id, timestamp, device token, `{serverName, opaque sessionId, kind}` — access-log-equivalent metadata. Everything else (Claude messages, commands, tool input, session names) stays on the tailnet, served by authenticated endpoints. `ntfy.includeContent=false` (already implemented on this branch) applies the same content-free stance to the ntfy fallback.

## Phase Plan (merged, post-review)

| Phase | Deliverable | Effort (solo, part-time, incl. Kotlin ramp) | Risk |
|---|---|---|---|
| 0 | Server prep: commit `/attention` (+ serverName/lastMessage honoring includeContent), G8 capabilities, G3 clear-event, G1 device registry | 3–5 d | Low |
| 1 | **FCM notifications + read-aloud + minimal landing screen** (G2; app skeleton, Keystore auth, FCM registration w/ reconciliation, self-rendered notifications from name cache, TTS of attention.lastMessage, read-only session/attention screen as the deep-link target) | 4–6 wk | Med (FCM/Doze/Samsung battery; first Kotlin) |
| 2 | Dashboard control + dictation (G4; full cross-server list, create/kill/rename/notify-level, scrollback peek, push-to-talk → input) | 2–3 wk | Low-Med |
| 3 | Chat-style history (G5; native chat renderer; event-triggered updates) | 2–4 wk | Med (JSONL schema drift) |
| 4 | Structured approvals (G6+G7; Deny-first on lock screen; voice-answer only as a later sketch) | 2–4 wk | **Highest** — ship deny-only first |
| 5 | Desktop = web PWA install (0 d); native only if it disappoints | 0 d | Low |

**Honest estimate:** first useful daily-driver increment at ~4–6 weeks; full vision ~3–5 months part-time (the 6–9-week figure assumed prior Android experience). Commit only to Phase 1; re-estimate after.

## Owner Setup Checklist (Firebase — one-time, ~15 min, $0)

1. console.firebase.google.com → **Add project** (e.g. `web-terminal-push`), disable Analytics.
2. **Add Android app** — choose an `applicationId` (lowercase reverse-domain, permanent). SHA-1: leave blank (not needed for FCM). Download **`google-services.json`**.
3. Project Settings → Service accounts → **Generate new private key** → download the service-account JSON. Copy to each server at a gitignored path (e.g. outside the repo). Never commit.
4. Confirm the **project_id** (inside both JSON files).
5. No Blaze/billing needed (FCM is free on Spark). No Play Console needed (sideload via ADB/APK).
6. After app install on the phone: Battery → **Unrestricted** + add to "Never sleeping apps" (Samsung kills FCM listeners otherwise — the single most important device step).

## Decisions (confirmed by owner, 2026-07-05)

1. **Auth: password-in-Keystore** (biometric app-lock optional) — CONFIRMED.
2. **Push cutover: `push.provider: "both"`** (FCM + ntfy in parallel) until FCM delivery is proven on the phone, then flip to `"fcm"` — CONFIRMED.
3. **Scope: Phase 0 + Phase 1 only committed**; re-estimate before later phases — CONFIRMED.

Panel defaults adopted without objection: drop sessionName from the FCM payload; approvals last; Open-in-web + native peek (no embedded WebView terminal); single `/respond` contract with server-authoritative guardrails; api-error action = Open + Dismiss; event-triggered transcript updates; disable PWA phone notifications once the app ships; Kotlin + Compose with KMP deferred.
