'use strict';

/// Which background commands a session still has RUNNING.
///
/// Why this exists: a session's status tracks the AGENT'S TURN, not the work
/// running inside it. `run_in_background` returns the moment the command is
/// *launched*, so PostToolUse fires at once, the turn ends, `Stop` flips the
/// session to idle — and the dot goes green while a build is still running.
/// Reported live on Office ("Launch host unit-test gate" mid-build, session
/// showing idle). Status is left alone on purpose: from the agent's point of
/// view it really is idle. This is the separate fact the dot cannot carry.
///
/// The transcript is the source of truth because it records BOTH ends, so no
/// new hook (and no cold restart) is needed:
///   launch → a tool_result reading
///            "Command running in background with ID: <id>. Output is being…"
///   finish → a `<task-notification>` block carrying `<task-id><id></task-id>`
///            (measured statuses: `completed`, `killed`)
/// Running = launched − finished. Both halves are in the same file, and a
/// finish always follows its launch, so reading a TAIL can only ever miss a
/// pair entirely — never report a finished task as still running.
///
/// Subagents emit task-notifications too, under their own ids. Those ids were
/// never launched as background commands, so they match nothing and are
/// ignored — a finish is only ever applied to an id we actually saw launch.
module.exports = { scanBackgroundTasks };

const LAUNCH_RE = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/g;
const TASK_ID_RE = /<task-id>\s*([^<\s]+)\s*<\/task-id>/g;

function textOf(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(textOf).join(' ');
  return '';
}

/// Scan transcript JSONL [text] (a whole file or a tail) for background commands
/// that launched and have not reported finishing.
///
/// Returns `[{ id, description, startedAt }]`, oldest first. `description` is
/// the launching tool_use's own description when that line is still in the
/// window (a tail can cut it off), else ''. `startedAt` is the launching line's
/// timestamp in ms, or null — the caller uses it as the stuck-badge backstop.
///
/// Never throws: a tail's first line is usually a partial JSON fragment, and a
/// transcript may carry shapes this does not know.
function scanBackgroundTasks(text) {
  const launched = new Map(); // background id -> { id, description, startedAt }
  const finished = new Set();
  const describedBy = new Map(); // tool_use id -> description

  for (const line of String(text || '').split('\n')) {
    if (!line) continue;

    // A finish is plain text in an injected message — match it on the raw line
    // so it is found however the block happens to be nested.
    if (line.includes('<task-notification>')) {
      TASK_ID_RE.lastIndex = 0;
      let m;
      while ((m = TASK_ID_RE.exec(line)) !== null) finished.add(m[1]);
    }

    const looksLikeLaunch = line.includes('Command running in background with ID:');
    const looksLikeBash = line.includes('run_in_background');
    if (!looksLikeLaunch && !looksLikeBash) continue;

    let obj = null;
    try { obj = JSON.parse(line); } catch { obj = null; }
    const blocks = obj && obj.message && Array.isArray(obj.message.content)
      ? obj.message.content
      : null;

    if (!blocks) continue;

    const startedAt = Date.parse(obj.timestamp || '') || null;
    for (const b of blocks) {
      if (b && b.type === 'tool_use' && b.name === 'Bash' &&
          b.input && b.input.run_in_background === true) {
        describedBy.set(b.id, String(b.input.description || '').slice(0, 120));
      }
      // A launch counts ONLY when the result points back at a run_in_background
      // Bash tool_use in this window. That pairing is the sole way to tell a real
      // launch from the same sentence merely QUOTED — which happens for real: a
      // session that greps transcripts records "Command running in background
      // with ID: …" as ordinary tool output, and matching on the text alone
      // reported 12 long-finished builds as running against a live transcript.
      // The tool_use and its result are written as adjacent lines, so requiring
      // the pair costs essentially nothing even when reading a tail.
      if (b && b.type === 'tool_result' && describedBy.has(b.tool_use_id)) {
        const body = textOf(b);
        if (!body.includes('Command running in background with ID:')) continue;
        LAUNCH_RE.lastIndex = 0;
        let m;
        while ((m = LAUNCH_RE.exec(body)) !== null) {
          const id = m[1];
          if (launched.has(id)) continue;
          launched.set(id, {
            id,
            description: describedBy.get(b.tool_use_id) || '',
            startedAt,
          });
        }
      }
    }
  }

  const out = [];
  for (const [id, task] of launched) if (!finished.has(id)) out.push(task);
  return out;
}
