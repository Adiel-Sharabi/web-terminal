'use strict';
// #512 - Mission Control's "Start work": what a start request means, what the started
// session is called and told, and which machine to suggest.
//
// POST /api/mc/start creates the session through the ordinary create path (this server's
// own POST /api/sessions logic, or that route on a peer with the stored cluster token);
// this module only decides WHAT to create. GET /api/mc/machines ranks the cluster's
// machines from the cluster view the authority already holds. The binding the start
// records is lib/mc-binding.js. docs/mission-control.md "Start work" is the contract.
//
// Pure: the server passes the config, the tracker titles and the cluster view.
const { MAX_SUBJECTS } = require('./mc-binding');

/** What a session started here runs, unless config `mc.startCommand` says otherwise: the
 *  supervisor dispatcher's default (lib/supervisor-cases.js), the agent the owner runs. */
const DEFAULT_START_COMMAND = 'claude --dangerously-skip-permissions';
const NAME_MAX = 100;
const BRIEF_MAX = 500;
const AUTO_COMMAND_MAX = 500; // POST /api/sessions keeps this many characters
const GOAL_MAX = 300; // lib/spawn-store.js goalOf

/** Text that goes inside the double quotes of a launch command, which a shell then reads
 *  (bash, PowerShell or cmd.exe: whichever the machine runs). Kept: letters and digits in
 *  any script, spaces and plain punctuation. Dropped: every character any of those shells
 *  acts on inside double quotes (`` ` $ " \ ! % ^ ``, and `& | < >` for good measure) and
 *  every control character; whitespace runs become one space. */
