// eslint.config.js — ESLint v9+ flat config for web-terminal
// CommonJS project (no "type":"module" in package.json), Node >=18, Node 22 in practice.
// Browser JS lives inline in .html files — ESLint does not lint inline HTML without a
// plugin, so there are no browser-globals blocks here.  sw.js runs in a ServiceWorker
// context (browser-like) and is listed in the ignores below.

'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // ── Global ignores ─────────────────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'test-results/**',
      'scrollback/**',
      'logs/**',
      'clipboard-images/**',
      'coverage/**',
      // Local scratch / one-off files not part of the shipped codebase
      'check-server.js',
      'evloop-test.js',
      'local-burst-test.js',
      'pty-test.js',
      'pty-test2.js',
      'raw-pipe-test.js',
      'server-evloop.js',
      // Service-worker runs in a browser ServiceWorker context; skip for now
      // (would need browser + serviceworker globals — add a plugin if desired)
      'sw.js',
      // SSL dir (certs, not JS)
      'ssl/**',
    ],
  },

  // ── Server-side Node / CommonJS files ──────────────────────────────────────
  {
    files: [
      'server.js',
      'monitor.js',
      'pty-worker.js',
      'claude-hook.js',
      'fix-hooks.js',
      'setup-autostart.js',
      'upgrade-node.js',
      'smoke-test-hot-reload.js',
      'smoke-test-longproc.js',
      'playwright.config.js',
      'lib/**/*.js',
      'scripts/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      // Downgrade unused-vars to warn; ignore leading-underscore params/vars
      'no-unused-vars': ['warn', {
        vars: 'all',
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // `catch (e)` that ignores the error is a deliberate fail-closed pattern
        // throughout this codebase — don't flag unused caught bindings.
        caughtErrors: 'none',
      }],

      // Empty catch blocks are common for intentional swallowing
      'no-empty': ['error', { allowEmptyCatch: true }],

      // console.log is used everywhere in a server app — keep it
      'no-console': 'off',

      // Prototype builtins (hasOwnProperty etc.) — warn only
      'no-prototype-builtins': 'warn',

      // Constant conditions appear in intentional while(true) loops
      'no-constant-condition': ['error', { checkLoops: false }],

      // These fire a lot in existing code with no real bug risk
      'no-fallthrough': 'warn',

      // Terminal/ANSI code legitimately matches control chars (\x1b, \x00, \x1f)
      // in regexes — this is the domain of the app, not a mistake.
      'no-control-regex': 'off',

      // Defensive `let x = false` initializers that get overwritten before use
      // are an intentional fail-closed pattern here, not dead code.
      'no-useless-assignment': 'warn',

      // Harmless redundant escapes — warn rather than block.
      'no-useless-escape': 'warn',
    },
  },

  // ── Test files (Playwright) — Node + some browser globals ──────────────────
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        // Playwright test globals
        ...globals.browser,
        // App-internal globals referenced inside page.evaluate() browser-context
        // callbacks (defined in app.html, not visible to the Node linter).
        // Each one must actually exist in app.html — this list documents the
        // browser context the spec runs in, it is not a way to silence a typo.
        ws: 'readonly',
        clusterServers: 'readonly',
        // #152 — the two pure render helpers the resources specs call directly.
        esc: 'readonly',
        resourcesHtml: 'readonly',
        switchSession: 'readonly',
        showNotification: 'readonly',
        attentionSessions: 'readonly',
        sessionHasAlert: 'readonly',
        maybeClearAttention: 'readonly',
        handleAttentionCleared: 'readonly',
        pendingAlerts: 'readonly',
        // Written, not just read: a spec sets it to force a long backoff.
        reconnectAttempts: 'writable',
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      'no-unused-vars': ['warn', {
        vars: 'all',
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // `catch (e)` that ignores the error is a deliberate fail-closed pattern
        // throughout this codebase — don't flag unused caught bindings.
        caughtErrors: 'none',
      }],

      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
      'no-prototype-builtins': 'warn',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'warn',
      'no-control-regex': 'off',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
    },
  },
];
