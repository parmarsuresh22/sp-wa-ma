# FOMS — Form Studio (POC)

A local, web-based **form builder** (Orbeon-style) with a drag-and-drop designer,
roles & workflow stages, role/stage-based field visibility, a local database
viewer, an **n8n-style low-code workflow editor** per button, and a
**publish / versioning** lifecycle.

Built with **Flask + SQLite (SQLAlchemy)** on the backend and a **no-build-step
vanilla-JS** frontend (Drawflow for the node editor, SortableJS for drag-drop).

---

## Run it

```powershell
# one-time
py -m pip install -r requirements.txt

# start the server
py "web-automation_app.py"
```

Then open **http://127.0.0.1:5000**.

The SQLite database `foms.db` is created automatically on first run.

> **Note on the file name.** This machine's security policy only lets
> `python.exe` read/run `.py` files named `web-automation_*.py`. Hyphens are
> illegal in Python import names, so the whole backend is intentionally kept in
> the single file `web-automation_app.py` (no importable sub-modules).

---

## What you can do

### 1. Projects → Forms (landing & project pages)
- Landing page lists all **projects**; **Create New Project**.
- Inside a project, see all **forms**; **Create New Form**.
- Each form has two entry points: **Edit / Design** and **Summary**.

### 2. Form Design tab (default)
- Drag items from the palette onto the canvas (or click to add); reorder by
  dragging; click to edit **properties**:
  - **Components**: text, textarea, number, date, email, dropdown, radio,
    checkbox, section heading (label, key, placeholder, required, options).
  - **Section (group)**: a container — drop fields/buttons inside it. Rules set
    on a section apply to **every item inside it at once**.
  - **Button**: placed anywhere on the form (label, unique key, style). Each
    button gets its own workflow.
- Create **Roles** and **Workflow Stages**.
- Per-item **rules**, by role and by stage:
  - **Visibility** — empty = visible to all; otherwise visible only to the
    chosen roles/stages.
  - **Read-only** — the item is shown but not editable for the chosen
    roles/stages (buttons become disabled).
- **File Upload** component: users attach a file on the form; it's stored with
  the submission and can be attached to confirmation emails.
- **Layout**: each item has a **Width** (Full / Half / Third / Quarter) so you
  can place items side by side (e.g. First Name + Last Name on one row).
  **Buttons** also have an **alignment** (left / center / right) and each sits on
  its own row by default.
- Per-field **Value**: a **default value** (pre-set during design) and a
  **calculated value** formula (e.g. `num({qty}) * num({price})`) which makes
  the field computed & read-only.
- Per-field **Validation**: built-in by type (email/number), a **format preset**
  (numbers only, letters only, phone = 10 digits, custom regex…), min/max length,
  and a **custom rule formula** with your own error message.
- **Conditional (formula) rules** on any field *or section*: **Visible when** /
  **Read-only when** expressions that depend on other fields
  (e.g. `{country} == 'US'`). Set them on a **section** to apply to every item
  inside it at once. Each block has inline **help & examples**.
- Manage **Email templates** (sender / recipient / subject / body / attachment —
  all support `{{field}}` templating).
- **Summary Page — who can edit**: pick roles allowed to submit/edit on the
  Summary page (none = everyone).

### 3. Database tab
- Tabular view of the **form schema**, all **submissions**, the **email log**,
  and **published version history**.
- **Search** submissions by any field value / stage / status / editor.
- **Edit** any submission in place; saving records **Modified By** (the name in
  the "Your name" box) and the **timestamp**, and writes back to the DB.
- **⤓ Extract**: choose columns, file type (**CSV / Excel**), and a schedule:
  - **Immediate** → downloads the file in your browser.
  - **Hourly / Daily / Weekly / Monthly** at a chosen hour/minute + **timezone**
    → saved as a **scheduled task** (shown as a chip by the Extract button, with
    edit / run-now / delete). A background scheduler writes the file to the
    server folder you specify (on the machine running FOMS).

### 4. Form Workflow tab (low-code, like n8n)
- Pick a button, then drag **nodes** onto the canvas and connect them in order:
  - **Validate Required** — checks required fields, stops on failure
  - **Set Workflow Stage** — pick a stage defined in Design
  - **Set Field Value** — set a field (supports `{{field}}`)
  - **Save to Database**
  - **Send Email** — pick an email template defined in Design
  - **HTTP Request** — call an external service (GET/POST/PUT/DELETE)
  - **Navigate** — send the user to a URL (same tab or new tab) after a step
  - **If / Else** — branch on a field condition (==, !=, >, <, contains, empty…);
    top output = true, bottom = false
  - **Switch** — route to one of 3 case outputs by a field value, else a default
  - **Popup Dialog** — show a dialog after this step with a header + body
    (supports `{{field}}`) and up to **3 toggleable buttons**, each with an
    editable label: **Navigate** (opens a URL), **Close tab** (closes the
    browser tab), and **Dismiss** (just closes the dialog)
