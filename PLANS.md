# Web Terminal — Future Feature Plans

Prioritized backlog.

## P1 — Permission/approval notification
Distinct urgent notification when Claude is mid-task and actively waiting for user approval (permission prompt, y/n question), not just idle after finishing. Different sound/color from the "Claude is done" notification.
_Why:_ Missing an approval prompt blocks Claude for minutes; missing an idle notice costs nothing.
_Approach:_ Use `PermissionRequest` hook event + existing PTY `NOTIFY_PATTERNS`. Red pulsing dot + browser notification with distinct tag. Consider sound alert.

## P2 — Instant remote session switching
Pre-fetch and cache remote session scrollback in the background so switching from local to remote feels instant instead of waiting 2-5 seconds.
_Why:_ Content is mostly static but we re-fetch it every switch through the cluster proxy.
_Approach:_ Pre-connect WebSockets to visible remote sessions in background, cache scrollback in memory. On switch, render cached content immediately and upgrade to live connection. Or keep hidden xterm instances for recent sessions and swap visibility.

## P3 — Collapsible server groups
Click server header in sidebar to expand/collapse its sessions.
_Approach:_ CSS toggle + localStorage persistence per server.

## P4 — Compact session cards
Smaller sidebar footprint — show name + status dot only, expand on hover/click for details.

## P5 — Auto-deploy to all servers
Automate git pull + restart across all cluster servers from a single action.
_Approach:_ Use existing `/api/exec` endpoint on each server. Add a button in Settings or a `/deploy` skill.

## P6 — Codex CLI support + Claude/Codex orchestration
Add OpenAI Codex CLI as a second AI agent alongside Claude, and enable orchestration workflows where both agents collaborate on a task.

### Setup
- Install: `npm install -g @openai/codex`
- Auth: `CODEX_API_KEY` or `OPENAI_API_KEY` env var (or `codex login` for ChatGPT account)
- Non-interactive mode: `codex exec "prompt"` — streams progress to stderr, final result to stdout
- Auto-approve: `--full-auto` or `--dangerously-bypass-approvals-and-sandbox`
- Working dir: `-C /path` flag, write access via `--sandbox workspace-write`

### Orchestration workflow
File-based handoff between Claude and Codex sessions:
1. User asks Claude a question in a web-terminal session
2. Claude writes results to a shared folder (e.g. `/tmp/wt-orchestrate/<job-id>/`)
3. Web-terminal detects Claude went idle (via hooks), launches Codex session with `codex exec` pointing at the shared folder to review/validate
4. Codex writes its review back to the shared folder
5. Web-terminal detects Codex finished, feeds the review back to Claude (new session or inject via WebSocket)
6. Repeat until user is satisfied

_Why:_ Get a second opinion from a different model on code reviews, architecture decisions, or bug analysis. Each model has different strengths — cross-validation catches more issues.

_Approach:_
- Add `codex` as a recognized agent type alongside `claude` in session creation (new `provider` field)
- Add `/api/session/:id/write` endpoint to inject text into a running PTY via WebSocket (needed for feeding results back)
- Build an orchestration API: `POST /api/orchestrate` with `{ prompt, agents: ['claude', 'codex'], mode: 'review-loop' }` — server manages the handoff loop
- Status tracking: reuse existing hook system for Claude, poll Codex process exit for completion
- UI: show orchestration progress in sidebar — which agent is active, iteration count
- Config: add `codexApiKey` to settings (or use env var), `codexModel` (default `o3`)
