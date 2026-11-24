'use strict';
// #533 / #525 - the ONE owner of "which model does this agent command run". `--model <m>` is added to a
// command unless the command already names one (its own choice wins). A model name reaches a shell command
// line, so it is validated here, never sanitised: a name outside the pattern is refused.

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\[[0-9a-z]{1,8}\])?$/;
const HAS_MODEL_RE = /(^|\s)--model(\s|=|$)/;

/** { model: string|null } for an absent value, { model } for a valid name, { error } otherwise. */
function parseModel(v) {
  if (v === undefined || v === null || v === '') return { model: null };
  if (typeof v !== 'string' || !MODEL_RE.test(v)) return { error: 'model must be a model name such as sonnet, opus or claude-sonnet-5-5' };
  return { model: v };
}

/** [cmd] running [model]: `--model <model>` added unless [cmd] already names a model or [model] is null. */
function withModel(cmd, model) {
  if (!model || HAS_MODEL_RE.test(cmd)) return cmd;
  return `${cmd} --model ${model}`;
}

/** The model a command names (`--model x` or `--model=x`), else null. */
function modelOf(cmd) {
  const m = /(?:^|\s)--model(?:\s+|=)(\S+)/.exec(String(cmd || ''));
  return m ? m[1] : null;
}

module.exports = { parseModel, withModel, modelOf, MODEL_RE };
