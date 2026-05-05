// @ts-check
// Paste diagnostic — run against the live server to find where multiline paste
// data gets truncated.
// Run: set DIAG_PASS=yourpass && npx playwright test tests/paste-diag.spec.js --config playwright.diag.config.js
const { test, expect, request: pwRequest } = require('@playwright/test');

// Defaults to the standard test server so the test runs without any special setup.
// Override with DIAG_URL / DIAG_USER / DIAG_PASS to run against the live server.
const BASE = process.env.DIAG_URL  || 'http://localhost:17681';
const AUTH = { user: process.env.DIAG_USER || 'testuser', password: process.env.DIAG_PASS || 'testpass:colon' };

async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  return pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Cookie: setCookie?.split(';')[0] || '' } });
}

async function loginPage(page) {
  await page.goto(BASE + '/login');
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
}

const PASTE_LINE_COUNT = 70;

function makeLines(n) {
  return Array.from({ length: n }, (_, i) => `PASTE_LINE_${String(i + 1).padStart(3, '0')}`).join('\n');
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

test.describe('Paste diagnostics', () => {
  test('stage 1 – bracketedPasteMode is set before first paste', async ({ page }) => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'paste-diag-bpm' } });
    const { id: sid } = await createRes.json();

    try {
      await loginPage(page);
      await page.goto(BASE + '/app');

      // Switch to our session
      await page.evaluate(id => {
        if (typeof switchSession === 'function') switchSession(id);
      }, sid);

      // Poll bracketedPasteMode up to 6 s
      const bpmHistory = [];
      let gotBpm = false;
      for (let i = 0; i < 24; i++) {
        await page.waitForTimeout(250);
        const bpm = await page.evaluate(() =>
          window.term?._core?.coreService?.decPrivateModes?.bracketedPasteMode ?? null
        );
        bpmHistory.push({ ms: (i + 1) * 250, bpm });
        if (bpm === true) { gotBpm = true; break; }
      }
      console.log('[DIAG] bracketedPasteMode history:', JSON.stringify(bpmHistory));
      if (!gotBpm) console.warn('[DIAG] WARNING: shell never sent \\x1b[?2004h — old bash or BPM disabled');
      expect(gotBpm, 'shell should enable bracketedPasteMode within 6s').toBe(true);
    } finally {
      try { await ctx.delete('/api/sessions/' + sid); } catch {}
      await ctx.dispose();
    }
  });

  test('stage 2 – all 70 lines arrive at PTY (cat + file check)', async ({ page }) => {
    const diagLogs = [];
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[PASTE-DIAG]')) { diagLogs.push(t); console.log('[browser]', t); }
    });

    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'paste-diag-70' } });
    const { id: sid } = await createRes.json();
    const TMP = '/tmp/_paste_diag_test.txt';

    try {
      await loginPage(page);
      await page.goto(BASE + '/app');

      await page.evaluate(id => {
        if (typeof switchSession === 'function') switchSession(id);
      }, sid);

      // Wait for bracketedPasteMode
      await page.waitForFunction(
        () => window.term?._core?.coreService?.decPrivateModes?.bracketedPasteMode === true,
        null, { timeout: 8000 }
      ).catch(() => {});

      const bpm = await page.evaluate(() =>
        window.term?._core?.coreService?.decPrivateModes?.bracketedPasteMode ?? false
      );
      console.log('[DIAG] bracketedPasteMode at paste time:', bpm);

      // Start cat writing to temp file
      await page.evaluate(tmp => window.term.paste(`cat > ${tmp}\n`), TMP);
      await page.waitForTimeout(600);

      // Paste 70 lines
      const pasteText = makeLines(PASTE_LINE_COUNT);
      const meta = await page.evaluate((text) => {
        const bpm = window.term?._core?.coreService?.decPrivateModes?.bracketedPasteMode;
        window.term.paste(text);
        return { bpm, chars: text.length, lines: text.split('\n').length };
      }, pasteText);
      console.log('[DIAG] term.paste() called with:', meta);

      // Give time for WS round-trip and PTY write
      await page.waitForTimeout(1500);

      // EOF
      await page.evaluate(() => window.term.paste('\x04'));
      await page.waitForTimeout(600);

      // Count lines via shell (using another paste into the same session)
      // Capture output by writing to a second file so we can read it cleanly
      const RESULT_FILE = '/tmp/_paste_diag_result.txt';
      await page.evaluate(
        ([tmp, res]) => window.term.paste(`wc -lc ${tmp} > ${res} 2>&1 && head -2 ${tmp} >> ${res} && tail -2 ${tmp} >> ${res}\n`),
        [TMP, RESULT_FILE]
      );
      await page.waitForTimeout(1200);

      // Read result file via WebSocket-driven cat
      const wsResult = await page.evaluate(async ([BASE, sid, res]) => {
        return new Promise(resolve => {
          const ws = new WebSocket(`ws://${location.host}/ws/${sid}`);
          let output = '';
          const MARKER = '---DONE---';
          ws.onopen = () => {
            ws.send(JSON.stringify({ resize: { cols: 200, rows: 50 } }));
            setTimeout(() => ws.send(`cat ${res} && echo '${MARKER}'\n`), 200);
          };
          ws.onmessage = e => {
            if (typeof e.data === 'string') output += e.data;
            else e.data.text().then(t => output += t);
            if (output.includes(MARKER)) { ws.close(); resolve(output); }
          };
          ws.onerror = () => resolve(output);
          setTimeout(() => { ws.close(); resolve(output); }, 6000);
        });
      }, [BASE, sid, RESULT_FILE]);

      const clean = stripAnsi(wsResult);
      console.log('[DIAG] raw shell output (stripped):\n', clean);
      console.log('[DIAG] PASTE-DIAG browser logs:', diagLogs.length);
      diagLogs.forEach(l => console.log('  ', l));

      // Parse wc output: "  <lines> <chars> <file>"
      const wcMatch = clean.match(/(\d+)\s+(\d+)/);
      const linesGot = wcMatch ? parseInt(wcMatch[1]) : -1;
      const charsGot = wcMatch ? parseInt(wcMatch[2]) : -1;
      console.log(`[DIAG] Lines at PTY: ${linesGot} / ${PASTE_LINE_COUNT}  Chars: ${charsGot} / ${pasteText.length}`);

      expect(linesGot).toBe(PASTE_LINE_COUNT);
    } finally {
      try { await ctx.delete('/api/sessions/' + sid); } catch {}
      await ctx.dispose();
    }
  });

  test('stage 3 – raw WS send (no term.paste) vs term.paste comparison', async ({ page }) => {
    const diagLogs = [];
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[PASTE-DIAG]')) { diagLogs.push(t); console.log('[browser-raw]', t); }
    });

    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'paste-diag-raw' } });
    const { id: sid } = await createRes.json();
    const TMP = '/tmp/_paste_diag_raw.txt';

    try {
      await loginPage(page);
      await page.goto(BASE + '/app');
      await page.evaluate(id => {
        if (typeof switchSession === 'function') switchSession(id);
      }, sid);
      await page.waitForFunction(
        () => window.term?._core?.coreService?.decPrivateModes?.bracketedPasteMode === true,
        null, { timeout: 8000 }
      ).catch(() => {});

      // Write via raw ws.send with manual bracketed paste markers
      await page.evaluate(tmp => window.term.paste(`cat > ${tmp}\n`), TMP);
      await page.waitForTimeout(600);

      const pasteText = makeLines(PASTE_LINE_COUNT);
      const rawMeta = await page.evaluate(async (text) => {
        // Manually wrap with bracketed paste sequences and send raw via the
        // active WebSocket (exposed as window.wtWs for diagnostics).
        const wrapped = '\x1b[200~' + text + '\x1b[201~';
        const sock = window.wtWs;
        if (sock && sock.readyState === 1) {
          sock.send(wrapped);
          return { method: 'raw-ws', chars: wrapped.length };
        }
        return { method: 'ws-not-open', readyState: sock?.readyState };
      }, pasteText);
      console.log('[DIAG] raw WS send meta:', rawMeta);

      await page.waitForTimeout(1500);
      await page.evaluate(() => window.term.paste('\x04'));
      await page.waitForTimeout(600);

      // Count via shell
      const RESULT_FILE = '/tmp/_paste_diag_raw_result.txt';
      await page.evaluate(
        ([tmp, res]) => window.term.paste(`wc -lc ${tmp} > ${res} 2>&1\n`),
        [TMP, RESULT_FILE]
      );
      await page.waitForTimeout(1000);

      const wsResult = await page.evaluate(async ([sid, res]) => {
        return new Promise(resolve => {
          const ws = new WebSocket(`ws://${location.host}/ws/${sid}`);
          let output = '';
          const MARKER = '---RAW-DONE---';
          ws.onopen = () => {
            setTimeout(() => ws.send(`cat ${res} && echo '${MARKER}'\n`), 200);
          };
          ws.onmessage = e => {
            if (typeof e.data === 'string') output += e.data;
            else e.data.text().then(t => output += t);
            if (output.includes(MARKER)) { ws.close(); resolve(output); }
          };
          ws.onerror = () => resolve(output);
          setTimeout(() => { ws.close(); resolve(output); }, 6000);
        });
      }, [sid, RESULT_FILE]);

      const clean = stripAnsi(wsResult);
      console.log('[DIAG] raw WS result:\n', clean);
      diagLogs.forEach(l => console.log('  raw:', l));

      const wcMatch = clean.match(/(\d+)\s+(\d+)/);
      const linesGot = wcMatch ? parseInt(wcMatch[1]) : -1;
      console.log(`[DIAG] Raw WS: Lines at PTY: ${linesGot} / ${PASTE_LINE_COUNT}`);

      expect(linesGot).toBe(PASTE_LINE_COUNT);
    } finally {
      try { await ctx.delete('/api/sessions/' + sid); } catch {}
      await ctx.dispose();
    }
  });
});
