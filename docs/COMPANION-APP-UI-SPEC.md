# Companion App — Phase 1 UI Spec (Android)

**Status:** Accepted 2026-07-05. Implementation blueprint for the Phase 1 Kotlin/Compose app defined in COMPANION-APP-DESIGN.md. Scope: FCM notifications + read-aloud + minimal landing screen. Dark theme only, Material 3, dynamic color disabled. Target device: Samsung Galaxy S25.

> **Orchestrator implementation notes (corrections to apply while building):**
> - There is **no `POST /api/login`**. "Test Connection" = `POST /api/auth/token` (public, rate-limited; body `{username, password}`; returns bearer) → `GET /api/version` with the bearer to read `{serverName, version, capabilities}`. Cookie login for the "Open in web" handoff is the site's `POST /login` form endpoint — verify its exact contract at implementation time.
> - FCM data payload values arrive as **strings** on the wire (FCM requirement) — parse `ts` to Long client-side.
> - `deepLink` in the payload targets the web UI (`<publicUrl>/app/:id`); the app's own `webterminal://` scheme is constructed client-side from serverBaseUrl + sessionId.

---

## 0. Visual Language

### 0.1 Palette (`res/values/colors.xml`, no DynamicColorScheme)

| Token | Hex | Role |
|---|---|---|
| `colorBackground` | `#121622` | Window/scaffold background (AMOLED-deep) |
| `colorSurface` | `#16213e` | Cards, sheets, dialogs (mirrors web sidebar) |
| `colorSurfaceContainer` | `#192743` | Slightly raised surfaces |
| `colorSurfaceContainerHigh` | `#1e3050` | Menus, tooltips |
| `colorOutline` | `#24405f` | Active borders |
| `colorOutlineVariant` | `#0f3460` | Subtle dividers (mirrors web border) |
| `colorOnBackground` | `#e0e0e0` | Primary text |
| `colorOnSurface` | `#e0e0e0` | Text on cards/sheets |
| `colorOnSurfaceVariant` | `#8899aa` | Secondary text, captions |
| `colorOnSurfaceDisabled` | `#4a5568` | Disabled text/icons |
| `colorPrimary` | `#00d4aa` | Action tint, selected state (web accent) |
| `colorOnPrimary` | `#1a1a2e` | Text on teal buttons |
| `colorPrimaryContainer` | `#0d2e29` | Subtle teal fill (chips, banners) |
| `colorOnPrimaryContainer` | `#00d4aa` | |
| `colorError` | `#ff2d4b` | API error, destructive (web api-error red) |
| `colorErrorContainer` | `#2b0f16` | Error surface tint |

### 0.2 Status colors (`ui/theme/AppColors.kt`)

```kotlin
object StatusColor {
    val Idle       = Color(0xFF44AA44)   // solid green — web #4a4
    val Active     = Color(0xFF44AA44)
    val Working    = Color(0xFFFF9900)   // orange — web #f90
    val Waiting    = Color(0xFFE94560)   // pulsing red — web #e94560
    val ApiError   = Color(0xFFFF2D4B)   // pulsing red+glow — web #ff2d4b
    val ServerOnline     = Color(0xFF44AA44)
    val ServerOffline    = Color(0xFFAA4444)
    val ServerNeedsAuth  = Color(0xFFDDAA44)
}
```

Pulse: `infiniteTransition`, alpha 1.0↔0.35 over 1500ms easeInOut. ApiError adds a `drawBehind` glow ring (blur 8dp, alpha 0.5).

### 0.3 Typography

| Style | sp | Weight | Use |
|---|---|---|---|
| `titleLarge` | 22 | Medium | Screen titles (TopAppBar) |
| `titleMedium` | 16 | SemiBold | Session name in card |
| `bodyLarge` | 16 | Normal | Body copy, lastMessage text |
| `bodyMedium` | 14 | Normal | Secondary info |
| `bodySmall` | 12 | Normal | Timestamps, captions |
| `labelLarge` | 14 | Medium | Buttons |
| `labelSmall` | 11 | Medium | Server badge, chips |

`FontFamily.Monospace` for session names containing `/`, `~`, or `.`.

### 0.4 Spacing & Shape

