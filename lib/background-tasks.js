'use strict';

/// Which background work a session still has RUNNING - everything that could wake it.
///
/// Why this exists: a session's status tracks the AGENT'S TURN, not the work
/// running inside it. `run_in_background` returns the moment the command is
/// *launched*, so PostToolUse fires at once, the turn ends, `Stop` flips the
/// session to idle - and the dot goes green while a build is still running.
/// Reported live on Office ("Launch host unit-test gate" mid-build, session
/// showing idle). Status is left alone on purpose: from the agent's point of
/// view it really is idle. This is the separate fact the dot cannot carry.
///
/// #443: the same list is what decides whether a session that reported "I'll resume
/// on my own" (`wait: self`) still has anything that could resume it (lib/handoff.js
/// isStaleSelf, lib/session-reason.js). Background shells were only one of the things
/// that wake a Claude session. A 2026-11-09 scan of 1,881 transcripts found async
/// subagents, Monitors, ScheduleWakeup and cron behind most legitimate multi-hour
/// self-waits, so each is a KIND here (`kind` on every entry):
///
///   command  Bash run_in_background
///            launch  the tool_result "Command running in background with ID: <id>",
///                    paired with its run_in_background Bash tool_use
///            end     ANY <task-notification> for <id> (measured: completed, failed,
///                    killed), or a TaskStop/KillShell naming it
///   agent    an async subagent (Agent/Task tool). Most async launches do NOT carry
///            run_in_background in their input, so the launch is read off the RESULT:
///            launch  toolUseResult { isAsync: true, agentId } on a result paired with
///                    an Agent/Task tool_use (text fallback "Async agent launched" +
///                    "agentId: <id>")
///            end     any <task-notification> for <agentId> (every measured one carried
///                    <status>), or TaskStop naming it
///            revive  SendMessage's result { resumedAgentId } - a finished agent runs
///                    again, so the LATEST of resume/finish decides (by timestamp)
///   monitor  the Monitor tool
///            launch  toolUseResult { taskId, timeoutMs, persistent } on a paired result
///            end     a notification for <taskId> that carries <status>, or Claude
///                    Code's "[Monitor expired" notice, or TaskStop naming it, or
///                    `timeoutMs` elapsing (`until`; a persistent monitor has none).
///                    Its ordinary notifications are EVENTS ("Monitor event: ..."),
///                    and they do NOT end it - the rule that ends a command would
///                    have dropped every monitor at its first event.
///   wakeup   ScheduleWakeup - one pending wake per session, so the LATEST call wins
///            launch  toolUseResult { scheduledFor } (ms; the tool clamps to <= 1 h)
///            end     `scheduledFor` (+ a short grace) passing, or a later call with
///                    `stop: true` (from the tool's schema; no stop call was observed, and
///                    `noop: true` calls still return scheduledFor and are counted)
///   cron     CronCreate
///            launch  toolUseResult { id, recurring, nextFireAt }; also any
///                    `scheduled_task_fire` system line (it carries taskId), so a job
///                    whose create has scrolled out of the window is still seen
///            end     CronDelete naming it; a one-shot that has fired, or whose fire
///                    time has passed; a recurring job 6 h after its last sign of life
///                    (created, last fire, or a first fire still ahead), capped by the
///                    7-day auto-expiry
///
/// A known end instant travels as `until` (ms). The caller drops an entry at `until`
/// (notEnded) and does NOT apply its age backstop to it: the end is a fact, not a guess.
///
/// Known gap, kept on purpose: all of these live INSIDE the Claude process. If it
/// exits or restarts (a worker cold restart, a crash), its subagents, monitors and
/// session-only crons die without writing an end, and they read as live until their
/// own bound: `until` for monitors, wake-ups and crons (a recurring cron: 6 h after its last
/// fire), the caller's age backstop for commands and agents. The spawn reaper and the restart
/// hold read the list UNAGED (server.js reaperRunningWork, by design: see lib/spawn-reaper.js
/// hasLiveWork), so for them a dead agent or persistent monitor with no end keeps the session
/// until the server restarts - as a stranded command already did. The hold only ASKS such a
/// session (busyPrompt), so the cost there is a nudge. Erring toward "live" is deliberate:
/// a self-wait called stale is PROMPTED (#443 milestone 2) and taken by the automatic
/// hand-off (#437), so a miss there costs a full-context turn, while an over-long
/// "live" only delays a check-in. Detecting the restart is a separate change.
///
/// The transcript is the source of truth because it records BOTH ends, so no new hook
/// (and no cold restart) is needed. A finish always follows its launch in the file, so a
/// window that cuts the head can only miss a pair entirely - never report a finished task
/// as running. The caller feeds the file INCREMENTALLY (createBackgroundScanner), because
/// a fixed tail missed most launches that later woke a session: measured on XPS, the
/// launch sat more than 256 KB before the idle began for 23% of subagent wakes, 45% of
/// monitor events and 81% of cron fires.
///
/// Notifications for ids never seen launching (teammates, workflows) match nothing and are
/// ignored - an end is only ever applied to an id we saw start.
const WORK_KINDS = Object.freeze(['command', 'agent', 'monitor', 'wakeup', 'cron', 'child']);
module.exports = { scanBackgroundTasks, createBackgroundScanner, notEnded, addChildWork, WORK_KINDS };

