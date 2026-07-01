#!/usr/bin/env node
// pw_trace.js — Interactive Playwright trace REPL for Odoo visual testing
//
// Usage:
//   node pw_trace.js <task_label> [target_url]
//   node pw_trace.js DEMO http://localhost:8069/web/login
//   node pw_trace.js TASK-001 http://192.168.1.10:8069/web/login
//
// Then type commands line-by-line (or pipe a command file):
//   node pw_trace.js DEMO < flows/so-invoice-payment.txt
//
// Trace saved to ./traces/<task_label>.zip
// View:  npx playwright show-trace traces/<task_label>.zip
//        or drag-drop to https://trace.playwright.dev

const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const taskLabel = process.argv[2];
const targetUrl = process.argv[3] || 'http://localhost:8069/web/login';

if (!taskLabel) {
  console.error('Usage: node pw_trace.js <task_label> [target_url]');
  console.error('Example: node pw_trace.js DEMO http://localhost:8069/web/login');
  process.exit(1);
}

const tracesDir = path.join(__dirname, 'traces');
if (!fs.existsSync(tracesDir)) fs.mkdirSync(tracesDir, { recursive: true });

const traceFile = path.join(tracesDir, `${taskLabel}.zip`);

(async () => {
  console.log(`\nStarting trace: ${taskLabel}`);
  console.log(`Target:  ${targetUrl}`);
  console.log(`Output:  ${traceFile}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

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
  console.log('  press <key>              keyboard press (Enter, Tab, Escape, ArrowDown...)');
  console.log('  wait <ms>                pause');
  console.log('  screenshot [name]        save screenshot to traces/');
  console.log('  snapshot                 print page element tree (for selector discovery)');
  console.log('  eval <js>                evaluate JS and print result');
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
        await page.click(rawRest, { timeout: 30000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  clicked: ${rawRest}`);

      } else if (cmd === 'fclick') {
        // Force click — bypasses Playwright visibility/stability checks
        // Good for: SPA buttons that Playwright thinks aren't actionable
        await page.click(rawRest, { force: true, timeout: 15000 });
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

      } else if (cmd === 'press') {
        await page.keyboard.press(parts[1]);
        console.log(`  pressed: ${parts[1]}`);

      } else if (cmd === 'wait') {
        const ms = parseInt(parts[1] || '1000');
        await page.waitForTimeout(ms);
        console.log(`  waited ${ms}ms`);

      } else if (cmd === 'screenshot') {
        const imgName = parts[1] || `${taskLabel}-${Date.now()}`;
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
