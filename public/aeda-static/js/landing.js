let showArchived = false;
let allProjects = [];     // everything loaded for the current (active/archived) view
let projQuery = '';       // current search text
function escapeHtmlL(s) { return String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

document.getElementById('archivedToggle').addEventListener('click', () => {
  showArchived = !showArchived;
  document.getElementById('archivedToggle').textContent = showArchived ? '← Back to active' : '🗄 Show archived';
  document.getElementById('pageTitle').textContent = showArchived ? 'Archived Projects' : 'Projects';
  document.getElementById('newProjectBtn').style.display = showArchived ? 'none' : '';
  load();
});

// ---- Finder: live search + jump-to dropdown ----
document.getElementById('projSearch').addEventListener('input', (e) => { projQuery = e.target.value; renderProjects(); });
document.getElementById('projJump').addEventListener('change', (e) => { if (e.target.value) location.href = `/aeda/projects/${e.target.value}`; });

async function load() {
  allProjects = await API.get('/api/aeda/projects' + (showArchived ? '?archived=1' : ''));
  renderProjects();
}

function renderProjects() {
  const grid = document.getElementById('projectGrid');
  grid.innerHTML = '';

  // Jump dropdown always lists every project in the current view.
  const jump = document.getElementById('projJump');
  jump.innerHTML = '';
  jump.appendChild(el('option', { value: '', text: showArchived ? 'Jump to archived project…' : 'Jump to project…' }));
  allProjects.forEach(p => jump.appendChild(el('option', { value: p.id, text: p.name })));

  const term = projQuery.trim().toLowerCase();
  const projects = !term ? allProjects : allProjects.filter(p =>
    (p.name || '').toLowerCase().includes(term) || (p.description || '').toLowerCase().includes(term));

  if (!projects.length) {
    grid.appendChild(el('div', { class: 'empty', html: term
      ? `No projects match “${escapeHtmlL(projQuery)}”.`
      : (showArchived ? 'No archived projects.' : 'No projects yet. Create your first one to get started.') }));
  }
  projects.forEach(p => {
    const actions = showArchived ? [
      el('button', { class: 'btn sm', text: 'Restore', title: 'Restore project and all its forms', onclick: async (e) => {
        e.stopPropagation(); await API.post(`/api/aeda/projects/${p.id}/restore-all`, {}); toast('Project + forms restored', 'ok'); load();
      }}),
      el('button', { class: 'btn danger sm', text: 'Delete forever', onclick: async (e) => {
        e.stopPropagation();
        if (await confirmModal('Delete permanently?', `"${p.name}" and all its forms will be permanently removed. This cannot be undone.`, 'Delete forever')) {
          await API.del(`/api/aeda/projects/${p.id}`); toast('Project deleted', 'ok'); load();
        }
      }}),
    ] : [
      el('button', { class: 'btn sm', text: 'Archive', onclick: async (e) => {
        e.stopPropagation(); await API.post(`/api/aeda/projects/${p.id}/archive`, { archived: true }); toast('Project archived', 'ok'); load();
      }}),
    ];
    const card = el('div', { class: 'card', onclick: () => location.href = `/aeda/projects/${p.id}` }, [
      el('div', { class: 'row-actions' }, actions),
      el('h3', { text: p.name }),
      el('div', { class: 'subtle', text: p.description || 'No description' }),
      el('div', { class: 'meta' }, [
        el('span', { text: `${p.form_count} form(s)` }),
        el('span', { text: fmtDate(p.created_at) }),
      ]),
    ]);
    grid.appendChild(card);
  });
}

document.getElementById('newProjectBtn').addEventListener('click', async () => {
  const res = await modal({
    title: 'Create New Project',
    fields: [
      { name: 'name', label: 'Project name', placeholder: 'e.g. HR Forms' },
      { name: 'description', label: 'Description (optional)', type: 'textarea' },
    ],
    okLabel: 'Create',
  });
  if (!res) return;
  if (!res.name.trim()) return toast('Name is required', 'err');
  const p = await API.post('/api/aeda/projects', res);
  toast('Project created', 'ok');
  location.href = `/aeda/projects/${p.id}`;
});

load();