function safeText(s, max) {
  const t = String(s == null ? '' : s)
    .replace(/[^\p{L}\p{N}\p{M} .,:;#/()'?@+=_[\]-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  // Never half a surrogate pair (a letter outside the BMP).
  const cut = /[\uD800-\uDBFF]$/.test(t.slice(0, max)) ? max - 1 : max;
  return t.slice(0, cut).trimEnd();
}

/** The characters `safeText` would drop from `s` (blanks apart: runs of spaces become one),
 *  each named once; [] when it keeps every one. A brief is REFUSED, never quietly changed. */
function droppedChars(s) {
  const out = [];
  for (const c of String(s).replace(/[\p{L}\p{N}\p{M} .,:;#/()'?@+=_[\]-]/gu, '')) {
    const name = /[\x00-\x1f\x7f]/.test(c) ? 'a line break or control character' : c;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** config `mc.startCommand`: a plain command line (letters, digits, space and `.:/\=_-`
 *  only - it is typed into a shell with the brief appended), else the default. */
function startCommand(mcCfg) {
  const c = mcCfg && typeof mcCfg.startCommand === 'string' ? mcCfg.startCommand.trim() : '';
  return c && c.length <= 200 && /^[\w .:/\\=-]+$/.test(c) ? c : DEFAULT_START_COMMAND;
}

/** The body of POST /api/mc/start, read against the configured projects (lib/projects.js
 *  validateProjects' list). `{value}` or `{error}` (a 400 in words meant for a person).
 *  `parseRef` is lib/tracker-meta.js's: a bare `#N` is qualified with the project's first
 *  repo; one the project cannot qualify is refused, never guessed. */
function parseStart(body, { projects, parseRef }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof b.project !== 'string' || !b.project) return { error: 'project is required: a project id from /api/mc/projects' };
  const project = (Array.isArray(projects) ? projects : []).find((p) => p.id === b.project);
  if (!project) return { error: `no project ${JSON.stringify(b.project.slice(0, 40))}: add it under Projects in Settings first` };
  if (b.hunt !== undefined && typeof b.hunt !== 'boolean') return { error: 'hunt must be true or false' };
  const hunt = b.hunt === true;
  if (b.subjects !== undefined && !Array.isArray(b.subjects)) return { error: 'subjects must be a list of work-item refs' };
  const raw = Array.isArray(b.subjects) ? b.subjects : [];
  if (raw.length > MAX_SUBJECTS) return { error: `at most ${MAX_SUBJECTS} work items in one start` };
  const repo = project.match.repos[0];
  const subjects = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !s.trim() || s.length > 100) return { error: 'each work item is a ref such as #123, owner/repo#123 or ado:123' };
    const r = parseRef(s.trim(), repo ? { repo } : {});
    if (!r) return { error: `not a work-item ref: ${safeText(s, 60)} (#123, owner/repo#123 or ado:123)` };
    if (r.unqualified) return { error: `${safeText(s, 20)} names no repo, and ${project.name} has no GitHub repo: write owner/repo#N or ado:N` };
    if (!subjects.some((x) => x.key === r.key)) subjects.push({ key: r.key, ref: r.ref });
  }
  if (!hunt && !subjects.length) return { error: 'pick at least one work item, or start a hunt' };
  if (typeof b.server !== 'string' || !b.server.trim() || b.server.length > 100) return { error: 'server is required: a machine name from /api/mc/machines' };
  for (const [k, max] of [['name', NAME_MAX], ['brief', BRIEF_MAX]]) {
    const v = b[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > max) return { error: `${k} must be text of at most ${max} characters` };
  }
  // The brief is typed into a shell inside double quotes: what a shell would act on there is
  // refused and named, never dropped behind the person's back.
  const bad = typeof b.brief === 'string' ? droppedChars(b.brief) : [];
  if (bad.length) return { error: `the brief is typed into a shell, so it cannot contain ${bad.join(' ')} - leave ${bad.length > 1 ? 'them' : 'it'} out` };
  const cwd = project.match.paths[0];
  if (!cwd) return { error: `${project.name} has no folder to start in: add one to its paths (Settings, Projects)` };
  return {
    value: {
      project, subjects, hunt, server: b.server.trim(), cwd,
      name: typeof b.name === 'string' ? b.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim() || null : null,
      brief: typeof b.brief === 'string' ? b.brief.replace(/ +/g, ' ').trim() || null : null,
    },
  };
}

/** The new session's name, launch command and goal, or `{error}` when the brief does not fit
 *  the launch command beside the task (refused, never cut). `titles`: tracker titles by key;
 *  the server's own words (task, title) are shortened to fit, the person's never. */
function startPlan({ project, subjects, hunt, name, brief }, { titles = {}, command = DEFAULT_START_COMMAND } = {}) {
  const first = subjects[0] || null;
  const gloss = first && titles[first.key] ? safeText(titles[first.key], 60) : '';
  const refs = subjects.map((s) => s.key);
  const what = hunt ? 'hunt' : `${first.ref}${subjects.length > 1 ? ` +${subjects.length - 1}` : ''}`;
  const autoName = `${project.name} ${what}${gloss ? ` ${gloss}` : ''}`;
  const task = hunt
    ? `Bug hunt in project ${project.name}${refs.length ? `, starting from ${refs.join(', ')}` : ''}.`
    : `Fix ${refs.join(', ')}${gloss ? ` (${gloss})` : ''} in project ${project.name}.`;
  const room = AUTO_COMMAND_MAX - command.length - 3; // a space and the two quotes
  if (brief) {
    const over = safeText(task, AUTO_COMMAND_MAX).length + 1 + brief.length - room;
    if (over > 0) return { error: `the brief is ${over} character${over === 1 ? '' : 's'} too long for this start: it shares one ${AUTO_COMMAND_MAX}-character launch command with the task` };
  }
  const prompt = safeText(brief ? `${task} ${brief}` : task, Math.max(0, room));
  return {
    name: (name || autoName).slice(0, NAME_MAX),
    autoCommand: prompt ? `${command} "${prompt}"` : command,
    goal: safeText(task, GOAL_MAX),
  };
}

const num = (v) => (Number.isFinite(v) ? v : null);

/** GET /api/mc/machines: every server of the cluster view (`servers` as
 *  /api/cluster/sessions lists them, this one first), with its sessions (`rows`, the same
 *  view's) and its restart hold (`holds[name]`: `{held, reason}`; absent = not read).
 *  `ok` = reachable, signed in and known not to be held. `suggested` = the ok machine with
 *  the fewest WORKING sessions, then the fewest sessions, then the lowest CPU, then list
 *  order; null when none is ok. */
function machinesView({ servers, rows, holds = {} }) {
  const list = Array.isArray(servers) ? servers.filter((s) => s && typeof s.name === 'string') : [];
  const sessions = Array.isArray(rows) ? rows : [];
  const machines = list.map((s, i) => {
    const mine = sessions.filter((r) => r && r.server === s.name);
    const h = holds[s.name];
    const held = h ? h.held === true : null;
    const reachable = s.online !== false && s.needsAuth !== true;
    const why = s.online === false ? 'offline'
      : s.needsAuth ? 'this server is not signed in to it'
        : held ? `restart hold${h.reason ? `: ${safeText(h.reason, 80)}` : ''}`
          : held === null ? 'its restart hold could not be read' : null;
    return {
      name: s.name, url: typeof s.url === 'string' ? s.url : null,
      ok: reachable && held === false, why,
      sessions: mine.length, working: mine.filter((r) => r.status === 'working').length,
      load: s.resources ? num(s.resources.cpuPct) : null,
      _i: i,
    };
  });
  const ranked = machines.filter((m) => m.ok).sort((a, b) => a.working - b.working || a.sessions - b.sessions
    || (a.load === null) - (b.load === null) || (a.load || 0) - (b.load || 0) || a._i - b._i);
  for (const m of machines) delete m._i;
  return { machines, suggested: ranked.length ? ranked[0].name : null };
}

module.exports = { DEFAULT_START_COMMAND, safeText, startCommand, parseStart, startPlan, machinesView };
