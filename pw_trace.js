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
// Trace saved to ./traces/<name> <timestamp> <run-id>.zip
// View:  npx playwright show-trace "<printed-trace-path>"
//        or drag-drop to https://trace.playwright.dev

const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const { parseOptions, resolveContext, sourceRevision } = require('./run-context');
const { createFieldTools } = require('./field-tools');
const { createCapture } = require('./run-capture');
const { randomUUID } = require('crypto');
const { attachRuntimeEvidence } = require('./runtime-evidence');
let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exit(2); }

(async () => {
await resolveContext(options);
const targetUrl = options.targetUrl;
const runId = randomUUID();
const startedAt = new Date().toISOString();
const cfg = options.config;
const label = [cfg.taskInFilename ? options.task : '', options.name,
  startedAt.replace(/[:.]/g, '-'), runId].filter(Boolean).join(' ');
const capture = createCapture(options.flowFile);
const tracesDir = cfg.outputDir;
if (!fs.existsSync(tracesDir)) fs.mkdirSync(tracesDir, { recursive: true });

const traceFile = path.join(tracesDir, `${label}.zip`);
const logFile = path.join(tracesDir, `${label}.log`);

// Tee every console line to a per-run log file, flushed SYNCHRONOUSLY, so a run
// killed by SIGTERM/timeout still shows the last command it reached (stdout may
// be block-buffered and lost on kill; the log file is durable).
try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
const _appendLog = (s) => { try { fs.appendFileSync(logFile, s + '\n'); } catch { /* ignore */ } };
{
  const _stdout = console.log.bind(console);
  const _stderr = console.error.bind(console);
  const fmt = (a) => a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log = (...a) => { const s = fmt(a); _appendLog(s); _stdout(s); };
  console.error = (...a) => { const s = fmt(a); _appendLog(s); _stderr(s); };
}

const resultFile = path.join(tracesDir, `${label}.result.json`);
const report = {
  schema_version: 2, run_id: runId, flow_name: options.name, status: 'running', started_at: startedAt,
  context: { task: options.task || null, session_id: options.sessionId || null,
    target_url: targetUrl, requested_db: options.db || null, verified_session: null,
    source: sourceRevision(process.cwd()), toolkit: sourceRevision(__dirname) },
  steps: [], trace_file: traceFile, log_file: logFile,
};
const saveReport = () => {
  report.flow = capture.snapshot();
  report.updated_at = new Date().toISOString();
  fs.writeFileSync(resultFile + '.tmp', JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(resultFile + '.tmp', resultFile);
};
saveReport();
const heartbeat = setInterval(saveReport, 15000);
heartbeat.unref();
let browser, context, tracing = false, runtimeEvidence, activeStep = null;
try {
  // Fail-fast: per-command action timeout (bad selectors fail in seconds, not
  // Playwright's silent 30s default). Override with CMD_TIMEOUT env or the
  // `timeout <ms>` directive. `strict` (STRICT env / `strict on`) aborts the
  // flow on the first error/timeout instead of continuing.
  let actionTimeout = parseInt(process.env.CMD_TIMEOUT || '8000', 10);
  if (!(actionTimeout > 0)) actionTimeout = 8000;
  let strict = /^(1|true|on|yes)$/i.test(process.env.STRICT || '');
  let aborted = false;

  // Screenshots taken this run — deleted on exit (they're captured in the
  // trace too), so one flow leaves just one .zip + .log. Set KEEP_SHOTS=1 to keep.
  const shots = [];
  const keepShots = /^(1|true|on|yes)$/i.test(process.env.KEEP_SHOTS || '');

  // Warn when a selector-taking command (fill/date/mark/m2o) got an UNQUOTED
  // selector that the tokenizer likely split — the classic silent failure
  // (`fill .o_field[name="x"] input V` → selector=".o_field[name=\"x\"]",
  // value="input V"). Selectors with spaces must be wrapped in 'single quotes'.
  // NB: 'a' and 'i' are deliberately NOT here — they are ordinary words ("A
  // company"), and including them made this fire on real values.
  const SEL_TAG_RE = /^(input|button|span|div|textarea|select|td|tr|th|label|ul|li|table|form|section|nav|option)$/i;
  // `fatal` for the value-writing commands (fill/date/m2o): a truncated selector
  // there writes into the WRONG element and still logs success, which cascades
  // silently through every later step (see
  // issues/2026-09-09-product-name-field-is-textarea-not-input.txt). `mark` only
  // draws an annotation, so it stays a warning.
  //
  // The "looks like a selector fragment" test is deliberately narrow. It used to
  // count any token containing '.' '#' or '>', which fired on ~112 perfectly good
  // lines across flows/ — `fill input#password <pw-with-a-dot>` (a dot in a password)
  // and `<CUSTOMER_NAME>` placeholders. A warning that cries wolf is one people
  // learn to scroll past, which is exactly what happened.
  const warnIfTruncated = (parts, quoted, cmdName) => {
    if (quoted[1]) return;                         // selector was quoted → safe
    const sel = parts[1] || '', next = parts[2];
    if (next === undefined) return;                // nothing trailing to fold in
    const selIsCss = /[.#\[\]>]/.test(sel);
    const nextIsFrag = SEL_TAG_RE.test(next) || /^[.#[]/.test(next) || /[\[\]]/.test(next);
    if (!(selIsCss && nextIsFrag)) return;
    const msg = `selector "${sel}" looks unquoted and was truncated at "${next}" — `
      + `wrap selectors containing spaces in 'single quotes', e.g. ${cmdName || 'fill'} '${sel} ${next}' <value>`;
    if (cmdName === 'fill' || cmdName === 'date' || cmdName === 'm2o') {
      throw new Error(msg + ' (refusing to write into whatever that truncated selector matched)');
    }
    console.log(`  WARNING: ${msg}`);
  };

  // click/fclick/jclick/waitfor/bbox/find/evals/scroll/cols/highlight take the
  // WHOLE REST OF THE LINE as the selector (so a raw CSS selector with quotes
  // inside it, e.g. [name="x"], survives intact). Wrapping one in 'single quotes'
  // used to make the quotes literal characters that never match (issues
  // 2026-08-06-quoted-click-selector, 2026-09-09-fresh-rma-flow-build-gotchas),
  // then a hard error. Now one pair of wrapping quotes is simply removed.
  //
  // 2026-11-23: quoting is no longer a per-command rule to remember. It was the
  // single most common reason a new flow failed (~10 runs in 7 flows between
  // 10-09 and 11-11, see issues/2026-11-23-selector-quoting-differs-per-command.txt),
  // so every selector now works quoted OR unquoted:
  //   * rest-of-line commands drop one pair of wrapping quotes (unwrapRest);
  //   * selector+value commands find where an unquoted selector ends
  //     (splitSelector, below).
  const unwrapRest = (s) => {
    s = (s || '').trim();
    return (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") ? s.slice(1, -1) : s;
  };

  // A token that can only be the continuation of a CSS/Playwright selector, never
  // ordinary value text: a tag name, a combinator, or something starting with
  // . # [ : or carrying selector punctuation ([ ] ( ) = ").
  const looksLikeSelPart = (t) => SEL_TAG_RE.test(t) || /^[.#\[:>~+*]/.test(t) || /[\[\]()="]/.test(t);

  // Where does the selector end on `<cmd> <selector> <value...>`? Quoted: the
  // quotes say so. Unquoted: start with the first token; while the joined
  // selector is still syntactically incomplete, or the next token looks like
  // more selector, try the longer selector and KEEP it if it matches an element
  // on the page. Value text never gets swallowed unless it both looks like CSS
  // and turns the selector into one that matches something.
  const splitSelector = async (cmdName, parts, quoted, i = 1) => {
    const first = parts[i];
    if (first === undefined || quoted[i]) return { sel: first, rest: parts.slice(i + 1) };
    const count = async (s) => { try { return await page.locator(s).count(); } catch { return -1; } };
    let best = i, bestN = await count(first), j = i;
    let n = bestN;
    while (j + 1 < parts.length && (n < 0 || looksLikeSelPart(parts[j + 1]))) {
      j++;
      n = await count(parts.slice(i, j + 1).join(' '));
      if (n > 0) { best = j; bestN = n; }
    }
    const sel = parts.slice(i, best + 1).join(' ');
    if (best > i) {
      console.log(`  NOTE: unquoted selector read as '${sel}' (${bestN} match${bestN === 1 ? '' : 'es'}) — quote it to make that explicit`);
    } else if (bestN <= 0 && i === 1) {
      // Nothing matches yet, so the page cannot tell us where the selector ends.
      // Writing commands must not guess (a truncated selector writes into the
      // wrong element and still reports success); mark/expect just wait and fail.
      warnIfTruncated(parts, quoted, cmdName);
    }
    return { sel, rest: parts.slice(best + 1) };
  };

  // Does an observed /web/ request plausibly belong to the button we just
  // clicked? Used by `clickrpc`. Deliberately CONSERVATIVE: a false failure is
  // loud and easy to check, a false success is the exact bug clickrpc exists to
  // catch. Two real false positives drove this (see
  // issues/2026-08-21-clickrpc-accepts-unrelated-call_kw.txt):
  //   * call_kw/access.management/get_remove_options — unrelated background JS
  //     from another module that merely landed inside the wait window.
  //   * call_kw/stock.picking/web_save — the framework's pre-button save, which
  //     happens whether or not the button's own method then runs.
  const FRAMEWORK_METHODS = /^(web_save|web_read|web_search_read|read|search_read|search_count|onchange|name_search|name_get|name_create|read_group|web_read_group|has_group|load_views|get_views|fields_get|default_get|check_access_rights|systray_get_activities)$/;
  const HELPER_MODELS = /^(access\.management|ks_|mail\.|bus\.|ir\.|res\.users$|res\.lang|res\.config)/;
  const rpcQualifies = (pathname, buttonName) => {
    // A type="object"/type="action" button always goes through call_button.
    if (/\/web\/dataset\/call_button/.test(pathname)) return true;
    const m = pathname.match(/\/web\/dataset\/call_kw\/([^/]+)\/([^/]+)/);
    if (!m) return false;
    const model = m[1], method = m[2];
    if (buttonName && method === buttonName) return true;   // strongest signal
    if (FRAMEWORK_METHODS.test(method)) return false;       // form noise, not the action
    if (HELPER_MODELS.test(model)) return false;            // another module's background chatter
    return true;
  };

  // Shared button matcher for `clickbtn` and `clickrpc`: find an action control
  // by the label you SEE (exact → contains), falling back to title/aria-label
  // (icon buttons) and the internal name.
  //
  // NB: do NOT treat a leftover raw `invisible=`/`readonly=` attribute on the
  // rendered button as a fault signal. Verified against Odoo 17 source: the
  // compiler READS the modifier (view_compiler.js getModifier = getAttribute,
  // no removal) and compileButton then passes every remaining attribute through
  // in `attrs`, which views.ViewButton spreads onto the DOM via t-att. So a
  // healthy button with invisible="state != 'x'" in its arch always renders
  // with that attribute still present. It carries no diagnostic meaning.
  // Use `clickrpc` (does an RPC actually fire?) to detect a dead button.
  // ISO date → the user's own Odoo format, so one flow runs on servers whose
  // lang formats differ (local en_US MM/DD/YYYY vs staging DD/MM/YYYY — typing
  // the wrong one silently EMPTIED the field: issues/2026-11-23-date-format-
  // depends-on-locale.txt). `fmt` is {date, datetime} in either Odoo 17 luxon
  // tokens (MM/dd/yyyy HH:mm:ss) or Odoo 14 strftime (%m/%d/%Y %H:%M:%S).
  // Returns null when the value is not ISO or the format is unknown, so a value
  // already in the server's format passes through unchanged.
  function isoToOdooDate(value, fmt) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value || '').trim());
    if (!m || !fmt) return null;
    const [, Y, Mo, D, h, mi, s] = m;
    const pattern = h !== undefined ? fmt.datetime : fmt.date;
    if (!pattern) return null;
    const H = h || '00', MI = mi || '00', S = s || '00';
    const h12 = (Number(H) % 12) || 12, ampm = Number(H) < 12 ? 'AM' : 'PM';
    const t = {
      '%Y': Y, '%y': Y.slice(2), '%m': Mo, '%d': D, '%H': H, '%M': MI, '%S': S,
      '%I': String(h12).padStart(2, '0'), '%p': ampm,
      yyyy: Y, yy: Y.slice(2), MM: Mo, dd: D, HH: H, mm: MI, ss: S,
      hh: String(h12).padStart(2, '0'), a: ampm,
      M: String(Number(Mo)), d: String(Number(D)), H: String(Number(H)), h: String(h12),
    };
    return pattern.replace(/%[YymdHMSIp]|yyyy|yy|MM|dd|HH|mm|ss|hh|M|d|H|h|a/g, k => t[k]);
  }

  // The logged-in user's date formats, from the page itself: Odoo 17 keeps them
  // in @web/core/l10n/localization, Odoo 14 in the lang parameters.
  const readDateFormat = () => page.evaluate(() => {
    try {
      const mods = window.odoo && window.odoo.loader && window.odoo.loader.modules;
      const mod = mods && (mods.get ? mods.get('@web/core/l10n/localization') : mods['@web/core/l10n/localization']);
      const l = mod && mod.localization;
      if (l && l.dateFormat) return { date: l.dateFormat, datetime: l.dateTimeFormat || `${l.dateFormat} ${l.timeFormat}` };
    } catch (e) { /* not Odoo 17 */ }
    try {
      const p = window.odoo.__DEBUG__.services['web.core']._t.database.parameters;
      if (p && p.date_format) return { date: p.date_format, datetime: `${p.date_format} ${p.time_format}` };
    } catch (e) { /* not Odoo 14 */ }
    return null;
  }).catch(() => null);

  function clickButtonByLabel(w) {
    // Buttons + only-OPEN dropdown/cog-menu items. NOT every .dropdown-item in
    // the DOM (the apps-menu portal is always present and would flood the
    // candidates), and never the apps grid itself (that's navmenu's job).
    let els = Array.from(document.querySelectorAll(
      'button, a[role="button"], .btn, .o_statusbar_buttons button, ' +
      '.dropdown-menu.show .dropdown-item, .o-dropdown--menu.d-block .dropdown-item'))
      .filter(e => e.offsetParent !== null && !e.disabled && e.getAttribute('aria-disabled') !== 'true'
        && !e.closest('.o_menu_apps, .o_grid_apps_menu, .o-app-menu'));
    // With a dialog open, only ITS controls count: a user cannot reach the form
    // behind the backdrop, and `clickbtn Confirm` used to click the sale order's
    // own Confirm behind a wizard (issues/2026-11-23-clickbtn-hits-button-behind-dialog.txt).
    // Odoo keeps closed v14 modals in the DOM, so "open" means actually rendered.
    const shown = m => m.getClientRects().length > 0 && getComputedStyle(m).display !== 'none'
      && getComputedStyle(m).visibility !== 'hidden';
    const dialogs = Array.from(document.querySelectorAll('.modal')).filter(shown);
    const top = dialogs[dialogs.length - 1];
    let dialogTitle = null;
    if (top) {
      els = els.filter(e => top.contains(e));
      const t = top.querySelector('.modal-title');
      dialogTitle = t ? t.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) : '(untitled dialog)';
    }
    const label = e => (e.textContent || '').trim().replace(/\s+/g, ' ');
    const txt = e => label(e).toLowerCase();
    const alt = e => ((e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().toLowerCase();
    const nm = e => (e.getAttribute('name') || '').toLowerCase();
    let el = null;
    if (w) {
      el = els.find(e => txt(e) === w) ||               // exact label
        els.find(e => nm(e) === w) ||                   // exact internal name
        els.find(e => txt(e).includes(w) && txt(e)) ||  // label contains
        els.find(e => alt(e).includes(w) && alt(e)) ||  // title/aria contains (icon buttons)
        els.find(e => nm(e).includes(w) && nm(e));      // name contains
    }
    if (!el) {
      const labels = [...new Set(els.map(e => label(e) || `[icon] ${alt(e)}` || `[name] ${nm(e)}`).filter(Boolean))].slice(0, 20);
      return { ok: false, labels, dialog: dialogTitle };
    }
    el.click();
    return { ok: true, text: label(el).slice(0, 40), name: el.getAttribute('name') || '', dialog: dialogTitle };
  }

  // Shared dropdown-item matcher for `pick` and `m2o`: works for OWL
  // (.o-autocomplete--dropdown-item) and v14 jQuery-UI (.ui-menu-item). Skips
  // "Create"/"Create and Edit"/"Search More" so a blank/ambiguous search never
  // lands on a create option (a v14 trap). Exact text match first, then
  // contains, case-insensitive; only clicks a REAL match — never blind-clicks
  // whatever happens to be first (see
  // issues/2026-08-06-m2o-blind-click-and-escape-closes-modal.txt).
  //
  // Odoo renders a "Loading..." placeholder that matches the SAME item selector
  // before the name_search RPC results replace it, so the dropdown existing does
  // not mean the options exist. Placeholders are never selectable, and when they
  // are all that is present this reports {loading:true} so the caller can wait
  // instead of failing (see issues/2026-09-04-autocomplete-loading-placeholder.txt).
  function pickFromDropdown(w) {
    const norm = e => (e.textContent || '').replace(/\s+/g, ' ').trim();
    const isCreate = t => /^(create\b|create and edit|search more|start typing)/i.test(t);
    const isLoading = t => /^(loading|searching)[.\u2026\s]*$/i.test(t);
    const items = Array.from(document.querySelectorAll(
      '.o-autocomplete--dropdown-item, ul.ui-autocomplete li.ui-menu-item, .ui-menu-item a'))
      .filter(e => e.offsetParent !== null);
    const settled = items.filter(e => !isLoading(norm(e)));
    if (!settled.length) {
      // Either a placeholder is showing, or nothing has rendered yet. Both mean
      // "not ready" — the caller should wait rather than fail. `empty` only
      // affects the wording of the eventual give-up message.
      return { ok: false, loading: true, empty: items.length === 0,
               candidates: items.map(norm).filter(Boolean).slice(0, 12) };
    }
    const real = settled.filter(e => !isCreate(norm(e)));
    const pool = real.length ? real : settled;
    let el = w ? pool.find(e => norm(e).toLowerCase() === w) : null;
    if (!el && w) el = pool.find(e => norm(e).toLowerCase().includes(w));
    if (!el && !w) el = pool[0];
    if (!el) return { ok: false, candidates: settled.map(norm).filter(Boolean).slice(0, 12) };
    el.click();
    return { ok: true, text: norm(el).slice(0, 50) };
  }

  // Call pickFromDropdown, waiting out any "Loading..." placeholder. Replaces
  // the `wait 1000` that flows were adding by hand after `waitfor`.
  const pickWhenSettled = async (wanted) => {
    const deadline = Date.now() + actionTimeout;
    let res = await page.evaluate(pickFromDropdown, wanted);
    while (res.loading && Date.now() < deadline) {
      await page.waitForTimeout(120);
      res = await page.evaluate(pickFromDropdown, wanted);
    }
    return res;
  };

  console.log(`\nStarting trace: ${label}`);
  console.log(`Log:     ${logFile}`);
  console.log(`Target:  ${targetUrl}`);
  console.log(`Context: task=${options.task || "(unassigned)"}, session=${options.sessionId || "(unassigned)"}, db=${options.db || "(unpinned)"}`);
  console.log(`Output:  ${traceFile}`);
  console.log(`Timeout: ${actionTimeout}ms/action, strict=${strict}`);

  browser = await chromium.launch({ headless: true });

  // Reuse the login session between runs (cookies persisted per host+port+db)
  // so flows don't have to log in every single time
  const sessionsDir = process.env.TRACE_SESSION_DIR || path.join(__dirname, '.sessions');
  let sessionFile = null;
  try {
    const u = new URL(targetUrl);
    const db = u.searchParams.get('db') || 'default';
    sessionFile = path.join(sessionsDir, `${u.protocol.slice(0, -1)}_${u.hostname}_${u.port || (u.protocol === 'https:' ? '443' : '80')}_${encodeURIComponent(db)}.json`);
  } catch { /* non-URL target — skip session reuse */ }

  const contextOpts = { viewport: { width: 1440, height: 900 } };
  if (sessionFile && fs.existsSync(sessionFile)) {
    contextOpts.storageState = sessionFile;
    console.log(`Session: reusing saved login (${path.basename(sessionFile)})`);
  }
  context = await browser.newContext(contextOpts);

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

  // Kill CSS animations/transitions during recording. Odoo's app-menu and
  // dropdown overlays fade/scale in; if a trace snapshot lands mid-transition
  // the previous view bleeds through (the trace viewer freezes transitions and
  // doesn't composite backdrop-filter), which reads as "flickering/overlapping"
  // in the viewer. With transitions off, overlays snap to their final opaque
  // state, so snapshots are clean. Also neutralize backdrop blur for the same
  // reason. Purely cosmetic for the recording — does not change click behavior.
  await context.addInitScript(() => {
    const apply = () => {
      if (document.getElementById('__pw_no_anim')) return;
      const s = document.createElement('style');
      s.id = '__pw_no_anim';
      s.textContent =
        '*,*::before,*::after{transition:none!important;animation:none!important;' +
        'animation-duration:0s!important;transition-duration:0s!important}' +
        '.o-dropdown--menu,.o_app_menu,.dropdown-menu{backdrop-filter:none!important}';
      (document.head || document.documentElement).appendChild(s);
    };
    apply();
    // head may not exist at document_start — re-apply once the DOM is ready
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  });

  await context.tracing.start({ screenshots: true, snapshots: true });
  tracing = true;
  runtimeEvidence = attachRuntimeEvidence(context, report, () => activeStep, targetUrl);
  if (options.pythonTrace) await runtimeEvidence.enablePythonTrace();
  const page = await context.newPage();
  // Fail-fast default for all Playwright waits (click/fill/waitForSelector/…);
  // waitidle/login keep their own longer internal deadlines.
  page.setDefaultTimeout(actionTimeout);

  // `step` banner: a "STEP 2/5 …" strip across the bottom of every screenshot
  // and trace snapshot. Five flows hand-built one with an eval'd pwStep(), which
  // a reload wiped along with the helper itself
  // (issues/2026-11-23-no-step-banner-command.txt). The kit holds the text and
  // redraws it after every document load; pointer-events:none so it can never
  // swallow a click, and it turns red on the step that fails.
  let banner = null;               // { text, kind: 'info' | 'pass' | 'fail' }
  const drawBanner = () => page.evaluate((b) => {
    let d = document.getElementById('pw-step');
    if (!b) { if (d) d.remove(); return; }
    if (!d) { d = document.createElement('div'); d.id = 'pw-step'; (document.body || document.documentElement).appendChild(d); }
    const bg = b.kind === 'pass' ? '#15803d' : b.kind === 'fail' ? '#b91c1c' : '#1d4ed8';
    d.style.cssText = 'position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:2147483646;'
      + 'max-width:92%;padding:8px 18px;border-radius:8px 8px 0 0;font:600 15px/1.35 sans-serif;color:#fff;'
      + `pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35);background:${bg}`;
    d.textContent = b.text;
  }, banner).catch(() => {});
  page.on('domcontentloaded', () => { if (banner) drawBanner(); });

  // Which dialog is open right now — printed with every failed step, because an
  // unexpected dialog otherwise shows up only as "matched 0 elements" on the
  // next selector (issues/2026-11-23-unexpected-dialog-not-reported.txt).
  const openDialogInfo = () => Promise.race([
    page.evaluate(() => {
      const shown = m => m.getClientRects().length > 0 && getComputedStyle(m).display !== 'none';
      const top = Array.from(document.querySelectorAll('.modal')).filter(shown).pop();
      if (!top) return null;
      const t = top.querySelector('.modal-title');
      const buttons = Array.from(top.querySelectorAll('.modal-footer button, .modal-footer .btn, footer button'))
        .filter(b => b.offsetParent !== null).map(b => b.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean);
      return { title: t ? t.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) : '(untitled)', buttons };
    }),
    new Promise(resolve => setTimeout(() => resolve(null), 2000)),
  ]).catch(() => null);

  // Track in-flight document navigations (form POSTs, redirects) — these are NOT
  // XHR/fetch so the in-page counter can't see them, and waitidle would pass early
  let pendingNav = 0;
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pendingNav++;
  });
  const navDone = (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pendingNav = Math.max(0, pendingNav - 1);
  };
  page.on('requestfinished', navDone);
  page.on('requestfailed', navDone);

  await page.goto(targetUrl, { timeout: 30000 });
  await page.waitForLoadState('domcontentloaded');
  console.log(`\nLoaded: ${await page.title()}`);
  console.log(`URL:    ${page.url()}`);

  console.log('\n--- Commands ---');
  for (const command of require('./commands.json')) {
    console.log(`  ${command.usage.padEnd(42)} ${command.description}`);
  }


  // Shared idle-wait: no pending document navigation (Node-side counter),
  // no pending RPCs (in-page fetch/XHR counter, bus/longpolling excluded),
  // no visible loading overlay, document complete — and stable 250ms later
  const waitIdle = async (maxMs = 15000) => {
    const t0 = Date.now();
    const deadline = t0 + maxMs;
    // Lead-in: give the previous action time to start its request/navigation
    await page.waitForTimeout(400);
    const checkIdle = () => page.evaluate(() => {
      const pending = window.__odooPending || 0;
      // Overlays only count if visible AND actually occupying space — Odoo
      // keeps a permanent hidden <div class="o_loading"> in the DOM and
      // toggles display, and (Odoo 19+) a permanent zero-height empty
      // <div class="o_blockUI"></div> that stays in the layout (has an
      // offsetParent) but never obstructs anything.
      const overlays = document.querySelectorAll('.o_loading_indicator, .o_loading, .o_blockUI');
      const visible = Array.from(overlays).some(el => {
        if (el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return pending === 0 && !visible && document.readyState === 'complete';
    }).catch(() => false); // evaluate throws mid-navigation → not idle
    while (Date.now() < deadline) {
      if (pendingNav > 0) {
        await page.waitForLoadState('load', { timeout: deadline - Date.now() }).catch(() => {});
        await page.waitForTimeout(100);
        continue;
      }
      if (await checkIdle()) {
        await page.waitForTimeout(250);
        if (pendingNav === 0 && await checkIdle()) break;
      } else {
        await page.waitForTimeout(150);
      }
    }
    if (pendingNav !== 0 || !(await checkIdle())) throw new Error(`waitidle timed out after ${maxMs}ms`);
    return Date.now() - t0;
  };

  const fieldTools = createFieldTools(page, waitIdle, () => actionTimeout);

  // Navigation mode: 'human' clicks through the menu; 'quick' short-circuits
  // navmenu to goto #action=<id> when the flow supplies one (`... @<id>`).
  // Set per-flow with the `mode` directive, or via NAV_MODE env var.
  let navMode = (process.env.NAV_MODE || 'human').toLowerCase();
  if (navMode !== 'human' && navMode !== 'quick') navMode = 'human';

  // Red-pointer helpers (shared with the `mark` command's drawing style):
  // inject a real box + caption that survives into the trace viewer, and
  // clear them. Used by navmenu's human mode to explain each menu step.
  const clearMarks = () => page.evaluate(() => {
    document.querySelectorAll('[data-pw-mark]').forEach(e => e.remove());
  }).catch(() => {});
  const drawMarkRect = (rect, caption) => page.evaluate(({ rect, caption }) => {
    if (!rect || !rect.width) return;
    const box = document.createElement('div');
    box.setAttribute('data-pw-mark', '1');
    box.style.cssText = `position:fixed;left:${rect.x - 6}px;top:${rect.y - 6}px;` +
      `width:${rect.width + 12}px;height:${rect.height + 12}px;border:3px solid #dc1e1e;` +
      `border-radius:6px;z-index:2147483647;pointer-events:none;box-sizing:border-box;`;
    document.body.appendChild(box);
    if (caption) {
      const maxW = Math.min(320, window.innerWidth - 24);
      const left = Math.min(Math.max(rect.x, 8), window.innerWidth - maxW - 8);
      const label = document.createElement('div');
      label.setAttribute('data-pw-mark', '1');
      label.textContent = caption;
      // caption below the box if there's no room above (e.g. top navbar)
      const below = rect.y < 40;
      label.style.cssText = `position:fixed;left:${left}px;` +
        `top:${below ? rect.y + rect.height + 6 : Math.max(rect.y - 48, 4)}px;` +
        `max-width:${maxW}px;background:#dc1e1e;color:#fff;font:bold 13px sans-serif;` +
        `line-height:1.3;padding:4px 9px;border-radius:4px;z-index:2147483647;` +
        `pointer-events:none;white-space:normal;`;
      document.body.appendChild(label);
    }
  }, { rect, caption }).catch(() => {});

  // In-page resolver for one menu level. Matches on RENDERED visible text
  // (exact-then-contains, case-insensitive) so translated labels (e.g. Thai)
  // work — the flow author writes whatever appears on screen. It does NOT
  // click: it TAGS the target with data-nav-target and returns its bounding
  // box, so the caller can draw the red pointer first, then click. Selectors
  // are UNIONS across Odoo 14/16/17 so one flow runs unchanged on any of them:
  //   app      → v14 .o_menu_apps a.o_app  |  v16/17 a.o-app-menu-item
  //   section  → v14 .o_menu_sections > li > a  |  v16/17 .o_menu_sections > .o-dropdown > button.dropdown-toggle
  //   dropdown → v14 .dropdown-menu.show inline  |  v16/17 body portal .o-dropdown--menu.d-block
  //   items    → .dropdown-header (group, not clickable) + a.dropdown-item / .dropdown-item (leaf)
  const navLocate = (spec) => page.evaluate((spec) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const w = norm(spec.label);
    const listText = els => els.map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const rectOf = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const tag = el => {
      document.querySelectorAll('[data-nav-target]').forEach(e => e.removeAttribute('data-nav-target'));
      el.setAttribute('data-nav-target', '1');
    };

    if (spec.level === 'app') {
      // Odoo 14: .o_menu_apps a.o_app  |  Odoo 16/17: a.o-app-menu-item carries the
      // app label (its child div.o_app is icon-only, so match the anchor).
      const items = Array.from(document.querySelectorAll('.o_menu_apps a.o_app, a.o-app-menu-item, a.o_app'));
      let el = items.find(e => norm(e.textContent) === w) || items.find(e => norm(e.textContent).includes(w));
      if (!el) {
        // Backend themes such as mk_apps_sidebar render apps as sidebar nav-links and
        // ship no home-menu tiles at all, so `items` above is empty and every navmenu
        // died with '"<App>" (app level)'. Fall back to the stable data-menu-xmlid
        // anchor: match the xmlid itself when the label looks like one
        // (purchase_request.parent_menu_purchase_request), else the visible text.
        const links = Array.from(document.querySelectorAll('a[data-menu-xmlid]'));
        const asXmlid = (spec.label || '').trim();
        el = links.find(e => e.getAttribute('data-menu-xmlid') === asXmlid)
          || links.find(e => norm(e.textContent) === w)
          || links.find(e => norm(e.textContent).includes(w));
        if (el) {
          tag(el);
          const label = (el.textContent || '').trim() || el.getAttribute('data-menu-xmlid');
          return { ok: true, text: label, kind: 'item', leaf: true, rect: rectOf(el), via: 'xmlid' };
        }
        // Offer the xmlids too: on a sidebar theme the tile list is empty, so the old
        // candidate list came back blank and said nothing about what IS available.
        return { ok: false, candidates: listText(items).concat(links.map(e => e.getAttribute('data-menu-xmlid')).filter(Boolean)) };
      }
      tag(el);
      return { ok: true, text: el.textContent.trim(), kind: 'item', leaf: true, rect: rectOf(el) };
    }

    if (spec.level === 'section') {
      // Odoo 14: sections are <li><a> ; Odoo 16/17: <div.o-dropdown><button.dropdown-toggle>
      // Odoo 19: .o_menu_sections' direct children ARE the <a>/<button> themselves
      // (no <li>/.o-dropdown wrapper), e.g. <a class="o-navigable">Dashboard</a> or
      // <button class="dropdown-toggle"><span data-section="...">Configuration</span></button>
      const secs = Array.from(document.querySelectorAll('.o_menu_sections > li, .o_menu_sections > .o-dropdown, .o_menu_sections > a, .o_menu_sections > button'));
      const getA = li => (li.matches('a, button') ? li : li.querySelector('a, button.dropdown-toggle, button'));
      const match = secs.find(li => { const a = getA(li); return a && norm(a.textContent) === w; })
                 || secs.find(li => { const a = getA(li); return a && norm(a.textContent).includes(w); });
      if (!match) return { ok: false, candidates: secs.map(li => { const a = getA(li); return a ? a.textContent.trim() : ''; }).filter(Boolean) };
      const a = getA(match);
      tag(a);
      return { ok: true, text: a.textContent.trim(), kind: 'item', leaf: !a.classList.contains('dropdown-toggle'), rect: rectOf(a) };
    }

    // level === 'dropdown' — inside the currently open section dropdown
    const menu = document.querySelector('.o_menu_sections .dropdown-menu.show')
              || document.querySelector('.o_menu_sections li.show .dropdown-menu')
              // Odoo 16/17: the section dropdown renders in a body-level portal
              || document.querySelector('.o-dropdown--menu.dropdown-menu.d-block')
              || document.querySelector('.o-dropdown--menu.d-block')
              || document.querySelector('.o-dropdown--menu.show')
              // Odoo 19: rendered as an o_popover (position:fixed, so
              // offsetParent is always null regardless of visibility — the
              // popover component is only mounted in the DOM while open, so
              // existence alone is enough, no visibility check needed)
              || document.querySelector('.o_popover.o-dropdown--menu')
              || document.querySelector('.o_menu_sections .dropdown-menu');
    if (!menu) return { ok: false, nomenu: true, candidates: [] };
    const nodes = Array.from(menu.querySelectorAll('.dropdown-header, .dropdown-item'));
    const headers = nodes.filter(n => n.classList.contains('dropdown-header'));
    let items = nodes.filter(n => n.classList.contains('dropdown-item'));

    // If a group header was matched previously, scope items to that group
    // (between this header and the next) — Odoo 14 flattens groups into a
    // single menu with .dropdown-header separators, so "Products" as an
    // intermediate label narrows which items the next label may match.
    if (spec.group) {
      const gw = norm(spec.group);
      const hidx = nodes.findIndex(n => n.classList.contains('dropdown-header') && (norm(n.textContent) === gw || norm(n.textContent).includes(gw)));
      if (hidx !== -1) {
        let end = nodes.length;
        for (let j = hidx + 1; j < nodes.length; j++) { if (nodes[j].classList.contains('dropdown-header')) { end = j; break; } }
        items = nodes.slice(hidx + 1, end).filter(n => n.classList.contains('dropdown-item'));
      }
    }

    // Resolution order: exact item → exact header → contains item → contains
    // header. Exact-header-before-contains-item stops "Delivery" (a group)
    // from wrongly matching the item "Delivery Packages".
    const foundItem = el => { tag(el); return { ok: true, text: el.textContent.trim(), kind: 'item', leaf: !el.classList.contains('dropdown-toggle'), rect: rectOf(el) }; };
    const foundHeader = el => { tag(el); return { ok: true, text: el.textContent.trim(), kind: 'header', rect: rectOf(el) }; };
    let el = items.find(e => norm(e.textContent) === w);
    if (el) return foundItem(el);
    let hd = headers.find(e => norm(e.textContent) === w);
    if (hd) return foundHeader(hd);
    el = items.find(e => norm(e.textContent).includes(w));
    if (el) return foundItem(el);
    hd = headers.find(e => norm(e.textContent).includes(w));
    if (hd) return foundHeader(hd);

    return { ok: false, candidates: nodes.map(n => (n.classList.contains('dropdown-header') ? '[group] ' : '') + n.textContent.trim()).filter(Boolean) };
  }, spec);

  // Click whatever navLocate tagged, and clear the tag.
  const navClickTagged = () => page.evaluate(() => {
    const el = document.querySelector('[data-nav-target]');
    if (!el) return false;
    el.removeAttribute('data-nav-target');
    el.click();
    return true;
  });

  // Walk a `>`-separated label path by clicking each menu level, with an
  // implicit waitidle between navigating clicks. When opts.mark is set (human
  // mode), a red box + caption is drawn on each target before it is clicked,
  // so the trace explains every step. Returns true on success.
  const navMenuWalk = async (labels, opts = {}) => {
    const mark = !!opts.mark;
    const showCandidates = list => (list || []).forEach(c => console.log(`      · ${c}`));
    // draw the pointer, pause so it's captured in the trace, then (optionally) click
    const point = async (rect, caption) => {
      if (!mark) return;
      await clearMarks();
      await drawMarkRect(rect, caption);
      await page.waitForTimeout(600); // hold the pointer so it's visible in the trace
    };
    const fail = async (msg, r) => {
      console.log(`  navmenu NOT FOUND: ${msg}`);
      if (r && r.nomenu) console.log('      (no open dropdown menu found)');
      showCandidates(r && r.candidates);
      if (mark) await clearMarks();
      throw new Error(`navmenu NOT FOUND: ${msg}`);
    };

    // Level 0 — app: open the apps menu (for visual fidelity) then click it
    // Open the apps menu across versions (v14 .full toggle / v16 navbar apps /
    // v17 grid button). Skip if the app items are already present (menu open).
    await page.evaluate(() => {
      if (document.querySelector('a.o-app-menu-item, .o_menu_apps a.o_app')) return; // already open
      // Try in PRIORITY order — a comma-union querySelector returns the first
      // match in DOM order, which is the .o_navbar_apps_menu *container* (a
      // no-op click), not the button inside it. v17 grid button first.
      const sels = ['.o_grid_apps_menu__button', '.o_navbar_apps_menu button', '.o_menu_apps a.full', '.o_menu_apps .dropdown-toggle', '.o_navbar_apps_menu'];
      for (const s of sels) { const t = document.querySelector(s); if (t) { t.click(); return; } }
    }).catch(() => {});
    // Wait for the app grid to actually populate (portal render can outlast a
    // fixed sleep) — robust across versions instead of a flaky 250ms guess.
    await page.waitForSelector('a.o-app-menu-item, .o_menu_apps a.o_app, a[data-menu-xmlid]', { timeout: actionTimeout }).catch(() => {});
    await page.waitForTimeout(200); // let the overlay finish painting before the mark/snapshot
    let r = await navLocate({ level: 'app', label: labels[0] });
    if (!r.ok) return fail(`"${labels[0]}" (app level)`, r);
    await point(r.rect, `App: ${r.text}`);
    await navClickTagged();
    if (mark) await clearMarks(); // clicking the app navigates — drop the stale box
    console.log(`  navmenu → app "${r.text}"`);
    await waitIdle();
    if (labels.length === 1) return true;

    // Level 1 — section (top menu bar of the current app)
    r = await navLocate({ level: 'section', label: labels[1] });
    if (!r.ok) return fail(`"${labels[1]}" (section level)`, r);
    await point(r.rect, `Menu: ${r.text}`);
    await navClickTagged();
    if (r.leaf) {
      if (mark) await clearMarks(); // navigated — drop the stale box
      console.log(`  navmenu → section "${r.text}" (leaf)`);
      await waitIdle();
      if (labels.length > 2) console.log(`  navmenu WARNING: "${r.text}" navigated but ${labels.length - 2} more label(s) remain`);
      return true;
    }
    // dropdown toggle: keep the navbar mark up while the dropdown is open
    console.log(`  navmenu → opened section "${r.text}"`);
    // Wait for the section dropdown to actually render (v17 body portal / v14 inline)
    await page.waitForSelector('.o-dropdown--menu.d-block, .o-dropdown--menu.show, .o_menu_sections .dropdown-menu.show', { timeout: actionTimeout }).catch(() => {});
    await page.waitForTimeout(200); // let the dropdown finish painting before the mark/snapshot

    // Levels 2+ — inside the open dropdown (group headers + leaf items)
    let group = null;
    for (let i = 2; i < labels.length; i++) {
      r = await navLocate({ level: 'dropdown', label: labels[i], group });
      if (!r.ok) return fail(`"${labels[i]}" (under "${labels[i - 1]}")`, r);
      const isLast = i === labels.length - 1;
      if (r.kind === 'header') {
        // group header — explain it with the pointer but do NOT click
        await point(r.rect, `Group: ${r.text}`);
        group = r.text;
        if (isLast) {
          // Previously this only WARNED and the flow carried on against the
          // wrong page, so every later selector timed out for a reason that
          // looked unrelated. A group header is never what the flow wanted.
          if (mark) await clearMarks();
          const probe = await navLocate({ level: 'dropdown', label: '__no_such_item__', group: r.text });
          const opts = (probe && probe.candidates) || [];
          throw new Error(
            `navmenu: "${r.text}" is a GROUP HEADER, not a clickable menu item — nothing was opened.` +
            (opts.length ? ` This menu contains: ${opts.slice(0, 16).join(' | ')}` : '') +
            ` (If the record has no menu item at all, use: record <model> <id>)`);
        }
        console.log(`  navmenu → group "${r.text}"`);
      } else {
        await point(r.rect, `${isLast ? 'Open' : 'Menu'}: ${r.text}`);
        await navClickTagged();
        console.log(`  navmenu → item "${r.text}"${r.leaf ? '' : ' (submenu)'}`);
        group = null;
        if (r.leaf) { if (mark) await clearMarks(); await waitIdle(); } // navigated — drop stale box
        else await page.waitForTimeout(250);
      }
    }
    if (mark) await clearMarks();
    return true;
  };

  const rl = readline.createInterface({ input: capture.input });
  capture.start();

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    // Quote-aware tokenizer: 'my selector with spaces' becomes one token
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue; // skip empty lines and comments

    const parts = [];
    const quoted = [];               // parallel to parts: was this token single-quoted?
    let cur = '', inQ = false, curQuoted = false;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "'" && !inQ) { inQ = true; curQuoted = true; }
      else if (raw[i] === "'" && inQ) { inQ = false; }
      else if (raw[i] === ' ' && !inQ) { if (cur || curQuoted) { parts.push(cur); quoted.push(curQuoted); cur = ''; curQuoted = false; } }
      else { cur += raw[i]; }
    }
    if (cur || curQuoted) { parts.push(cur); quoted.push(curQuoted); }

    const cmd = parts[0];
    // rawRest used by eval/jclick to avoid quote-stripping JS code
    const rawRest = raw.slice(cmd.length + 1);
    // selector for the rest-of-line commands, quoted or not (see unwrapRest)
    const restSel = unwrapRest(rawRest);

    // Echo the command as it STARTS — flushed to the log file immediately, so a
    // killed/hung run shows exactly which command it was on.
    const displayCommand = ['login', 'cookie'].includes(cmd) ? `${cmd} [redacted]` : raw;
    console.log(`> ${displayCommand}`);
    const step = { step_id: `${runId}-step-${report.steps.length + 1}`, line: lineNumber, command: displayCommand, status: 'running', started_at: new Date().toISOString() };
    const stepStart = Date.now();
    activeStep = step;
    report.steps.push(step);
    saveReport();

    let stop = false;
    // Dispatch the command. Wrapped in Promise.race below so a genuine hang is
    // capped instead of looking like a silent multi-minute freeze.
    const dispatch = async () => {
      if (inQ && ['fill', 'date', 'm2o', 'celltype', 'boolcell', 'mark', 'expect', 'field', 'rowset'].includes(cmd))
        throw new Error('Unclosed single quote');
      if (cmd === 'done') {
        return 'STOP';

      } else if (cmd === 'timeout') {
        const ms = parseInt(parts[1] || '', 10);
        if (ms > 0) { actionTimeout = ms; page.setDefaultTimeout(actionTimeout); console.log(`  action timeout: ${actionTimeout}ms`); }
        else throw new Error(`  timeout expects milliseconds (got "${parts[1] || ''}")`);

      } else if (cmd === 'strict') {
        const v = (parts[1] || '').toLowerCase();
        if (!/^(1|true|on|yes|0|false|off|no)$/.test(v)) throw new Error('strict expects on or off');
        strict = /^(1|true|on|yes)$/.test(v);
        console.log(`  strict mode: ${strict ? 'ON — abort on first error' : 'off'}`);

      } else if (cmd === 'goto') {
        await page.goto(parts.slice(1).join(' '), { timeout: 20000 });
        await page.waitForLoadState('domcontentloaded');
        console.log(`  → ${page.url()}`);
        // An Odoo 18-style /odoo/<path> URL returns HTTP 200 on Odoo 17 but
        // renders NOTHING, so the next selectors fail with "0 elements" and it
        // reads as a selector bug. Say so here instead.
        // See issues/2026-08-20-no-scroll-command-and-odoo17-url.txt.
        const shell = await page.evaluate(() => {
          if (/\/web\/login|\/web\/database/.test(location.pathname)) return null; // auth pages: no action manager expected
          const am = document.querySelector('.o_action_manager');
          return { missing: !am, empty: !!am && am.textContent.trim().length === 0 };
        }).catch(() => null);
        if (shell && (shell.missing || shell.empty)) {
          console.log('  WARNING: the page rendered no action content (.o_action_manager is '
            + (shell.missing ? 'absent' : 'empty') + ').');
          console.log('      On Odoo 17 an /odoo/<path> style URL loads blank like this. Use the hash form');
          console.log('      /web#id=<id>&model=<model>&view_type=form  — or the `record <model> <id>` command.');
        }

      } else if (cmd === 'mode') {
        // Set navigation mode for subsequent `navmenu` commands.
        // Usage: mode human   (click through menus)
        //        mode quick   (short-circuit navmenu to goto #action=<id>)
        const m = (parts[1] || '').toLowerCase();
        if (m === 'human' || m === 'quick') {
          navMode = m;
          console.log(`  nav mode: ${navMode}`);
        } else {
          throw new Error(`  mode expects 'human' or 'quick' (got "${parts[1] || ''}")`);
        }

      } else if (cmd === 'navmenu') {
        // Navigate by clicking menu items instead of a hash URL.
        // Usage: navmenu App > Section > [Group >] Item [@<actionId>]
        //   human mode → clicks each label in turn (shows the real breadcrumb)
        //   quick  mode → jumps to #action=<id> if @<id> is given; else clicks through
        let spec = rawRest.trim();
        let actionId = null;
        const m = spec.match(/\s*@(\d+)\s*$/);
        if (m) { actionId = m[1]; spec = spec.slice(0, m.index).trim(); }
        const labels = spec.split('>').map(s => s.trim()).filter(Boolean);
        if (labels.length === 0) {
          throw new Error('  navmenu: no menu path given (e.g. navmenu Inventory > Configuration > Products > Purchase Product Group)');
        } else if (navMode === 'quick' && actionId) {
          const origin = new URL(page.url()).origin;
          await page.goto(`${origin}/web#action=${actionId}`, { timeout: 20000 });
          const ms = await waitIdle(15000);
          console.log(`  navmenu [quick] → #action=${actionId} (${ms}ms): ${labels.join(' > ')}`);
        } else {
          if (navMode === 'quick' && !actionId) {
            console.log('  navmenu [quick] no @<actionId> supplied — clicking through instead');
          }
          // Human mode always draws the red pointer at each step to explain it
          await navMenuWalk(labels, { mark: navMode === 'human' });
        }

      } else if (cmd === 'click') {
        await page.click(restSel, { timeout: actionTimeout }).catch(async (e) => {
          const count = await page.evaluate((s) => document.querySelectorAll(s).length, restSel).catch(() => -1);
          const hint = count === 0 ? 'selector matched 0 elements' : `selector matched ${count} element(s) but was not actionable`;
          throw new Error(`${e.message.split('\n')[0]} — ${hint}`);
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  clicked: ${restSel}`);

      } else if (cmd === 'fclick') {
        // Force click — bypasses Playwright visibility/stability checks
        // Good for: SPA buttons that Playwright thinks aren't actionable
        await page.click(restSel, { force: true, timeout: actionTimeout }).catch(async (e) => {
          const count = await page.evaluate((s) => document.querySelectorAll(s).length, restSel).catch(() => -1);
          const hint = count === 0 ? 'selector matched 0 elements' : `selector matched ${count} element(s) but was not actionable`;
          throw new Error(`${e.message.split('\n')[0]} — ${hint}`);
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  fclicked: ${restSel}`);

      } else if (cmd === 'jclick') {
        // JS click — dispatches .click() directly on the DOM element
        // Good for: Odoo OWL2 action buttons in forms
        const found = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.click();
          return true;
        }, restSel);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        if (!found) throw new Error(`jclick NOT FOUND: ${restSel}`);
        console.log(`  jclicked (found): ${restSel}`);

      } else if (cmd === 'field') {
        if (parts.length < 3) throw new Error('Usage: field <name> <value>');
        const actual = await fieldTools.field(parts[1], parts.slice(2).join(' '));
        console.log(`  field ${parts[1]}: verified ${JSON.stringify(actual)}`);

      } else if (cmd === 'rowset') {
        if (parts.length < 5) throw new Error('Usage: rowset <table-field> <#position|field=exact value> <column> <value>');
        const actual = await fieldTools.rowset(parts[1], parts[2], parts[3], parts.slice(4).join(' '));
        console.log(`  rowset ${parts[1]} ${parts[2]} ${parts[3]}: verified ${JSON.stringify(actual)}`);

      } else if (cmd === 'fill') {
        const { sel, rest } = await splitSelector(cmd, parts, quoted);
        const text = rest.join(' ');
        await page.fill(sel, text, { timeout: actionTimeout });
        // Read the value back. A "filled:" line has to be evidence, not a claim:
        // Playwright reports success as long as SOME element accepted the text,
        // so a too-broad selector can write into the wrong node while the field
        // you meant stays empty — which then only surfaces many steps later as a
        // validation error on Save.
        const landed = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return { missing: true };
          const v = ('value' in el && el.value !== undefined) ? el.value : el.textContent;
          return { value: v == null ? '' : String(v), count: document.querySelectorAll(s).length };
        }, sel);
        if (landed.missing) throw new Error(`fill: "${sel}" matched nothing when reading the value back`);
        if (landed.value !== text) {
          throw new Error(
            `fill: wrote to "${sel}" but reading it back gives ${JSON.stringify(landed.value)}, `
            + `not ${JSON.stringify(text)} — the text most likely went into a different element `
            + `(is the selector specific enough, and does it point at the input/textarea itself?)`);
        }
        console.log(`  filled: ${sel} = "${text}"${landed.count > 1 ? `  (NOTE: selector matches ${landed.count} elements; the first was used)` : ''}`);

      } else if (cmd === 'date') {
        // Odoo 17 date/datetime inputs open a picker overlay that is NOT
        // clickable — a `click` before fill eats a full timeout. Fill the value
        // directly (Playwright fill fires input+change), fire change again for
        // OWL, close the picker (Escape), and commit (blur). No click.
        // Value: write ISO (2026-12-15, or 2026-12-15 18:00 for a datetime) and it
        // is converted to the logged-in user's format, which differs by server
        // (local en_US MM/DD/YYYY, staging DD/MM/YYYY). A value already in the
        // server's format is passed through unchanged. Datetimes are user-local.
        // Usage: date <selector> <value>
        const { sel, rest } = await splitSelector(cmd, parts, quoted);
        let value = rest.join(' ');
        const fmt = await readDateFormat();
        const converted = isoToOdooDate(value, fmt);
        if (converted) {
          console.log(`  date: ${value} → "${converted}" (this server's format: ${/\d\d:\d\d/.test(value) ? fmt.datetime : fmt.date})`);
          value = converted;
        } else if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
          console.log('  NOTE: could not read this server\'s date format; writing the ISO value as is');
        }
        await page.fill(sel, value, { timeout: actionTimeout });
        await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
        }, sel);
        // Only dismiss a picker that is ACTUALLY open. `date` never clicks the
        // field, so usually no picker exists — and an Escape with nothing to
        // close bubbles to Odoo's Dialog component and shuts the whole
        // target='new' modal, after which every later step runs against the
        // screen behind it with no error from here. Same trap m2o/pick already
        // avoid. See issues/2026-09-11-date-command-escape-closes-target-new-dialog.txt
        const pickerOpen = await page.evaluate(() => !!document.querySelector(
          '.o_datetime_picker, .o_date_picker, .bootstrap-datetimepicker-widget, .datepicker'));
        if (pickerOpen) await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.blur(); }, sel);
        // Read it back. A date in the wrong format is not rejected by the input —
        // Odoo parses it on commit and leaves the field EMPTY (or flags it
        // invalid), and the flow only found out several steps later.
        await page.waitForTimeout(250);
        const back = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return null;
          const v = 'value' in el ? el.value : el.textContent;
          return { value: (v || '').trim(),
                   invalid: !!el.closest('.o_field_invalid, .o_invalid_field') || el.classList.contains('o_field_invalid') };
        }, sel);
        // Three ways Odoo rejects a date it cannot parse: it empties the field
        // (seen on staging, 14), flags it invalid, or — Odoo 17 — silently puts
        // the PREVIOUS value back. So compare the numbers too: "1/6/2026" and
        // "01/06/2026" are the same date, "15/12/2026" vs "12/16/2026" is not.
        const nums = s => (String(s).match(/\d+/g) || []).map(Number);
        const sameDate = (a, b) => { const x = nums(a), y = nums(b), n = Math.max(3, Math.min(x.length, y.length));
          return x.slice(0, n).join(',') === y.slice(0, n).join(','); };
        const why = !back ? null
          : !back.value ? 'is EMPTY'
          : back.invalid ? `is flagged invalid ("${back.value}")`
          : !sameDate(back.value, value) ? `shows "${back.value}" (Odoo kept or put back a different date)`
          : null;
        if (value && why) {
          throw new Error(`date: wrote "${value}" into ${sel}, but after commit the field ${why} — Odoo did not accept it. `
            + `This server's format is ${fmt ? `${fmt.date} (datetime ${fmt.datetime})` : 'unknown'}; `
            + 'write the date as ISO YYYY-MM-DD and the kit converts it.');
        }
        console.log(`  date: ${sel} = "${back ? back.value : value}"${pickerOpen ? ' (closed open picker)' : ''}`);

      } else if (cmd === 'type' || cmd === 'retype') {
        // type   — keystrokes into the focused element, AFTER whatever it holds.
        // retype — clear the focused input first, then type (replace, not append).
        // `type` into an input that already had text silently produced
        // "Product AProduct B" twice (issues/2026-11-23-type-appends-to-existing-text.txt),
        // so it now says when it appended.
        const text = parts.slice(1).join(' ');
        const readFocused = () => page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          return 'value' in el ? String(el.value) : (el.isContentEditable ? el.textContent : null);
        }).catch(() => null);
        const replace = cmd !== 'type';   // retype
        const before = await readFocused();
        if (replace) {
          await page.keyboard.press('Control+a');
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.type(text, { delay: 50 });
        const after = await readFocused();
        if (replace) {
          console.log(`  retyped: "${text}"${before ? ` (replaced "${before}")` : ''}`);
          if (after !== null && after !== text) console.log(`  NOTE: the input now reads "${after}"`);
        } else {
          console.log(`  typed: "${text}"`);
          if (before) console.log(`  NOTE: the focused input already held "${before}" — appended, it now reads "${after}". Use \`retype\` to replace.`);
        }

      } else if (cmd === 'm2o') {
        // Many2one field helper: click cell → clear any pre-filled value → type
        // search → wait for a dropdown item → pick the one that actually
        // matches (via the same matcher as `pick`, not blindly the first item).
        // Fixes fill() failing on role="combobox" inputs in OWL editable tree rows.
        // Previously this clicked whatever dropdown item appeared first
        // regardless of the typed text, and never cleared a pre-filled combobox
        // before typing (so typing appended instead of replacing) — see
        // issues/2026-08-06-m2o-blind-click-and-escape-closes-modal.txt. `pick`
        // already closes its own dropdown via a direct element click, so no
        // trailing `press Escape` is needed (or wanted) after m2o/pick — an
        // Escape here can instead close the whole enclosing modal.
        const { sel: cellSel, rest } = await splitSelector(cmd, parts, quoted);
        const searchText = rest.join(' ');
        await page.click(cellSel, { timeout: actionTimeout });
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(searchText, { delay: 50 });
        await page.waitForSelector(
          '.o-autocomplete--dropdown-item, ul.ui-autocomplete li.ui-menu-item, .ui-menu-item a',
          { timeout: actionTimeout });
        const res = await pickWhenSettled(searchText.trim().toLowerCase());
        if (res.ok) {
          console.log(`  m2o: ${cellSel} = "${res.text}"`);
        } else if (res.loading) {
          throw new Error(`  m2o NOT FOUND: ${cellSel} = "${searchText}" — after ${actionTimeout}ms the dropdown ${res.empty ? 'still had no visible items' : 'still showed only a loading placeholder'}; the name_search results never arrived`);
        } else {
          throw new Error(`  m2o NOT FOUND: ${cellSel} = "${searchText}" — options: ${(res.candidates || []).join(" | ")}`);
        }

      } else if (cmd === 'pick') {
        // Pick an option from an ALREADY-OPEN autocomplete dropdown by text —
        // works for OWL (.o-autocomplete--dropdown-item) and v14 jQuery-UI
        // (.ui-menu-item). Skips "Create"/"Create and Edit"/"Search More" so
        // Enter/first-item never lands on a create option (a v14 trap). Selects
        // via JS .click(); exact match first, then contains, case-insensitive.
        // Usage: fill '<input>' Text  →  waitidle  →  pick Text
        const wanted = rawRest.trim().toLowerCase();
        const res = await pickWhenSettled(wanted);
        if (res.ok) console.log(`  pick: "${res.text}"`);
        else if (res.loading) {
          throw new Error(`  pick NOT FOUND: "${rawRest}" — after ${actionTimeout}ms the dropdown ${res.empty ? 'still had no visible items' : 'still showed only a loading placeholder'}; the name_search results never arrived (is an autocomplete actually open, and does the search text match anything?)`);
        } else {
          throw new Error(`  pick NOT FOUND: "${rawRest}" — options: ${(res.candidates || []).join(" | ")}`);
        }

      } else if (cmd === 'celltype') {
        // v14 editable-list cell: a readonly-styled <td> often reports "not
        // actionable" to click/fclick even though it IS clickable, and the
        // first click only enters row-edit mode WITHOUT focusing the inner
        // input (so `type` lands in whatever was focused before). This does the
        // two-stage dance: JS-click the cell to enter edit, then focus the
        // cell's own input/textarea, then type into it.
        // Usage: celltype '<td selector>' <text>   (quote selectors with spaces)
        const { sel: cellSel, rest } = await splitSelector(cmd, parts, quoted);
        const text = rest.join(' ');
        const entered = await page.evaluate((s) => {
          const cell = document.querySelector(s);
          if (!cell) return { ok: false };
          cell.click(); // enter row-edit mode (CSS-selector click can wrongly report not-actionable)
          return { ok: true };
        }, cellSel);
        if (!entered.ok) { throw new Error(`  celltype NOT FOUND cell: ${cellSel}`); }
        else {
          await page.waitForTimeout(150); // let the input render in the cell
          const focused = await page.evaluate((s) => {
            const cell = document.querySelector(s);
            const inp = cell && cell.querySelector('input, textarea, [contenteditable="true"]');
            if (!inp) return false;
            inp.focus();
            if ('select' in inp) try { inp.select(); } catch (e) {}
            return true;
          }, cellSel);
          if (!focused) throw new Error(`  celltype: no input in cell ${cellSel} (cell did not enter edit mode)`);
          await page.keyboard.type(text, { delay: 50 });
          console.log(`  celltype: ${cellSel} = "${text}"${focused ? '' : ' (WARN: cell had no input)'}`);
        }

      } else if (cmd === 'cols') {
        // Print a table's header cells with their column index — column order is
        // NOT stable across tables (e.g. the "Detailed Operations" popup differs
        // from the main Operations tab), so discover per-table instead of
        // reusing an index. Usage: cols [table selector]  (default: first list)
        const tableSel = restSel || '.o_list_table, table.o_list_view, table';
        const heads = await page.evaluate((sel) => {
          const t = document.querySelector(sel);
          if (!t) return null;
          // first thead only — Odoo renders a duplicate sticky header
          const thead = t.querySelector('thead');
          const ths = Array.from((thead || t).querySelectorAll('th'));
          return ths.map((th, i) => ({ i, name: th.getAttribute('data-name') || th.getAttribute('name') || '', text: (th.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) }));
        }, tableSel);
        if (!heads) console.log(`  cols: no table matched ${tableSel}`);
        else heads.forEach(h => console.log(`  [${h.i}] "${h.text}"${h.name ? ` (name=${h.name})` : ''}`));

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
        if (!found) throw new Error(`addline NOT FOUND link: ${fieldName}`);
        await page.waitForSelector('tr.o_selected_row', { timeout: actionTimeout });
        console.log(`  addline (${found ? 'found' : 'NOT FOUND link'}): [name="${fieldName}"]`);

      } else if (cmd === 'press') {
        await page.keyboard.press(parts[1]);
        console.log(`  pressed: ${parts[1]}`);

      } else if (cmd === 'wait') {
        const ms = parseInt(parts[1] || '1000');
        await page.waitForTimeout(ms);
        console.log(`  waited ${ms}ms`);

      } else if (cmd === 'waitidle') {
        // Wait for Odoo to actually finish: RPCs drained + loading overlays gone.
        // Much faster than fixed waits — returns as soon as the page is ready.
        // Usage: waitidle [maxMs]   (default 15000)
        const ms = await waitIdle(parseInt(parts[1] || '15000'));
        console.log(`  idle after ${ms}ms`);

      } else if (cmd === 'login') {
        // Smart login: if the session (reused from .sessions/) is still valid,
        // skip the form and go straight to /web. NOTE: Odoo renders the login
        // form on /web/login even when authenticated — the form's presence
        // proves nothing; ask the server via get_session_info instead.
        // Usage: login <user> <password>
        const user = parts[1];
        const pass = parts.slice(2).join(' ');
        const getSession = () => page.evaluate(async () => {
          try {
            const r = await fetch('/web/session/get_session_info', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
            });
            const j = await r.json();
            return j.result && j.result.uid ? { uid: j.result.uid, db: j.result.db, username: j.result.username, server_version: j.result.server_version } : null;
          } catch { return null; }
        });
        let sess = await getSession();
        // Guard against wrong-DB sessions: if the target URL pins a db (?db=...)
        // and the restored session belongs to a different one, discard it —
        // otherwise the trace would silently record against the wrong database
        const wantDb = (() => {
          try { return new URL(targetUrl).searchParams.get('db'); } catch { return null; }
        })();
        if (sess && ((wantDb && sess.db !== wantDb) || sess.username !== user)) {
          console.log(`  session is for ${sess.username} / db "${sess.db}" but target wants ${user} / db "${wantDb || "(unspecified)"}" — discarding session, logging in fresh`);
          await context.clearCookies();
          await page.goto(targetUrl, { timeout: 20000 });
          await waitIdle(10000);
          sess = null;
        }
        if (sess) {
          const origin = new URL(page.url()).origin;
          await page.goto(origin + '/web', { timeout: 20000 });
          const ms = await waitIdle(15000);
          console.log(`  login skipped — session still valid (uid=${sess.uid}, db=${sess.db}, ${ms}ms)`);
        } else {
          await page.fill('input#login', user);
          await page.fill('input#password', pass);
          await page.keyboard.press('Enter');
          const ms = await waitIdle(20000);
          const failed = await page.evaluate(() => !!document.querySelector('input#login'));
          if (failed) {
            throw new Error(`  login FAILED for "${user}" — still on login form (check credentials/db)`);
          } else {
            const after = await getSession();
            if (!after || (wantDb && after.db !== wantDb) || after.username !== user) {
              const e = new Error('login FAILED: server did not verify the requested user/database');
              e.fatal = true;
              throw e;
            }
            sess = after;
            console.log(`  logged in as ${user} (db=${after ? after.db : '?'}, ${ms}ms)`);
          }
        }

        report.context.verified_session = sess;
        saveReport();

      } else if (cmd === 'expect') {
        const kind = parts[1];
        let selector = parts[2], expected = parts.slice(3).join(' ');
        if (kind === 'visible' || kind === 'hidden') {
          // No expected value, so the whole rest of the line is the selector —
          // `expect visible .o_form_view button[name="x"]` used to keep only the
          // first token and fail on the wrong element.
          selector = unwrapRest(rawRest.trim().slice(kind.length));
          expected = '';
        } else if (kind === 'text' || kind === 'value') {
          const split = await splitSelector(cmd, parts, quoted, 2);
          selector = split.sel; expected = split.rest.join(' ');
        }
        if (kind === 'state') {
          expected = parts.slice(2).join(' ');
          selector = '.o_form_view .o_statusbar_status .o_arrow_button_current, .o_form_view .o_statusbar_status [aria-checked="true"]';
        } else if (kind === 'dialog') {
          expected = parts.slice(2).join(' ');
          selector = '.modal:visible .modal-title';
        }
        if (!['visible', 'hidden', 'text', 'value', 'state', 'dialog'].includes(kind) || !selector)
          throw new Error('Usage: expect visible|hidden|text|value <selector> [expected], or expect state|dialog <expected text>');
        const loc = page.locator(selector);
        const normalize = text => text.replace(/\s+/g, ' ').trim();
        const deadline = Date.now() + actionTimeout;
        let actual = null, matched = false;
        do {
          const count = await loc.count();
          if (kind === 'hidden') {
            actual = !(await Promise.all((await loc.all()).map(el => el.isVisible()))).some(Boolean);
            matched = actual;
          }
          else if (count === 1 && await loc.isVisible()) {
            actual = kind === 'value' ? await loc.inputValue() : normalize(await loc.innerText());
            matched = kind === 'visible' || actual === (kind === 'value' ? expected : normalize(expected));
          } else { actual = `${count} matches (expected one visible element)`; }
          if (matched) break;
          await page.waitForTimeout(100);
        } while (Date.now() < deadline);
        if (!matched) throw new Error(`expect ${kind} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} for ${selector}`);
        console.log(`  expect ${kind}: PASS`);

      } else if (cmd === 'screenshot') {
        const imgName = parts[1] || `${label}-${Date.now()}`;
        const imgPath = path.join(tracesDir, imgName.endsWith('.png') ? imgName : `${imgName}.png`);
        // Wait for web-fonts (Font Awesome icons, Thai fonts) to finish loading,
        // else icon glyphs render as empty □ "tofu" boxes in the capture.
        await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
        await page.screenshot({ path: imgPath, fullPage: true });
        shots.push(imgPath); // tracked for end-of-run cleanup (they're in the trace)
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
        await page.locator(restSel).first().highlight();
        console.log(`  highlighted: ${restSel}`);

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
        const { sel, rest } = await splitSelector(cmd, parts, quoted);
        const caption = rest.join(' ');
        const rect = await page.locator(sel).first().boundingBox().catch(() => null);
        if (!rect) {
          throw new Error(`  mark NOT FOUND: ${sel}`);
        } else {
          await page.evaluate(({ rect, caption }) => {
            const box = document.createElement('div');
            box.setAttribute('data-pw-mark', '1');
            box.style.cssText = `position:fixed;left:${rect.x - 6}px;top:${rect.y - 6}px;` +
              `width:${rect.width + 12}px;height:${rect.height + 12}px;border:3px solid #dc1e1e;` +
              `border-radius:6px;z-index:2147483647;pointer-events:none;box-sizing:border-box;`;
            document.body.appendChild(box);
            if (caption) {
              // Wrap onto up to ~2 lines and keep the label inside the viewport —
              // long captions near the right edge used to run off-screen as one
              // unbroken nowrap line and get clipped by the screenshot itself.
              const maxW = Math.min(340, window.innerWidth - 24);
              const left = Math.min(Math.max(rect.x, 8), window.innerWidth - maxW - 8);
              const below = rect.y < 60;
              const label = document.createElement('div');
              label.setAttribute('data-pw-mark', '1');
              label.textContent = caption;
              label.style.cssText = `position:fixed;left:${left}px;` +
                `top:${below ? rect.y + rect.height + 8 : Math.max(rect.y - 54, 4)}px;` +
                `max-width:${maxW}px;background:#dc1e1e;color:#fff;font:bold 14px sans-serif;` +
                `line-height:1.35;padding:5px 10px;border-radius:4px;z-index:2147483647;` +
                `pointer-events:none;white-space:normal;`;
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
        const box = await page.locator(restSel).first().boundingBox();
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

      } else if (cmd === 'buttons') {
        // List all visible buttons: internal name + visible label — the ground truth
        // for picking action buttons (names vary by module: action_confirm vs action_sale_ok vs numeric IDs)
        const list = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button, a[role="button"]'))
            .filter(e => e.offsetParent !== null)
            .map(e => ({
              name: e.getAttribute('name') || '',
              text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
              disabled: !!e.disabled,
            }))
            .filter(b => b.text || b.name)
            .slice(0, 60);
        });
        if (list.length === 0) console.log('  (no visible buttons)');
        list.forEach(b => console.log(`  name="${b.name}" | "${b.text}"${b.disabled ? ' [disabled]' : ''}`));

      } else if (cmd === 'clickbtn') {
        // Click an action control by what you SEE, so you never hunt for
        // button[name="319"] / action_confirm / action_sale_ok. Matches on the
        // visible label (exact → contains), and also on title/aria-label (icon
        // buttons) and the internal name (so passing a name still works).
        // Covers header buttons, statusbar buttons, .btn, and dropdown/menu
        // items. On a miss it PRINTS the visible labels so you retry with the
        // right one instead of guessing a name/id.
        const wanted = rawRest.trim().toLowerCase();
        const result = await page.evaluate(clickButtonByLabel, wanted);
        if (result.ok) {
          console.log(`  clickbtn: "${result.text}" (name="${result.name}")${result.dialog ? ` in dialog "${result.dialog}"` : ''}`);
        } else {
          console.log(`  clickbtn NOT FOUND: "${rawRest}" — visible clickable labels${result.dialog ? ` in the open dialog "${result.dialog}" (only its buttons are reachable)` : ''} (use one of these, don't guess a name/id):`);
          (result.labels || []).forEach(l => console.log(`      · ${l}`));
          throw new Error(`${cmd} NOT FOUND: ${rawRest}; visible labels: ${(result.labels || []).join(' | ')}`);
        }

      } else if (cmd === 'clickrpc') {
        // Like clickbtn, but PROVES the button's own method reached the server.
        // A "clicked:" line is not evidence, and neither is "some RPC happened":
        // the framework's pre-save and other modules' background JS both fire
        // during the window. So we keep watching until a request that plausibly
        // belongs to THIS button arrives (rpcQualifies), and on failure print
        // everything we did see — which is what makes the cause diagnosable.
        // Usage: clickrpc <label>        (same matching as clickbtn)
        const wanted = rawRest.trim().toLowerCase();
        const seen = [];
        const onReq = (r) => {
          const u = r.url();
          if (/\/web\//.test(u)) { try { seen.push(new URL(u).pathname); } catch (e) { /* ignore */ } }
        };
        page.on('request', onReq);   // attach BEFORE clicking or a fast RPC is missed
        try {
          const result = await page.evaluate(clickButtonByLabel, wanted);
          if (!result.ok) {
            console.log(`  clickrpc NOT FOUND: "${rawRest}" — visible clickable labels${result.dialog ? ` in the open dialog "${result.dialog}"` : ''}:`);
            (result.labels || []).forEach(l => console.log(`      · ${l}`));
            throw new Error(`${cmd} NOT FOUND: ${rawRest}; visible labels: ${(result.labels || []).join(' | ')}`);
          } else {
            const btnName = (result.name || '').trim();
            const deadline = Date.now() + actionTimeout;
            let matched = null;
            while (!matched && Date.now() < deadline) {
              matched = seen.find(pth => rpcQualifies(pth, btnName)) || null;
              if (!matched) await page.waitForTimeout(100);
            }
            if (!matched) {
              const uniq = [...new Set(seen)];
              let obs;
              if (!uniq.length) {
                obs = ' NO /web/ requests fired at all — the click reached the element but produced no server traffic whatsoever.';
              } else {
                obs = ` Requests seen, none of which is this button's action: ${uniq.join(', ')}.`;
                if (uniq.some(u => /web_save/.test(u))) {
                  obs += ' A web_save DID fire — check whether the record failed to save, which blocks the button method.';
                }
              }
              throw new Error(
                `clickrpc: clicked "${result.text}" (name="${btnName}") but its method never ` +
                `reached the server within ${actionTimeout}ms.${obs}`);
            }
            console.log(`  clickrpc: "${result.text}" (name="${btnName}")${result.dialog ? ` in dialog "${result.dialog}"` : ''} → ${matched} OK`);
            await waitIdle();
          }
        } finally {
          page.off('request', onReq);
        }

      } else if (cmd === 'evals') {
        // Print outerHTML (first 300 chars) of each matched element — instant structure inspection
        const sel = restSel;
        const results = await page.evaluate((s) => {
          return Array.from(document.querySelectorAll(s)).slice(0, 5).map(e =>
            e.outerHTML.slice(0, 300)
          );
        }, sel);
        if (results.length === 0) console.log(`  (no matches for: ${sel})`);
        results.forEach((r, i) => console.log(`  [${i}] ${r}`));

      } else if (cmd === 'find') {
        const sel = restSel;
        const results = await page.evaluate((s) => {
          return Array.from(document.querySelectorAll(s)).slice(0, 5).map(e =>
            `${e.tagName}.${e.className.replace(/\s+/g, '.')} | text="${e.textContent?.trim().slice(0, 60)}"`
          );
        }, sel);
        if (results.length === 0) console.log(`  (no matches)`);
        results.forEach(r => console.log(`  ${r}`));

      } else if (cmd === 'waitfor') {
        const sel = restSel;
        await page.waitForSelector(sel, { timeout: actionTimeout });
        console.log(`  appeared: ${sel}`);

      } else if (cmd === 'scroll') {
        // Bring an element into view WITHOUT clicking or focusing it. Odoo forms
        // scroll inside .o_content, not the page body, so a fullPage screenshot
        // still misses a lower group; the old workaround was to click a field
        // down there, which dirties it and is wrong for a read-only check.
        // Usage: scroll <selector>
        const scrolled = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return true;
        }, restSel);
        if (!scrolled) throw new Error(`scroll: ${restSel} (NOT FOUND — 0 elements)`);
        await page.waitForTimeout(150); // let the scroll settle before any screenshot
        console.log(`  scroll: ${restSel}${scrolled ? '' : '  (NOT FOUND \u2014 0 elements)'}`);

      } else if (cmd === 'record') {
        // Open a record's form directly by model + id. Some records have no menu
        // item at all (e.g. a picking with a custom operation type), and flows
        // were hand-writing the hash URL every time.
        // Usage: record <model> <id>
        //        record <model> <name>   e.g. record stock.picking WH/OUT/00012
        // By name: resolved with name_search, exactly one exact match required.
        // Opening a record from a list is unreliable where the KS list-view
        // manager makes a row click start INLINE EDIT instead (issues/
        // 2026-11-23-ks-list-row-click-opens-inline-edit.txt).
        const rModel = parts[1];
        let rId = parts[2];
        const rName = parts.slice(2).join(' ');
        if (rId && !/^\d+$/.test(rId)) {
          const found = await page.evaluate(async ({ model, name }) => {
            const call = async (operator) => {
              const r = await fetch('/web/dataset/call_kw', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'call',
                  params: { model, method: 'name_search', args: [], kwargs: { name, operator, limit: 8 } } }) });
              const j = await r.json();
              if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message);
              return j.result;
            };
            const exact = await call('=');
            return exact.length ? { exact } : { exact, near: await call('ilike') };
          }, { model: rModel, name: rName }).catch(e => ({ error: e.message }));
          if (found.error) throw new Error(`record: name_search on ${rModel} failed: ${found.error}`);
          if (found.exact.length !== 1) {
            const list = (found.exact.length ? found.exact : found.near || []).map(([id, n]) => `${n} (#${id})`);
            throw new Error(`record: ${found.exact.length || 'no'} ${rModel} named exactly "${rName}"`
              + (list.length ? ` — ${found.exact.length ? 'matches' : 'similar'}: ${list.join(' | ')}. Use the id.` : ''));
          }
          rId = String(found.exact[0][0]);
          console.log(`  record: "${rName}" is ${rModel} #${rId}`);
        }
        if (!rModel || !rId) {
          throw new Error('  record: usage is  record <model> <id|name>   e.g. record stock.picking 1234');
        } else {
          const origin = new URL(page.url()).origin;
          await page.goto(`${origin}/web#id=${rId}&model=${rModel}&view_type=form`, { timeout: 20000 });
          const ms = await waitIdle(15000);
          console.log(`  record: ${rModel} #${rId} (${ms}ms) \u2192 ${page.url()}`);
        }

      } else if (cmd === 'breadcrumb') {
        // Breadcrumb links are flaky to click by CSS (often "not actionable", or
        // the wrong level gets hit). Click by INDEX via JS instead.
        // Usage: breadcrumb        -> the previous level (parent record)
        //        breadcrumb 1      -> the first crumb (top-level list)
        //        breadcrumb -1     -> the last crumb (current record)
        const argN = (parts[1] || '').trim();
        const res = await page.evaluate((n) => {
          const crumbs = Array.from(document.querySelectorAll(
            '.o_breadcrumb a, .breadcrumb a, .o_control_panel .o_breadcrumb .o_breadcrumb_item a'))
            .filter(e => e.offsetParent !== null);
          const all = Array.from(document.querySelectorAll(
            '.o_breadcrumb, .breadcrumb')).map(e => e.textContent.replace(/\s+/g, ' ').trim());
          if (!crumbs.length) return { ok: false, crumbs: all };
          let idx;
          if (n === '') idx = crumbs.length - 1;         // default: parent = last LINK
          else if (Number(n) < 0) idx = crumbs.length + Number(n);
          else idx = Number(n) - 1;
          const el = crumbs[idx];
          if (!el) return { ok: false, count: crumbs.length,
                            texts: crumbs.map(c => c.textContent.trim()) };
          const text = el.textContent.trim();
          el.click();
          return { ok: true, text, index: idx + 1, count: crumbs.length };
        }, argN);
        if (res.ok) {
          await waitIdle();
          console.log(`  breadcrumb: clicked #${res.index}/${res.count} "${res.text}"`);
        } else if (res.count) {
          throw new Error(`  breadcrumb: index out of range (there are ${res.count} clickable crumbs): ${(res.texts || []).join(' | ')}`);
        } else {
          throw new Error(`  breadcrumb: no clickable crumbs found. Breadcrumb text: ${(res.crumbs || []).join(' | ') || '(none)'}`);
        }

      } else if (cmd === 'boolcell') {
        // Editable-tree boolean cell. A raw click on the checkbox reports success
        // but .checked never flips, because the ROW has to be in edit mode first.
        // This clicks the cell to activate the row, toggles the checkbox, then
        // VERIFIES .checked actually changed (and says so if it didn't).
        // Usage: boolcell '<td selector>' [on|off]
        // See issues/2026-08-14-boolean-checkbox-click-in-editable-tree.txt.
        const { sel: bcSel, rest } = await splitSelector(cmd, parts, quoted);
        const want = (rest[0] || '').toLowerCase();   // '', 'on'/'true'/'1', 'off'/'false'/'0'
        const target = ['on', 'true', '1', 'yes', 'check', 'checked'].includes(want) ? true
          : ['off', 'false', '0', 'no', 'uncheck', 'unchecked'].includes(want) ? false
          : null;                                       // null = just toggle
        const enter = await page.evaluate((sel) => {
          const cell = document.querySelector(sel);
          if (!cell) return false;
          cell.click();                                 // activate row-edit mode
          return true;
        }, bcSel);
        if (!enter) { throw new Error(`  boolcell NOT FOUND cell: ${bcSel}`); }
        else {
          await page.waitForTimeout(150);               // let the row enter edit mode
          const r = await page.evaluate(({ sel, target }) => {
            const cell = document.querySelector(sel);
            const box = cell && cell.querySelector('input[type="checkbox"]');
            if (!box) return { ok: false, noBox: true };
            const before = !!box.checked;
            if (target !== null && before === target) return { ok: true, before, after: before, skipped: true };
            box.click();
            let after = !!box.checked;
            if (after === before) {                     // click swallowed - force it
              box.checked = !before;
              box.dispatchEvent(new Event('input', { bubbles: true }));
              box.dispatchEvent(new Event('change', { bubbles: true }));
              after = !!box.checked;
            }
            return { ok: true, before, after, forced: after !== before ? false : true };
          }, { sel: bcSel, target });
          if (!r.ok) throw new Error(`  boolcell: no checkbox inside ${bcSel}`);
          else if (r.skipped) console.log(`  boolcell: ${bcSel} already ${r.before} \u2014 left alone`);
          else if (r.after === r.before) throw new Error(`  boolcell FAILED: ${bcSel} still ${r.after} after clicking AND forcing input/change \u2014 the widget is not accepting the toggle`);
          else console.log(`  boolcell: ${bcSel} ${r.before} \u2192 ${r.after}`);
        }

      } else if (cmd === 'step') {
        // Banner across the bottom of the page, kept through reloads, red when a
        // later command fails. Usage: step <text> | step pass <text> | step off
        const text = rawRest.trim();
        if (/^off$/i.test(text)) {
          banner = null;
          await drawBanner();
          console.log('  step banner cleared');
        } else {
          const pass = /^(pass|ok)\b/i.test(text);
          const body = pass ? text.replace(/^(pass|ok)\b\s*/i, '') : text;
          if (!body) throw new Error('Usage: step <text>  |  step pass <text>  |  step off');
          banner = { kind: pass ? 'pass' : 'info', base: body, text: pass ? `✓ ${body}` : body };
          await drawBanner();
          console.log(`  step: ${banner.text}`);
        }

      } else if (cmd === 'actionmenu') {
        // The control panel's Action (Odoo 14 button / Odoo 17 gear) and Print
        // menus. Flows were opening them with hand-written evals whose first
        // selector was too narrow (issues/2026-11-23-no-action-menu-command.txt).
        // Usage: actionmenu <item>          e.g. actionmenu Duplicate
        //        actionmenu Print > <item>  e.g. actionmenu Print > Delivery Slip
        const segs = restSel.split('>').map(x => x.trim()).filter(Boolean);
        const menu = segs.length > 1 ? segs[0].toLowerCase() : 'action';
        const item = (segs.length > 1 ? segs.slice(1).join(' > ') : segs[0] || '').toLowerCase();
        if (!item) throw new Error('Usage: actionmenu <item>   or   actionmenu Print > <item>');
        const opened = await page.evaluate((menu) => {
          const root = document.querySelector('.o_cp_action_menus');
          if (!root) return { ok: false, why: 'this view has no Action/Print menus (.o_cp_action_menus is absent) — open a record, or select list rows first' };
          const toggles = Array.from(root.querySelectorAll('button, .dropdown-toggle, .o_dropdown_toggler_btn'))
            .filter(e => e.offsetParent !== null);
          const sig = e => [e.textContent, e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('data-tooltip'),
            e.className, ...Array.from(e.querySelectorAll('i, span')).map(i => i.className)].join(' ').toLowerCase();
          const want = menu === 'print' ? /print/ : /action|fa-cog|oi-cog|gear/;
          let t = toggles.find(e => want.test(sig(e)));
          if (!t && menu !== 'print') t = toggles.find(e => !/print/.test(sig(e)));
          if (!t) return { ok: false, why: `no "${menu}" menu here; toggles: ${toggles.map(e => e.textContent.trim() || e.getAttribute('title') || '[icon]').join(' | ') || '(none)'}` };
          document.querySelectorAll('[data-pw-actionmenu]').forEach(e => e.removeAttribute('data-pw-actionmenu'));
          t.setAttribute('data-pw-actionmenu', '1');
          // Open it unless its items are actually showing (aria-expanded alone has
          // been seen out of sync with what is on screen).
          const box = t.closest('.o_dropdown, .dropdown, .btn-group, .o-dropdown');
          const showing = !!box && Array.from(box.querySelectorAll('.dropdown-item, .o_menu_item')).some(e => e.offsetParent !== null);
          if (t.getAttribute('aria-expanded') !== 'true' || (box && !showing && !document.querySelector('.o-dropdown--menu .dropdown-item'))) t.click();
          return { ok: true, toggle: t.textContent.trim().replace(/\s+/g, ' ') || (menu === 'print' ? 'Print' : 'Action') };
        }, menu);
        if (!opened.ok) throw new Error(`actionmenu: ${opened.why}`);
        let res = null;
        const deadline = Date.now() + actionTimeout;
        do {   // OWL renders the menu a tick after the click
          res = await page.evaluate((w) => {
            const norm = e => e.textContent.trim().replace(/\s+/g, ' ');
            const visible = list => Array.from(list).filter(e => e.offsetParent !== null && norm(e));
            // Items of the menu we just opened; Odoo 17 may render it outside
            // the toggle's container, so fall back to any open dropdown.
            const t = document.querySelector('[data-pw-actionmenu]');
            const box = t && t.closest('.o_dropdown, .dropdown, .btn-group, .o-dropdown');
            let items = box ? visible(box.querySelectorAll('.dropdown-item, .o_menu_item')) : [];
            if (!items.length) items = visible(document.querySelectorAll(
              '.o_cp_action_menus .dropdown-item, .o_cp_action_menus .o_menu_item, '
              + '.o-dropdown--menu .dropdown-item, .dropdown-menu.show .dropdown-item'));
            if (!items.length) return { ok: false, none: true };
            // Odoo 14 renders <li class="o_menu_item"><a class="dropdown-item">Delete</a></li>
            // and the handler is on the <a>: clicking the <li> does NOTHING and used
            // to be reported as success. Keep only the innermost candidates.
            items = items.filter(e => !items.some(o => o !== e && e.contains(o)));
            const el = items.find(e => norm(e).toLowerCase() === w) || items.find(e => norm(e).toLowerCase().includes(w));
            if (!el) return { ok: false, items: [...new Set(items.map(norm))].slice(0, 30) };
            el.setAttribute('data-pw-actionitem', '1');
            el.click();
            return { ok: true, text: norm(el) };
          }, item);
          if (res.ok || !res.none) break;
          await page.waitForTimeout(100);
        } while (Date.now() < deadline);
        if (!res.ok) throw new Error(`actionmenu: no "${item}" in the ${opened.toggle} menu — items: ${(res.items || []).join(' | ') || '(the menu did not open)'}`);
        await waitIdle();
        // Odoo closes the menu when an item is chosen. If the item we clicked is
        // still showing, the click did not register — and every later step would
        // run against a page where nothing happened (on 14 a dead "Delete" was
        // followed by a clickbtn that hit the record's own Cancel button).
        const stillOpen = await page.evaluate(() => {
          const el = document.querySelector('[data-pw-actionitem]');
          const open = !!(el && el.isConnected && el.offsetParent !== null);
          if (el) el.removeAttribute('data-pw-actionitem');
          return open;
        });
        if (stillOpen) throw Object.assign(new Error(`actionmenu: clicked "${res.text}" but the ${opened.toggle} menu is still open — the click did not register, nothing was done`), { fatal: true });
        console.log(`  actionmenu: ${opened.toggle} > ${res.text}`);

      } else if (cmd === 'url') {
        console.log(`  ${page.url()}`);

      } else if (cmd === 'title') {
        console.log(`  ${await page.title()}`);

      } else if (cmd !== '') {
        throw new Error(`  Unknown command: ${cmd}`);
      }
    };

    const HARD = Math.max(actionTimeout * 4, 60000);
    let hardTimer = null;
    try {
      const p = dispatch();
      p.catch(() => {}); // swallow a late rejection if the hard cap fires first
      const hardP = new Promise((_, rej) => { hardTimer = setTimeout(() => rej(new Error('__HARD_TIMEOUT__')), HARD); });
      const res = await Promise.race([p, hardP]);
      step.status = 'passed';
      if (res === 'STOP') stop = true;
    } catch (e) {
      const msg = (e && e.message ? String(e.message).split('\n')[0] : String(e));
      step.status = 'failed';
      step.error = msg;
      const tgt = ['login', 'cookie'].includes(cmd) ? '[redacted]' : (rawRest || parts.slice(1).join(' ')).trim();
      if (msg === '__HARD_TIMEOUT__') {
        console.error(`  TIMEOUT on ${cmd} ${tgt} — exceeded ${Math.max(actionTimeout * 4, 60000)}ms hard cap`);
      } else if (/timeout|exceeded/i.test(msg)) {
        console.error(`  TIMEOUT on ${cmd} ${tgt} (${actionTimeout}ms): ${msg}`);
      } else {
        console.error(`  ERROR [${cmd}]: ${msg}`);
      }
      if (msg !== '__HARD_TIMEOUT__') {
        const dlg = await openDialogInfo();
        if (dlg) {
          console.error(`  open dialog: "${dlg.title}"${dlg.buttons.length ? ` — buttons: ${dlg.buttons.join(' | ')}` : ''}`);
          step.dialog = dlg;
        }
      }
      if (banner) {
        const base = banner.base || banner.text;
        banner = { kind: 'fail', base, text: `✗ ${base} — FAILED at line ${lineNumber}: ${cmd}` };
        await drawBanner();
      }
      if (strict || e.fatal || ['login'].includes(cmd) || msg === '__HARD_TIMEOUT__') { console.error('  aborting flow after failure'); aborted = true; }
    } finally {
      activeStep = null;
      step.duration_ms = Date.now() - stepStart;
      saveReport();
      if (hardTimer) clearTimeout(hardTimer); // don't leave a 60s timer keeping the process alive
    }
    if (stop || aborted) break;
  }

  rl.close();
  console.log('\nStopping trace...');
  // Persist the login session so the next run against the same host+db
  // can skip the login step entirely
  if (sessionFile) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    await context.storageState({ path: sessionFile }).catch(() => {});
  }
  await runtimeEvidence.finish();
  await context.tracing.stop({ path: traceFile });
  tracing = false;
  await browser.close();

  // Clean up this run's loose screenshots — they're captured in the trace, so
  // one flow leaves just <label>.zip + <label>.log. KEEP_SHOTS=1 to keep them.
  if (!keepShots && shots.length) {
    let n = 0;
    for (const p of shots) { try { fs.unlinkSync(p); n++; } catch { /* already gone */ } }
    if (n) console.log(`Cleaned ${n} screenshot(s) (they're in the trace; set KEEP_SHOTS=1 to keep)`);
  } else if (keepShots && shots.length) {
    console.log(`Kept ${shots.length} screenshot(s) (KEEP_SHOTS=1)`);
  }

  const size = fs.statSync(traceFile).size;
  console.log(`\nTrace saved: ${traceFile}`);
  console.log(`Size:        ${(size / 1024).toFixed(0)} KB\n`);
  console.log('View options:');
  console.log(`  npx playwright show-trace ${path.relative(process.cwd(), traceFile)}`);
  console.log(`  drag-drop to https://trace.playwright.dev`);
} catch (e) {
  report.error = String(e.message || e);
  console.error(`Run failed: ${report.error}`);
} finally {
  clearInterval(heartbeat);
  if (runtimeEvidence) await runtimeEvidence.finish();
  if (tracing && context) {
    try { await context.tracing.stop({ path: traceFile }); }
    catch (e) { report.cleanup_error = e.message; }
  }
  if (browser) await browser.close().catch(() => {});
  if (!report.steps.length && !report.error) report.error = 'No commands were executed';
  report.finished_at = new Date().toISOString();
  report.failed_steps = report.steps.filter(step => step.status !== 'passed').length;
  report.status = report.error || report.cleanup_error || report.failed_steps ? 'failed' : 'passed';
  process.exitCode = report.status === 'passed' ? 0 : 1;
  saveReport();
  console.log(`Result: ${report.status.toUpperCase()} — ${report.failed_steps} failed step(s). ${resultFile}`);
}
})().catch(e => { console.error(e.message); process.exitCode = 1; });
