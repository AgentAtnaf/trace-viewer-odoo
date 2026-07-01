# odoo-trace-kit

Interactive Playwright trace recorder for Odoo manual testing.  
Record a click-through session, then replay it step-by-step in the Playwright Trace Viewer — with screenshots and DOM snapshots at every action.

Works with **Odoo 14, 17, 18+** (and any version in between).

---

## Quick start

```bash
# 1. Install
git clone <this-repo>
cd odoo-trace-kit
npm install
npx playwright install chromium

# 2. Run interactively
./trace.sh MY-TASK http://your-odoo:8069/web/login

# 3. Or pipe a pre-written flow
./trace.sh SO-FLOW http://your-odoo:8069/web/login < flows/so-invoice-payment.txt

# 4. View the trace (on any machine with Node.js)
npx playwright show-trace traces/MY-TASK.zip
# or drag-drop to https://trace.playwright.dev
```

---

## Commands

| Command | Description |
|---|---|
| `goto <url>` | Navigate to URL |
| `click <sel>` | Standard click — waits for element to be visible |
| `fclick <sel>` | Force click — bypasses visibility/stability checks |
| `jclick <sel>` | JS `.click()` — use for SPA New/list buttons |
| `fill <sel> <text>` | Fill an input. Wrap multi-word selectors in `'single quotes'` |
| `press <key>` | Keyboard: `Enter`, `Tab`, `Escape`, `ArrowDown`, `ArrowUp` |
| `wait <ms>` | Pause (e.g. `wait 3000`) |
| `screenshot [name]` | Save a PNG to `traces/` |
| `snapshot` | Print visible elements tree (for selector discovery) |
| `eval <js>` | Run JS and print result |
| `find <sel>` | Print up to 5 matching elements with class and text |
| `waitfor <sel>` | Wait until selector appears (max 15s) |
| `url` | Print current URL |
| `title` | Print page title |
| `done` | Stop recording, save trace zip, exit |

Lines starting with `#` are comments and are skipped.

---

## Selector tips

### Autocomplete fields (Many2one)
```
fill input.o-autocomplete--input SearchTerm
wait 2000
click .o-autocomplete--dropdown-item   # picks the first result
```
To be precise: search by internal reference (e.g. `[EXP_GEN]`) instead of display name.

### Multi-word CSS selectors
```
fill 'td[name="product_template_id"] input' SearchTerm
```
Wrap in single quotes — the parser treats everything inside `'...'` as one token.

### Discover button names on any page
```
eval Array.from(document.querySelectorAll('button[name]')).map(b => b.name + '=' + b.textContent.trim().slice(0,25))
```

---

## Odoo version differences

See [docs/odoo-versions.md](docs/odoo-versions.md) for version-specific selectors and URL patterns.

---

## Viewing traces

**On Mac/Windows (no Odoo needed):**
```bash
npm install -g playwright   # one-time
scp user@odoo-server:/path/to/traces/MY-TASK.zip .
npx playwright show-trace MY-TASK.zip
```

Or drag-drop `MY-TASK.zip` to **https://trace.playwright.dev** — no install required.

---

## Directory layout

```
odoo-trace-kit/
├── pw_trace.js          # main REPL script
├── trace.sh             # convenience wrapper
├── package.json
├── flows/               # reusable command scripts
│   ├── so-invoice-payment.txt
│   └── login-only.txt
├── docs/
│   ├── odoo-versions.md
│   └── commands.md
└── traces/              # output zips (git-ignored)
```
