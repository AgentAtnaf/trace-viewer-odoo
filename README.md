# odoo-trace-kit

Record Odoo UI flows as Playwright traces — for visual manual testing and review.

Traces are self-contained `.zip` files. Open them in the Playwright Trace Viewer to step through every action with screenshots, DOM snapshots, and network logs — no Odoo access needed.

---

## Install

```bash
git clone <this-repo>
cd odoo-trace-kit
npm install
npx playwright install chromium
```

Requires Node.js 18+. Works on Linux, macOS, Windows (WSL).

---

## Usage

```bash
# Interactive — type commands manually
./trace.sh MY-TASK http://your-odoo:8069/web/login

# Automated — pipe a flow script
./trace.sh MY-TASK http://your-odoo:8069/web/login < flows/my-flow.txt
```

Trace saved to `traces/MY-TASK.zip`.

---

## View a trace

```bash
npx playwright show-trace traces/MY-TASK.zip
```

Or drag-drop `MY-TASK.zip` to **https://trace.playwright.dev** — zero install.

---

## Set up for your environment

Every Odoo instance is different — different version, database, action IDs, button names.

**If you have an AI assistant (Claude Code, Cursor, Copilot):**  
Open this repo and ask it to help you set up. It will read `CLAUDE.md` and guide you through discovering your environment and generating a flow file.

**Manually:**  
See the commands reference below, then write a `flows/my-flow.txt`.

---

## Commands

| Command | What it does |
|---|---|
| `goto <url>` | Navigate |
| `click <sel>` | Click — waits for visibility |
| `fclick <sel>` | Force click — skips visibility check |
| `jclick <sel>` | JS click — for Odoo SPA list buttons |
| `fill <sel> <text>` | Fill input. Wrap multi-word selectors in `'single quotes'` |
| `press <key>` | Keyboard: `Enter` `Tab` `Escape` `ArrowDown` |
| `wait <ms>` | Pause |
| `screenshot [name]` | Save PNG to `traces/` |
| `snapshot` | Print visible element tree (selector discovery) |
| `eval <js>` | Run JS, print result |
| `find <sel>` | Print up to 5 matching elements |
| `waitfor <sel>` | Wait up to 15s for selector to appear |
| `url` / `title` | Print current URL or page title |
| `done` | Stop recording, save zip |

Lines starting with `#` are ignored.

---

## Share a trace

Pull the zip to your local machine:
```bash
scp user@server:/path/to/odoo-trace-kit/traces/MY-TASK.zip .
npx playwright show-trace MY-TASK.zip
```

Or upload the `.zip` to a shared drive and teammates open it at https://trace.playwright.dev.
