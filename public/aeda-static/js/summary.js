// ===================== Summary page =====================
let rt = null, schema = null, submissions = [];
let columns = [];   // chosen component keys to display
let role = '';      // "acting as" role
let canEdit = true;
let subQuery = '';  // submissions search text

// ---- Finder: live search + jump-to dropdown ----
document.getElementById('subSearch').addEventListener('input', (e) => { subQuery = e.target.value; renderTable(); });
document.getElementById('subJump').addEventListener('change', (e) => {
  if (e.target.value) location.href = `/aeda/forms/${FORM_ID}/fill?submission=${encodeURIComponent(e.target.value)}&role=${encodeURIComponent(role)}`;
});

// All searchable text for a submission (reference, stage, status + every value).
function subSearchText(s) {
  return [s.uuid || '', s.stage || '', s.status || '',
    ...Object.values(s.data || {}).map(v => cellValue(v))].join(' ').toLowerCase();
}
const LS_KEY = `foms_summary_cols_${FORM_ID}`;
const LS_ROLE = `foms_summary_role_${FORM_ID}`;

function allKeys() { return fieldElements(schema).map(c => c.key); }
function labelFor(key) { const c = fieldElements(schema).find(x => x.key === key); return c ? c.label : key; }

async function load() {
  rt = await API.get(`/api/aeda/forms/${FORM_ID}/runtime`);
  schema = rt.schema;
  schemaElements(schema);
  document.getElementById('formTitle').textContent = rt.form.name + ' — Submissions';
  document.getElementById('backLink').href = `/aeda/projects/${rt.form.project_id}`;
  document.getElementById('designLink').href = `/aeda/forms/${FORM_ID}/design`;
  document.getElementById('newFormBtn').href = `/aeda/forms/${FORM_ID}/fill`;
  document.getElementById('crumbs').innerHTML =
    `<a href="/aeda/projects/${rt.form.project_id}">${rt.project_name}</a> / <b>${rt.form.name}</b>`;
  const badge = document.getElementById('statusBadge');
  badge.textContent = rt.form.status; badge.className = 'badge ' + rt.form.status;
  document.getElementById('newFormBtn').onclick = (e) => { e.preventDefault(); location.href = `/aeda/forms/${FORM_ID}/fill?role=${encodeURIComponent(role)}`; };

  schema.summaryEditRoles ||= [];
  role = localStorage.getItem(LS_ROLE) || '';
  const rsel = document.getElementById('roleSelect');
  rsel.innerHTML = '<option value="">— any —</option>' + schema.roles.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
  rsel.value = role;
  rsel.onchange = () => { role = rsel.value; localStorage.setItem(LS_ROLE, role); applyPermissions(); renderColumnControls(); renderTable(); };
  applyPermissions();

  // load columns: localStorage -> schema.summaryColumns -> first 4 keys
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  columns = saved || (schema.summaryColumns && schema.summaryColumns.length ? schema.summaryColumns.slice() : allKeys().slice(0, 4));
  columns = columns.filter(k => allKeys().includes(k)); // drop stale keys

  submissions = await API.get(`/api/aeda/forms/${FORM_ID}/submissions`);
  renderColumnControls();
  renderTable();
}

function applyPermissions() {
  const edit = schema.summaryEditRoles || [];
  canEdit = !edit.length || edit.includes(role);
  // Submit New Form is available to everyone; only the Design button + column
  // editing are restricted to authorised roles.
  document.getElementById('designLink').style.display = canEdit ? '' : 'none';
  document.getElementById('viewOnlyBadge').style.display = canEdit ? 'none' : '';
}

function saveCols() { localStorage.setItem(LS_KEY, JSON.stringify(columns)); }

function renderColumnControls() {
  const chips = document.getElementById('columnChips');
  chips.innerHTML = '';
  columns.forEach(k => {
    const chip = el('span', { class: 'chip' }, [el('span', { text: labelFor(k) })]);
    if (canEdit) {
      chip.appendChild(el('span', { class: 'x', text: '✕', title: 'Remove column', onclick: () => {
        columns = columns.filter(x => x !== k); saveCols(); renderColumnControls(); renderTable();
      }}));
    }
    chips.appendChild(chip);
  });
  const sel = document.getElementById('addColumnSelect');
  if (!canEdit) {
    sel.style.display = 'none';
    return;
  }
  sel.style.display = '';
  const avail = allKeys().filter(k => !columns.includes(k));
  sel.innerHTML = '<option value="">+ Add column…</option>' + avail.map(k => `<option value="${k}">${labelFor(k)}</option>`).join('');
  sel.onchange = () => {
    if (!canEdit) return;
    if (sel.value) { columns.push(sel.value); saveCols(); renderColumnControls(); renderTable(); }
  };
}

function renderTable() {
  const t = document.getElementById('summaryTable');
  const head = '<tr><th>Reference</th>' + columns.map(k => `<th>${escapeHtml(labelFor(k))}</th>`).join('') +
    '<th>Stage</th><th>Status</th><th>Created</th><th></th></tr>';

  // Jump dropdown lists every submission (reference + first column value).
  const jump = document.getElementById('subJump');
  jump.innerHTML = '';
  jump.appendChild(el('option', { value: '', text: 'Jump to submission…' }));
  submissions.forEach(s => {
    const ref = (s.uuid || String(s.id)).slice(0, 10);
    const first = columns.length ? cellValue(s.data[columns[0]]) : '';
    jump.appendChild(el('option', { value: s.uuid || s.id, text: (ref + (first ? ` — ${first}` : '')).slice(0, 48) }));
  });

  const term = subQuery.trim().toLowerCase();
  const rows = !term ? submissions : submissions.filter(s => subSearchText(s).includes(term));
  if (!rows.length) {
    const msg = submissions.length
      ? `No submissions match “${escapeHtml(subQuery)}”.`
      : 'No submissions yet. Click “Submit New Form”.';
    t.innerHTML = head + `<tr><td colspan="${columns.length + 5}" class="subtle" style="text-align:center;padding:30px">${msg}</td></tr>`;
    return;
  }
  t.innerHTML = head + rows.map(s =>
    `<tr><td title="${escapeHtml(s.uuid || '')}"><code>${escapeHtml((s.uuid || '').slice(0, 10))}…</code></td>` +
    columns.map(k => `<td>${escapeHtml(cellValue(s.data[k]))}</td>`).join('') +
    `<td>${escapeHtml(s.stage || '')}</td><td>${s.status}</td><td>${fmtDate(s.created_at)}</td>` +
    `<td style="white-space:nowrap">` +
    `<a class="btn sm ghost" href="/aeda/forms/${FORM_ID}/fill?submission=${encodeURIComponent(s.uuid || s.id)}&role=${encodeURIComponent(role)}">Open</a> ` +
    `<button class="btn sm ghost pdf-btn" data-id="${s.id}">⬇ PDF</button></td></tr>`
  ).join('');
  t.querySelectorAll('.pdf-btn').forEach(b => b.onclick = () => {
    const s = submissions.find(x => x.id == b.getAttribute('data-id'));
    if (!s) return;
    if (!window.jspdf) return toast('PDF library not loaded', 'err');
    const doc = buildFormPdf(schema, s.data, { formName: rt.form.name, role, stage: s.stage });
    doc.save(`${(rt.form.name || 'form').replace(/\s+/g, '_')}_${(s.uuid || s.id).toString().slice(0, 10)}.pdf`);
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

load();