const LAUNCH_RE = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/g;
const NOTIF_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID_RE = /<task-id>\s*([^<\s]+)\s*<\/task-id>/;
const TS_RE = /"timestamp":"([^"]+)"/;
const AGENT_ID_RE = /agentId:\s*([A-Za-z0-9_-]+)/;
const CRON_ID_RE = /job\s+([A-Za-z0-9_-]+)/;
/// After a wake-up's or a one-shot's fire time, how long it still counts: the fire starts
/// a turn (status `working`), so this only has to cover the fire itself being late.
const FIRE_GRACE_MS = 2 * 60 * 1000;
/// Claude Code: "Auto-expires after 7 days" (measured on every recurring CronCreate result).
const CRON_RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/// How long a recurring job may go without a sign of life before it is taken as dead (the
/// same horizon as the caller's age backstop). Cost: a job that fires less often than this
/// (daily) reads as ended between fires.
const CRON_QUIET_MS = 6 * 60 * 60 * 1000;
/// Launching calls kept for pairing with their result.
const PENDING_MAX = 500;

const LAUNCH_TOOLS = new Set(['Agent', 'Task', 'Monitor', 'ScheduleWakeup', 'CronCreate', 'SendMessage']);
const PREFILTER = [
  'Command running in background with ID:', 'run_in_background', 'TaskStop', 'KillShell',
  '"Agent"', '"Task"', 'Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'scheduled_task_fire',
  'SendMessage', 'resumedAgentId', 'Async agent launched', 'isAsync', 'scheduledFor', 'nextFireAt', 'Scheduled ',
];

function textOf(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(textOf).join(' ');
  return '';
}

const short = (v, fallback) => {
  const s = typeof v === 'string' ? v.trim().slice(0, 120) : '';
  return s || fallback;
};
const finite = (v) => (Number.isFinite(v) ? v : null);

