// Runs once, BEFORE the suite (#177).
//
// Several specs write Codex rollout fixtures into the developer's real
// `~/.codex/sessions` tree, because that is the one place the server looks. Each
// cleans up in its own `afterAll` — which does not run when a run is interrupted,
// and a leaked fixture then poisons every LATER run permanently:
//
//   * it declares `cwd: %TEMP%`, and `%TEMP%` is `WT_CWD` — the cwd every session
//     the suite creates inherits — so transcript resolution, which matches a
//     rollout to a session by cwd, serves it to sessions asserting they have no
//     transcript at all (`recap-api`, `speech-api`, `transcript-api`);
//   * being written today, it is also the NEWEST rollout on disk, which is how
//     `metrics-codex.spec.js` picks "a real rollout" (it now skips fixture years).
//
// Measured on this repo 2026-08-27: with two fixtures left over from an
// interrupted run the day before, those five specs failed; deleting only that
// tree took the same five spec files from 87 passed / 5 failed to 92 / 0.
//
// So the sweep belongs at the START of a run. A run cannot be trusted to clean up
// after itself — that is the whole defect — but it CAN refuse to inherit someone
// else's mess. The per-spec `afterAll`s stay: they keep a normal run tidy.
const { sweepCodexFixtures, FIXTURE_YEARS } = require('./test-helpers');

module.exports = async function globalSetup() {
  const removed = sweepCodexFixtures();
  if (removed) {
    console.log(
      `[setup] swept ${removed} leaked Codex fixture tree(s) `
      + `(${FIXTURE_YEARS.join('/')}) left by an earlier run`,
    );
  }
};
