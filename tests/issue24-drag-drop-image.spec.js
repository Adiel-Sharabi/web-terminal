// @ts-check
// Issue #24: dragging and dropping an image onto the terminal should upload it
// through the same /api/clipboard-image endpoint Alt+V uses.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

test.describe('Issue #24: drag & drop image onto terminal', () => {
  test('dropping an image file on #terminal POSTs it to /api/clipboard-image', async ({ page }) => {
    const posted = [];
    await page.route('**/api/clipboard-image', async (route, req) => {
      posted.push({
        url: req.url(),
        method: req.method(),
        contentType: req.headers()['content-type'],
        bodyBytes: (req.postDataBuffer() || Buffer.alloc(0)).length,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, clipboard: true }),
      });
    });

    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForSelector('#terminal');
    // Let init() finish so the drop-zone listener is attached.
    await page.waitForTimeout(300);

    // Simulate a drag-drop by building a DataTransfer inside the page and
    // dispatching dragover+drop events on #terminal.
    await page.evaluate(() => {
      const term = document.getElementById('terminal');
      if (!term) throw new Error('#terminal not found');
      const dt = new DataTransfer();
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic header
      const file = new File([bytes], 'test.png', { type: 'image/png' });
      dt.items.add(file);
      term.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      term.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

    // Wait for the fetch to land.
    await page.waitForTimeout(400);

    expect(posted.length).toBe(1);
    expect(posted[0].method).toBe('POST');
    expect(posted[0].contentType).toBe('image/png');
    expect(posted[0].bodyBytes).toBeGreaterThan(0);
  });

  test('drop of a non-image file is ignored', async ({ page }) => {
    const posted = [];
    await page.route('**/api/clipboard-image', async (route, req) => {
      posted.push(req.url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });

    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForSelector('#terminal');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const term = document.getElementById('terminal');
      const dt = new DataTransfer();
      const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
      dt.items.add(file);
      term.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      term.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForTimeout(300);

    expect(posted.length).toBe(0);
  });
});
