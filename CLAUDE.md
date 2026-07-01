# odoo-trace-kit — AI Setup Guide

You are helping a developer use this tool to record and replay Odoo UI flows as Playwright traces.

## What this tool does

`pw_trace.js` runs a headless Chromium browser and lets the user (or you) type commands line-by-line to drive it:
- navigate pages, click buttons, fill fields, take screenshots
- save everything as a `.zip` trace viewable in the Playwright Trace Viewer

## Your job: discover their environment first

Before writing any flow or running any command, ask the developer:

1. **Odoo URL** — `http://localhost:8069` or a remote IP/hostname?
2. **Database name** — which DB to test against?
3. **Login credentials** — username + password for the test session
4. **Odoo version** — 14, 16, 17, 18? (affects selectors and URL patterns)
5. **What flow do they want to record?** — e.g. SO→Invoice, Purchase, Inventory, etc.

If they don't know some answers, help them find out:

```bash
# Check running Odoo process
ps aux | grep odoo-bin | grep -v grep

# List available databases
psql -U odoo -h localhost -c "\l" 2>/dev/null | grep -v template

# Check Odoo version from source
grep -r "^version" /path/to/odoo/odoo/release.py 2>/dev/null | head -3
```

---

## Environment probe — run BEFORE writing flows

Once you have the URL + DB + credentials, do a quick probe run to discover:

### 1. Verify login works
```bash
./trace.sh PROBE http://ODOO_URL/web/login <<'EOF'
fill input#login ADMIN_USER
fill input#password ADMIN_PASS
press Enter
wait 6000
url
screenshot
done
EOF
```

If the URL redirected to `/web` — login works. If it redirected back to `/web/login` — credentials are wrong.

### 2. Discover action IDs for the target module

For Sales (sale.order):
```sql
SELECT id, name->>'en_US' AS name FROM ir_act_window
WHERE res_model = 'sale.order' ORDER BY id;
```

For Purchase (purchase.order):
```sql
SELECT id, name->>'en_US' AS name FROM ir_act_window
WHERE res_model = 'purchase.order' ORDER BY id;
```

Replace `->>'en_US'` with `::text` on Odoo 14 where `name` is a plain varchar.

### 3. Discover button names on a form

After opening a form (e.g. new SO), run:
```
eval Array.from(document.querySelectorAll('button[name]')).map(b => b.name + '=' + b.textContent.trim().slice(0,25))
```

### 4. Find the "Add a line" / "Add a product" button text

```
eval Array.from(document.querySelectorAll('[name="order_line"] a, [name="order_line"] button')).map(e => e.textContent.trim())
```

### 5. Check product field name in order lines

```
eval document.querySelector('td[name]')?.getAttribute('name')
```

---

## Key selector differences by Odoo version

| Thing | Odoo 14 | Odoo 16/17 | Odoo 18+ |
|---|---|---|---|
| Navigate to list | `/web#action=ID` | `/web#action=ID` | `/odoo/sales` or hash |
| New button | `button.o_list_button_add` | `button.o_list_button_add` | same |
| Add line text | "Add a line" | "Add a product" | "Add a product" |
| Product field | `td[name="product_id"]` | `td[name="product_template_id"]` | check with eval |
| Confirm SO | `button[name="action_confirm"]` | `button[name="action_confirm"]` or custom | check with eval |
| Confirm invoice | `button[name="action_post"]` | `button[name="action_post"]` | same |
| Login quirk | clean form | website module may overlay | same |

---

## How to write a flow file

Once you know the selectors, write a `.txt` file in `flows/`. Comments start with `#`.

**Template for any login + form flow:**
```
# flows/my-flow.txt
# Env: Odoo X.X @ http://HOST:8069 / DB: my_db

# Login
fill input#login admin
fill input#password admin
press Enter
wait 6000

# Navigate
goto http://HOST:8069/web#action=ACTION_ID
wait 8000

# ... your steps here ...

screenshot
done
```

Then run:
```bash
./trace.sh MY-FLOW http://HOST:8069/web/login < flows/my-flow.txt
```

---

## Debugging tips

**Element not found / timeout:**
- Use `snapshot` to print the visible element tree
- Use `eval document.querySelector('YOUR_SEL')?.outerHTML?.slice(0,200)` to check if it exists
- Use `find button` to list all buttons on the page

**Click fires but nothing happens:**
- Try `fclick` instead of `click` (bypasses visibility checks)
- For Odoo SPA list buttons, use `jclick` instead
- Make sure the previous autocomplete/edit is committed (`press Escape` or `press Tab` first)

**Autocomplete not selecting:**
```
fill input.o-autocomplete--input SearchTerm
wait 2000
click .o-autocomplete--dropdown-item
wait 1500
```

**After hash URL navigation, page looks empty:**
- OWL renders after `domcontentloaded` — always add `wait 5000` to `wait 8000` after hash navigation

---

## Deliverable

After setup, produce:
1. A working `flows/<name>.txt` file for the developer's target flow
2. A short summary of what selectors/IDs you discovered for their DB
3. The command to run it and pull the trace zip
