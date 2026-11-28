// ===================== Portal Settings (multiple email accounts) =====================
let accounts = [];

function blankAccount() {
  return { id: 'acc_' + Math.random().toString(36).slice(2, 9), name: '', provider: 'sendgrid',
           from_email: '', from_name: '', sendgrid_api_key: '', smtp_host: '', smtp_port: '587',
           smtp_user: '', smtp_pass: '', smtp_tls: '1', has_sendgrid_key: false, has_smtp_pass: false };
}

async function load() {
  document.getElementById('crumbs').innerHTML = '<a href="/aeda">Projects</a> / <b>Settings</b>';
  renderThemePane();
  const data = await API.get('/api/aeda/settings');
  accounts = data.accounts || [];
  if (!accounts.length) accounts = [blankAccount()];
  render();
}

// ---- Left-menu navigation: show one pane at a time ----
document.getElementById('settingsNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pane]');
  if (!btn) return;
  document.querySelectorAll('#settingsNav button').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.settings-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + btn.dataset.pane));
  if (btn.dataset.pane === 'master') renderMaster();   // load data lazily on first open
});

// ---- Appearance: theme cards (THEMES/applyTheme live in common.js) ----
function renderThemePane() {
  const grid = document.getElementById('themeGrid');
  grid.innerHTML = '';
  const sync = () => {
    const cur = getThemePref();
    grid.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.theme === cur));
  };
  THEMES.forEach(t => {
    const swatch = el('div', { class: 'theme-swatch' }, t.swatch.map(c => el('span', { style: `background:${c}` })));
    const card = el('div', { class: 'theme-card', 'data-theme': t.id, onclick: () => { applyTheme(t.id); sync(); } }, [
      swatch,
      el('div', { class: 'tc-text' }, [
        el('div', { class: 'tc-name', text: t.name }),
        el('div', { class: 'tc-desc', text: t.desc }),
      ]),
      el('div', { class: 'tc-check', text: '✓' }),
    ]);
    grid.appendChild(card);
  });
  sync();
}

// ===================== Master database (read-only) =====================
let master = null;       // cached /api/master payload
let masterTab = 'submissions';

document.getElementById('masterRefresh').onclick = () => renderMaster(true);
document.getElementById('masterTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab[data-mtab]');
  if (!tab) return;
  masterTab = tab.dataset.mtab;
  document.querySelectorAll('#masterTabs .tab').forEach(t => t.classList.toggle('active', t === tab));
  paintMaster();
});

async function renderMaster(force) {
  const body = document.getElementById('masterBody');
  if (force || !master) {
    body.innerHTML = '<p class="subtle">Loading…</p>';
    try { master = await API.get('/api/aeda/master'); }
    catch (e) { body.innerHTML = ''; body.appendChild(el('p', { class: 'subtle', text: 'Failed to load: ' + e.message })); return; }
  }
  paintMaster();
}

// Build a read-only table. cols: [{label, get(row)}]. `get` may return a node or string.
function dataTable(cols, rows, emptyMsg) {
  const table = el('table', { class: 'data' });
  table.appendChild(el('thead', {}, [el('tr', {}, cols.map(c => el('th', { text: c.label })))]));
  const tbody = el('tbody');
  if (!rows.length) {
    tbody.appendChild(el('tr', {}, [el('td', { colspan: cols.length, class: 'subtle', style: 'padding:18px', text: emptyMsg || 'No records.' })]));
  }
  rows.forEach(r => tbody.appendChild(el('tr', {}, cols.map(c => {
    const v = c.get(r);
    return el('td', {}, [typeof v === 'string' || typeof v === 'number' ? String(v) : (v || '')]);
  }))));
  table.appendChild(tbody);
  return el('div', { class: 'tablewrap' }, [table]);
}

function badge(text, kind) { return el('span', { class: 'badge ' + (kind || 'draft'), text }); }
function viewDataBtn(title, obj) {
  return el('button', { class: 'btn sm ghost', text: '⤢ View', onclick: () => {
    modal({ title, okLabel: 'Close', bodyHtml:
      `<pre style="white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;margin:0;font-size:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px">${escapeHtml(JSON.stringify(obj, null, 2))}</pre>` });
  }});
}

