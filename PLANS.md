# Web Terminal — Future Feature Plans

Collected during development. Not prioritized — just a backlog to pick from.

## UI / Sidebar
- Collapsible server groups in sidebar (click server header to expand/collapse)
- Compact session cards — smaller footprint, show name + status dot only, expand on hover/click
- Split/grid view — show 2-4 sessions simultaneously
- Session search/filter in sidebar

## Session Intelligence
- Cost & token tracking per session (parse Claude's statusLine output)
- Context window percentage bar per session in sidebar
- Context high alert (>80%) via browser notification
- Session activity heatmap or timeline

## Mobile
- Fingerprint/biometric auth for PWA (WebAuthn)
- Swipe gestures for session switching
- Better virtual keyboard integration

## Cluster
- Auto-deploy code changes to all servers (git pull + restart via API)
- Server health dashboard (CPU, memory, disk)
- Cross-server session migration (move a running session between servers)

## Developer Experience
- Git panel in sidebar (file changes, branch, diff viewer)
- Clickable file paths in terminal output (open in editor)
- Quick-open file viewer
