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

## The files

| file | covers |
|---|---|
| [`input-submit.md`](input-submit.md) | the #55 input/submit contract in full — #44 #137 #138 #146 #147 #179 #190 #201 #204 #206 #209 #213 #218 |
| [`agents-codex.md`](agents-codex.md) | the multi-agent registry, Codex empirics, the hooks investigation, OSC 9 — #73 #78 #142 #191 #227 |
| [`questions.md`](questions.md) | AskUserQuestion layouts, keys, notes and free text — #19 #84 #143 #145 #236 #239 |
| [`chat-lens.md`](chat-lens.md) | the session recap, queued prompts, the tail strip, scrollback, the companion widget layer — #81 #83 #167 #176 #178 #194 #210 #249 |

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
- **Captures are deliberately not checked in.** An Agent View frame names every Claude
  session on the machine, and an idle frame carries a status line naming a project and a
  user. This repo is public: keep the numbers, drop the bytes.
