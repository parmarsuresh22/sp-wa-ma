let showArchived = false;   // form-level archived view (only for an active project)
let projectForms = [];      // forms in the current (active/archived) view
let formQuery = '';         // current search text

document.getElementById('archivedToggle').addEventListener('click', () => {
  showArchived = !showArchived;
  document.getElementById('archivedToggle').textContent = showArchived ? '← Back to active' : '🗄 Show archived';
  document.getElementById('newFormBtn').style.display = showArchived ? 'none' : '';
  load();
});

// ---- Finder: live search + jump-to dropdown (active-project view) ----
document.getElementById('formSearch').addEventListener('input', (e) => { formQuery = e.target.value; renderForms(); });
document.getElementById('formJump').addEventListener('change', (e) => { if (e.target.value) location.href = `/forms/${e.target.value}/summary`; });

function formCard(f, actions, inner) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'row-actions' }, actions),
    el('div', { class: 'flex' }, [
      el('h3', { text: f.name, style: 'margin:0' }),
      el('span', { class: 'badge ' + (f.archived ? 'draft' : f.status), text: f.archived ? 'archived' : f.status }),
    ]),
    el('div', { class: 'meta' }, [
      el('span', { text: `${f.submission_count} submission(s)` }),
      el('span', { text: `v${f.version_count}` }),
    ]),
    el('div', { class: 'flex', style: 'margin-top:14px;gap:8px' }, inner),
  ]);
}

async function load() {
  const p = await API.get(`/api/projects/${PROJECT_ID}`);
  document.getElementById('crumbs').innerHTML = `<a href="/">Projects</a> / <b>${p.name}</b>`;
  document.getElementById('projectDesc').textContent = p.description || '';
  const grid = document.getElementById('formGrid');
  grid.innerHTML = '';
  const toggle = document.getElementById('archivedToggle');
  const newBtn = document.getElementById('newFormBtn');
  const finder = document.querySelector('.finder');

  // ---------- Archived project: show ALL forms, restore whole or single ----------
  if (p.archived) {
    document.getElementById('projectName').textContent = p.name + ' — Archived';
    toggle.style.display = 'none';
    newBtn.style.display = 'none';
    finder.style.display = 'none';
    if (!document.getElementById('restoreAllBtn')) {
      const rb = el('button', { class: 'btn primary', id: 'restoreAllBtn', text: '↩ Restore whole project' });
      newBtn.parentElement.appendChild(rb);
    }
    document.getElementById('restoreAllBtn').style.display = '';
    document.getElementById('restoreAllBtn').onclick = async () => {
      await API.post(`/api/projects/${PROJECT_ID}/restore-all`, {});
      toast('Project + all forms restored', 'ok'); location.reload();
    };
    grid.appendChild(el('div', { class: 'hint', style: 'flex:0 0 100%', html: 'This project is <b>archived</b>. Restore the whole project, or restore a single form (restores the project with only that form active).' }));
    p.forms.forEach(f => {
      const actions = [
        el('button', { class: 'btn sm', text: 'Restore this only', title: 'Restore project with only this form active', onclick: async (e) => {
          e.stopPropagation(); await API.post(`/api/forms/${f.id}/restore-only`, {}); toast('Restored (only this form active)', 'ok'); location.reload();
        }}),
        el('button', { class: 'btn danger sm', text: 'Delete forever', onclick: async (e) => {
          e.stopPropagation();
          if (await confirmModal('Delete permanently?', `"${f.name}" and its submissions will be permanently removed.`, 'Delete forever')) {
            await API.del(`/api/forms/${f.id}`); toast('Form deleted', 'ok'); load();
          }
        }}),
      ];
      grid.appendChild(formCard(f, actions, []));
    });
    return;
  }

  // ---------- Active project ----------
  const rb = document.getElementById('restoreAllBtn'); if (rb) rb.style.display = 'none';
  finder.style.display = '';
  document.getElementById('projectName').textContent = p.name + (showArchived ? ' — Archived forms' : '');
  projectForms = p.forms.filter(f => bool(f.archived) === showArchived);
  renderForms();
}

