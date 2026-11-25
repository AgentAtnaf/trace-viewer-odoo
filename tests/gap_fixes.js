#!/usr/bin/env node
// Regression tests for the eight gaps filed 2026-11-23 (issues/2026-11-23-*.txt).
// Synthetic page + mock JSON-RPC, no Odoo, no credentials. Each block names the
// issue note it proves fixed.
//
//   node tests/gap_fixes.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const kit = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-gaps-'));

// --- unit: isoToOdooDate, extracted from pw_trace.js so it cannot drift ------
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} not found`);
}
const isoToOdooDate = new Function(`${extractFn(fs.readFileSync(path.join(kit, 'pw_trace.js'), 'utf8'), 'isoToOdooDate')}; return isoToOdooDate;`)();
const v17us = { date: 'MM/dd/yyyy', datetime: 'MM/dd/yyyy HH:mm:ss' };
const v17gb = { date: 'dd/MM/yyyy', datetime: 'dd/MM/yyyy HH:mm:ss' };
const v14 = { date: '%m/%d/%Y', datetime: '%m/%d/%Y %H:%M:%S' };
assert.equal(isoToOdooDate('2026-12-15', v17us), '12/15/2026');
assert.equal(isoToOdooDate('2026-12-15', v17gb), '15/12/2026');
assert.equal(isoToOdooDate('2026-12-15 18:05', v17gb), '15/12/2026 18:05:00');
assert.equal(isoToOdooDate('2026-01-06 09:00:30', v14), '01/06/2026 09:00:30');
assert.equal(isoToOdooDate('2026-01-06', { date: 'd/M/yy' }), '6/1/26');
assert.equal(isoToOdooDate('15/12/2026', v17gb), null, 'non-ISO passes through');
assert.equal(isoToOdooDate('2026-12-15', null), null, 'unknown format passes through');
console.log('  PASS  isoToOdooDate: luxon + strftime, date + datetime, pass-through');

// --- fixture page --------------------------------------------------------------
const page = `<html><head><title>Gaps</title>
<style>.modal{display:none;position:fixed;inset:0} .modal.open{display:block} .dropdown-menu{display:none} .dropdown-menu.show{display:block} .dropdown-menu li{list-style:none}</style>
<script>
  window.odoo = { loader: { modules: new Map([['@web/core/l10n/localization',
    { localization: { dateFormat: 'dd/MM/yyyy', dateTimeFormat: 'dd/MM/yyyy HH:mm:ss' } }]]) } };
  window.hit = [];
  // Odoo parses a date on commit and EMPTIES the field when it cannot.
  // ...and, like Odoo, accepts 1/6/2026 and shows it as 01/06/2026.
  function commitDate(el) { const m = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(el.value);
    if (!m || +m[2] > 12 || +m[1] > 31) { el.value = ''; return; }
    el.value = m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') + '/' + m[3]; }
  // Like Odoo: choosing an item closes its menu.
  function pickItem(a, what) { hit.push(what); const m = a.closest('.dropdown-menu'); m.classList.remove('show');
    m.previousElementSibling.setAttribute('aria-expanded', 'false'); }
  function toggle(btn) { const open = btn.nextElementSibling.classList.toggle('show'); btn.setAttribute('aria-expanded', String(open)); }
</script></head><body>
<div class="o_action_manager">
  <div class="o_cp_action_menus">
    <div class="o_dropdown"><button class="o_dropdown_toggler_btn btn" onclick="toggle(this)">Print</button>
      <ul class="dropdown-menu"><li class="o_menu_item"><a class="dropdown-item" href="#" onclick="pickItem(this,'slip');return false">Delivery Slip</a></li></ul></div>
    <div class="o_dropdown"><button class="o_dropdown_toggler_btn btn" onclick="toggle(this)">Action</button>
      <!-- Odoo 14 shape: the handler is on the <a>, the <li> around it does nothing -->
      <ul class="dropdown-menu"><li class="o_menu_item"><a class="dropdown-item" href="#" onclick="pickItem(this,'dup');return false">Duplicate</a></li>
        <li class="o_menu_item"><a class="dropdown-item" href="#" onclick="pickItem(this,'del');return false">Delete</a></li>
        <li class="o_menu_item"><a class="dropdown-item" href="#">Dead item</a></li></ul></div>
  </div>
  <div class="o_form_view">
    <div class="o_statusbar_buttons"><button name="action_confirm" onclick="hit.push('form-confirm')">Confirm</button></div>
    <button id="open" onclick="document.getElementById('wiz').classList.add('open')">Open wizard</button>
    <div class="o_field_widget" name="x"><input value=""></div>
    <input id="t" value="Product A">
    <div class="o_field_widget o_field_date" name="date_deadline"><input id="d" onchange="commitDate(this)"></div>
    <!-- Odoo 17 behaviour: an unparsable date silently puts the PREVIOUS value back -->
    <input id="d2" value="16/12/2026" onfocus="this.dataset.prev=this.value"
      onchange="if (!/^\\d{2}\\/(0[1-9]|1[0-2])\\/\\d{4}$/.test(this.value)) this.value=this.dataset.prev">
  </div>
</div>
<div class="modal" id="wiz"><div class="modal-dialog"><div class="modal-content">
  <header class="modal-header"><h4 class="modal-title">Schedule</h4></header>
  <div class="modal-body">Pick a slot</div>
  <footer class="modal-footer"><button name="action_set" onclick="hit.push('wizard-confirm')">Confirm</button>
    <button onclick="document.getElementById('wiz').classList.remove('open')">Cancel</button></footer>
</div></div></div>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/web/dataset/call_kw') {
    let raw = ''; for await (const c of req) raw += c;
    const { params } = JSON.parse(raw);
    const { name, operator } = params.kwargs;
    let result = [];
    if (params.method === 'name_search') {
      if (operator === '=' && name === 'WH/OUT/00012') result = [[42, 'WH/OUT/00012']];
      else if (operator === '=' && name === 'Twice') result = [[1, 'Twice'], [2, 'Twice']];
      else if (operator === 'ilike') result = [[43, 'WH/OUT/00013']];
    }
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ jsonrpc: '2.0', result }));
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(page);
});