/// An incremental scan: `feed(text)` takes whole JSONL lines (a tail's first line may be a
/// fragment; it is skipped), in file order, any number of times; `running()` folds what was
/// fed into the work still running, oldest first. Never throws on transcript content.
function createBackgroundScanner() {
  const pending = new Map();   // tool_use id -> { name, input }
  const tasks = new Map();     // id -> entry (command | agent | monitor)
  const ended = new Map();     // id -> latest end timestamp (0 when the line had none)
  const terminal = new Map();  // id -> latest TERMINAL notification timestamp (monitor rule)
  const resumed = new Map();   // agent id -> latest resume timestamp
  const cron = new Map();      // job id -> { createdAt, recurring, nextFireAt, lastFireAt, cron, deleted }
  let wakeup = null;           // { at, until, cancelled }

  const endAt = (map, id, ts) => { map.set(id, Math.max(map.get(id) || 0, ts || 0)); };
  const cronOf = (id) => {
    if (!cron.has(id)) cron.set(id, { createdAt: null, recurring: null, nextFireAt: null, lastFireAt: null, cron: '', deleted: false });
    return cron.get(id);
  };

  function feedLine(line) {
    // A finish is plain text in an injected message - match it on the raw line so it is
    // found however the block happens to be nested (user turn, queued attachment, queue op).
    if (line.includes('<task-notification>')) {
      const tsm = TS_RE.exec(line);
      const ts = tsm ? (Date.parse(tsm[1]) || 0) : 0;
      NOTIF_RE.lastIndex = 0;
      let m;
      while ((m = NOTIF_RE.exec(line)) !== null) {
        const body = m[1];
        const idm = TASK_ID_RE.exec(body);
        if (!idm) continue;
        endAt(ended, idm[1], ts);
        if (body.includes('<status>') || body.includes('[Monitor expired')) endAt(terminal, idm[1], ts);
      }
    }

    if (!PREFILTER.some((p) => line.includes(p))) return;

    let obj = null;
    try { obj = JSON.parse(line); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') return;
    const ts = Date.parse(obj.timestamp || '') || null;

    // A cron fire is a system line of its own; it proves the job exists even when its
    // create has scrolled out of the window.
    if (obj.type === 'system' && obj.subtype === 'scheduled_task_fire' && typeof obj.taskId === 'string' && ts) {
      const c = cronOf(obj.taskId);
      c.lastFireAt = Math.max(c.lastFireAt || 0, ts);
      if (!c.cron && typeof obj.cron === 'string') c.cron = obj.cron;
      return;
    }

    // Claude Code also writes the API REQUEST it sent (`api-request-blob`, no timestamp): copies
    // of earlier calls and results, not events. Measured: one replayed a launch result before
    // the real line, the agent was registered with no start time, and the age backstop could
    // never drop it. A replayed END is harmless (it did happen) and is matched above.
    if (obj.type === 'api-request-blob') return;
    const blocks = obj.message && Array.isArray(obj.message.content) ? obj.message.content : null;
    if (!blocks) return;
    // The line-level structured result belongs to the line's result only when there is ONE.
    const results = blocks.filter((b) => b && b.type === 'tool_result');
    const tur = results.length === 1 && obj.toolUseResult && typeof obj.toolUseResult === 'object' ? obj.toolUseResult : null;

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        // Only the fields a launch reads: the scanner lives as long as the session, and an
        // Agent input carries its whole prompt.
        const keep = () => ({
          description: input.description, summary: input.summary, timeout_ms: input.timeout_ms,
          persistent: input.persistent, cron: input.cron, recurring: input.recurring,
        });
        if (b.name === 'Bash' && input.run_in_background === true) pending.set(b.id, { name: 'Bash', input: keep() });
        else if (LAUNCH_TOOLS.has(b.name)) pending.set(b.id, { name: b.name, input: keep() });
        // A result follows its call within a line or two (and a replay can repeat it, so an
        // entry is not dropped on first use); only the newest calls can still be paired.
        if (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
        // A task KILLED from the orchestrator gets no `<task-notification>` at all - only
        // this tool call. Read off the tool_use (not the result text) so a grep that merely
        // QUOTES "Successfully stopped task: ..." can never end one. Any string in the input
        // may be the id; only ids we saw launch can match.
        if (b.name === 'TaskStop' || b.name === 'KillShell') {
          for (const v of Object.values(input)) if (typeof v === 'string' && v) endAt(ended, v, ts);
          for (const v of Object.values(input)) if (typeof v === 'string' && v) endAt(terminal, v, ts);
        }
        if (b.name === 'CronDelete' && typeof input.id === 'string') cronOf(input.id).deleted = true;
        // Cancelling the loop is the call itself; its result says nothing more.
        if (b.name === 'ScheduleWakeup' && input.stop === true && ts && (!wakeup || ts >= wakeup.at)) {
          wakeup = { at: ts, until: null, cancelled: true };
        }
        continue;
      }
      // A launch counts ONLY when the result points back at a launching tool_use in this
      // window. That pairing is the sole way to tell a real launch from the same sentence
      // merely QUOTED - which happens for real: a session that greps transcripts records
      // "Command running in background with ID: ..." as ordinary tool output, and matching
      // on the text alone reported 12 long-finished builds as running against a live
      // transcript. The tool_use and its result are written as adjacent lines.
      if (b.type !== 'tool_result' || !pending.has(b.tool_use_id) || b.is_error) continue;
      const use = pending.get(b.tool_use_id);
      const body = textOf(b);
      if (use.name === 'Bash') {
        if (!body.includes('Command running in background with ID:')) continue;
        LAUNCH_RE.lastIndex = 0;
        let m;
        while ((m = LAUNCH_RE.exec(body)) !== null) {
          if (!tasks.has(m[1])) {
            tasks.set(m[1], { id: m[1], kind: 'command', description: short(use.input.description, ''), startedAt: ts });
          }
        }
      } else if (use.name === 'Agent' || use.name === 'Task') {
        let id = tur && tur.isAsync === true && typeof tur.agentId === 'string' ? tur.agentId : null;
        if (!id && body.includes('Async agent launched')) { const m = AGENT_ID_RE.exec(body); if (m) id = m[1]; }
        if (id && !tasks.has(id)) {
          tasks.set(id, { id, kind: 'agent', description: short(use.input.description, 'subagent'), startedAt: ts });
        }
      } else if (use.name === 'SendMessage') {
        const id = tur && (typeof tur.resumedAgentId === 'string' ? tur.resumedAgentId
          : typeof tur.revivedAgentId === 'string' ? tur.revivedAgentId : null);
        if (!id || !ts) continue;
        resumed.set(id, Math.max(resumed.get(id) || 0, ts));
        // A revived agent's run starts NOW: keeping its first launch time aged it out at once.
        const prev = tasks.get(id);
        if (!prev) tasks.set(id, { id, kind: 'agent', description: short(use.input.summary, 'subagent'), startedAt: ts });
        else if (!(prev.startedAt >= ts)) prev.startedAt = ts;
      } else if (use.name === 'Monitor') {
        const id = tur && typeof tur.taskId === 'string' ? tur.taskId : null;
        if (!id || tasks.has(id)) continue;
        const timeoutMs = finite(tur.timeoutMs) ?? finite(use.input.timeout_ms);
        const persistent = tur.persistent === true || use.input.persistent === true;
        const entry = { id, kind: 'monitor', description: short(use.input.description, 'monitor'), startedAt: ts };
        if (!persistent && ts && timeoutMs !== null && timeoutMs > 0) entry.until = ts + timeoutMs;
        tasks.set(id, entry);
      } else if (use.name === 'ScheduleWakeup') {
        // Timestamp required: "the latest call wins" needs an order, and replayed lines carry none.
        const at = tur ? finite(tur.scheduledFor) : null;
        if (!ts || at === null || (wakeup && ts < wakeup.at)) continue;
        wakeup = { at: ts, until: at + FIRE_GRACE_MS, cancelled: false };
      } else if (use.name === 'CronCreate') {
        let id = tur && typeof tur.id === 'string' ? tur.id : null;
        if (!id) { const m = CRON_ID_RE.exec(body); if (m && body.startsWith('Scheduled')) id = m[1]; }
        if (!id) continue;
        const c = cronOf(id);
        if (c.createdAt === null) c.createdAt = ts;
        c.recurring = tur && typeof tur.recurring === 'boolean' ? tur.recurring
          : (typeof use.input.recurring === 'boolean' ? use.input.recurring : /recurring/i.test(body));
        c.nextFireAt = tur ? finite(tur.nextFireAt) : null;
        if (!c.cron) c.cron = short(use.input.cron, '');
      }
    }
  }

  function feed(text) {
    for (const line of String(text || '').split('\n')) {
      if (!line) continue;
      try { feedLine(line); } catch { /* a shape this does not know: skip the line */ }
    }
  }

  function running() {
    const out = [];
    for (const [id, t] of tasks) {
      if (t.kind === 'monitor') { if (terminal.has(id)) continue; }
      else if (ended.has(id)) {
        // Only an agent can run again after it ended: SendMessage revives it.
        if (!(t.kind === 'agent' && (resumed.get(id) || 0) > ended.get(id))) continue;
      }
      out.push({ ...t });
    }
    if (wakeup && !wakeup.cancelled) {
      out.push({ id: 'wakeup', kind: 'wakeup', description: 'scheduled wake-up', startedAt: wakeup.at, until: wakeup.until });
    }
    for (const [id, c] of cron) {
      if (c.deleted) continue;
      const fired = c.lastFireAt !== null;
      // A one-shot is spent once it fires. A job seen only by its fires is taken as recurring:
      // a fire is the only evidence there is, and "live" is the cheap side to err on.
      const recurring = c.recurring !== false;
      if (!recurring && fired) continue;
      const startedAt = c.createdAt ?? c.lastFireAt;
      let until;
      if (recurring) {
        // Every fire writes a line, so a job that has gone quiet for CRON_QUIET_MS past its
        // last sign of life (created, last fired, or a first fire still ahead) died with its
        // Claude process: session-only jobs write no end. Final review measured 5 of 5 dead
        // recurring jobs that the 7-day expiry alone would have kept live for 5-7 days.
        const lastSign = Math.max(c.createdAt || 0, c.lastFireAt || 0, c.nextFireAt || 0);
        until = Math.min((c.createdAt ?? c.lastFireAt) + CRON_RECURRING_TTL_MS, lastSign + CRON_QUIET_MS);
      } else until = c.nextFireAt !== null ? c.nextFireAt + FIRE_GRACE_MS : null;
      const entry = { id: 'cron-' + id, kind: 'cron', description: c.cron ? `scheduled task (${c.cron})` : 'scheduled task', startedAt };
      if (Number.isFinite(until)) entry.until = until;
      out.push(entry);
    }
    out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    return out;
  }

  return { feed, running };
}

