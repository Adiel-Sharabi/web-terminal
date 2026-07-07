// @ts-check
// Unit tests for restore-time command resolution (lib/restore-command.js).
//
// Regression cover for #23 — "New session in a folder unexpectedly resumes the
// last Claude session." The old restore logic appended `--continue` to any
// claude session whose own id we hadn't recorded, which resumes the
// most-recently-modified conversation in the cwd (the "last session"). A
// restored unknown-id claude session must now start FRESH instead.

const { test, expect } = require('@playwright/test');
const { resolveRestoreRunCommand } = require('../lib/restore-command');

test.describe('resolveRestoreRunCommand', () => {
  test('#23: unknown-id claude session does NOT get an implicit --continue', () => {
    // The exact real-world config: server default command, no recorded id.
    expect(resolveRestoreRunCommand({
      autoCommand: 'claude --dangerously-skip-permissions',
      claudeSessionId: null,
    })).toBe('claude --dangerously-skip-permissions');

    // Bare claude, no id -> stays bare (fresh), never `claude --continue`.
    expect(resolveRestoreRunCommand({ autoCommand: 'claude', claudeSessionId: null }))
      .toBe('claude');
  });

  test('known id restores that exact conversation with --resume <id>', () => {
    expect(resolveRestoreRunCommand({
      autoCommand: 'claude',
      claudeSessionId: 'abcd1234-5678-9abc-def0-123456789abc',
    })).toBe('claude --resume abcd1234-5678-9abc-def0-123456789abc');
  });

  test('known id preserves other flags and replaces any stale continue/resume', () => {
    expect(resolveRestoreRunCommand({
      autoCommand: 'claude --dangerously-skip-permissions',
      claudeSessionId: 'eeee1111-2222-3333-4444-555566667777',
    })).toBe('claude --dangerously-skip-permissions --resume eeee1111-2222-3333-4444-555566667777');

    // A stale --continue in the persisted command is stripped before appending
    // the canonical --resume <id> (no double flag).
    expect(resolveRestoreRunCommand({
      autoCommand: 'claude --continue',
      claudeSessionId: 'eeee1111-2222-3333-4444-555566667777',
    })).toBe('claude --resume eeee1111-2222-3333-4444-555566667777');

    // A stale --resume <old> is replaced by the recorded id.
    expect(resolveRestoreRunCommand({
      autoCommand: 'claude --resume 00000000-0000-0000-0000-000000000000',
      claudeSessionId: 'eeee1111-2222-3333-4444-555566667777',
    })).toBe('claude --resume eeee1111-2222-3333-4444-555566667777');
  });

  test('explicit user --continue is honored even without a recorded id', () => {
    // The user deliberately typed --continue: respect their intent verbatim.
    expect(resolveRestoreRunCommand({ autoCommand: 'claude --continue', claudeSessionId: null }))
      .toBe('claude --continue');
  });

  test('explicit user --resume <id> is honored even without a recorded id', () => {
    expect(resolveRestoreRunCommand({
      autoCommand: 'claude --resume face0000-1111-2222-3333-444455556666',
      claudeSessionId: null,
    })).toBe('claude --resume face0000-1111-2222-3333-444455556666');
  });

  test('non-claude commands are returned unchanged', () => {
    expect(resolveRestoreRunCommand({ autoCommand: 'echo hello', claudeSessionId: null }))
      .toBe('echo hello');
    // Even with an id somehow present, a non-claude command is untouched.
    expect(resolveRestoreRunCommand({ autoCommand: 'npm run dev', claudeSessionId: 'x' }))
      .toBe('npm run dev');
  });

  test('empty / missing autoCommand yields empty string', () => {
    expect(resolveRestoreRunCommand({ autoCommand: '', claudeSessionId: null })).toBe('');
    expect(resolveRestoreRunCommand({ claudeSessionId: null })).toBe('');
    expect(resolveRestoreRunCommand({})).toBe('');
  });
});