async function run(name, flow) {
  const target = `http://127.0.0.1:${server.address().port}/web`;
  const child = spawn(process.execPath, [path.join(kit, 'pw_trace.js'), name, target], {
    env: { ...process.env, ODOO_TASK: '', ODOO_SESSION_ID: '', ODOO_DB: '', TRACE_LOCAL: '',
      TRACE_OUT_DIR: tmp, TRACE_SESSION_DIR: path.join(tmp, 'sessions'), CMD_TIMEOUT: '1500' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  child.stdin.end(flow);
  await new Promise(r => child.on('close', r));
  return out;
}
const has = (out, s, what) => { assert(out.includes(s), `${what}: expected to find\n  ${s}\n--- output ---\n${out}`); console.log(`  PASS  ${what}`); };
const lacks = (out, s, what) => { assert(!out.includes(s), `${what}: did not expect\n  ${s}\n--- output ---\n${out}`); console.log(`  PASS  ${what}`); };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    // 1. selector-quoting-differs-per-command
    let out = await run('gap-quoting', [
      "click 'button#open'",
      'eval document.getElementById("wiz").classList.contains("open")',
      "click 'button[onclick*=\"remove\"]'",
      'fill .o_field_widget[name="x"] input hello world',
      'eval document.querySelector(\'.o_field_widget[name="x"] input\').value',
      'mark button:has-text("Open wizard") Opens the wizard',
      'expect visible .o_field_widget[name="x"] input',
      'fill input#t admin',
      'done', ''].join('\n'));
    has(out, 'eval: true', "quoted selector on click works (wizard opened)");
    has(out, `NOTE: unquoted selector read as '.o_field_widget[name="x"] input'`, 'unquoted fill selector extended to the element');
    has(out, 'eval: "hello world"', 'fill value kept intact after the selector');
    has(out, 'marked: button:has-text("Open wizard") — Opens the wizard', 'unquoted mark with :has-text("…") + caption');
    has(out, 'expect visible: PASS', 'expect visible takes the whole rest of the line');
    has(out, 'filled: input#t = "admin"', 'plain value is never swallowed into the selector');
    lacks(out, 'ERROR', 'quoting flow ran without errors');

    // 2. date-format-depends-on-locale
    out = await run('gap-date', ['date #d 2026-12-15', 'date #d 12/15/2026', 'date #d2 12/15/2026',
      'date #d 1/6/2026', 'done', ''].join('\n'));
    has(out, 'date: 2026-12-15 → "15/12/2026" (this server\'s format: dd/MM/yyyy)', 'ISO converted to the server format');
    has(out, 'date: #d = "15/12/2026"', 'read back after commit');
    has(out, 'but after commit the field is EMPTY', 'wrong-format date is an error, not silent');
    has(out, "This server's format is dd/MM/yyyy", 'error names the expected format');
    has(out, 'but after commit the field shows "16/12/2026" (Odoo kept or put back a different date)', 'a silently reverted date is an error too');
    lacks(out, 'wrote "1/6/2026"', 'same date written without leading zeros is accepted');

    // 3. type-appends-to-existing-text
    out = await run('gap-type', ['click #t', 'type Product B', 'retype Product C',
      'eval document.getElementById("t").value', 'done', ''].join('\n'));
    has(out, 'NOTE: the focused input already held "Product A" — appended, it now reads "Product AProduct B"', 'type says when it appended');
    has(out, 'retyped: "Product C" (replaced "Product AProduct B")', 'retype replaces');
    has(out, 'eval: "Product C"', 'input really holds only the retyped text');

    // 4. no-action-menu-command
    out = await run('gap-actionmenu', ['actionmenu Duplicate', 'actionmenu Print > Delivery Slip',
      'actionmenu Archive', 'eval hit.join(",")', 'actionmenu Dead item', 'eval "after dead item"', 'done', ''].join('\n'));
    has(out, 'actionmenu: Action > Duplicate', 'Action menu item by label');
    has(out, 'actionmenu: Print > Delivery Slip', 'Print menu item by label');
    has(out, 'no "archive" in the Action menu — items: Duplicate | Delete | Dead item', 'a miss lists the real items');
    has(out, 'clicked "Dead item" but the Action menu is still open — the click did not register', 'a click that did nothing is an error');
    has(out, 'aborting flow after failure', '...and stops the flow before anything else runs');
    lacks(out, 'eval: "after dead item"', 'no step ran after the dead click');
    has(out, 'eval: "dup,slip"', 'the right items were clicked');

    // 5 + 6. clickbtn-hits-button-behind-dialog, unexpected-dialog-not-reported
    out = await run('gap-dialog', ['click #open', 'clickbtn Confirm', 'eval hit.join(",")',
      'click #open', 'click #not-on-this-page', 'done', ''].join('\n'));
    has(out, 'clickbtn: "Confirm" (name="action_set") in dialog "Schedule"', 'clickbtn scoped to the open dialog');
    has(out, 'eval: "wizard-confirm"', "the form's own Confirm behind it was not clicked");
    has(out, 'open dialog: "Schedule" — buttons: Confirm | Cancel', 'a failing step names the open dialog');

    // 7. ks-list-row-click-opens-inline-edit
    out = await run('gap-record', ['record stock.picking WH/OUT/00012', 'url',
      'record stock.picking Twice', 'record stock.picking WH/OUT/0001', 'done', ''].join('\n'));
    has(out, 'record: "WH/OUT/00012" is stock.picking #42', 'record by name resolves the id');
    has(out, '#id=42&model=stock.picking&view_type=form', 'and opens the form by hash');
    has(out, 'record: 2 stock.picking named exactly "Twice" — matches: Twice (#1) | Twice (#2)', 'ambiguous name refused');
    has(out, 'record: no stock.picking named exactly "WH/OUT/0001" — similar: WH/OUT/00013 (#43)', 'missing name lists similar');

    // 8. no-step-banner-command
    out = await run('gap-step', ['step STEP 1/2 · checking the slot',
      'eval location.reload()', 'waitfor #pw-step',
      'eval [document.getElementById("pw-step").textContent, getComputedStyle(document.getElementById("pw-step")).pointerEvents]',
      'click #open',
      'step pass STEP 2/2 · slot kept', 'eval document.getElementById("pw-step").textContent',
      'click #missing-thing',
      'eval document.getElementById("pw-step").textContent',
      'done', ''].join('\n'));
    has(out, 'eval: ["STEP 1/2 · checking the slot","none"]', 'banner survives a reload and never takes clicks');
    has(out, 'clicked: #open', 'banner does not block the click under it');
    has(out, 'eval: "✓ STEP 2/2 · slot kept"', 'step pass shows a pass banner');
    has(out, 'eval: "✗ STEP 2/2 · slot kept — FAILED at line 8: click"', 'banner turns red at the failing command');

    console.log('gap fixes: all passed');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; server.close(); });
