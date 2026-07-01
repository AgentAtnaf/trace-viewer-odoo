# Odoo Version Differences

This tool works across Odoo versions. Here's what changes between versions.

---

## Odoo 14.0

### Login
```
goto http://your-odoo:8069/web/login
fill input#login admin
fill input#password admin
press Enter
wait 6000
```
Odoo 14 login page is clean (no website overlay). No CSRF quirks with Enter submit.

### Navigation
Use hash URLs — Odoo 14 does NOT have the `/odoo/` routes:
```
goto http://your-odoo:8069/web#action=ACTION_ID
wait 5000
```

### List view — New button
```
jclick button.o_list_button_add
```
Same class as Odoo 17.

### SO form — product field
```
fill 'td[name="product_id"] input' SearchTerm
```
Note: `product_id` (not `product_template_id`) in standard Odoo 14.

### SO order line — "Add a line"
```
click text=Add a line
```
Odoo 14 uses "Add a line" (not "Add a product").

### Confirm SO button
```
fclick button[name="action_confirm"]
```
Standard name in Odoo 14/16. Some custom modules use `action_sale_ok`.

### Create Invoice button
The button typically has a numeric `name` matching the action ID. Discover it:
```
eval Array.from(document.querySelectorAll('button[name]')).map(b => b.name + '=' + b.textContent.trim().slice(0,25))
```
Then use:
```
fclick button[name="<numeric_id>"]
```

### Create Invoice wizard button
```
click button[name="create_invoices"]
```
Same as Odoo 17.

---

## Odoo 17.0

This is the fully-tested reference version. See [flows/so-invoice-payment.txt](../flows/so-invoice-payment.txt).

Key selectors:

| Action | Selector |
|---|---|
| New button (list) | `jclick button.o_list_button_add` |
| Customer autocomplete | `fill input.o-autocomplete--input NAME` |
| Add product link | `click text=Add a product` |
| Product field | `fill 'td[name="product_template_id"] input' REF` |
| Quantity field | `fill 'td[name="product_uom_qty"] input' QTY` |
| Commit line | `press Escape` |
| Confirm SO | `fclick button[name="action_sale_ok"]` *(RTI custom)* |
| Confirm SO (standard) | `fclick button[name="action_confirm"]` |
| Create Invoice | `fclick button[name="319"]` *(action ID — varies by DB)* |
| Create Invoice wizard | `click button[name="create_invoices"]` |
| Confirm Invoice | `fclick button[name="action_post"]` |
| Register Payment | `fclick button[name="action_register_payment"]` |
| Complete Payment | `fclick button[name="action_create_payments"]` |

### Finding the Quotations action ID

The action ID for "Quotations" (`sale.order`) differs per database.  
Run this SQL to find it:
```sql
SELECT id, name->>'en_US' AS name, res_model
FROM ir_act_window
WHERE res_model = 'sale.order'
ORDER BY id;
```
Or use the URL bar after opening Sales > Quotations manually.

### Website module login overlay

If `/web/login` loads a website page (you see a navbar with "Sign in"), `input#login` and `input#password` are still present — just use `press Enter` to submit (don't click the submit button, it may match the website search button).

---

## Odoo 18.0 / 19.0

Odoo 18 introduced `/odoo/` URL routes replacing hash-based navigation.

### Navigation (new style)
```
goto http://your-odoo:8069/odoo/sales
wait 5000
```
If `/odoo/sales` is intercepted by the website module, fall back to hash URL:
```
goto http://your-odoo:8069/web#action=SALES_ACTION_ID
wait 6000
```

### List view — New button
Same as Odoo 17:
```
jclick button.o_list_button_add
```

### SO form — product field
```
fill 'td[name="product_id"] input' SearchTerm
```
Check whether the DB uses `product_id` or `product_template_id`:
```
eval document.querySelector('td[name="product_id"], td[name="product_template_id"]')?.getAttribute('name')
```

### Add product line
```
click text=Add a product
```
Same as Odoo 17.

### Confirm SO
```
fclick button[name="action_confirm"]
```

### Invoice flow
The invoice flow (Create Invoice → Confirm → Payment) is largely unchanged from Odoo 17. Discover button names with:
```
eval Array.from(document.querySelectorAll('button[name]')).map(b => b.name + '=' + b.textContent.trim().slice(0,25))
```

---

## General debugging tips

### Discover all named buttons on current page
```
eval Array.from(document.querySelectorAll('button[name]')).map(b => b.name + '=' + b.textContent.trim().slice(0,25))
```

### Discover product field name in SO line
```
eval document.querySelector('td[name="product_id"], td[name="product_template_id"]')?.getAttribute('name')
```

### Check "Add a line" button text
```
eval Array.from(document.querySelectorAll('[name="order_line"] a, [name="order_line"] button')).slice(-5).map(e => e.textContent.trim())
```

### Check autocomplete dropdown contents
```
eval Array.from(document.querySelectorAll('.o-autocomplete--dropdown-item')).map(e => e.textContent.trim().slice(0,40))
```

### Check current page status bar
```
eval document.querySelector('.o_statusbar_status .o_arrow_button.o_status_current')?.textContent?.trim()
```