/// Scan transcript JSONL [text] (a whole file or a tail) for background work that started
/// and has not ended. Returns `[{ id, kind, description, startedAt, until? }]`, oldest
/// first. `description` is the launching tool_use's own description when that line is in
/// the window, else a generic label ('' for a command, as before). `startedAt` is the
/// launching line's timestamp in ms, or null.
function scanBackgroundTasks(text) {
  const s = createBackgroundScanner();
  s.feed(text);
  return s.running();
}

/// [tasks] without the ones whose known end (`until`) is at or before [now]. Applied on
/// every read, cached or not: an end is a property of NOW, not of the scan.
function notEnded(tasks, now) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => !(t && Number.isFinite(t.until) && t.until <= now));
}

/// Statuses in which a child session is still doing something (`active`: booting or
/// printing; `waiting`: it owes the person an answer and carries on after it).
const CHILD_LIVE_STATUSES = new Set(['working', 'waiting', 'active']);

/// #443 - a parent waiting on child sessions it opened (#374 `spawn.parentId`) is waiting
/// on live work while any child is. Appends a `kind: 'child'` entry to each such parent's
/// `backgroundTasks`, so the reason row and isStaleSelf read it like any other work.
///
/// A child is live when its status is working/waiting/active, it is compacting, an armed
/// usage cap will resume it, it has live background work of its own, or it has a live
/// child (any depth; a cycle counts as nothing). A child that is idle and done is NOT live:
/// nothing in the parent will wake it - the lost-watcher shape #443 exists for.
///
/// Reads only rows in [rows], so it sees children on THIS server: a child opened on a peer
/// is not counted (known gap; the clients merge peers client-side). A row whose
/// `backgroundTasks` is not an array (unknown) is left alone. Mutates and returns [rows].
function addChildWork(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [];
  const byId = new Map(list.map((r) => [r.id, r]));
  const kids = new Map();
  for (const r of list) {
    const pid = r.spawn && typeof r.spawn.parentId === 'string' ? r.spawn.parentId : null;
    if (!pid || pid === r.id || !byId.has(pid)) continue;
    if (!kids.has(pid)) kids.set(pid, []);
    kids.get(pid).push(r);
  }
  if (!kids.size) return rows;
  const memo = new Map();
  const live = (r, seen) => {
    if (memo.has(r.id)) return memo.get(r.id);
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    const cap = r.usageLimit;
    const own = Array.isArray(r.backgroundTasks) && r.backgroundTasks.some((t) => t && !t.stale);
    const v = CHILD_LIVE_STATUSES.has(r.status) || r.compacting === true || own ||
      !!(cap && cap.waiting && cap.armed) ||
      (kids.get(r.id) || []).some((k) => live(k, seen));
    memo.set(r.id, v);
    return v;
  };
  // Decide every verdict BEFORE appending, so a parent's new child entries never feed back.
  const add = [];
  for (const [pid, children] of kids) {
    const liveKids = children.filter((k) => live(k, new Set([pid])));
    if (liveKids.length) add.push([byId.get(pid), liveKids]);
  }
  for (const [parent, liveKids] of add) {
    if (!Array.isArray(parent.backgroundTasks)) continue;
    parent.backgroundTasks = [...parent.backgroundTasks, ...liveKids.map((k) => ({
      id: 'child-' + k.id,
      kind: 'child',
      description: typeof k.name === 'string' && k.name.trim() ? `session ${k.name.trim().slice(0, 100)}` : 'child session',
      startedAt: k.spawn && Number.isFinite(k.spawn.createdAt) ? k.spawn.createdAt : null,
    }))];
  }
  return rows;
}