// Render the form grid for the active-project view, applying the search filter
// and (re)populating the jump-to dropdown with every form in the current view.
function renderForms() {
  const grid = document.getElementById('formGrid');
  grid.innerHTML = '';

  const jump = document.getElementById('formJump');
  jump.innerHTML = '';
  jump.appendChild(el('option', { value: '', text: showArchived ? 'Jump to archived form…' : 'Jump to form…' }));
  projectForms.forEach(f => jump.appendChild(el('option', { value: f.id, text: f.name })));

  const term = formQuery.trim().toLowerCase();
  const forms = !term ? projectForms : projectForms.filter(f => (f.name || '').toLowerCase().includes(term));
  if (!forms.length) {
    grid.appendChild(el('div', { class: 'empty', html: term
      ? `No forms match “${escapeHtmlP(formQuery)}”.`
      : (showArchived ? 'No archived forms.' : 'No forms yet. Create a form to open the designer.') }));
  }
  forms.forEach(f => {
    const actions = showArchived ? [
      el('button', { class: 'btn sm', text: 'Restore', onclick: async (e) => {
        e.stopPropagation(); await API.post(`/api/forms/${f.id}/archive`, { archived: false }); toast('Form restored', 'ok'); load();
      }}),
      el('button', { class: 'btn danger sm', text: 'Delete forever', onclick: async (e) => {
        e.stopPropagation();
        if (await confirmModal('Delete permanently?', `"${f.name}" and its submissions will be permanently removed.`, 'Delete forever')) {
          await API.del(`/api/forms/${f.id}`); toast('Form deleted', 'ok'); load();
        }
      }}),
    ] : [
      el('button', { class: 'btn sm', text: '⧉ Duplicate', title: 'Duplicate this form (design + workflow)', onclick: async (e) => {
        e.stopPropagation();
        const res = await modal({
          title: 'Duplicate form',
          bodyHtml: `<p class="subtle" style="margin-top:0">Copies the design, workflow and lookup tables of <b>${escapeHtmlP(f.name)}</b> into a new draft form (submissions are not copied).</p>`,
          fields: [{ name: 'name', label: 'New form name', value: f.name + ' (copy)' }],
          okLabel: 'Duplicate',
        });
        if (!res) return;
        if (!res.name.trim()) return toast('Name is required', 'err');
        const nf = await API.post(`/api/forms/${f.id}/duplicate`, { name: res.name.trim() });
        toast('Form duplicated', 'ok'); location.href = `/forms/${nf.id}/design`;
      }}),
      el('button', { class: 'btn sm', text: 'Archive', onclick: async (e) => {
        e.stopPropagation(); await API.post(`/api/forms/${f.id}/archive`, { archived: true }); toast('Form archived', 'ok'); load();
      }}),
    ];
    const inner = showArchived ? [] : [
      el('a', { class: 'btn sm', href: `/forms/${f.id}/design`, text: '✎ Edit / Design' }),
      el('a', { class: 'btn sm', href: `/forms/${f.id}/summary`, text: '☰ Summary' }),
    ];
    grid.appendChild(formCard(f, actions, inner));
  });
}

function bool(v) { return v === true || v === 1 || v === '1'; }
function escapeHtmlP(s) { return String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

// ---- Import a form from a JSON export ----
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch (err) { return toast('That file is not valid JSON', 'err'); }
  if (!payload || !payload.schema) return toast('Not a valid FOMS form export', 'err');
  const res = await modal({
    title: 'Import form',
    bodyHtml: `<p class="subtle" style="margin-top:0">Importing <b>${escapeHtmlP(payload.name || 'form')}</b> — design, workflow, ${(payload.submissions || []).length} submission(s) and ${(payload.lookups || []).length} lookup table(s). It is created as a new draft form.</p>`,
    fields: [{ name: 'name', label: 'Form name', value: payload.name || 'Imported form' }],
    okLabel: 'Import',
  });
  if (!res) return;
  if (!res.name.trim()) return toast('Name is required', 'err');
  try {
    const nf = await API.post(`/api/projects/${PROJECT_ID}/import`, { name: res.name.trim(), payload });
    toast('Form imported', 'ok'); location.href = `/forms/${nf.id}/design`;
  } catch (err) { toast('Import failed: ' + err.message, 'err'); }
});

document.getElementById('newFormBtn').addEventListener('click', async () => {
  const res = await modal({
    title: 'Create New Form',
    fields: [{ name: 'name', label: 'Form name', placeholder: 'e.g. Leave Request' }],
    okLabel: 'Create & Design',
  });
  if (!res) return;
  if (!res.name.trim()) return toast('Name is required', 'err');
  const f = await API.post(`/api/projects/${PROJECT_ID}/forms`, res);
  location.href = `/forms/${f.id}/design`;
});

load();