function paintMaster() {
  const body = document.getElementById('masterBody');
  if (!master) return;
  body.innerHTML = '';
  let table, count;
  if (masterTab === 'submissions') {
    const rows = master.submissions;
    count = rows.length;
    table = dataTable([
      { label: 'ID', get: r => r.id },
      { label: 'Project', get: r => r.project_name },
      { label: 'Form', get: r => r.form_name },
      { label: 'Stage', get: r => r.stage || '—' },
      { label: 'Status', get: r => badge(r.status || 'draft', r.status === 'submitted' ? 'published' : 'draft') },
      { label: 'Modified by', get: r => r.modified_by || '—' },
      { label: 'Created', get: r => fmtDate(r.created_at) },
      { label: 'Data', get: r => viewDataBtn(`Submission #${r.id} · ${r.form_name}`, r.data) },
    ], rows, 'No submissions yet across any form.');
  } else if (masterTab === 'forms') {
    const rows = master.forms;
    count = rows.length;
    table = dataTable([
      { label: 'ID', get: r => r.id },
      { label: 'Project', get: r => r.project_name },
      { label: 'Form', get: r => r.name },
      { label: 'Status', get: r => badge(r.archived ? 'archived' : r.status, r.archived ? 'draft' : r.status) },
      { label: 'Submissions', get: r => r.submission_count },
      { label: 'Updated', get: r => fmtDate(r.updated_at) },
      { label: '', get: r => el('a', { class: 'btn sm', href: `/aeda/forms/${r.id}/summary`, text: '☰ Open' }) },
    ], rows, 'No forms yet.');
  } else if (masterTab === 'projects') {
    const rows = master.projects;
    count = rows.length;
    table = dataTable([
      { label: 'ID', get: r => r.id },
      { label: 'Project', get: r => r.name },
      { label: 'Description', get: r => r.description || '—' },
      { label: 'Status', get: r => badge(r.archived ? 'archived' : 'active', r.archived ? 'draft' : 'published') },
      { label: 'Forms', get: r => r.form_count },
      { label: 'Created', get: r => fmtDate(r.created_at) },
      { label: '', get: r => el('a', { class: 'btn sm', href: `/aeda/projects/${r.id}`, text: '↗ Open' }) },
    ], rows, 'No projects yet.');
  } else {
    const rows = master.emails;
    count = rows.length;
    table = dataTable([
      { label: 'ID', get: r => r.id },
      { label: 'Sent', get: r => fmtDate(r.sent_at) },
      { label: 'From', get: r => r.sender || '—' },
      { label: 'To', get: r => r.recipient || '—' },
      { label: 'Subject', get: r => r.subject || '—' },
      { label: 'Body', get: r => viewDataBtn(`Email #${r.id}`, { subject: r.subject, to: r.recipient, body: r.body }) },
    ], rows, 'No emails have been sent yet.');
  }
  body.appendChild(el('div', { class: 'master-meta' }, [el('span', { text: `${count} record(s)` })]));
  body.appendChild(table);
}

function field(label, inp) { return el('label', { class: 'field' }, [el('span', { html: label }), inp]); }

