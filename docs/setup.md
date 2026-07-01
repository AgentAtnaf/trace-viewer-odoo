# Setup Guide

## Requirements

- **Node.js 18+** — for running the script  
- **npm** — for installing Playwright  
- Chromium is installed automatically by Playwright (no separate browser install needed)

---

## Install

```bash
git clone <repo-url> odoo-trace-kit
cd odoo-trace-kit
npm install
npx playwright install chromium
```

That's it. The script runs headlessly — no display or desktop required.

---

## Ubuntu / Debian (Linux server)

If Chromium has missing system libraries, install them:

```bash
npx playwright install-deps chromium
```

Or manually:
```bash
sudo apt-get install -y \
  libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libdbus-1-3 libxcb1 libxkbcommon0 \
  libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2
```

---

## macOS

```bash
brew install node
git clone <repo-url> odoo-trace-kit
cd odoo-trace-kit
npm install
npx playwright install chromium
```

---

## Windows (WSL or native)

**WSL (recommended):**
```bash
# In WSL terminal
sudo apt-get update && sudo apt-get install -y nodejs npm
npm install
npx playwright install chromium
npx playwright install-deps chromium
```

**Native Windows:**
```powershell
winget install OpenJS.NodeJS
# then in PowerShell:
npm install
npx playwright install chromium
```

---

## Verify install

```bash
./trace.sh SMOKE http://your-odoo:8069/web/login < flows/login-only.txt
```

Should produce `traces/SMOKE.zip`. Open it with:
```bash
npx playwright show-trace traces/SMOKE.zip
```

---

## Viewing traces (no Odoo needed)

Traces are self-contained zip files. Share them by any means (Slack, Drive, email).

**Option 1 — CLI:**
```bash
npm install -g playwright  # one-time global install
npx playwright show-trace MY-TASK.zip
```

**Option 2 — Browser (zero install):**
1. Go to https://trace.playwright.dev
2. Drag-drop the `.zip` file

The viewer shows:
- Timeline of all actions
- Screenshots before/after each step
- DOM snapshot (inspect any element)
- Network requests
