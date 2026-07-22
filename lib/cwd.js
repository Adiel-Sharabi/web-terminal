'use strict';

/// The canonical form of a session's working directory.
///
/// A trailing separator looks harmless and is not. `claudeProjectDirName`
/// (`lib/transcript.js`) encodes a cwd by replacing EVERY non-alphanumeric
/// character with its own dash, uncollapsed — so `C:\dev\proj\` encodes one dash
/// longer than `C:\dev\proj`. The real Claude CLI never passes a trailing
/// separator, so that extra dash names a project directory that does not exist and
/// the Chat lens silently resolves nothing. Same family as #42, which was also a
/// cwd string that encoded to the wrong directory name.
///
/// So the rule lives HERE, at the one place a cwd enters the system (`POST
/// /api/sessions`), rather than in each client: the web app, the companion and any
/// later client are all fixed at once, and a hand-typed trailing slash — which
/// broke the lens long before any client pre-filled one — is normalized too.
module.exports = { normalizeCwd };

/// Strip trailing path separators, except where the separator IS the directory.
///
/// `C:\` and `/` are roots: dropping the separator changes what they mean (bare
/// `C:` is drive-RELATIVE on Windows, and `/` would become empty), so they are
/// returned untouched.
function normalizeCwd(cwd) {
  const s = String(cwd ?? '');
  if (!s) return s;
  if (/^[a-zA-Z]:[\\/]$/.test(s)) return s; // C:\  or  C:/
  if (/^[\\/]+$/.test(s)) return s; // /  or  \  or  //
  const trimmed = s.replace(/[\\/]+$/, '');
  return trimmed === '' ? s : trimmed;
}
