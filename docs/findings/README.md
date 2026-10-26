# Findings archive

`CLAUDE.md` in the repo root is loaded into every Claude Code session, and it has a hard
**150,000-character** limit. On 2026-09-15 it reached 151,814 and stopped loading at all —
which is the worst possible failure for a file whose entire job is to be present.

So the two kinds of writing that had grown up together were separated:

| | lives in | why |
|---|---|---|
| **the law** — what you must and must not do, which module owns each rule, the symptom to recognise | `CLAUDE.md` | it has to be in context *before* the edit, or it binds nothing |
| **the evidence** — measurement tables, probe recipes, refuted hypotheses, review post-mortems, superseded corrections | here | it is read when you reopen an issue, not on every session |

The move was **verbatim**. Nothing was summarised or dropped on the way in; the duplicate
paragraphs an incremental edit had left behind were removed, and that is all.

**Second step, 2026-10-26: `CLAUDE.md` became a digest** (~97k → ~25k characters, so every
turn of every session re-reads about 18k fewer tokens). It now holds one line per rule,
grouped by area, each area naming its file here. The long-form law prose it used to carry
was moved here **verbatim** too:

- where a section here already covered the same rule, the paragraphs that were not already
  here sit at the top of that section, between a **"Law, as `CLAUDE.md` stated it until
  2026-10-26"** line and an *"End of the moved law text"* line;
- the sections with no counterpart here (overview, gates, architecture, security, tests,
  deploy, cluster) moved whole into [`operations.md`](operations.md);
- every rule was triaged against the CODE first (KEEP / MERGE / OBSOLETE / STALE). The
  few whose claim the code had overtaken went to [`retired-rules.md`](retired-rules.md),
  verbatim, each with the evidence that retired it.

## The files

| file | covers |
|---|---|
| [`input-submit.md`](input-submit.md) | the #55 input/submit contract in full — #44 #137 #138 #146 #147 #179 #190 #201 #204 #206 #209 #213 #218 |
| [`agents-codex.md`](agents-codex.md) | the multi-agent registry, Codex empirics, the hooks investigation, OSC 9 — #73 #78 #142 #191 #227 |
| [`questions.md`](questions.md) | AskUserQuestion layouts, keys, notes and free text — #19 #84 #143 #145 #236 #239 |
| [`chat-lens.md`](chat-lens.md) | the session recap, queued prompts, the tail strip, scrollback, the companion widget layer — #81 #83 #167 #176 #178 #194 #210 #249 |
| [`retired-rules.md`](retired-rules.md) | rules the code has overtaken — kept verbatim, with the evidence; none of them binds |
| [`operations.md`](operations.md) | the pre-digest full text of overview, gates, architecture inventory, auth and security (#257 #264), test config (#240), deploy and operations, cluster |

## Rules for this directory

- **Read the covering file before reopening any issue it names.** Most of these issues have
  already been reopened once on a premise the archive falsifies in a line.
- **New measurements go here, not into `CLAUDE.md`.** A measurement kept in `CLAUDE.md` is a
  law nobody can load.
- **Every table records the agent version it was taken against.** A claude or codex release
  can move any of these numbers and no unit test will catch it — a changed glyph, spacing,
  paste threshold or banner needs a rig re-probe.
- **When a law in `CLAUDE.md` and the evidence here disagree, the evidence is older.** It
  says how the number was obtained and against what; go and re-measure rather than pick one.
- **The digest line in `CLAUDE.md` is the only current law; the moved law text here is
  frozen history**, the full form of that line as of 2026-10-26. Change a rule in `CLAUDE.md`;
  if its reasoning changed, add a dated note here rather than editing the frozen text. Never
  let a rule exist only here — if it binds, it needs a line in `CLAUDE.md`. The one
  exception is DORMANT code (Codex, `app.html`): `CLAUDE.md` keeps their never-do rules
  and a pointer to the file here, which holds the rest and must be read before touching it.
- **Captures are deliberately not checked in.** An Agent View frame names every Claude
  session on the machine, and an idle frame carries a status line naming a project and a
  user. This repo is public: keep the numbers, drop the bytes.