4dp base grid; 16dp screen horizontal padding; 16dp card padding; list rows 12dp×16dp. Shapes: Large 12dp (sheets/dialogs), Medium 8dp (cards/banners), Small 4dp (chips/badges).

### 0.5 StatusDot

`@Composable fun StatusDot(status: SessionStatus, modifier: Modifier)` — 10dp circle. Enum `Idle | Active | Working | Waiting | ApiError`. Idle/Active/Working solid; Waiting alpha-pulse; ApiError pulse + glow ring.

---

## 1. First-Run Flow

Triggered when `EncryptedSharedPreferences` key `setup_complete` is absent → `FirstRunScreen`. One-time device setup, not a login aesthetic. No bottom nav; system back exits.

```
┌─────────────────────────────────────────┐
│  Set Up Web Terminal                    │  ← SmallTopAppBar
├─────────────────────────────────────────┤
│  YOUR SERVERS                           │  ← labelSmall, #8899aa, UPPERCASE
│  ┌─────────────────────────────────┐   │
│  │ Server 1                        │   │  ← ElevatedCard, 8dp radius
│  │ Server URL      [https://     ] │   │  ← OutlinedTextField, Uri, Next
│  │ Username        [             ] │   │  ← Text, Next
│  │ Password        [•••••••  eye ] │   │  ← Password, Done→Test
│  │  [ Test Connection ]            │   │  ← FilledTonalButton
│  │  ○ Not tested                   │   │  ← TestStatusRow
│  └─────────────────────────────────┘   │
│  + Add another server                   │  ← TextButton (max 5; #2+ removable)
│  ─────────────────────────────────────  │
│  APP SECURITY                           │
│  │ Biometric app lock       [ OFF ]│   │  ← ListItem + Switch
│  ┌─────────────────────────────────┐   │
│  │        Finish Setup             │   │  ← FilledButton
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

URL validation on focus-exit: must start `http://`/`https://`; helper "Enter a valid URL (e.g. https://home.local:7681)".

**Test Connection** — `TestStatus: Idle | Testing | Success(serverName, version) | Error(message)`:

| State | Icon | Text | Color |
|---|---|---|---|
| Idle | RadioButtonUnchecked | "Not tested" | `#4a5568` |
| Testing | CircularProgressIndicator(16dp) | "Connecting…" | onSurfaceVariant |
| Success | CheckCircle | "{serverName} — v{version}" | StatusColor.Idle |
| Error | Error | mapped message | colorError |

