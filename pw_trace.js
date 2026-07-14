#!/usr/bin/env node
// pw_trace.js — Interactive Playwright trace REPL for Odoo visual testing
//
// Usage:
//   node pw_trace.js <name> [target_url]
//   node pw_trace.js demo http://localhost:8069/web/login
//   node pw_trace.js so-flow http://192.168.1.10:8069/web/login
//
// Then type commands line-by-line (or pipe a command file):
//   node pw_trace.js so-flow http://localhost:8069/web/login < flows/so-invoice-payment.txt
//
// Trace saved to ./traces/<name>.zip
// View:  npx playwright show-trace traces/<name>.zip
//        or drag-drop to https://trace.playwright.dev

const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const label = process.argv[2];
const targetUrl = process.argv[3] || 'http://localhost:8069/web/login';

if (!label) {
  console.error('Usage: node pw_trace.js <name> [target_url]');
  console.error('Example: node pw_trace.js DEMO http://localhost:8069/web/login');
  process.exit(1);
}

const tracesDir = process.env.TRACE_OUT_DIR || path.join(__dirname, 'traces');
if (!fs.existsSync(tracesDir)) fs.mkdirSync(tracesDir, { recursive: true });

const traceFile = path.join(tracesDir, `${label}.zip`);

(async () => {
  console.log(`\nStarting trace: ${label}`);
  console.log(`Target:  ${targetUrl}`);
  console.log(`Output:  ${traceFile}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Track in-flight RPCs (excluding the bus/longpolling connections that never close)
  // so `waitidle` can detect real idle instead of relying on networkidle
  await context.addInitScript(() => {
    window.__odooPending = 0;
    const skip = (u) => {
      const url = typeof u === 'string' ? u : (u && u.url) || '';
      return url.includes('/longpolling/') || url.includes('/websocket') || url.includes('/bus/');
    };
    const origFetch = window.fetch;
    window.fetch = function (...a) {
      if (skip(a[0])) return origFetch.apply(this, a);
      window.__odooPending++;
      return origFetch.apply(this, a).finally(() => window.__odooPending--);
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
      this.__skipCount = skip(u);
      return origOpen.call(this, m, u, ...r);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
      if (!this.__skipCount) {
        window.__odooPending++;
        this.addEventListener('loadend', () => window.__odooPending--, { once: true });
      }
      return origSend.apply(this, a);
    };
  });

  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();

  await page.goto(targetUrl, { timeout: 30000 });
  await page.waitForLoadState('domcontentloaded');
  console.log(`\nLoaded: ${await page.title()}`);
  console.log(`URL:    ${page.url()}`);

  console.log('\n--- Commands ---');
  console.log('  goto <url>               navigate');
  console.log('  click <sel>              standard Playwright click (waits for visibility)');
  console.log('  fclick <sel>             force click (bypasses visibility checks)');
  console.log('  jclick <sel>             JS .click() (OWL2-friendly for Odoo SPA buttons)');
  console.log('  fill <sel> <text>        fill input (use single quotes for selectors with spaces)');
  console.log('  type <text>              type text into focused element (keyboard events, no selector)');
  console.log('  m2o <cell_sel> <text>    many2one: click cell → type → pick first dropdown result');
  console.log('  addline <field_name>     add row to One2many list, waits for new row to appear');
  console.log('  press <key>              keyboard press (Enter, Tab, Escape, ArrowDown...)');
  console.log('  wait <ms>                pause (fixed — prefer waitidle/waitfor)');
  console.log('  waitidle [maxMs]         wait until Odoo is idle (network + loading overlay), fast');
  console.log('  screenshot [name]        save screenshot to traces/');
  console.log('  snapshot                 print page element tree (for selector discovery)');
  console.log('  eval <js>                evaluate JS and print result');
  console.log('  cookie <n> <v> [domain]  set a raw browser cookie (works for HttpOnly, e.g. session_id)');
  console.log('  highlight <sel>          draw Playwright\'s native pink box (screenshot-only, invisible in trace viewer)');
  console.log('  mark <sel> [caption]     inject a REAL red box+caption around an element (visible in trace viewer Snapshot tab)');
  console.log('  unmark                   remove all marks added by `mark`');
  console.log('  bbox <sel>               print an element\'s {x,y,width,height} viewport box (for custom annotation)');
  console.log('  evals <sel>              print outerHTML of matched elements (structure inspection)');
  console.log('  find <sel>               print matching elements (max 5)');
  console.log('  waitfor <sel>            wait for selector to appear');
  console.log('  url                      print current URL');
  console.log('  title                    print page title');
  console.log('  done                     stop trace, save zip, exit\n');

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    // Quote-aware tokenizer: 'my selector with spaces' becomes one token
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue; // skip empty lines and comments

    const parts = [];
    let cur = '', inQ = false;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "'" && !inQ) { inQ = true; }
      else if (raw[i] === "'" && inQ) { inQ = false; }
      else if (raw[i] === ' ' && !inQ) { if (cur) { parts.push(cur); cur = ''; } }
      else { cur += raw[i]; }
    }
    if (cur) parts.push(cur);

    const cmd = parts[0];
    // rawRest used by eval/jclick to avoid quote-stripping JS code
    const rawRest = raw.slice(cmd.length + 1);

    try {
      if (cmd === 'done') {
        break;

      } else if (cmd === 'goto') {
        await page.goto(parts.slice(1).join(' '), { timeout: 20000 });
        await page.waitForLoadState('domcontentloaded');
        console.log(`  → ${page.url()}`);

      } else if (cmd === 'click') {
        await page.click(rawRest, { timeout: 30000 }).catch(async (e) => {
          const count = await page.evaluate((s) => document.querySelectorAll(s).length, rawRest).catch(() => -1);
          const hint = count === 0 ? 'selector matched 0 elements' : `selector matched ${count} element(s) but was not actionable`;
          throw new Error(`${e.message.split('\n')[0]} — ${hint}`);
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  clicked: ${rawRest}`);

      } else if (cmd === 'fclick') {
        // Force click — bypasses Playwright visibility/stability checks
        // Good for: SPA buttons that Playwright thinks aren't actionable
        await page.click(rawRest, { force: true, timeout: 15000 }).catch(async (e) => {
          const count = await page.evaluate((s) => document.querySelectorAll(s).length, rawRest).catch(() => -1);
          const hint = count === 0 ? 'selector matched 0 elements' : `selector matched ${count} element(s) but was not actionable`;
          throw new Error(`${e.message.split('\n')[0]} — ${hint}`);
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  fclicked: ${rawRest}`);

      } else if (cmd === 'jclick') {
        // JS click — dispatches .click() directly on the DOM element
        // Good for: Odoo OWL2 action buttons in forms
        const found = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.click();
          return true;
        }, rawRest);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  jclicked (${found ? 'found' : 'NOT FOUND'}): ${rawRest}`);

      } else if (cmd === 'fill') {
        const sel = parts[1];
        const text = parts.slice(2).join(' ');
        await page.fill(sel, text);
        console.log(`  filled: ${sel} = "${text}"`);

      } else if (cmd === 'type') {
        // Type text into the currently-focused element via keyboard events (no selector needed)
        const text = parts.slice(1).join(' ');
        await page.keyboard.type(text, { delay: 50 });
        console.log(`  typed: "${text}"`);

      } else if (cmd === 'm2o') {
        // Many2one field helper: click cell → type search → wait for dropdown → pick first result
        // Fixes fill() failing on role="combobox" inputs in OWL editable tree rows
        const cellSel = parts[1];
        const searchText = parts.slice(2).join(' ');
        await page.click(cellSel, { timeout: 10000 });
        await page.keyboard.type(searchText, { delay: 50 });
        await page.waitForSelector('.o-autocomplete--dropdown-item', { timeout: 10000 });
        await page.click('.o-autocomplete--dropdown-item');
        console.log(`  m2o: ${cellSel} = "${searchText}"`);

      } else if (cmd === 'addline') {
        // Add a row to a One2many list: jclick the "Add a line/product" link → wait for new row
        // Usage: addline <field_name>   e.g.  addline order_line
        const fieldName = parts[1];
        const found = await page.evaluate((f) => {
          const el = document.querySelector(`[name="${f}"] a`);
          if (!el) return false;
          el.click();
          return true;
        }, fieldName);
        await page.waitForSelector('tr.o_selected_row', { timeout: 10000 });
        console.log(`  addline (${found ? 'found' : 'NOT FOUND link'}): [name="${fieldName}"]`);

      } else if (cmd === 'press') {
        await page.keyboard.press(parts[1]);
        console.log(`  pressed: ${parts[1]}`);

      } else if (cmd === 'wait') {
        const ms = parseInt(parts[1] || '1000');
        await page.waitForTimeout(ms);
        console.log(`  waited ${ms}ms`);

      } else if (cmd === 'waitidle') {
        // Wait for Odoo to actually finish: network idle + loading indicators gone.
        // Much faster than fixed waits — returns as soon as the page is ready.
        // Usage: waitidle [maxMs]   (default 15000)
        const maxMs = parseInt(parts[1] || '15000');
        const t0 = Date.now();
        // Lead-in: give the previous action time to start its request/navigation,
        // otherwise the pending-RPC check can pass before the RPC even fires
        await page.waitForTimeout(400);
        // Idle = no pending RPCs (bus/longpolling excluded via init script),
        // no Odoo loading overlay (.o_loading_indicator 17+, .o_loading 14, .o_blockUI),
        // and document fully loaded
        await page.waitForFunction(() => {
          const pending = window.__odooPending || 0;
          // Loading overlays only count if actually visible — Odoo keeps a
          // permanent hidden <div class="o_loading"> in the DOM and toggles display
          const overlays = document.querySelectorAll('.o_loading_indicator, .o_loading, .o_blockUI');
          const visible = Array.from(overlays).some(el => el.offsetParent !== null);
          return pending === 0 && !visible && document.readyState === 'complete';
        }, undefined, { timeout: maxMs }).catch(() => {});
        // Small settle for OWL rendering after RPCs complete
        await page.waitForTimeout(300);
        console.log(`  idle after ${Date.now() - t0}ms`);

      } else if (cmd === 'screenshot') {
        const imgName = parts[1] || `${label}-${Date.now()}`;
        const imgPath = path.join(tracesDir, imgName.endsWith('.png') ? imgName : `${imgName}.png`);
        await page.screenshot({ path: imgPath, fullPage: true });
        console.log(`  screenshot: ${imgPath}`);

      } else if (cmd === 'snapshot') {
        const s = await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          const nodes = [];
          let n;
          while ((n = walker.nextNode()) && nodes.length < 100) {
            const role = n.getAttribute('role') || n.tagName.toLowerCase();
            const label = n.getAttribute('aria-label') || n.innerText?.slice(0, 60) || '';
            if (label) nodes.push(`${role}: ${label}`);
          }
          return nodes.join('\n');
        });
        console.log(s);

      } else if (cmd === 'eval') {
        const result = await page.evaluate(new Function(`return (${rawRest})`));
        console.log(`  eval: ${JSON.stringify(result)}`);

      } else if (cmd === 'highlight') {
        // Playwright's native highlight: draws a pink box around the element
        // directly in the live page — shows up in the next screenshot, but
        // NOT in the trace viewer's Snapshot/DOM tab (Playwright strips its
        // own debug overlay before serializing snapshots). Use `mark`
        // instead if the annotation needs to survive in the trace viewer.
        // Usage: highlight <selector>
        await page.locator(rawRest).first().highlight();
        console.log(`  highlighted: ${rawRest}`);

      } else if (cmd === 'mark') {
        // Inject a REAL red box (+ optional caption) around an element —
        // unlike highlight(), this is genuine page content, so it survives
        // into the trace viewer's Snapshot/DOM tab and every screenshot
        // taken afterward, until cleared with `unmark`.
        // Resolve the target via Playwright's own locator (supports
        // :has-text() and friends, which plain querySelector cannot), then
        // draw using the already-resolved coordinates.
        // Usage: mark <selector> [caption text]  (wrap selector in 'single
        // quotes' if it contains spaces, e.g. 'button:has-text("Log in")')
        const sel = parts[1];
        const caption = parts.slice(2).join(' ');
        const rect = await page.locator(sel).first().boundingBox().catch(() => null);
        if (!rect) {
          console.log(`  mark NOT FOUND: ${sel}`);
        } else {
          await page.evaluate(({ rect, caption }) => {
            const box = document.createElement('div');
            box.setAttribute('data-pw-mark', '1');
            box.style.cssText = `position:fixed;left:${rect.x - 6}px;top:${rect.y - 6}px;` +
              `width:${rect.width + 12}px;height:${rect.height + 12}px;border:3px solid #dc1e1e;` +
              `border-radius:6px;z-index:2147483647;pointer-events:none;box-sizing:border-box;`;
            document.body.appendChild(box);
            if (caption) {
              const label = document.createElement('div');
              label.setAttribute('data-pw-mark', '1');
              label.textContent = caption;
              label.style.cssText = `position:fixed;left:${rect.x}px;top:${Math.max(rect.y - 38, 4)}px;` +
                `background:#dc1e1e;color:#fff;font:bold 14px sans-serif;padding:4px 10px;` +
                `border-radius:4px;z-index:2147483647;pointer-events:none;white-space:nowrap;`;
              document.body.appendChild(label);
            }
          }, { rect, caption });
          console.log(`  marked: ${sel}${caption ? ' — ' + caption : ''}`);
        }

      } else if (cmd === 'unmark') {
        // Remove all marks added by `mark`.
        await page.evaluate(() => {
          document.querySelectorAll('[data-pw-mark]').forEach((e) => e.remove());
        });
        console.log('  cleared all marks');

      } else if (cmd === 'bbox') {
        // Print an element's viewport bounding box as JSON — feed the
        // coordinates to an external tool (e.g. Pillow) to draw a custom
        // circle/arrow annotation on the saved screenshot.
        // Usage: bbox <selector>
        const box = await page.locator(rawRest).first().boundingBox();
        console.log(`  bbox: ${JSON.stringify(box)}`);

      } else if (cmd === 'cookie') {
        // Set a raw browser cookie at the context level — works even for
        // HttpOnly cookies (e.g. an Odoo session_id obtained out-of-band),
        // which page-JS document.cookie can never touch.
        // Usage: cookie <name> <value> [domain] [path]
        const name = parts[1];
        const value = parts[2];
        const domain = parts[3] || new URL(page.url()).hostname;
        const cpath = parts[4] || '/';
        await context.addCookies([{ name, value, domain, path: cpath }]);
        console.log(`  cookie set: ${name} on ${domain}${cpath}`);

      } else if (cmd === 'evals') {
        // Print outerHTML (first 300 chars) of each matched element — instant structure inspection
        const sel = rawRest;
        const results = await page.evaluate((s) => {
          return Array.from(document.querySelectorAll(s)).slice(0, 5).map(e =>
            e.outerHTML.slice(0, 300)
          );
        }, sel);
        if (results.length === 0) console.log(`  (no matches for: ${sel})`);
        results.forEach((r, i) => console.log(`  [${i}] ${r}`));

      } else if (cmd === 'find') {
        const sel = rawRest;
        const results = await page.evaluate((s) => {
          return Array.from(document.querySelectorAll(s)).slice(0, 5).map(e =>
            `${e.tagName}.${e.className.replace(/\s+/g, '.')} | text="${e.textContent?.trim().slice(0, 60)}"`
          );
        }, sel);
        if (results.length === 0) console.log(`  (no matches)`);
        results.forEach(r => console.log(`  ${r}`));

      } else if (cmd === 'waitfor') {
        const sel = rawRest;
        await page.waitForSelector(sel, { timeout: 15000 });
        console.log(`  appeared: ${sel}`);

      } else if (cmd === 'url') {
        console.log(`  ${page.url()}`);

      } else if (cmd === 'title') {
        console.log(`  ${await page.title()}`);

      } else if (cmd !== '') {
        console.log(`  Unknown command: ${cmd}`);
      }
    } catch (e) {
      console.error(`  ERROR [${cmd}]: ${e.message.split('\n')[0]}`);
    }
  }

  rl.close();
  console.log('\nStopping trace...');
  await context.tracing.stop({ path: traceFile });
  await browser.close();

  const size = fs.statSync(traceFile).size;
  console.log(`\nTrace saved: ${traceFile}`);
  console.log(`Size:        ${(size / 1024).toFixed(0)} KB\n`);
  console.log('View options:');
  console.log(`  npx playwright show-trace ${path.relative(process.cwd(), traceFile)}`);
  console.log(`  drag-drop to https://trace.playwright.dev`);
})();
