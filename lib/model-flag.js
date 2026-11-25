'use strict';
// #533 / #525 - the ONE owner of "which model does this agent command run": the model-name check, where
// `--model <m>` goes in a command, and which model a command names. Every consumer (POST /api/sessions,
// the supervisor dispatcher's config) imports it; nobody keeps a copy of the pattern or the placement.
//
// The flag belongs INSIDE the claude call, so the command is read as a shell line (lib/launch-prompt.js
// `tokenize`, the parser the launch-prompt strip trusts): `--model <m>` goes right after the program
// word, before any `;` `&&` `|` that ends the call and before its prompt. Appending to the end of the
// line, as the first cut did, put it on `exit` in `claude "go"; exit` and on `bash` in `... || bash`:
// claude then ran on the default model while the answer named the requested one. A command that has
// no claude call, or that cannot be read exactly as bash reads it, is REFUSED with the reason - never
// guessed at and never silently left without the flag.

const agents = require('./agents');
const { tokenize, programIndex } = require('./launch-prompt');

/// A model name: an alias or id (`sonnet`, `claude-sonnet-5-5`), with Claude's optional context
/// suffix (`opus[1m]`). Never a flag (`--print`) and nothing a shell acts on. THE one pattern.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\[[0-9a-z]{1,8}\])?$/;
const BARE = /^[A-Za-z0-9._-]+$/;

const isClaudeProgram = (word) => agents.commandLaunches('claude', word);

/** { model: string|null } for an absent value, { model } for a valid name, { error } otherwise. */
function parseModel(v) {
  if (v === undefined || v === null || v === '') return { model: null };
  if (typeof v !== 'string' || !MODEL_RE.test(v)) return { error: 'model must be a model name such as sonnet, opus or claude-sonnet-5-5' };
  return { model: v };
}

/// The claude call of a command: its tokens (program word first) up to the operator that ends it, or an
/// `error` saying why there is none to place a flag in.
function claudeCall(cmd) {
  const toks = tokenize(String(cmd == null ? '' : cmd));
  if (!toks) return { error: 'the command cannot be read as a plain shell line, so --model cannot be placed in it' };
  const k = programIndex(toks, isClaudeProgram);
  if (k < 0) return { error: 'model is only for claude sessions: the command has no claude call' };
  let end = k + 1;
  while (end < toks.length && !toks[end].op) end++;
  return { toks, k, argv: toks.slice(k + 1, end) };
}

/// The model the claude call NAMES (`--model x` or `--model=x`), else null. A WORD that is exactly `--model`
/// (or starts `--model=`) before `--` counts, wherever it stands: a `--model` inside a quoted prompt is one
/// word with other text in it and does not. No flag's value is skipped, because the grammar knows only the
/// bare and variadic flags - a flag with an optional value (`--resume`, `--debug`) would swallow a real
/// `--model` after it, and the flag would then be added over the user's own (commander: the last wins).
/// A flag whose value is literally the word `--model` reads as the flag; the result is that nothing is added.
/// The LAST one wins, as it does in claude (commander), so the answer is the model that runs.
function ownModel(argv) {
  let named = null;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i].text;
    if (t === '--') break;
    if (t === '--model') {
      const v = i + 1 < argv.length ? argv[i + 1].text : null;
      named = v && v[0] !== '-' ? v : null; // a dangling `--model`, or one followed by a flag, names no model
    } else if (t.startsWith('--model=')) named = t.slice('--model='.length) || null;
  }
  return named;
}

/** The model a command names, else null (also null when it has no claude call or cannot be read). */
function modelOf(cmd) {
  const c = claudeCall(cmd);
  return c.error ? null : ownModel(c.argv);
}

/** [cmd] running [model]: `{ cmd }` with `--model <model>` right after the claude program word, unchanged when
 *  [model] is null or the call already names one (its own choice wins); `{ error }` when it cannot go. */
function applyModel(cmd, model) {
  if (!model) return { cmd };
  const c = claudeCall(cmd);
  if (c.error) return { error: c.error };
  if (ownModel(c.argv) != null) return { cmd };
  const at = c.toks[c.k].end;
  const value = BARE.test(model) ? model : `'${model}'`; // `[1m]` is a glob in bash: quoted, never left bare
  return { cmd: `${cmd.slice(0, at)} --model ${value}${cmd.slice(at)}` };
}

/** [cmd] for a caller that owns its command (the dispatcher): the model placed when it can be, the command
 *  as written when it cannot. A client's request goes through `applyModel`, which says why not. */
function withModel(cmd, model) {
  const r = applyModel(cmd, model);
  return r.error ? cmd : r.cmd;
}

module.exports = { parseModel, applyModel, withModel, modelOf, MODEL_RE };
