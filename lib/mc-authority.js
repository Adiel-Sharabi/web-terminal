'use strict';
// #501/#503 - Mission Control: which server answers `/api/mc/*`.
//
// Cluster-wide Mission Control state is computed on ONE server: the lease authority, the same
// one the supervisor runs on (lib/leases.js resolveAuthority). This is the rule for every
// `/api/mc/*` route; the server only applies it (docs/mission-control.md "Who answers").

/** null when this server answers (it is the authority, or none is configured), else the
 *  `{status, json}` to answer with: 409 naming the authority, or 503 explaining a config
 *  that names no server this one knows. */
function mcRefusal(authority) {
  const a = authority || { mode: 'none' };
  if (a.mode === 'self' || a.mode === 'none') return null;
  if (a.mode === 'remote') return { status: 409, json: { role: 'peer', authority: { name: a.name, url: a.url } } };
  return { status: 503, json: { error: `Mission Control has no authority: ${a.error || 'leases.authority is not valid'}` } };
}

module.exports = { mcRefusal };