Error mapping: timeout/UnknownHost → "Server unreachable"; 401 → "Wrong username or password"; 5xx → "Server error ({code})"; else "Connection failed".
Implementation: `POST /api/auth/token` → on 200, `GET /api/version` (bearer) → Success. *(Corrected from designer's /api/login.)*

**Finish Setup** — enabled when ≥1 server Success. Untested servers → AlertDialog "Test them now or proceed knowing some may be offline" (Go back | Proceed anyway). Some errored → "…{N} server(s) could not be reached. You can retry from Settings later." → Continue. On proceed: credentials → EncryptedSharedPreferences (Keystore-backed), `setup_complete=true`, → LandingScreen.

Biometric toggle with no enrolled biometrics → Snackbar "No biometrics enrolled. Enable them in System Settings first." + revert.

Re-run from Settings → same screen, pre-populated (password masked, cleared on first tap).

---

## 2. Landing Screen

`LargeTopAppBar("Sessions")` with offline-count warning badge + Settings action. `PullToRefreshBox` around a LazyColumn. No FAB, no bottom bar.

**Auto-refresh (foreground only, `repeatOnLifecycle(STARTED)`):** every 30s; immediately on ON_RESUME; immediately on FCM push received.

**Session card** (`ListItem`):

```
┌──────────────────────────────────────────────┐
│  ●  Session Name           [Home]  ┆  2m ago │
│     [Needs approval ×]                        │  ← only when kind != null
└──────────────────────────────────────────────┘
```

- Leading `StatusDot`; headline = name or "Session {shortId}", `titleMedium`, 1-line ellipsis; trailing `ServerBadge` + relative time.
- Card tint: ApiError → errorContainer + 4dp left border colorError; Waiting → `Waiting.copy(alpha=0.08f)`; else surface.

**ServerBadge:** primaryContainer pill, 4dp radius, labelSmall, name truncated 12 chars.

**AttentionChip** (`SuggestionChip`, custom colors): approval → "Needs approval" (Waiting container, PriorityHigh); apierror → "API error" (error container, Warning); idle → "Done" (Idle container, Check).

**Sort:** attentionRank (approval 0, apierror 1, idle 2, none 3) → statusRank (waiting 0, api_error 1, working 2, else 3) → recency desc.

**Tap:** kind!=null → AttentionDetailSheet full; kind==null → half-height no-attention mode.

**States:** Loading (centered spinner) / AllOffline (CloudOff, "No servers reachable — Pull down to retry") / PartialOffline (banner "⚠ {Server} is unreachable — sessions from this server may be stale", ServerOffline 12% bg + 4dp left border; "2 servers are unreachable" for multiple) / Empty (Terminal icon, "No sessions running — Start a session from the web UI") / Success / Refreshing / Error (Snackbar "Could not refresh. {err}").

**Relative time:** `<60s "just now"; <1h "Nm ago"; <24h "Nh ago"; else "Nd ago"`.

---

## 3. Attention Detail Sheet

`ModalBottomSheet(skipPartiallyExpanded = true)` overlay on LandingScreen (not a nav destination). Deep link sets `AttentionTarget` in SavedStateHandle → auto-opens.

```
┌─────────────────────────────────────────┐
│              ─────                      │  ← drag handle
│  [Home]  Terminal Session 4             │  ← ServerBadge + titleLarge
│  2026-07-05 14:32                       │  ← absolute event time
│  ┌───────────────────────────────────┐  │
│  │ ⚠  NEEDS APPROVAL                │  │  ← KindBanner
│  └───────────────────────────────────┘  │
│  REASON                                 │  ← omit section if blank
│  Running: npm install in ~/project      │
│  LAST MESSAGE                           │
│  <selectable, scrollable, max 2000     │
│   chars then "[Message truncated —     │
│   open in web for full content]">      │
│  [ 🔊 Read aloud ]                      │  ← FilledTonalButton
│  [ ↗ Open in web ]                     │  ← OutlinedButton
│  [ Dismiss notification ]               │  ← TextButton
│  ─────────────────────────────────────  │
│  ● Read aloud automatically       [ ]  │  ← per-session Switch
└─────────────────────────────────────────┘
```

**KindBanner:** approval → Waiting 15% bg, PriorityHigh, "NEEDS APPROVAL"; apierror → errorContainer, Warning, "API ERROR"; idle → Idle 15% bg, CheckCircle, "DONE". labelSmall uppercase, letterSpacing 0.08em, 12×16dp, 8dp radius.

**Read aloud button:** while speaking for this session → error-tinted, Stop icon, "Stop" (tap = `TextToSpeech.stop()`).

**Open in web:** cookie login with stored credentials (best-effort `CookieManager.setCookie`), then `CustomTabsIntent` → `{serverBaseUrl}/app/{sessionId}`.

**Dismiss notification:** `NotificationManagerCompat.cancel(tag "wt-{sessionId}", sessionId.hashCode())`; no server call in Phase 1; closes sheet.

**No-attention mode (kind==null):** half-height — badge + name, "Last activity: {rel}", StatusDot + status label, [Open in web] only.

**Off-tailnet failure** (attention GET fails; 10s timeout, 1 retry at 2s): KindBanner from FCM payload + errorContainer banner "⚠ Server unreachable — Content couldn't be loaded. Make sure you're on the Tailscale network. [Retry]" + [Open in web]. If a successful attention response ≤5 min old is cached (DataStore): show it with header "Showing cached content from {relativeTime}."

---

## 4. Notifications

**Channels** (created in `Application.onCreate()`):

| Channel ID | Name | Importance | Sound | Vibration | LED |
|---|---|---|---|---|---|
| `wt_approval` | Needs Approval | MAX | default ringtone | [0,300,200,300] | #E94560 |
| `wt_api_error` | API Error | HIGH | default | [0,200,100,200] | #FF2D4B |
| `wt_idle` | Session Updates | LOW | none | none | none |
| `wt_tts` | Reading Aloud | LOW | none | none | none |

**Payload:** `{serverName, sessionId, kind: approval|apierror|idle|clear, ts, deepLink}` (string values on the wire).

**Session-name cache:** DataStore JSON map `"{serverBaseUrl}|{sessionId}" → name`, updated on every successful `/api/sessions` fetch; serverName→baseUrl mapping stored from `/api/version` during setup. Cache miss → "A session".

**Per-kind layout:** tag `"wt-{sessionId}"`, id `sessionId.hashCode()`, title `{serverName}`, BigTextStyle, autoCancel:
- approval: body "{name} needs your approval" — actions **[Open] [Read aloud]** (NO approve/deny in Phase 1)
- apierror: body "{name} stopped — API error" — actions **[Open] [Dismiss]**
- idle: body "{name} finished" — tap-to-open only
- clear: post nothing; `cancel("wt-{sessionId}", hash)`

**Grouping:** per server, `setGroup("wt_group_{serverName}")` + GROUP_ALERT_CHILDREN; summary "{N} sessions need attention" when ≥2 active in group.

**Deep link:** `webterminal://session/{encodedServerBaseUrl}/{sessionId}` intent-filter on MainActivity; onNewIntent → AttentionTarget → sheet opens. Dead session → Snackbar "Session no longer active."

---

## 5. Read-Aloud

`TtsManager` singleton over `android.speech.tts.TextToSpeech`, `StateFlow<TtsState>` (`Idle | Speaking(sessionId) | Error`). Locale = default; Hebrew/mixed text spoken as-is (known limitation, noted in Settings copy).

**Template:** `"On {serverName}, {sessionName|'a session'}: {lastMessage|'There is no message to read.'}"`, lastMessage truncated at 500 chars + spoken suffix ". Message truncated."

**Triggers:** sheet button (fetch if uncached → speak); notification action via `TtsActionReceiver` → foreground service; Driving Mode ON → auto-speak every push except clear; per-session auto-speak toggle → scoped auto-speak. Driving Mode overrides per-session.

**Foreground service** (Android 14+, `FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK`): start on TTS begin, ongoing silent notification on `wt_tts` ("Reading aloud" / "{server} — {session}" / [Stop]), stopSelf on done/error/Stop.

**In-sheet indication while speaking:** button → error-tinted "Stop", indeterminate LinearProgressIndicator at sheet top.

**Persistence:** per-session `auto_speak_{serverBaseUrl}_{sessionId}` (default false); global `driving_mode` (default false; Snackbar on enable: "Driving Mode on — all alerts will be read aloud").

---

## 6. Settings

Sections: SERVERS (read-only rows: StatusDot + name + URL; [Re-run Setup]) · VOICE (Driving Mode switch; TTS Voice picker — voices grouped by language, radio + Preview; Speech Rate slider 0.5–2.0× step 0.25, sample "Speed test." on release) · NOTIFICATIONS (single row → system `ACTION_APP_NOTIFICATION_SETTINGS`) · DIAGNOSTICS (per server: FCM token status Registered(green, rel-time)/Failed(red, error)/Unknown(grey); [Re-register] → token → `POST /api/push/devices`; [Send test push] → `POST /api/notify-test` → Snackbar; plus "Last push received: {rel}" from DataStore `last_push_ts`).

---

## 7. Navigation

```kotlin
NavHost(startDestination = if (setupComplete) "landing" else "firstRun") {
  composable("firstRun") { FirstRunScreen(nav) }
  composable("landing")  { LandingScreen(nav, attentionTarget = savedState["target"]) }
  composable("settings") { SettingsScreen(nav) }
  composable("settings/tts_voice") { TtsVoicePickerScreen(nav) }
}
```

AttentionDetailSheet is an overlay on LandingScreen, not a destination.

---

## 8. NOT in Phase 1 (no stubs, no placeholders)

Approve/Deny actions · session create/kill/rename · dictation/PTT/SpeechRecognizer · conversation view · embedded WebView terminal (Custom Tab only) · scrollback peek · favorites · draft persistence · server filter chips · notify-level bell controls · session reorder · voice approvals · cloud TTS/STT · volume-key history · WorkManager background polling · KMP :core module · anything from Phases 2–5 of COMPANION-APP-DESIGN.md.
