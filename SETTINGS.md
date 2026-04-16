# Web Terminal — External Settings Reference

Settings that live outside the codebase but are required for the system to work correctly. Use this file to track, sync, and audit settings across all servers.

## Claude Code Hooks (`~/.claude/settings.json`)

HTTP hooks that report Claude session status to the web terminal. No subprocess spawned — direct HTTP request, no console window flash on Windows.

### Required hooks

| Event | Purpose | Status effect |
|-------|---------|---------------|
| `UserPromptSubmit` | User sent a prompt | → `working` |
| `SubagentStart` | Subagent spawned | → `working` |
| `Notification` | Claude finished, waiting for input | → `idle` + notification |
| `Stop` | Claude stopped | → `idle` + notification |

### Hooks NOT used (and why)

| Event | Reason excluded |
|-------|----------------|
| `PreToolUse` | Fires on every tool call — too noisy, dozens per minute |
| `PostToolUse` | Same as above |
| `PermissionRequest` | Fires even in `--dangerously-skip-permissions` mode — false alerts |
| `SessionStart` / `SessionEnd` | Not needed — session lifecycle managed by web terminal |

### Hook configuration

Each hook entry is identical — only the event name differs:

```json
{
  "hooks": {
    "<EVENT>": [{
      "hooks": [{
        "type": "http",
        "url": "http://127.0.0.1:7681/api/hook",
        "headers": {"X-WT-Session-ID": "$WT_SESSION_ID"},
        "allowedEnvVars": ["WT_SESSION_ID"]
      }]
    }]
  }
}
```

**How it works:**
1. Web terminal sets `WT_SESSION_ID` env var when spawning each PTY session
2. Claude Code inherits the env var and passes it via the `X-WT-Session-ID` header
3. Server matches the ID to the running session and updates its status
4. Sessions without `WT_SESSION_ID` (regular CLI, old sessions) are silently ignored (200 OK)

### Setup utility

Run on each server to apply the correct hooks:
```bash
cd web-terminal && node fix-hooks.js
```

This reads the existing `~/.claude/settings.json`, adds/overwrites the hooks section, and preserves all other settings.

---

## Claude Code Status Line (`~/.claude/settings.json`)

Custom status bar showing folder, branch, and context percentage:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/claude-status.sh"
  }
}
```

Script location: `~/.claude/claude-status.sh` (must exist on each server).

---

## Server Comparison

Last verified: 2026-04-16

| Setting | Home | Office | XPS |
|---------|------|--------|-----|
| **Hooks configured** | Yes (HTTP) | Yes (HTTP) | Yes (HTTP) |
| **Hooks events** | UserPromptSubmit, SubagentStart, Notification, Stop | UserPromptSubmit, SubagentStart, Notification, Stop | UserPromptSubmit, SubagentStart, Notification, Stop |
| **PreToolUse hook** | No (removed) | No (removed) | No (removed) |
| **statusLine** | bash ~/.claude/claude-status.sh | bash ~/.claude/claude-status.sh | Missing |
| **skipDangerousModePermissionPrompt** | true | true | true |
| **Server version** | 1.3.1 | 1.3.1 | 1.3.1 |
| **Process manager** | plain node | monitor.js | monitor.js |
| **config.json: defaultCommand** | claude --dangerously-skip-permissions | claude --dangerously-skip-permissions | (check) |
| **config.json: serverName** | Home | Office | Adiel-Xps |
| **config.json: publicUrl** | https://adiel-home.braid-mintaka.ts.net | (not set) | https://adiel-xps.braid-mintaka.ts.net |
| **Scheduled task** | Not registered (needs admin) | Unknown | Unknown |

---

## Updating all servers

### 1. Change hooks
Edit `fix-hooks.js` in the repo, commit, push, then run on each server:
```bash
# Via /api/exec from any server:
curl -X POST https://<server>/api/exec -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"command":"cd web-terminal && git pull && node fix-hooks.js"}'
```

### 2. Change statusLine
Edit `~/.claude/claude-status.sh` on each server, or create a `fix-statusline.js` utility.

### 3. Verify all servers match
```bash
# From any server with cluster tokens:
curl -X POST https://<server>/api/exec -H "Authorization: Bearer <token>" \
  -d '{"command":"cat ~/.claude/settings.json | node -e \"d=require(\\\"fs\\\").readFileSync(0,\\\"utf8\\\");s=JSON.parse(d);console.log(JSON.stringify({hooks:Object.keys(s.hooks||{}),statusLine:!!s.statusLine},null,2))\""}'
```

---

## Changelog

| Date | Change | Servers affected |
|------|--------|-----------------|
| 2026-04-14 | Initial hooks: bash command type (UserPromptSubmit, PreToolUse, Notification, Stop, PermissionRequest) | Home, Office |
| 2026-04-14 | Removed PermissionRequest — fires in skip-perms mode, false alerts | Home, Office |
| 2026-04-14 | Removed PreToolUse — too noisy, dozens of fires per minute | Home, Office |
| 2026-04-15 | Switched from bash command hooks to HTTP hooks — no console window flash on Windows | Home, Office |
| 2026-04-15 | Added SubagentStart hook — tracks when subagents spawn | Home, Office |
| 2026-04-15 | Removed PTY heuristic status — hooks-only session intelligence | All |
| 2026-04-16 | Re-added hooks on Office (were lost) via fix-hooks.js | Office |
