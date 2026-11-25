'use strict';
// #533 - which model a started session runs, chosen by the KIND of work: the ONE owner of the
// kinds, the model each suggests, what Start work may be asked for, and the line the session's
// brief carries. Pure. Placing the flag in a command is lib/model-flag.js's (never repeated here).
//
// The rule (owner, 2026-10-19 / 2026-11-24): a routine fix, a small feature, a watch / deploy / merge
// run -> Sonnet; a narrow lookup, status check or build -> Haiku; a design-heavy, ambiguous or
// security milestone -> the DEFAULT model (no flag: the strongest one the command runs). The picker
// shows the suggestion and the person may override it.

const { parseModel, applyModel } = require('./model-flag');

/** The choice that means "no flag": whatever model the start command and the CLI run. */
const DEFAULT_MODEL = 'default';

/** The kinds of work, in the order a picker shows them. `model` null = the default model.
 *  `why` finishes the sentence "Model: <m> for ..." in the session's brief (plain words). */
const KINDS = Object.freeze([
  { id: 'fix', label: 'Routine fix or small feature', model: 'sonnet', why: 'a routine fix or small feature' },
  { id: 'run', label: 'Watch, deploy or merge run', model: 'sonnet', why: 'a watch, deploy or merge run' },
  { id: 'lookup', label: 'Lookup, status check or build', model: 'haiku', why: 'a lookup, status check or build' },
  { id: 'design', label: 'Design, ambiguous or security work', model: null, why: 'design, ambiguous or security work' },
].map(Object.freeze));

/** The models Start work offers beside the default (any name POST /api/sessions takes is accepted
 *  in a request; the picker lists these). */
const MODELS = Object.freeze([
  { id: DEFAULT_MODEL, label: 'Default model' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
].map(Object.freeze));

/** The kind a start begins on, by what it starts: work items are routine fixes; a bug hunt is
 *  open-ended investigation, which the owner's rule keeps on the stronger model. */
const DEFAULT_KIND = Object.freeze({ subjects: 'fix', hunt: 'design' });

const kindById = (id) => KINDS.find((k) => k.id === id) || null;

/** Can `--model` be placed in [startCommand] (the authority's `mc.startCommand`)? Asked of the one owner of
 *  the placement (lib/model-flag.js `applyModel`), never answered by a second reading of the command: it
 *  cannot for a command with no claude call (`codex --full-auto`) or one the shell reader refuses (a
 *  backslash Windows path, which bash reads as escapes). A start that names a model on such a command is a
 *  400, so the picker is not drawn for it. Which named model is probed does not matter: the error is about
 *  the command. No command at all cannot take it either. */
function modelPlaceable(startCommand) {
  const probe = MODELS.find((m) => m.id !== DEFAULT_MODEL);
  return !applyModel(startCommand, probe ? probe.id : 'sonnet').error;
}

/** GET /api/mc/models - everything a client needs to draw the picker. Its presence is also how a
 *  client knows the server it asks takes `kind` / `model` at all (an older one answers 404).
 *  `modelPlaceable: false` = the start command cannot take the flag: the client draws no picker and sends
 *  no `kind` / `model`, exactly as for an older authority, so a start that worked before still works. */
function catalogue(startCommand) {
  return {
    kinds: KINDS.map((k) => ({ id: k.id, label: k.label, model: k.model })),
    models: MODELS.map((m) => ({ id: m.id, label: m.label })),
    defaults: { ...DEFAULT_KIND },
    defaultModel: DEFAULT_MODEL,
    modelPlaceable: modelPlaceable(startCommand),
  };
}

/** The `kind` and `model` of a start request. `{choice}`: null when the request names neither (the
 *  session runs as it did before the picker: no flag, no line in its brief), else
 *  `{kind, model, suggested}` - `kind` the kind id or null, `model` the name to run or null for the
 *  default model, `suggested` the kind's own model (null for the default model too) or undefined
 *  without a kind. A `model` wins over the kind's suggestion. `{error}` in words for a person. */
function parseChoice(body) {
  const b = body && typeof body === 'object' ? body : {};
  const hasKind = b.kind !== undefined && b.kind !== null && b.kind !== '';
  const hasModel = b.model !== undefined && b.model !== null && b.model !== '';
  if (!hasKind && !hasModel) return { choice: null };
  let kind = null;
  if (hasKind) {
    kind = typeof b.kind === 'string' ? kindById(b.kind) : null;
    if (!kind) return { error: `kind must be one of ${KINDS.map((k) => k.id).join(', ')}` };
  }
  let model = kind ? kind.model : null;
  if (hasModel) {
    if (b.model === DEFAULT_MODEL) model = null;
    else {
      const m = parseModel(b.model);
      if (m.error) return { error: `model must be ${DEFAULT_MODEL} or a model name such as sonnet, haiku or claude-sonnet-5-5` };
      model = m.model;
    }
  }
  return { choice: { kind: kind ? kind.id : null, model, ...(kind ? { suggested: kind.model } : {}) } };
}

/** The one line of the brief a session starts from that says which model it runs and why.
 *  `effective`: the model its command really names (null = the default model): the start command
 *  may name its own, and the line says what RUNS. Plain words only: it is typed into a shell
 *  inside double quotes (lib/mc-start.js safeText). '' when the request chose nothing. */
function briefLine(choice, effective) {
  if (!choice) return '';
  const name = effective || 'the default model';
  const kind = kindById(choice.kind);
  const forWhat = kind ? ` for ${kind.why}` : '';
  let why;
  if (effective !== choice.model) why = 'the start command names its own model';
  else if (!kind) why = 'chosen when it was started';
  else if (choice.model === choice.suggested) why = 'the suggested model for this kind of work';
  else why = `chosen when it was started; the suggested model for this kind is ${kind.model || 'the default model'}`;
  return `Model: ${name}${forWhat} (${why}).`;
}

module.exports = { DEFAULT_MODEL, KINDS, MODELS, DEFAULT_KIND, kindById, modelPlaceable, catalogue, parseChoice, briefLine };