function render() {
  const box = document.getElementById('accounts');
  box.innerHTML = '';
  accounts.forEach((a, idx) => {
    const card = el('div', { class: 'card', style: 'cursor:default;margin-bottom:12px' });
    const nameInp = el('input', { type: 'text', value: a.name || '', placeholder: 'Account name (e.g. HR Mailer)' });
    nameInp.oninput = () => a.name = nameInp.value;
    const provSel = el('select');
    [['sendgrid', 'SendGrid'], ['smtp', 'SMTP'], ['none', 'Off']].forEach(([v, l]) => provSel.appendChild(el('option', { value: v, text: l })));
    provSel.value = a.provider || 'sendgrid';

    const fromEmail = el('input', { type: 'email', value: a.from_email || '', placeholder: 'forms@company.com' });
    fromEmail.oninput = () => a.from_email = fromEmail.value;
    const fromName = el('input', { type: 'text', value: a.from_name || '', placeholder: 'FOMS Forms' });
    fromName.oninput = () => a.from_name = fromName.value;

    const sgKey = el('input', { type: 'password', placeholder: a.has_sendgrid_key ? '•••••• (saved — leave blank to keep)' : 'SG.xxxx' });
    sgKey.oninput = () => a.sendgrid_api_key = sgKey.value;
    const sgBox = el('div', {}, [field('SendGrid API key', sgKey),
      el('p', { class: 'subtle', style: 'font-size:11px;margin:0', text: 'The From email must be a Verified Sender in SendGrid.' })]);

    const host = el('input', { type: 'text', value: a.smtp_host || '', placeholder: 'smtp.office365.com' }); host.oninput = () => a.smtp_host = host.value;
    const port = el('input', { type: 'number', value: a.smtp_port || '587' }); port.oninput = () => a.smtp_port = port.value;
    const user = el('input', { type: 'text', value: a.smtp_user || '' }); user.oninput = () => a.smtp_user = user.value;
    const pass = el('input', { type: 'password', placeholder: a.has_smtp_pass ? '•••••• (saved)' : '' }); pass.oninput = () => a.smtp_pass = pass.value;
    const tls = el('input', { type: 'checkbox' }); tls.checked = String(a.smtp_tls) !== '0'; tls.onchange = () => a.smtp_tls = tls.checked ? '1' : '0';
    const smtpBox = el('div', {}, [
      el('div', { class: 'flex', style: 'gap:10px' }, [
        el('div', { style: 'flex:2' }, [field('Host', host)]),
        el('div', { style: 'flex:1' }, [field('Port', port)]),
      ]),
      el('div', { class: 'flex', style: 'gap:10px' }, [
        el('div', { style: 'flex:1' }, [field('Username', user)]),
        el('div', { style: 'flex:1' }, [field('Password', pass)]),
      ]),
      el('label', { class: 'checkbox-row' }, [tls, el('span', { text: 'Use STARTTLS' })]),
    ]);

    const syncProv = () => { a.provider = provSel.value; sgBox.style.display = a.provider === 'sendgrid' ? '' : 'none'; smtpBox.style.display = a.provider === 'smtp' ? '' : 'none'; };
    provSel.onchange = syncProv;

    card.appendChild(el('div', { class: 'flex', style: 'gap:10px' }, [
      el('div', { style: 'flex:1' }, [field('Account name', nameInp)]),
      el('button', { class: 'btn danger sm', text: '✕ Remove', onclick: () => { accounts.splice(idx, 1); if (!accounts.length) accounts = [blankAccount()]; render(); } }),
    ]));
    card.appendChild(field('Provider', provSel));
    card.appendChild(el('div', { class: 'flex', style: 'gap:10px' }, [
      el('div', { style: 'flex:1' }, [field('From email', fromEmail)]),
      el('div', { style: 'flex:1' }, [field('From name', fromName)]),
    ]));
    card.appendChild(sgBox); card.appendChild(smtpBox);
    box.appendChild(card);
    syncProv();
  });

  const tsel = document.getElementById('testAccount');
  tsel.innerHTML = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name || a.from_email || 'Account')}</option>`).join('');
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

document.getElementById('addAccountBtn').onclick = () => { accounts.push(blankAccount()); render(); };

document.getElementById('saveBtn').onclick = async () => {
  const r = await API.post('/api/aeda/settings', { accounts });
  accounts = r.accounts || accounts;
  toast('Settings saved', 'ok');
  render();
};

document.getElementById('testBtn').onclick = async () => {
  const to = document.getElementById('testTo').value.trim();
  if (!to) return toast('Enter a recipient address', 'err');
  const box = document.getElementById('testResult');
  box.style.display = ''; box.textContent = 'Sending…';
  try {
    const r = await API.post('/api/aeda/settings/test', { to, account_id: document.getElementById('testAccount').value });
    box.style.borderColor = r.sent ? 'var(--green)' : 'var(--red)';
    box.style.color = r.sent ? '' : '#fca5a5';
    box.textContent = (r.sent ? '✓ Sent — ' : '✗ Not sent — ') + r.detail;
  } catch (e) { box.style.borderColor = 'var(--red)'; box.textContent = '✗ ' + e.message; }
};

load();