- Workflow editor has **zoom in/out/reset** and **delete-node** controls.
- Each button's graph is saved with the form.
- **Validate** only checks fields that are **visible** for the current
  role/stage, so hidden fields never block submission.

### 5. Save / Publish / Versioning
- **Save** stores design + workflow (working copy).
- **Publish** snapshots the working copy into an **immutable version** and goes
  live, then offers **Summary Page** / **New Form**.
- While **published the form is locked** — you must **Unpublish** to edit.
- On **re-publish** you choose whether changes apply to **all forms incl.
  previously submitted** (migrate) or **only new submissions** (old ones stay on
  their original schema). Every publish is kept forever, so old + new schemas are
  always backed up.

### 4b. Preview / Test tab
- A fourth designer tab that runs your **working** (unpublished) design +
  workflow end-to-end — no need to publish.
- Pick a **role** and **workflow stage**, fill the form (visibility, read-only,
  calculations, validation and lookups all apply live), then click any button.
- The button's **workflow trace** appears **right under that button** (validate,
  branch decisions, stage change, save, emails, navigate), with field errors
  inline. Submissions and emails are **simulated — nothing is saved or sent**.

### 5b. Versions & Restore (Database tab)
- Every publish is kept as an immutable version. In the **Published Versions**
  table each row has a **↩ Restore** button: it loads that version's schema +
  workflow back into the working copy and unpublishes the form so you can review
  and re-publish it. Existing submissions are untouched.

### 5c. Email setup (portal Settings) — real emails
- Configure email **once** for all projects/forms at **⚙ Settings** (top-right
  on the Projects page). Pick a provider:
  - **SendGrid** — paste an API key + a verified **From** address. (FOMS calls
    the SendGrid HTTP API, so it works even where SMTP ports are blocked.)
  - **SMTP** — host/port/user/password (e.g. Gmail app password, Office 365).
  - **Off** — emails are simulated (logged only), the default.
- Use **Send a test email** on the Settings page to verify before relying on it.
- Recipients come from each email template's **Recipient** field (which supports
  `{{field}}`), so emails go to the address captured on the form.

### 6. Summary page & New Form (runtime)
- **Summary** lists submissions; choose which **columns** to show (add/remove any
  field), and open any submission to edit.
- **New Form** renders the published form. Fields honour role/stage visibility.
  Clicking a button runs that button's workflow server-side and shows a live
  **trace** (validation, stage change, save, emails, HTTP).

---

## Project layout

```
web-automation_app.py     # entire backend: DB, models, API, workflow engine
templates/                # Jinja pages (base, landing, project, designer, fill, summary)
static/css/styles.css     # all styling
static/js/                # common.js + one controller per page
web-automation_e2e.py     # end-to-end test against a running server
foms.db                   # SQLite (auto-created)
```

## Run the end-to-end test

With the server running in another terminal:

```powershell
$env:PYTHONIOENCODING='utf-8'   # so emoji in the workflow trace print on Windows
py "web-automation_e2e.py"
```

It exercises: project/form creation, all page routes, schema save, publish,
required-field validation, a full `validate → set_stage → save → send_email`
workflow with templating, the published-edit lock (409), and unpublish →
re-publish-with-migrate.

---

## Other behaviours
- **Submission reference**: every submission gets a unique **40-char
  alphanumeric id** (shown instead of `#id`). Use **`{{uuid}}`** in email
  templates / formulas / Set Value just like any field token.
- **Submission rule** (Design, left panel): **Multiple** (default) or **Single
  submission per value** of a chosen field — a duplicate is rejected on save.
- **Workflow stops on failure**: if a node fails (e.g. email not sent, HTTP
  error), later nodes — including dialogs — don't run, and the reason is shown
  inline on the form. Effects that already happened (stage change, set values,
  save) still apply immediately.
- **Per-submission trace**: the Database tab shows a **Trace** button per
  submission (red row + ⚠ if the last run failed) with the full step log.
- **Edit submissions** in the Database tab (search + ✎ Edit), recording
  **Modified By** + timestamp.
- **PDF**: download a styled PDF of a submission from the **Summary** page
  (per row); email templates can attach it. PDFs/visibility honour conditional
  rules (hidden fields are excluded).
- **Archive, don't delete**: projects and forms are **archived** (recoverable)
  rather than deleted. Use **🗄 Show archived** to **Restore** or permanently
  delete.

## Notes / POC limitations
- Workflows execute as a **linear chain** (each node → its first connected node);
  branching is not interpreted.
- "Sent" emails are **logged**, not actually delivered.
- No authentication — the role selector on the fill page simulates "acting as".
- Summary column choices are stored per-browser (localStorage).
```
