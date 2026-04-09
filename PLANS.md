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
