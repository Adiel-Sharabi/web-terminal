# AI agent support — what works, and what doesn't

Web Terminal runs any CLI in a session. Two AI coding agents get **first-class treatment**
— status dots, transcripts rendered as chat, usage badges, phone push. That support is
**not equal between them**, and this page says exactly where the gaps are.

> **Short version: Claude Code is fully supported. Codex is partial.** Codex sessions run
> and are genuinely usable, but four features are missing and one status state is
> unreachable. If you are choosing an agent based on how well this app supports it, choose
> Claude Code.

## Support matrix

| Capability | Claude Code | Codex |
|---|:---:|:---:|
| Run a session, terminal lens, input/submit | ✅ | ✅ |
| Transcript rendered as chat (companion) | ✅ | ✅ |
| Rich tool cards (shell, file edits, web search) | ✅ | ✅ |
| Task-list panel | ✅ | ✅ |
| Context-window % and rate-limit badges | ✅ | ✅ |
| Session recap | ✅ | ✅ |
| Read-aloud | ✅ | ✅ |
| Status: **waiting** (needs approval) | ✅ | ✅ |
| Status: **idle** (turn finished) | ✅ | ✅ |
| Status: **working** (turn in progress) | ✅ | ❌ **unreachable** |
| Subagent drill-in / pinned subagent strip | ✅ | ❌ |
| Background-work badge | ✅ | ❌ |
| "Compacting conversation…" indicator | ✅ | ❌ |
| Stable transcript path | ✅ | ❌ rediscovered per read |

Everything in that table is a field in the provider registry (`lib/agents.js`), not a
special case scattered through the code — so the gaps are visible in one file, and closing
one is a registry change plus its feature, never a new branch.

## Why the gaps exist

**Codex hooks do not run.** This is the root of most of the missing rows. Measured across
four controlled PTY runs against codex-cli 0.144.6 — the `[features] hooks = true` gate
set, a user-level `~/.codex/hooks.json` parsed and its definitions enumerated, trust
answered and persisted — **zero hook processes were ever spawned**. That was proven with a
batch file that appends a marker line before doing anything else, so "never invoked" is
distinguishable from "invoked but the interpreter was missing". The marker file was never
created.

So Codex status comes from a different channel: with `tui.notifications`,
`notification_method = "osc9"` and `notification_condition = "always"`, the Codex TUI
writes its notifications into the terminal as OSC 9 escape sequences — and since
`pty-worker.js` *is* the terminal, it already reads every byte. Run
`node scripts/install-codex-notify.js` to enable it (worker-side, so it needs a cold
restart). `--check` reports without changing anything.

**That channel fires on exactly two occasions: an approval, and a finished turn.** There is
no turn-start notification, so **`working` cannot be reported for Codex at all** — not as a
bug to fix, but by construction of the only channel available. A Codex session goes from
idle straight to idle, showing red only when it is blocked on you.

**Subagent traces and the compaction indicator** both depend on hook events
(`SubagentStart`/`SubagentStop`, `PreCompact`) with no equivalent in the rollout, so they
are off for Codex rather than half-working.

**Transcript paths are discovered, not derived.** Codex writes a **new rollout on every
run** and keys them by date + UUID rather than by working directory, so "which rollout is
this session's" is a search whose correct answer changes while nothing about the session
does. The path is therefore re-derived past a short TTL instead of being cached forever.
Claude's path is a pure function of cwd + conversation id, which is why it is stable.

## If you are adding another agent

One parser module plus one entry in `lib/agents.js`. Every consumer — both clients, the
worker, the API — reads the registry, and `GET /api/agents` publishes the catalogue, so a
new agent needs **no client release**. If you find yourself writing `if (agent === '…')` in
`server.js`, `pty-worker.js`, `app.html` or the companion, the change belongs in the
registry instead. See [CONTRIBUTING.md](../CONTRIBUTING.md#pull-request-gate).

## Claude Code hooks setup

Status dots, notifications, the session browser and the chat lens are driven by Claude
Code hooks. Install them with:

```bash
node scripts/install-hooks.js           # patch
node scripts/install-hooks.js --check    # report only, change nothing
```

It adds or corrects **only** web-terminal's own entry (matched by URL), so hooks you
added yourself are preserved, and it is idempotent — run it after every deploy. Hooks are
read per agent launch, so running sessions keep the old set until their next start or
resume; no server restart is involved.

All nine events are required as a set, not a menu. `PreToolUse`/`PostToolUse` are the
heartbeat that keeps a busy session from being flipped to Idle by the 5-minute stale
guard. `SubagentStart` **without** `SubagentStop` is worse than installing neither: the
in-flight count only ever grows, so the main agent's `Stop` is held forever and the
session never reports idle.

`SessionStart` is the one that is easy to think optional, and it is not. Every other
event fires only once the user is **already** interacting, so a session that has started
— or resumed a conversation — and has not yet been prompted reports nothing at all: the
server never learns its conversation id, and the chat lens 404s next to a perfectly live
terminal. It also carries `transcript_path`, which is the only cwd-independent answer to
"where is this conversation", and therefore the thing that keeps the lens working when
the agent runs somewhere other than where its shell started. Measured on claude 2.1.x: it
fires on a fresh start and on `--resume` (`source: "resume"`).

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "SubagentStart": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "PreToolUse": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "PostToolUse": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "Notification": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "Stop": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "SubagentStop": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "PreCompact": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}]
  }
}
```

The HTTP hook type sends requests directly — no subprocess, so no console-window flash on
Windows. Sessions started outside Web Terminal have no `WT_HOOK_TOKEN`, so their hook
requests are rejected with 401; that is harmless, their status simply does not update. The
token is generated per install into `.hook-token` (chmod 0600 on unix) and passed to
spawned shells as `WT_HOOK_TOKEN`.

For the usage badges, also run `node scripts/install-statusline.js` — **after** deploying
the server, which the installer enforces by checking that the endpoint advertises
`accepts: 'raw'`.

## Hook event transform

Claude's raw hook stream is noisy — every `Notification` subtype shares one event name,
`Stop` fires between agentic turns even when the next starts milliseconds later, and
`Stop` inside a subagent is auto-converted to `SubagentStop`. `server.js` reshapes events
before they reach the worker:

- `Notification` is demultiplexed by payload: permission prompts → **Waiting**, idle
  prompts → **Idle**, everything else dropped.
- `Stop` and idle Notifications are debounced (~750 ms, `WT_HOOK_STOP_DEBOUNCE_MS`). Any
  working event inside the window cancels the idle transition, which removes the "flash of
  stopped" between turns. The debounce lives **in the worker**, which owns session status.
- `SubagentStop` is forwarded to the worker, which tracks the set of in-flight `agent_id`s.
  While that set is non-empty, a `Stop` from the **main** agent does not mark the session
  idle and fires no "done" push — the turn isn't over. The last `SubagentStop` releases it.

**The payload says who fired the event** — measured against the real stream, not the docs.
Every event raised *inside* a subagent carries `agent_id`; no main-agent event does, not
even the `PreToolUse`/`PostToolUse` of the `Agent` call that launched it. A backgrounded
Task returns its `PostToolUse` immediately, so the parent's `Stop` lands seconds *before*
the subagent's `SubagentStop`:

```
PreToolUse(Agent) [main] → SubagentStart [sub] → PostToolUse(Agent) [main]
  → Stop [main]  … 13s …  → SubagentStop [sub]
```
