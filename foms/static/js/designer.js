// ===================== Form Designer controller =====================
let form = null;        // full form object from API
let schema = null;      // working schema (elements, roles, stages, emails, summaryColumns)
let workflow = null;    // { buttonKey: drawflowExport }
let selectedId = null;  // selected element id
let locked = false;     // true when published (read-only)

// Drawflow state
let editor = null;
let wfInited = false;
let currentWfButton = null;
let emailAccounts = [];   // sender accounts from Settings

const COMPONENT_TYPES = [
  { type: 'text',     ic: '🅣', label: 'Text' },
  { type: 'textarea', ic: '📝', label: 'Text Area' },
  { type: 'number',   ic: '#',  label: 'Number' },
  { type: 'date',     ic: '📅', label: 'Date' },
  { type: 'email',    ic: '✉',  label: 'Email' },
  { type: 'select',   ic: '▾',  label: 'Dropdown' },
  { type: 'radio',    ic: '◉',  label: 'Radio Group' },
  { type: 'checkbox', ic: '☑',  label: 'Checkbox' },
  { type: 'file',     ic: '📎', label: 'File Upload' },
  { type: 'downloads',  ic: '⬇',  label: 'Download Files' },
  { type: 'docview',    ic: '🔒', label: 'Secure Viewer' },
  { type: 'wmdownload', ic: '🌊', label: 'Watermarked Download' },
  { type: 'heading',  ic: 'H',  label: 'Section Heading' },
  { type: 'section',  ic: '▦',  label: 'Section (group)' },
  { type: 'http',     ic: '🌐', label: 'API Fetch' },
  { type: 'button',   ic: '⏎',  label: 'Button' },
];

const WF_NODES = [
  { type: 'validate',   ic: '✔', label: 'Validate Required' },
  { type: 'set_stage',  ic: '→', label: 'Set Workflow Stage' },
  { type: 'set_value',  ic: '=', label: 'Set Field Value' },
  { type: 'save',       ic: '💾', label: 'Save to Database' },
  { type: 'send_email', ic: '✉', label: 'Send Email' },
  { type: 'http',       ic: '🌐', label: 'HTTP Request' },
  { type: 'dialog',     ic: '🗔', label: 'Popup Dialog' },
  { type: 'navigate',   ic: '➡', label: 'Navigate (URL)' },
  { type: 'if',         ic: '⎇', label: 'If / Else' },
  { type: 'switch',     ic: '⌥', label: 'Switch' },
];

// --------------------------------------------------------------------
async function loadForm() {
  form = await API.get(`/api/forms/${FORM_ID}`);
  schema = form.schema;
  workflow = form.workflow || {};
  schemaElements(schema);           // migrate / normalize -> schema.elements
  schema.roles ||= []; schema.stages ||= []; schema.emails ||= []; schema.summaryColumns ||= [];

  locked = form.status === 'published';
  document.getElementById('formName').textContent = form.name;
  document.getElementById('canvasTitle').textContent = form.name;
  document.getElementById('backLink').href = `/projects/${form.project_id}`;
  document.getElementById('summaryLink').href = `/forms/${FORM_ID}/summary`;
  document.getElementById('fillLink').href = `/forms/${FORM_ID}/fill`;
  document.getElementById('crumbs').innerHTML =
    `<a href="/">Projects</a> / <a href="/projects/${form.project_id}">${form.project_name}</a> / <b>${form.name}</b>`;

  const badge = document.getElementById('statusBadge');
  badge.textContent = form.status; badge.className = 'badge ' + form.status;
  document.getElementById('saveBtn').style.display = locked ? 'none' : '';
  document.getElementById('publishBtn').style.display = locked ? 'none' : '';
  document.getElementById('unpublishBtn').style.display = locked ? '' : 'none';

  schema.summaryEditRoles ||= [];
  schema.submission ||= { mode: 'multiple', key: '' };
  emailAccounts = await API.get('/api/email-accounts').catch(() => []);
  renderPalette();
  renderCanvas();
  renderProps();
  renderRoles(); renderStages(); renderEmails(); renderSummaryRoles(); renderSubmissionRule();
  populateWfButtons();
}

function renderSubmissionRule() {
  const mode = document.getElementById('subMode');
  const keyF = document.getElementById('subKeyField');
  const keySel = document.getElementById('subKey');
  if (!mode) return;
  schema.submission ||= { mode: 'multiple', key: '' };
  mode.value = schema.submission.mode || 'multiple';
  keySel.innerHTML = fieldElements(schema).map(f => `<option value="${f.key}">${escapeHtml(f.label)} (${f.key})</option>`).join('');
  if (schema.submission.key) keySel.value = schema.submission.key;
  keyF.style.display = mode.value === 'single' ? '' : 'none';
  mode.onchange = () => {
    if (guard()) { mode.value = schema.submission.mode; return; }
    schema.submission.mode = mode.value;
    if (mode.value === 'single' && !schema.submission.key && keySel.value) schema.submission.key = keySel.value;
    keyF.style.display = mode.value === 'single' ? '' : 'none';
  };
  keySel.onchange = () => { if (guard()) return; schema.submission.key = keySel.value; };
}

function renderSummaryRoles() {
  const box = document.getElementById('summaryRolesBox');
  box.innerHTML = '';
  if (!schema.roles.length) { box.appendChild(el('span', { class: 'subtle', style: 'font-size:12px', text: 'Add roles first.' })); return; }
  schema.roles.forEach(r => {
    const active = schema.summaryEditRoles.includes(r.name);
    const chip = el('span', { class: 'chip', style: 'cursor:pointer' + (active ? ';border-color:var(--primary);color:var(--primary-2)' : ''), text: r.name });
    chip.onclick = () => { if (guard()) return; const i = schema.summaryEditRoles.indexOf(r.name); if (i >= 0) schema.summaryEditRoles.splice(i, 1); else schema.summaryEditRoles.push(r.name); renderSummaryRoles(); };
    box.appendChild(chip);
  });
}

function guard() {
  if (locked) { toast('Form is published — Unpublish to edit.', 'err'); return true; }
  return false;
}

// ---------- tree helpers ----------
function findEl(id, arr = schema.elements, parent = null) {
  for (const el of arr) {
    if (el.id === id) return { el, parent, arr };
    if (el.type === 'section') { const r = findEl(id, el.children, el); if (r) return r; }
  }
  return null;
}
function countType(type) {
  let n = 0;
  eachField(schema).forEach(x => { if (x.el.type === type) n++; });
  schemaElements(schema).forEach(e => { if (e.type === type && e.type === 'section') n++; });
  return n;
}
function uniqueKey(base) {
  const keys = new Set(eachField(schema).map(x => x.el.key).filter(Boolean));
  let k = base, i = 1; while (keys.has(k)) k = base + (++i); return k;
}

// ---------------- Palette ----------------
function renderPalette() {
  const box = document.getElementById('palette');
  box.innerHTML = '';
  COMPONENT_TYPES.forEach(c => {
    const item = el('div', { class: 'palette-item', draggable: 'true' }, [
      el('span', { class: 'ic', text: c.ic }), el('span', { text: c.label }),
    ]);
    item.addEventListener('dragstart', e => e.dataTransfer.setData('ctype', c.type));
    item.addEventListener('click', () => addElement(c.type));
    box.appendChild(item);
  });
}

function makeElement(type) {
  const rules = blankRules();
  if (type === 'section') return { id: uid('sec'), type, label: 'Section ' + (countType('section') + 1), children: [], rules };
  if (type === 'button') {
    const n = buttonElements(schema).length + 1;
    return { id: uid('btn'), type, key: uniqueKey('button' + n), label: 'Button ' + n, style: 'primary', rules };
  }
  if (type === 'heading') return { id: uid('h'), type, label: 'Section Heading', rules };
  if (type === 'downloads') return { id: uid('dl'), type, label: 'Download Files', files: [], rules };
  if (type === 'docview') return { id: uid('dv'), type, label: 'Reference Document', file: null, viewHeight: 480, wmText: 'CONFIDENTIAL', rules };
  if (type === 'wmdownload') return { id: uid('wm'), type, label: 'Watermarked Download', file: null, wmText: 'CONFIDENTIAL — {{_timestamp}}', rules };
  if (type === 'http') {
    const n = eachField(schema).filter(x => x.el.type === 'http').length + 1;
    return { id: uid('api'), type, key: uniqueKey('api' + n), label: 'API Fetch ' + n,
      method: 'GET', url: '', authtype: 'none', authuser: '', authpass: '', authtoken: '',
      headername: '', headervalue: '', bodytype: 'none', body: '', trigger: '', rootPath: '', mappings: [], rules };
  }
  const fnum = fieldElements(schema).length + 1;
  return {
    id: uid('c'), type, key: uniqueKey(type + fnum),
    label: COMPONENT_TYPES.find(c => c.type === type).label + ' ' + fnum,
    required: false, placeholder: '',
    options: (type === 'select' || type === 'radio') ? ['Option 1', 'Option 2'] : [],
    rules,
  };
}

function addElement(type, section = null) {
  if (guard()) return;
  if (type === 'section' && section) return toast('Sections cannot be nested.', 'err');
  const elObj = makeElement(type);
  (section ? section.children : schema.elements).push(elObj);
  selectedId = elObj.id;
  renderCanvas(); renderProps();
  if (type === 'button') populateWfButtons();
}

function removeElement(id) {
  if (guard()) return;
  const found = findEl(id);
  if (!found) return;
  const idx = found.arr.indexOf(found.el);
  found.arr.splice(idx, 1);
  if (found.el.type === 'button') { delete workflow[found.el.key]; populateWfButtons(); }
  if (selectedId === id) selectedId = null;
  renderCanvas(); renderProps();
}

// ---------------- Canvas ----------------
function compPreview(c) {
  if (c.type === 'heading') return el('div', { style: 'font-weight:700;font-size:15px', text: c.label });
  if (c.type === 'textarea') return el('textarea', { rows: 2, placeholder: c.placeholder || '' });
  if (c.type === 'select') {
    const s = el('select'); (c.options || []).forEach(o => s.appendChild(el('option', { text: o }))); return s;
  }
  if (c.type === 'radio') {
    const w = el('div', { class: 'wrap-gap' });
    (c.options || []).forEach(o => w.appendChild(el('label', { class: 'checkbox-row' }, [el('input', { type: 'radio', disabled: 'true' }), el('span', { text: o })])));
    return w;
  }
  if (c.type === 'checkbox') return el('label', { class: 'checkbox-row' }, [el('input', { type: 'checkbox', disabled: 'true' }), el('span', { text: 'Yes' })]);
  if (c.type === 'file') return el('input', { type: 'file', disabled: 'true' });
  if (c.type === 'downloads') {
    const files = c.files || [];
    return el('div', { class: 'content-prev' }, files.length
      ? files.map(f => el('div', { class: 'dl-row' }, [el('span', { text: '⬇' }), el('span', { text: f.name })]))
      : [el('span', { class: 'subtle', text: 'No files uploaded yet — add files in properties →' })]);
  }
  if (c.type === 'docview') {
    return el('div', { class: 'content-prev' }, [
      el('div', { text: '🔒 Secure view-only: ' + (c.file ? c.file.name : 'no file yet') }),
      el('div', { class: 'subtle', style: 'font-size:11px', text: 'Rendered view-only with a tracing watermark; vertical scroll for long files.' }),
    ]);
  }
  if (c.type === 'wmdownload') {
    return el('div', { class: 'content-prev' }, [
      el('div', { text: '🌊 Watermarked download: ' + (c.file ? c.file.name : 'no file yet') }),
      el('div', { class: 'subtle', style: 'font-size:11px', text: 'Watermark: ' + (c.wmText || '(none)') }),
    ]);
  }
  return el('input', { type: c.type === 'number' ? 'number' : (c.type === 'date' ? 'date' : (c.type === 'email' ? 'email' : 'text')), placeholder: c.placeholder || '' });
}

function ruleHint(elx) {
  const r = elx.rules || {};
  const bits = [];
  if ((r.visibleRoles || []).length || (r.visibleStages || []).length || (elx.visibleWhen || '').trim()) bits.push('👁 conditional');
  if ((r.readonlyRoles || []).length || (r.readonlyStages || []).length || (elx.readonlyWhen || '').trim()) bits.push('🔒 read-only');
  if ((elx.calc || '').trim()) bits.push('🧮 calc');
  if (elx.validation && ((elx.validation.preset && elx.validation.preset !== 'none') || (elx.validation.formula || '').trim())) bits.push('✓ validated');
  if (elx.width && elx.width !== 'full') bits.push({ half: '½ width', third: '⅓ width', quarter: '¼ width' }[elx.width] || elx.width);
  if (elx.type === 'button' && elx.align && elx.align !== 'left') bits.push('⇥ ' + elx.align);
  if (elx.pdf === false && elx.type !== 'button') bits.push('🚫 no-PDF');
  return bits.join(' · ');
}

function widthClass(w) { return 'frm-cell w-' + (['half', 'third', 'quarter'].includes(w) ? w : 'full'); }

function elementCard(elx, section) {
  if (elx.type === 'section') {
    const head = el('div', { class: 'section-head' }, [
      el('span', { text: '▦ ' + elx.label }),
      ruleHint(elx) ? el('span', { class: 'pill', style: 'font-size:10px', text: ruleHint(elx) }) : null,
      el('span', { class: 'stag', text: 'section' }),
      el('span', { class: 'del', style: 'cursor:pointer', text: '✕', onclick: (e) => { e.stopPropagation(); removeElement(elx.id); } }),
    ]);
    head.onclick = () => { selectedId = elx.id; renderCanvas(); renderProps(); };
    const zone = el('div', { class: 'section-zone', 'data-section': elx.id });
    (elx.children || []).forEach(ch => zone.appendChild(elementCard(ch, elx)));
    if (!elx.children.length) zone.appendChild(el('div', { class: 'subtle', style: 'text-align:center;font-size:12px', text: 'Drop fields / buttons here' }));
    wireZone(zone, elx);
    const card = el('div', { class: 'canvas-item section-card' + (elx.id === selectedId ? ' selected' : ''), 'data-id': elx.id, 'data-eltype': 'section' }, [head, zone]);
    return card;
  }
  if (elx.type === 'button') {
    const bprev = el('span', { class: 'bprev ' + (elx.style === 'secondary' ? 'secondary' : ''), text: elx.label });
    if (elx.color) { bprev.style.background = elx.color; bprev.style.borderColor = elx.color; bprev.style.color = '#fff'; }
    const card = el('div', { class: 'canvas-item comp btnitem ' + widthClass(elx.width) + (elx.id === selectedId ? ' selected' : ''), 'data-id': elx.id, 'data-eltype': 'button' }, [
      bprev,
      el('span', { class: 'k', style: 'font-size:11px;color:var(--muted)', text: 'key: ' + elx.key }),
      ruleHint(elx) ? el('span', { class: 'pill', style: 'font-size:10px', text: ruleHint(elx) }) : null,
      el('span', { style: 'flex:1' }),
      el('span', { class: 'del', text: '✕', onclick: (e) => { e.stopPropagation(); removeElement(elx.id); } }),
    ]);
    card.onclick = () => { selectedId = elx.id; renderCanvas(); renderProps(); };
    return card;
  }
  if (elx.type === 'http') {
    const card = el('div', { class: 'canvas-item comp ' + widthClass(elx.width) + (elx.id === selectedId ? ' selected' : ''), 'data-id': elx.id, 'data-eltype': 'http' }, [
      el('div', { class: 'clabel' }, [
        el('span', { text: '🌐 ' + elx.label }),
        el('span', { class: 'pill', style: 'font-size:10px', text: elx.trigger ? ('↵ ' + elx.trigger) : 'no trigger field' }),
        el('span', { class: 'ctype', text: 'API' }),
        el('span', { class: 'del', text: '✕', onclick: (e) => { e.stopPropagation(); removeElement(elx.id); } }),
      ]),
      el('div', { class: 'subtle', style: 'font-size:11px', text: `${elx.method || 'GET'} ${elx.url || '(no URL)'} → ${(elx.mappings || []).length} mapping(s)` }),
    ]);
    card.onclick = () => { selectedId = elx.id; renderCanvas(); renderProps(); };
    return card;
  }
  // field / heading
  const card = el('div', { class: 'canvas-item comp ' + widthClass(elx.width) + (elx.id === selectedId ? ' selected' : ''), 'data-id': elx.id, 'data-eltype': elx.type }, [
    el('div', { class: 'clabel' }, [
      el('span', { text: elx.label }),
      elx.required ? el('span', { class: 'req', text: '*' }) : null,
      ruleHint(elx) ? el('span', { class: 'pill', style: 'font-size:10px', text: ruleHint(elx) }) : null,
      el('span', { class: 'ctype', text: elx.type }),
      el('span', { class: 'del', text: '✕', onclick: (e) => { e.stopPropagation(); removeElement(elx.id); } }),
    ]),
    elx.type !== 'heading' ? el('div', { class: 'preview' }, [compPreview(elx)]) : null,
  ]);
  card.onclick = () => { selectedId = elx.id; renderCanvas(); renderProps(); };
  return card;
}

function wireZone(zone, section) {
  zone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag');
    const t = e.dataTransfer.getData('ctype');
    if (t) addElement(t, section);
  });
  if (window.Sortable && !locked) {
    Sortable.create(zone, {
      group: 'canvas', animation: 150,
      onMove: (evt) => !(evt.dragged.getAttribute('data-eltype') === 'section' && evt.to.classList.contains('section-zone')),
      onEnd: () => { rebuildTreeFromDom(); renderCanvas(); renderProps(); },
    });
  }
}

function renderCanvas() {
  const dz = document.getElementById('dropzone');
  dz.innerHTML = '';
  if (!schema.elements.length) dz.appendChild(el('div', { class: 'subtle', style: 'text-align:center;padding:30px', text: 'Drop components here' }));
  schema.elements.forEach(e => dz.appendChild(elementCard(e, null)));

  dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = e => {
    e.preventDefault(); dz.classList.remove('drag');
    const t = e.dataTransfer.getData('ctype');
    if (t) addElement(t, null);
  };
  if (window.Sortable && !locked) {
    Sortable.create(dz, {
      group: 'canvas', animation: 150,
      onMove: (evt) => !(evt.dragged.getAttribute('data-eltype') === 'section' && evt.to.classList.contains('section-zone')),
      onEnd: () => { rebuildTreeFromDom(); renderCanvas(); renderProps(); },
    });
  }
}

function rebuildTreeFromDom() {
  const map = {};
  (function collect(arr) { arr.forEach(e => { map[e.id] = e; if (e.type === 'section') collect(e.children || []); }); })(schema.elements);
  const readZone = (zone) => [...zone.children].filter(n => n.classList && n.classList.contains('canvas-item')).map(n => {
    const e = map[n.getAttribute('data-id')];
    if (e && e.type === 'section') { const inner = n.querySelector('.section-zone'); e.children = inner ? readZone(inner) : []; }
    return e;
  }).filter(Boolean);
  schema.elements = readZone(document.getElementById('dropzone'));
}

// ---------------- Properties ----------------
function renderProps() {
  const p = document.getElementById('propsPanel');
  const found = findEl(selectedId);
  if (!found) { p.innerHTML = '<p class="subtle">Select an item to edit its properties, validation and role/stage rules.</p>'; return; }
  const c = found.el;
  p.innerHTML = '';
  const field = (label, inp) => el('label', { class: 'field' }, [el('span', { text: label }), inp]);
  const txt = (val, on) => { const i = el('input', { type: 'text', value: val || '' }); i.oninput = () => { if (guard()) return; on(i.value); }; return i; };

  p.appendChild(field('Label', txt(c.label, v => { c.label = v; renderCanvas(); })));

  if (c.type === 'http') { buildHttpProps(p, c); return; }

  if (c.type === 'button') {
    p.appendChild(field('Button key (unique)', txt(c.key, v => { c.key = v.replace(/\s+/g, '_'); populateWfButtons(); renderCanvas(); })));
    const sel = el('select'); ['primary', 'secondary'].forEach(o => sel.appendChild(el('option', { value: o, text: o })));
    sel.value = c.style || 'primary'; sel.onchange = () => { if (guard()) { sel.value = c.style; return; } c.style = sel.value; renderCanvas(); };
    p.appendChild(field('Style', sel));
    const colorInp = el('input', { type: 'color', value: c.color || '#6366f1', style: 'width:56px;height:34px;padding:2px' });
    colorInp.oninput = () => { if (guard()) return; c.color = colorInp.value; renderCanvas(); };
    const resetC = el('button', { class: 'btn sm ghost', text: 'Reset', onclick: () => { if (guard()) return; c.color = ''; renderCanvas(); renderProps(); } });
    p.appendChild(field('Button color', el('div', { class: 'flex', style: 'gap:8px' }, [colorInp, resetC])));
  } else if (c.type === 'section') {
    p.appendChild(el('p', { class: 'subtle', style: 'font-size:12px', text: 'Rules set here apply to every field/button inside this section.' }));
  } else if (isContentType(c.type)) {
    buildContentProps(p, c);
  } else {
    p.appendChild(field('Field key (data column)', txt(c.key, v => { c.key = v.replace(/\s+/g, '_'); })));
    if (c.type !== 'heading' && c.type !== 'checkbox') p.appendChild(field('Placeholder', txt(c.placeholder, v => { c.placeholder = v; renderCanvas(); })));
    if (c.type !== 'heading') {
      const cb = el('input', { type: 'checkbox' }); cb.checked = !!c.required;
      cb.onchange = () => { if (guard()) { cb.checked = !!c.required; return; } c.required = cb.checked; renderCanvas(); };
      p.appendChild(el('label', { class: 'checkbox-row', style: 'margin-bottom:12px' }, [cb, el('span', { text: 'Required' })]));
    }
    if (c.type === 'select' || c.type === 'radio') {
      const ta = el('textarea', { rows: 4 }); ta.value = (c.options || []).join('\n');
      ta.oninput = () => { if (guard()) return; c.options = ta.value.split('\n').map(s => s.trim()).filter(Boolean); renderCanvas(); };
      p.appendChild(field('Options (one per line)', ta));
    }
  }

  buildLayout(p, c);
  if (FIELD_TYPES.includes(c.type)) buildValueValidation(p, c);
  if (FIELD_TYPES.includes(c.type) || c.type === 'section' || c.type === 'button' || isContentType(c.type)) buildConditional(p, c);

  // ---- Rules: visibility + read-only ----
  c.rules ||= blankRules();
  const rulesBlk = (title, hint, roleArr, stageArr) => {
    const blk = el('div', { class: 'ruleblk' }, [el('h5', { text: title }), el('p', { class: 'subtle', style: 'font-size:11px;margin:0 0 8px', text: hint })]);
    const rw = el('div', { class: 'wrap-gap' }); schema.roles.forEach(r => rw.appendChild(toggleChip(roleArr, r.name)));
    blk.appendChild(field('Roles', rw));
    const sw = el('div', { class: 'wrap-gap' }); schema.stages.forEach(s => sw.appendChild(toggleChip(stageArr, s.name)));
    blk.appendChild(field('Stages', sw));
    return blk;
  };
  p.appendChild(rulesBlk('Visibility', 'Leave empty = visible to everyone / every stage.', c.rules.visibleRoles, c.rules.visibleStages));
  p.appendChild(rulesBlk('Read-only', 'Read-only for the selected roles / stages.', c.rules.readonlyRoles, c.rules.readonlyStages));
}

function toggleChip(arr, name) {
  const active = arr.includes(name);
  const chip = el('span', { class: 'chip', style: 'cursor:pointer' + (active ? ';border-color:var(--primary);color:var(--primary-2)' : ''), text: name });
  chip.onclick = () => { if (guard()) return; const i = arr.indexOf(name); if (i >= 0) arr.splice(i, 1); else arr.push(name); renderProps(); renderCanvas(); };
  return chip;
}

// ---- Properties: small builders ----
function pField(label, inp, hint) {
  const w = el('label', { class: 'field' }, [el('span', { text: label }), inp]);
  if (hint) w.appendChild(el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px', html: hint }));
  return w;
}
function pText(val, on, ph) { const i = el('input', { type: 'text', value: val || '', placeholder: ph || '' }); i.oninput = () => { if (guard()) return; on(i.value); }; return i; }
function pNum(val, on) { const i = el('input', { type: 'number', value: (val ?? '') }); i.oninput = () => { if (guard()) return; on(i.value); }; return i; }

function formulaHelp() {
  const d = document.createElement('details');
  d.style.marginTop = '6px';
  d.innerHTML = `<summary class="subtle" style="cursor:pointer;font-size:11px">Formula help &amp; examples</summary>
   <div class="hint" style="margin-top:6px;line-height:1.6">
   Reference other fields with <code>{fieldKey}</code>. <code>value</code> = this field's value.<br>
   Helpers: <code>len(x)</code>, <code>num(x)</code>, <code>isEmail(x)</code>, <code>isNumber(x)</code>, <code>matches(x,'regex')</code>, <code>upper(x)</code>, <code>lower(x)</code>.<br><br>
   <b>Calculated value</b>: <code>num({qty}) * num({price})</code><br>
   <b>Validation</b> (true = valid): <code>len({phone}) == 10</code> &middot; <code>matches({name},'^[A-Za-z ]+$')</code><br>
   <b>Visible when</b>: <code>{country} == 'US'</code> &middot; <code>num({age}) &gt;= 18</code><br>
   <b>Read-only when</b>: <code>{status} == 'Approved'</code></div>`;
  return d;
}

function buildValueValidation(p, c) {
  const vblk = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Value' })]);
  vblk.appendChild(pField('Default value (preset during design)', pText(c.default, v => { c.default = v; }), 'Pre-fills new forms.'));
  vblk.appendChild(pField('Calculated value (formula)', pText(c.calc, v => { c.calc = v; renderCanvas(); }, 'num({qty}) * num({price})'), 'If set, the field is computed &amp; read-only on the form.'));
  p.appendChild(vblk);

  c.validation ||= { preset: 'none', regex: '', minLength: '', maxLength: '', formula: '', message: '' };
  const blk = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Validation' })]);
  const tnote = c.type === 'email' ? 'Email format is enforced automatically.'
    : c.type === 'number' ? 'Numeric input is enforced automatically.' : '';
  if (tnote) blk.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:0 0 8px', text: tnote }));

  const presetSel = el('select');
  Object.entries(VALIDATION_PRESETS).forEach(([k, o]) => presetSel.appendChild(el('option', { value: k, text: o.label })));
  presetSel.value = c.validation.preset || 'none';
  const regexField = pField('Custom regex', pText(c.validation.regex, v => { c.validation.regex = v; }, '^[A-Za-z]+$'));
  presetSel.onchange = () => { if (guard()) { presetSel.value = c.validation.preset; return; } c.validation.preset = presetSel.value; regexField.style.display = presetSel.value === 'custom' ? '' : 'none'; };
  blk.appendChild(pField('Format', presetSel));
  regexField.style.display = c.validation.preset === 'custom' ? '' : 'none';
  blk.appendChild(regexField);
  blk.appendChild(el('div', { class: 'flex', style: 'gap:8px;align-items:flex-end' }, [
    pField('Min length', pNum(c.validation.minLength, v => { c.validation.minLength = v; })),
    pField('Max length', pNum(c.validation.maxLength, v => { c.validation.maxLength = v; })),
  ]));
  blk.appendChild(pField('Custom rule (formula must be true)', pText(c.validation.formula, v => { c.validation.formula = v; }, 'len({phone}) == 10')));
  blk.appendChild(pField('Error message', pText(c.validation.message, v => { c.validation.message = v; }, 'Phone must be exactly 10 digits')));
  blk.appendChild(formulaHelp());
  p.appendChild(blk);
}

// Read a File into the base64 {name,type,size,data} shape stored in the schema.
function readFileObj(file) {
  return new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res({ name: file.name, type: file.type, size: file.size, data: fr.result });
    fr.readAsDataURL(file);
  });
}
function humanSize(n) { return !n ? '' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'); }

// Properties UI for the file-based content components (downloads / docview / wmdownload).
function buildContentProps(p, c) {
  const blk = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Files' })]);

  if (c.type === 'downloads') {
    blk.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:0 0 8px', text: 'Pre-upload one or more files. The form user can only download them.' }));
    const list = el('div', {});
    (c.files || []).forEach((f, i) => list.appendChild(el('div', { class: 'flex', style: 'gap:8px;margin-bottom:6px' }, [
      el('span', { style: 'flex:1;font-size:12px', text: `📄 ${f.name} ${humanSize(f.size)}` }),
      el('button', { class: 'btn danger sm', text: '✕', onclick: () => { if (guard()) return; c.files.splice(i, 1); renderCanvas(); renderProps(); } }),
    ])));
    blk.appendChild(list);
    const inp = el('input', { type: 'file', multiple: 'true' });
    inp.onchange = async () => { if (guard()) return; for (const f of inp.files) c.files.push(await readFileObj(f)); renderCanvas(); renderProps(); };
    blk.appendChild(pField('Add file(s)', inp));
    p.appendChild(blk);
    return;
  }

  // docview + wmdownload: a single PDF or image file
  blk.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:0 0 8px', html: c.type === 'docview'
    ? 'Upload a <b>PDF or image</b> to show view-only on the form (no copy / download).'
    : 'Upload a <b>PDF or image</b>. The form user can only download it — stamped with the watermark below.' }));
  if (c.file) blk.appendChild(el('div', { class: 'flex', style: 'gap:8px;margin-bottom:6px' }, [
    el('span', { style: 'flex:1;font-size:12px', text: `📄 ${c.file.name} ${humanSize(c.file.size)}` }),
    el('button', { class: 'btn danger sm', text: '✕ Remove', onclick: () => { if (guard()) return; c.file = null; renderCanvas(); renderProps(); } }),
  ]));
  const fin = el('input', { type: 'file', accept: '.pdf,application/pdf,image/*' });
  fin.onchange = async () => { if (guard()) return; if (fin.files[0]) { c.file = await readFileObj(fin.files[0]); renderCanvas(); renderProps(); } };
  blk.appendChild(pField(c.file ? 'Replace file' : 'Upload file', fin));

  if (c.type === 'docview') {
    blk.appendChild(pField('Viewer height (px)', pNum(c.viewHeight, v => { c.viewHeight = Number(v) || 480; renderCanvas(); }),
      'Long documents scroll vertically inside this height.'));
  }

  // Watermark text + token chips (both docview overlay and wmdownload stamp)
  const wmInput = pText(c.wmText, v => { c.wmText = v; renderCanvas(); }, 'CONFIDENTIAL — {{email}} {{_timestamp}}');
  blk.appendChild(pField(c.type === 'docview' ? 'Watermark overlay text' : 'Watermark text', wmInput,
    'Plain text and/or tokens. Tokens resolve when the user opens/downloads.'));
  const chips = el('div', { class: 'wrap-gap', style: 'margin-top:2px' });
  [['{{_timestamp}}', 'date & time'], ['{{_date}}', 'date'], ['{{_time}}', 'time']].forEach(([tok, lbl]) =>
    chips.appendChild(el('span', { class: 'chip', style: 'cursor:pointer', text: lbl + ' · ' + tok, onclick: () => { if (guard()) return; insertAtCursor(wmInput, tok); c.wmText = wmInput.value; renderCanvas(); } })));
  fieldElements(schema).forEach(f => chips.appendChild(el('span', { class: 'chip', style: 'cursor:pointer', text: `${f.label} · {{${f.key}}}`, onclick: () => { if (guard()) return; insertAtCursor(wmInput, `{{${f.key}}}`); c.wmText = wmInput.value; renderCanvas(); } })));
  blk.appendChild(el('div', { style: 'margin-top:6px' }, [el('span', { class: 'subtle', style: 'font-size:11px', text: 'Insert a token:' }), chips]));

  // Watermark appearance: font size, font style, and diagonal rows (max 3)
  const fontSel = el('select');
  [['Helvetica', 'Helvetica'], ['Helvetica-Bold', 'Helvetica Bold'], ['Times-Roman', 'Times'], ['Courier', 'Courier'], ['Courier-Bold', 'Courier Bold']]
    .forEach(([v, l]) => fontSel.appendChild(el('option', { value: v, text: l })));
  fontSel.value = c.wmFont || 'Helvetica-Bold';
  fontSel.onchange = () => { if (guard()) { fontSel.value = c.wmFont; return; } c.wmFont = fontSel.value; renderCanvas(); };

  const rowsSel = el('select');
  [1, 2, 3].forEach(n => rowsSel.appendChild(el('option', { value: n, text: n + (n === 1 ? ' row' : ' rows') })));
  rowsSel.value = String(c.wmRows || 3);
  rowsSel.onchange = () => { if (guard()) { rowsSel.value = c.wmRows; return; } c.wmRows = Number(rowsSel.value); renderCanvas(); };

  blk.appendChild(el('div', { class: 'flex', style: 'gap:8px;align-items:flex-end;margin-top:8px' }, [
    pField('Font size (px)', pNum(c.wmFontSize, v => { c.wmFontSize = Number(v) || 28; renderCanvas(); })),
    pField('Font style', fontSel),
    pField('Diagonal rows', rowsSel),
  ]));
  blk.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:4px 0 0', text: 'Up to 3 diagonal rows are stamped across each page.' }));
  p.appendChild(blk);
}

function buildLayout(p, c) {
  const blk = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Layout' })]);
  const wsel = el('select');
  [['full', 'Full width'], ['half', 'Half (½)'], ['third', 'Third (⅓)'], ['quarter', 'Quarter (¼)']]
    .forEach(([v, l]) => wsel.appendChild(el('option', { value: v, text: l })));
  wsel.value = c.width || 'full';
  wsel.onchange = () => { if (guard()) { wsel.value = c.width; return; } c.width = wsel.value; renderCanvas(); };
  blk.appendChild(pField('Width', wsel, 'Put items side by side — e.g. two “Half” items share a row.'));
  if (c.type === 'button') {
    const asel = el('select');
    [['left', 'Left'], ['center', 'Center'], ['right', 'Right']].forEach(([v, l]) => asel.appendChild(el('option', { value: v, text: l })));
    asel.value = c.align || 'left';
    asel.onchange = () => { if (guard()) { asel.value = c.align; return; } c.align = asel.value; renderCanvas(); };
    blk.appendChild(pField('Button alignment', asel));
  }
  // Include-in-PDF (fields / sections / headings) — overrides visibility in the PDF
  if (FIELD_TYPES.includes(c.type) || c.type === 'section' || c.type === 'heading') {
    const cb = el('input', { type: 'checkbox' }); cb.checked = c.pdf !== false;
    cb.onchange = () => { if (guard()) { cb.checked = c.pdf !== false; return; } c.pdf = cb.checked; renderCanvas(); };
    blk.appendChild(el('label', { class: 'checkbox-row', style: 'margin-top:8px' }, [cb, el('span', { text: 'Include in generated PDF' })]));
    blk.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:4px 0 0', text: 'Unticked = never in PDF, even if visible on the form. (Sections exclude all their fields.)' }));
  }
  p.appendChild(blk);
}

// Properties for the in-form API Fetch (type 'http') component.
function buildHttpProps(p, c) {
  c.mappings ||= [];
  const fields = fieldElements(schema);
  const sel = (val, options, on) => { const s = el('select'); options.forEach(([v, l]) => s.appendChild(el('option', { value: v, text: l }))); s.value = val; s.onchange = () => { if (guard()) { s.value = val; return; } on(s.value); }; return s; };
  const fieldOptions = [['', '— field —']].concat(fields.map(f => [f.key, `${f.label} (${f.key})`]));

  p.appendChild(el('p', { class: 'subtle', style: 'font-size:11px', html: 'Calls an external API while filling the form. When the user types into the <b>trigger field</b> and presses <b>Enter</b>, the response is fetched and mapped into the fields below.' }));
  p.appendChild(pField('Component key (unique)', pText(c.key, v => { c.key = v.replace(/\s+/g, '_'); renderCanvas(); })));

  const blk = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Trigger' })]);
  blk.appendChild(pField('Trigger field (Enter here fires the call)', sel(c.trigger || '', fieldOptions, v => { c.trigger = v; renderCanvas(); }), 'The key value typed here is sent (use it in the URL/body as a token).'));
  p.appendChild(blk);

  const req = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Request' })]);
  req.appendChild(pField('Method', sel(c.method || 'GET', [['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['DELETE', 'DELETE'], ['PATCH', 'PATCH']], v => c.method = v)));
  req.appendChild(pField('URL (supports {{field}})', pText(c.url, v => { c.url = v; renderCanvas(); }, 'https://api.example.com/users/{{empid}}')));
  req.appendChild(pField('Authorization', sel(c.authtype || 'none', [['none', 'None'], ['basic', 'Basic (user / password)'], ['bearer', 'Bearer token'], ['header', 'Custom header']], v => { c.authtype = v; renderProps(); })));
  if (c.authtype === 'basic') {
    req.appendChild(pField('Username', pText(c.authuser, v => c.authuser = v)));
    req.appendChild(pField('Password', pText(c.authpass, v => c.authpass = v)));
  } else if (c.authtype === 'bearer') {
    req.appendChild(pField('Token', pText(c.authtoken, v => c.authtoken = v)));
  } else if (c.authtype === 'header') {
    req.appendChild(pField('Header name', pText(c.headername, v => c.headername = v, 'X-API-Key')));
    req.appendChild(pField('Header value (supports {{field}})', pText(c.headervalue, v => c.headervalue = v)));
  }
  req.appendChild(pField('Body type', sel(c.bodytype || 'none', [['none', 'None'], ['json', 'JSON'], ['xml', 'XML'], ['html', 'HTML'], ['form', 'Form-urlencoded'], ['text', 'Plain text']], v => c.bodytype = v)));
  const bodyTa = el('textarea', { rows: 3, placeholder: '{ "id": "{{empid}}" }' }); bodyTa.value = c.body || '';
  bodyTa.oninput = () => { if (guard()) return; c.body = bodyTa.value; };
  req.appendChild(pField('Body (supports {{field}})', bodyTa));
  p.appendChild(req);

  const mapBlk = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Response → field mapping' })]);
  mapBlk.appendChild(pField('Response root path (optional)', pText(c.rootPath, v => c.rootPath = v, 'data.user'), 'Drill into the JSON before mapping, e.g. <code>data</code> or <code>results.0</code>.'));
  const list = el('div');
  const drawMaps = () => {
    list.innerHTML = '';
    if (!c.mappings.length) list.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:0 0 6px', text: 'No mappings yet. Add one below.' }));
    c.mappings.forEach((m, i) => {
      const path = el('input', { type: 'text', value: m.path || '', placeholder: 'json path e.g. name' });
      path.oninput = () => { if (guard()) return; m.path = path.value; renderCanvas(); };
      const fsel = el('select'); fieldOptions.forEach(([v, l]) => fsel.appendChild(el('option', { value: v, text: l }))); fsel.value = m.field || '';
      fsel.onchange = () => { if (guard()) return; m.field = fsel.value; renderCanvas(); };
      const del = el('button', { class: 'btn sm danger', text: '✕', onclick: () => { if (guard()) return; c.mappings.splice(i, 1); drawMaps(); renderCanvas(); } });
      list.appendChild(el('div', { class: 'flex', style: 'gap:6px;margin-bottom:6px;align-items:flex-end' }, [
        el('label', { class: 'field', style: 'flex:1;margin:0' }, [el('span', { text: 'path' }), path]),
        el('span', { class: 'subtle', text: '→' }),
        el('label', { class: 'field', style: 'flex:1;margin:0' }, [el('span', { text: 'field' }), fsel]),
        del,
      ]));
    });
  };
  drawMaps();
  mapBlk.appendChild(list);
  mapBlk.appendChild(el('button', { class: 'btn sm ghost', text: '+ Add mapping', onclick: () => { if (guard()) return; c.mappings.push({ path: '', field: '' }); drawMaps(); } }));
  mapBlk.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:8px 0 0', text: 'Use the “Preview / Test” tab to try it: type a value in the trigger field and press Enter.' }));
  p.appendChild(mapBlk);

  buildLayout(p, c);
}

function buildConditional(p, c) {
  const blk = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Conditional (formula) rules' })]);
  if (c.type === 'section') blk.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:0 0 8px', text: 'Applies to every item inside this section.' }));
  blk.appendChild(pField('Visible when', pText(c.visibleWhen, v => { c.visibleWhen = v; renderCanvas(); }, "{country} == 'US'"), 'Shows only when true. Empty = always (subject to role/stage).'));
  blk.appendChild(pField('Read-only when', pText(c.readonlyWhen, v => { c.readonlyWhen = v; renderCanvas(); }, "{status} == 'Approved'")));
  blk.appendChild(formulaHelp());
  p.appendChild(blk);
}

// ---------------- Roles / Stages / Emails ----------------
function renderChips(boxId, list, onRemove) {
  const box = document.getElementById(boxId); box.innerHTML = '';
  list.forEach(item => box.appendChild(el('span', { class: 'chip' }, [
    el('span', { text: item.name }),
    el('span', { class: 'x', text: '✕', onclick: () => { if (guard()) return; onRemove(item); } }),
  ])));
}
function renderRoles() { renderChips('rolesBox', schema.roles, r => { schema.roles = schema.roles.filter(x => x.id !== r.id); schema.summaryEditRoles = schema.summaryEditRoles.filter(n => n !== r.name); renderRoles(); renderProps(); renderSummaryRoles(); }); }
function renderStages() { renderChips('stagesBox', schema.stages, s => { schema.stages = schema.stages.filter(x => x.id !== s.id); renderStages(); renderProps(); }); }

document.getElementById('addRoleBtn').onclick = () => {
  if (guard()) return;
  const v = document.getElementById('roleInput').value.trim(); if (!v) return;
  schema.roles.push({ id: uid('role'), name: v }); document.getElementById('roleInput').value = '';
  renderRoles(); renderProps(); renderSummaryRoles();
};
document.getElementById('addStageBtn').onclick = () => {
  if (guard()) return;
  const v = document.getElementById('stageInput').value.trim(); if (!v) return;
  schema.stages.push({ id: uid('stage'), name: v }); document.getElementById('stageInput').value = '';
  renderStages(); renderProps();
};

function renderEmails() {
  const box = document.getElementById('emailsBox'); box.innerHTML = '';
  schema.emails.forEach(em => {
    box.appendChild(el('div', { class: 'blrow' }, [
      el('div', {}, [el('div', { text: em.name }), el('div', { class: 'k', text: (em.recipient || 'no recipient') })]),
      el('div', { style: 'flex:1' }),
      el('span', { class: 'del', style: 'cursor:pointer', text: '✎', onclick: () => editEmail(em) }),
      el('span', { class: 'del', style: 'cursor:pointer;color:var(--muted)', text: '✕', onclick: () => { if (guard()) return; schema.emails = schema.emails.filter(x => x.id !== em.id); renderEmails(); } }),
    ]));
  });
}
function insertAtCursor(input, text) {
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, s) + text + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
  input.focus();
}

function editEmail(em) {
  if (guard()) return;
  em.attachFields ||= [];
  const fields = fieldElements(schema);
  const fileFields = fields.filter(f => f.type === 'file');
  let lastInsert = null;   // function(token) -> inserts into the last-focused field/editor

  const back = el('div', { class: 'modal-back show' });
  const body = el('div', { class: 'body' });

  const plain = (key, label, ph) => {
    const inp = el('input', { type: 'text', value: em[key] || '', placeholder: ph || '' });
    inp.oninput = () => { em[key] = inp.value; };
    return el('label', { class: 'field' }, [el('span', { text: label }), inp]);
  };

  const tokenField = (key, label, multiline, ph) => {
    const inp = multiline ? el('textarea', { rows: 3, placeholder: ph || '' }) : el('input', { type: 'text', placeholder: ph || '' });
    inp.value = em[key] || '';
    const prev = el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px' });
    const upd = () => { em[key] = inp.value; prev.textContent = inp.value ? ('↳ ' + tokenPreview(schema, inp.value)) : ''; };
    inp.oninput = upd;
    inp.onfocus = () => { lastInsert = (tok) => { insertAtCursor(inp, tok); inp.dispatchEvent(new Event('input')); }; };
    upd();
    return el('label', { class: 'field' }, [el('span', { text: label }), inp, prev]);
  };

  // Rich-text body editor (HTML). Stores em.bodyHtml + a plain em.body fallback.
  const makeBodyEditor = () => {
    const tb = el('div', { class: 'rte-toolbar' });
    const ed = el('div', { class: 'rte-editor', contenteditable: 'true', 'data-placeholder': 'Hi {{name}}, …' });
    ed.innerHTML = em.bodyHtml || (em.body ? escapeHtml(em.body).replace(/\n/g, '<br>') : '');
    const prev = el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px' });
    const sync = () => { em.bodyHtml = ed.innerHTML; em.body = ed.innerText; prev.textContent = ed.innerText.trim() ? ('↳ ' + tokenPreview(schema, ed.innerText)) : ''; };
    let savedRange = null;
    const saveSel = () => { const s = window.getSelection(); if (s && s.rangeCount && ed.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); };
    const restore = () => { ed.focus(); if (savedRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); } };
    const exec = (cmd, val) => { restore(); document.execCommand(cmd, false, val ?? null); saveSel(); sync(); };
    ['keyup', 'mouseup', 'input'].forEach(ev => ed.addEventListener(ev, saveSel));
    ed.addEventListener('input', sync);
    ed.addEventListener('focus', () => { lastInsert = (tok) => { restore(); document.execCommand('insertText', false, tok); saveSel(); sync(); }; });

    const btn = (label, title, fn, style) => {
      const b = el('button', { type: 'button', title, html: label, style: style || '' });
      b.addEventListener('mousedown', e => e.preventDefault());   // keep selection in the editor
      b.onclick = fn;
      return b;
    };
    const sep = () => el('span', { class: 'sep' });

    tb.appendChild(btn('<b>B</b>', 'Bold', () => exec('bold')));
    tb.appendChild(btn('<i>I</i>', 'Italic', () => exec('italic')));
    tb.appendChild(btn('<u>U</u>', 'Underline', () => exec('underline')));
    tb.appendChild(btn('<s>S</s>', 'Strikethrough', () => exec('strikeThrough')));
    tb.appendChild(sep());

    const fontSel = el('select', { title: 'Font' });
    ['Default', 'Arial', 'Georgia', 'Tahoma', 'Times New Roman', 'Courier New', 'Verdana'].forEach(f =>
      fontSel.appendChild(el('option', { value: f === 'Default' ? '' : f, text: f })));
    fontSel.onchange = () => { if (fontSel.value) exec('fontName', fontSel.value); };
    tb.appendChild(fontSel);

    const sizeSel = el('select', { title: 'Size' });
    [['', 'Size'], ['2', 'Small'], ['3', 'Normal'], ['5', 'Large'], ['6', 'X-Large'], ['7', 'Huge']].forEach(([v, l]) =>
      sizeSel.appendChild(el('option', { value: v, text: l })));
    sizeSel.onchange = () => { if (sizeSel.value) exec('fontSize', sizeSel.value); };
    tb.appendChild(sizeSel);
    tb.appendChild(sep());

    const fc = el('input', { type: 'color', title: 'Text colour', value: '#e6e8f2' });
    fc.oninput = () => exec('foreColor', fc.value);
    tb.appendChild(fc);
    const hc = el('input', { type: 'color', title: 'Highlight colour', value: '#fde047' });
    hc.oninput = () => { restore(); if (!document.execCommand('hiliteColor', false, hc.value)) document.execCommand('backColor', false, hc.value); saveSel(); sync(); };
    tb.appendChild(hc);
    tb.appendChild(sep());

    tb.appendChild(btn('• List', 'Bulleted list', () => exec('insertUnorderedList')));
    tb.appendChild(btn('1. List', 'Numbered list', () => exec('insertOrderedList')));
    tb.appendChild(btn('🔗', 'Insert link', () => { const u = prompt('Link URL:', 'https://'); if (u) exec('createLink', u); }));
    tb.appendChild(btn('▦ Table', 'Insert table', () => {
      const r = parseInt(prompt('Rows:', '2'), 10), col = parseInt(prompt('Columns:', '2'), 10);
      if (!r || !col) return;
      let html = '<table>';
      for (let i = 0; i < r; i++) { html += '<tr>'; for (let j = 0; j < col; j++) html += '<td>&nbsp;</td>'; html += '</tr>'; }
      html += '</table><p><br></p>';
      exec('insertHTML', html);
    }));
    tb.appendChild(btn('✕ Clear', 'Clear formatting', () => exec('removeFormat')));

    sync();
    return el('label', { class: 'field' }, [el('span', { text: 'Body (rich text)' }), el('div', {}, [tb, ed]), prev]);
  };

  body.appendChild(plain('name', 'Template name', 'Confirmation'));
  const accSel = el('select');
  accSel.innerHTML = '<option value="">(default sender account)</option>' +
    (emailAccounts || []).map(a => `<option value="${a.id}">${escapeHtml(a.name || a.from_email || a.id)}</option>`).join('');
  accSel.value = em.account || '';
  accSel.onchange = () => { em.account = accSel.value; };
  body.appendChild(el('label', { class: 'field' }, [
    el('span', { html: 'Sender account ' + (emailAccounts.length ? '' : '<span class="subtle">(none configured — add in ⚙ Settings)</span>') }), accSel]));
  body.appendChild(tokenField('recipient', 'Recipient', false, '{{email}}'));
  body.appendChild(tokenField('subject', 'Subject', false, 'Your request {{name}}'));
  body.appendChild(makeBodyEditor());

  // field reference (click to insert; shows label + token)
  const ref = el('div', { class: 'wrap-gap', style: 'margin:2px 0 10px' });
  if (!fields.length) ref.appendChild(el('span', { class: 'subtle', style: 'font-size:12px', text: 'No fields yet.' }));
  fields.forEach(f => {
    const chip = el('span', { class: 'chip', style: 'cursor:pointer', text: `${f.label} · {{${f.key}}}` });
    chip.onclick = () => {
      if (!lastInsert) return toast('Click into Recipient/Subject/Body first.', '');
      lastInsert(`{{${f.key}}}`);
    };
    ref.appendChild(chip);
  });
  body.appendChild(el('div', { class: 'ruleblk' }, [
    el('h5', { text: 'Insert a field' }),
    el('p', { class: 'subtle', style: 'font-size:11px;margin:0 0 8px', text: 'Click a field to insert its token where your cursor is. The ↳ preview shows the labels so you can confirm.' }),
    ref,
  ]));

  // attachments
  const attBlk = el('div', { class: 'ruleblk' }, [el('h5', { text: 'Attachments' })]);
  const pdfCb = el('input', { type: 'checkbox' }); pdfCb.checked = !!em.attachPdf;
  pdfCb.onchange = () => { em.attachPdf = pdfCb.checked; };
  attBlk.appendChild(el('label', { class: 'checkbox-row', style: 'margin-bottom:10px' }, [pdfCb, el('span', { text: 'Attach a PDF of the submitted form (only visible fields)' })]));

  attBlk.appendChild(el('div', { class: 'subtle', style: 'font-size:12px;margin-bottom:4px', text: 'Attach uploaded files (from File Upload fields):' }));
  if (!fileFields.length) attBlk.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:0', text: 'No File Upload components in this form yet.' }));
  fileFields.forEach(f => {
    const cb = el('input', { type: 'checkbox' }); cb.checked = em.attachFields.includes(f.key);
    cb.onchange = () => { const i = em.attachFields.indexOf(f.key); if (cb.checked && i < 0) em.attachFields.push(f.key); else if (!cb.checked && i >= 0) em.attachFields.splice(i, 1); };
    attBlk.appendChild(el('label', { class: 'checkbox-row' }, [cb, el('span', { text: f.label + ' (' + f.key + ')' })]));
  });
  body.appendChild(attBlk);

  const close = () => back.remove();
  const m = el('div', { class: 'modal', style: 'width:560px' }, [
    el('h2', { text: 'Email Template' }),
    body,
    el('div', { class: 'foot' }, [
      el('button', { class: 'btn ghost', text: 'Done', onclick: () => { renderEmails(); close(); } }),
    ]),
  ]);
  back.appendChild(m);
  back.addEventListener('mousedown', e => { if (e.target === back) { renderEmails(); close(); } });
  document.body.appendChild(back);
}
document.getElementById('addEmailBtn').onclick = async () => {
  if (guard()) return;
  const em = { id: uid('em'), name: 'New Email', sender: '', recipient: '', subject: '', body: '', bodyHtml: '', attachment: '' };
  schema.emails.push(em); renderEmails(); editEmail(em);
};

// ---------------- Designer Help & Reference ----------------
function showDesignerHelp() {
  const fields = fieldElements(schema);
  const fieldRows = fields.length
    ? fields.map(f => `<tr><td><code>{{${escapeHtml(f.key)}}}</code></td><td>${escapeHtml(f.label)}</td><td>${f.type}</td></tr>`).join('')
    : `<tr><td colspan="3" class="subtle">No fields yet — add components on the Design tab first.</td></tr>`;

  const back = el('div', { class: 'modal-back show' });
  const body = el('div', { class: 'body help-body' });
  body.innerHTML = `
    <p class="subtle" style="margin-top:0">Everything you need to build forms efficiently — system tokens, field tokens, formulas, components, API Fetch and workflow. Tokens work in <b>email templates</b>, <b>workflow nodes</b> (Set Value, dialogs), <b>watermarks</b> and field <b>default values</b>.</p>

    <h3>🔑 System tokens</h3>
    <p class="subtle" style="margin:0 0 6px">Built-in values — type them anywhere a <code>{{token}}</code> is accepted. They resolve when the form is filled / the email is sent.</p>
    <table class="help-tbl">
      <tr><th>Token</th><th>Inserts</th></tr>
      <tr><td><code>{{_date}}</code></td><td>Current date (e.g. 2026-06-26)</td></tr>
      <tr><td><code>{{_time}}</code></td><td>Current time (e.g. 14:30:05)</td></tr>
      <tr><td><code>{{_datetime}}</code> / <code>{{_timestamp}}</code> / <code>{{_now}}</code></td><td>Current date &amp; time</td></tr>
      <tr><td><code>{{_uuid}}</code></td><td>Submission reference (set once the submission is saved)</td></tr>
    </table>
    <div class="hint" style="margin-top:8px">Where they work: <b>Email</b> recipient/subject/body · <b>Set Value</b> &amp; <b>Popup Dialog</b> workflow nodes · <b>Watermark</b> &amp; <b>Secure Viewer</b> text · field <b>Default value</b>. In <b>formulas</b> use the functions <code>now()</code>, <code>today()</code>, <code>nowTime()</code> instead.</div>

    <h3>🏷️ Field tokens (this form)</h3>
    <p class="subtle" style="margin:0 0 6px">Insert a field's value with <code>{{key}}</code> (email / workflow / watermark) or reference it in a <b>formula</b> with <code>{key}</code>. A field's key is set in its properties (right panel).</p>
    <table class="help-tbl"><tr><th>Token</th><th>Field label</th><th>Type</th></tr>${fieldRows}</table>

    <h3>🧮 Formulas</h3>
    <p class="subtle" style="margin:0 0 6px">Used in <b>Calculated value</b>, <b>Validation rule</b>, <b>Visible when</b> and <b>Read-only when</b>. Reference fields with <code>{key}</code>; <code>value</code> = the current field's value.</p>
    <div class="hint" style="line-height:1.7">
      Helpers: <code>len(x)</code>, <code>num(x)</code>, <code>isEmail(x)</code>, <code>isNumber(x)</code>, <code>matches(x,'regex')</code>, <code>upper(x)</code>, <code>lower(x)</code>, <code>now()</code>, <code>today()</code>, <code>nowTime()</code>.<br>
      <b>Calculated:</b> <code>num({qty}) * num({price})</code> &middot; <code>today()</code><br>
      <b>Validation</b> (true = valid): <code>len({phone}) == 10</code><br>
      <b>Visible when:</b> <code>{country} == 'US'</code> &middot; <code>num({age}) &gt;= 18</code><br>
      <b>Read-only when:</b> <code>{status} == 'Approved'</code>
    </div>

    <h3>🧩 Components</h3>
    <table class="help-tbl">
      <tr><th>Component</th><th>What it does</th></tr>
      <tr><td>Text / Text Area / Number / Date / Email</td><td>Standard inputs (with validation &amp; formats).</td></tr>
      <tr><td>Dropdown / Radio / Checkbox</td><td>Choice inputs (set options one-per-line).</td></tr>
      <tr><td>File Upload</td><td>User attaches a file (can be emailed as an attachment).</td></tr>
      <tr><td>⬇ Download Files</td><td>Pre-upload files the user can only download.</td></tr>
      <tr><td>🔒 Secure Viewer</td><td>Show a PDF/image view-only (no copy/download) with a tracing watermark &amp; vertical scroll.</td></tr>
      <tr><td>🌊 Watermarked Download</td><td>User downloads a file stamped with a watermark (static text + tokens; font size, style &amp; up to 3 diagonal rows).</td></tr>
      <tr><td>Section / Heading</td><td>Group &amp; label fields. Section rules cascade to children.</td></tr>
      <tr><td>API Fetch / Button</td><td>See below.</td></tr>
    </table>
    <p class="subtle" style="margin:6px 0 0">Every component supports <b>width</b> (full/½/⅓/¼), <b>visibility</b> &amp; <b>read-only</b> rules by role/stage or formula, and <b>Include in PDF</b>.</p>

    <h3>🌐 API Fetch node</h3>
    <div class="hint" style="line-height:1.7">
      Auto-fills fields from a web API while the user types. Configure: a <b>Trigger field</b> (pressing Enter in it runs the fetch), the <b>URL</b> (use <code>{{key}}</code> tokens), optional auth/headers/body, a <b>Root path</b> into the JSON (e.g. <code>data.0</code>), and <b>mappings</b> of JSON paths → form fields. Behaviour-only — it stores no data itself.
    </div>

    <h3>⚙️ Workflow (per button)</h3>
    <p class="subtle" style="margin:0 0 6px">Each <b>Button</b> starts its own flow on the Form Workflow tab. Drag nodes and connect them from the button's start node.</p>
    <table class="help-tbl">
      <tr><th>Node</th><th>Purpose</th></tr>
      <tr><td>Validate Required</td><td>Stops the flow if visible required fields are empty.</td></tr>
      <tr><td>Set Workflow Stage</td><td>Moves the submission to a stage (drives visibility/read-only).</td></tr>
      <tr><td>Set Field Value</td><td>Writes a value (supports <code>{{tokens}}</code>, incl. system tokens).</td></tr>
      <tr><td>Save to Database</td><td>Persists the submission (assigns the <code>{{_uuid}}</code>).</td></tr>
      <tr><td>Send Email</td><td>Sends a chosen email template (HTML body, attachments, PDF).</td></tr>
      <tr><td>HTTP Request</td><td>Calls an external API as part of the flow.</td></tr>
      <tr><td>Popup Dialog / Navigate</td><td>Show a message / redirect or open a URL.</td></tr>
      <tr><td>If-Else / Switch</td><td>Branch the flow on field conditions.</td></tr>
    </table>

    <h3>💡 Tips</h3>
    <ul class="help-list">
      <li><b>Roles &amp; Stages</b>: define them (left panel), then use them in visibility/read-only rules.</li>
      <li><b>Single vs multiple submission</b>: set in form settings; single mode blocks duplicates on a key field.</li>
      <li><b>Summary columns &amp; lookups</b>: choose table columns on the Summary page; upload lookup tables to auto-fill from a key field.</li>
      <li><b>Export / Import</b>: ⤓ Export saves design + workflow + data as JSON; import on a project to clone a form.</li>
      <li><b>Publish</b> to lock the form for real use; Unpublish to edit again.</li>
    </ul>`;

  const m = el('div', { class: 'modal', style: 'width:860px;max-width:96vw' }, [
    el('h2', { text: '❓ Designer Help & Reference' }),
    body,
    el('div', { class: 'foot' }, [el('button', { class: 'btn primary', text: 'Close', onclick: () => back.remove() })]),
  ]);
  back.appendChild(m);
  back.addEventListener('mousedown', e => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
}
document.getElementById('helpBtn').onclick = showDesignerHelp;

// ---------------- Tabs ----------------
document.querySelectorAll('.tabs .tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.getAttribute('data-tab');
    document.getElementById('pane-' + name).classList.add('active');
    if (name === 'database') renderDatabaseTab();
    if (name === 'workflow') initWorkflowTab();
    if (name === 'preview') renderPreview();
  };
});

// ---------------- Preview / Test ----------------
let pvData = {}, pvRole = '', pvStage = '', pvReg = [], pvLookups = [];

async function renderPreview() {
  if (!locked) { try { await save(true); } catch (e) {} }   // persist working copy so backend runs latest
  pvLookups = await API.get(`/api/forms/${FORM_ID}/lookups?rows=1`).catch(() => []);
  const rs = document.getElementById('pvRole');
  rs.innerHTML = '<option value="">— any —</option>' + schema.roles.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
  rs.value = pvRole; rs.onchange = () => { pvRole = rs.value; pvBuild(); };
  const ss = document.getElementById('pvStage');
  ss.innerHTML = '<option value="">— none —</option>' + schema.stages.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
  ss.value = pvStage; ss.onchange = () => { pvStage = ss.value; pvBuild(); };
  document.getElementById('pvReset').onclick = () => { pvData = {}; pvDefaults(); pvBuild(); };
  pvDefaults();
  pvBuild();
}

function pvDefaults() {
  fieldElements(schema).forEach(c => { if ((c.default ?? '') !== '' && (pvData[c.key] == null || pvData[c.key] === '')) pvData[c.key] = c.default; });
}

function pvInput(c) {
  const v = pvData[c.key] ?? '';
  let inp;
  if (c.type === 'textarea') { inp = el('textarea', { placeholder: c.placeholder || '' }); inp.value = v; }
  else if (c.type === 'select') {
    inp = el('select'); inp.appendChild(el('option', { value: '', text: c.placeholder || '— select —' }));
    (c.options || []).forEach(o => inp.appendChild(el('option', { value: o, text: o }))); inp.value = v;
  } else if (c.type === 'radio') {
    inp = el('div', { class: 'wrap-gap', 'data-key': c.key });
    (c.options || []).forEach(o => { const r = el('input', { type: 'radio', name: 'pv_' + c.key, value: o }); if (v === o) r.checked = true; r.onchange = () => { pvData[c.key] = o; pvApply(); }; inp.appendChild(el('label', { class: 'checkbox-row' }, [r, el('span', { text: o })])); });
    return inp;
  } else if (c.type === 'checkbox') {
    inp = el('input', { type: 'checkbox' }); inp.checked = (v === 'Yes' || v === true);
    inp.onchange = () => { pvData[c.key] = inp.checked ? 'Yes' : ''; pvApply(); };
    return el('label', { class: 'checkbox-row' }, [inp, el('span', { text: 'Yes' })]);
  } else if (c.type === 'file') {
    inp = el('input', { type: 'file', 'data-key': c.key });
    inp.onchange = () => { const f = inp.files[0]; if (!f) { pvData[c.key] = null; pvApply(); return; } const fr = new FileReader(); fr.onload = () => { pvData[c.key] = { name: f.name, type: f.type, data: fr.result }; pvApply(); }; fr.readAsDataURL(f); };
    return inp;
  } else { inp = el('input', { type: c.type === 'number' ? 'number' : (c.type === 'date' ? 'date' : (c.type === 'email' ? 'email' : 'text')), placeholder: c.placeholder || '' }); inp.value = v; }
  inp.setAttribute('data-key', c.key);
  if (!(c.calc || '').trim()) inp.oninput = () => { pvData[c.key] = inp.value; pvApply(); };
  return inp;
}

function pvFieldNode(c, section) {
  const calc = (c.calc || '').trim();
  const wrap = el('label', { class: 'field ' + widthClass(c.width), style: 'margin:0' }, [
    el('span', { html: c.label + (c.required ? ' <span style="color:var(--red)">*</span>' : '') + (calc ? ' <span class="pill" style="font-size:10px">calc</span>' : '') }),
    pvInput(c),
  ]);
  pvReg.push({ el: c, section, node: wrap, kind: 'field' });
  return wrap;
}

function pvBuild() {
  const body = document.getElementById('pvBody');
  body.innerHTML = ''; pvReg = [];
  const addChild = (c, section, container) => {
    if (c.type === 'http') { return; }   // behaviour-only; wired after build
    if (c.type === 'heading') { const h = el('h3', { class: widthClass(c.width), text: c.label, style: 'margin:6px 0 0;border-bottom:1px solid var(--border);padding-bottom:6px' }); pvReg.push({ el: c, section, node: h, kind: 'heading' }); container.appendChild(h); }
    else if (c.type === 'button') {
      const btn = el('button', { class: 'btn ' + (c.style === 'primary' ? 'primary' : ''), text: c.label });
      if (c.color) { btn.style.background = c.color; btn.style.borderColor = c.color; btn.style.color = '#fff'; }
      btn.onclick = () => pvRun(c);
      const al = c.align === 'center' ? 'al-center' : c.align === 'right' ? 'al-right' : 'al-left';
      const cell = el('div', { class: `btn-cell ${al} ${widthClass(c.width)}`, 'data-bkey': c.key }, [btn]);
      pvReg.push({ el: c, section, node: cell, btn, kind: 'button' });
      container.appendChild(cell);
    } else if (isContentType(c.type)) {
      // Same builders as the live Fill page (defined in common.js).
      const node = c.type === 'downloads' ? buildDownloads(c)
        : c.type === 'docview' ? buildDocView(c, pvData)
        : buildWmDownload(c, pvData);
      pvReg.push({ el: c, section, node, kind: 'content' });
      container.appendChild(node);
    } else container.appendChild(pvFieldNode(c, section));
  };
  schemaElements(schema).forEach(elx => {
    if (elx.type === 'section') {
      const box = el('div', { style: 'flex:0 0 100%;border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start' }, [el('div', { style: 'flex:0 0 100%;font-weight:700', text: elx.label })]);
      pvReg.push({ el: elx, section: null, node: box, kind: 'section' });
      (elx.children || []).forEach(ch => addChild(ch, elx, box));
      body.appendChild(box);
    } else addChild(elx, null, body);
  });
  pvApply();
  pvWireApiFetch();
}

function pvWireApiFetch() {
  eachField(schema).map(x => x.el).filter(e => e.type === 'http').forEach(comp => {
    if (!comp.trigger) return;
    const reg = pvReg.find(r => r.kind === 'field' && r.el.key === comp.trigger);
    if (!reg) return;
    const inp = reg.node.querySelector('[data-key]');
    if (!inp) return;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pvApiFetch(comp); } });
  });
}

async function pvApiFetch(comp) {
  let res;
  try { res = await API.post(`/api/forms/${FORM_ID}/http-fetch`, { key: comp.key, data: pvData }); }
  catch (e) { toast('API error: ' + e.message, 'err'); return; }
  if (!res.ok || res.json == null) { toast('API: ' + (res.error || ('no JSON returned (status ' + res.status + ')')), 'err'); return; }
  const root = getByPath(res.json, comp.rootPath);
  let n = 0;
  (comp.mappings || []).forEach(m => { if (!m.field) return; const v = getByPath(root, m.path); if (v === undefined) return; pvData[m.field] = (v === null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v); n++; });
  pvBuild();
  toast(`API filled ${n} field(s)`, 'ok');
}

function pvApply() {
  // lookups
  (pvLookups || []).forEach(lk => {
    const kv = String(pvData[lk.key_component] ?? '').trim(); if (!kv) return;
    const row = (lk.rows || []).find(r => String(r[lk.key_column] ?? '').trim() === kv); if (!row) return;
    (lk.mappings || []).forEach(m => { if (m.comp && (m.col in row)) { pvData[m.comp] = row[m.col]; const reg = pvReg.find(r => r.kind === 'field' && r.el.key === m.comp); if (reg) { const i = reg.node.querySelector('[data-key]'); if (i && 'value' in i) i.value = pvData[m.comp]; } } });
  });
  // calc
  pvReg.forEach(r => { if (r.kind === 'field' && (r.el.calc || '').trim()) { const out = evalFormula(r.el.calc, pvData, pvData[r.el.key]); if (out !== undefined) { pvData[r.el.key] = out; const i = r.node.querySelector('[data-key]'); if (i && 'value' in i) i.value = out; } } });
  // visibility + readonly
  pvReg.forEach(r => {
    if (r.kind === 'section') { r.node.classList.toggle('is-hidden', !(ruleVisible(r.el, pvRole, pvStage) && evalFormula(r.el.visibleWhen, pvData) !== false)); return; }
    const vis = effVisibleFull(r.el, r.section, pvRole, pvStage, pvData);
    r.node.classList.toggle('is-hidden', !vis);
    if (r.kind === 'button') { r.btn.disabled = effReadonlyFull(r.el, r.section, pvRole, pvStage, pvData); }
    if (r.kind === 'field') { const ro = effReadonlyFull(r.el, r.section, pvRole, pvStage, pvData); r.node.querySelectorAll('input,select,textarea').forEach(i => { if (i.type === 'radio' || i.type === 'checkbox') i.disabled = ro; else { if (ro) i.setAttribute('readonly', 'true'); else i.removeAttribute('readonly'); } i.style.opacity = ro ? '.65' : ''; }); }
  });
}

function pvVisibleKeys() { return pvReg.filter(r => r.kind === 'field' && effVisibleFull(r.el, r.section, pvRole, pvStage, pvData)).map(r => r.el.key); }

function pvHasValidate(key) {
  const g = (workflow || {})[key];
  if (!g || !g.drawflow) return false;
  for (const mod of Object.values(g.drawflow)) for (const n of Object.values(mod.data || {})) if (n.name === 'validate') return true;
  return false;
}

function pvShowErrors(pairs, extra) {
  pvReg.forEach(r => { if (r.kind === 'field') { r.node.classList.remove('invalid'); const e = r.node.querySelector('.field-error'); if (e) e.remove(); } });
  pairs.forEach(p => { p.entry.node.classList.add('invalid'); const e = el('div', { class: 'field-error', text: p.message }); p.entry.node.appendChild(e); });
  const box = document.getElementById('pvErrors');
  if (extra && extra.length) { box.style.display = ''; box.innerHTML = '⚠ ' + extra.join('<br>'); } else box.style.display = 'none';
}

async function pvRun(btn) {
  pvApply();
  document.getElementById('pvErrors').style.display = 'none';
  pvReg.forEach(r => { if (r.kind === 'field') { r.node.classList.remove('invalid'); const e = r.node.querySelector('.field-error'); if (e) e.remove(); } });
  // client validation if a validate node exists for this button
  if (pvHasValidate(btn.key)) {
    const pairs = [];
    pvReg.forEach(r => { if (r.kind === 'field' && effVisibleFull(r.el, r.section, pvRole, pvStage, pvData)) { const m = validateField(r.el, pvData); if (m) pairs.push({ entry: r, message: m }); } });
    if (pairs.length) { pvShowErrors(pairs, []); pvTrace(btn.key, { errors: pairs.map(p => p.message), log: ['✖ Client validation failed before sending to workflow.'] }); return; }
  }
  let res;
  try { res = await API.post(`/api/forms/${FORM_ID}/preview-run`, { button_key: btn.key, data: pvData, role: pvRole, stage: pvStage, visible_keys: pvVisibleKeys() }); }
  catch (e) { pvTrace(btn.key, { errors: [e.message], log: [] }); return; }
  if (res.data) pvData = res.data;
  if (res.stage) { pvStage = res.stage; document.getElementById('pvStage').value = pvStage; }
  pvBuild();
  if (res.errors && res.errors.length) {
    const pairs = [], extra = [];
    (res.errors).forEach(s => { const r = pvReg.find(x => x.kind === 'field' && s.includes(`'${x.el.label}'`)); if (r) pairs.push({ entry: r, message: s }); else extra.push(s); });
    pvShowErrors(pairs, extra);
  }
  pvTrace(btn.key, res);
  (res.dialogs || []).forEach(pvDialog);
}

function pvTrace(key, res) {
  // remove old traces
  document.querySelectorAll('#pvBody .pv-trace').forEach(n => n.remove());
  const cell = document.querySelector(`#pvBody [data-bkey="${CSS.escape(key)}"]`);
  const ok = !(res.errors && res.errors.length);
  const box = el('div', { class: 'pv-trace', style: 'flex:0 0 100%;margin-top:-4px' });
  const inner = el('div', { style: `border:1px solid ${ok ? 'var(--border)' : 'var(--red)'};border-radius:8px;padding:10px 12px;background:var(--bg-2)` }, [
    el('div', { class: 'flex', style: 'gap:8px;margin-bottom:6px' }, [
      el('span', { class: 'badge ' + (ok ? 'published' : 'draft'), text: ok ? 'OK' : 'FAILED' }),
      el('span', { class: 'pill', style: 'font-size:11px', text: 'button: ' + key }),
    ]),
  ]);
  if (res.errors && res.errors.length) inner.appendChild(el('div', { style: 'color:#fca5a5;font-size:12px;margin-bottom:6px', html: '⚠ ' + res.errors.map(escapeHtml).join('<br>') }));
  inner.appendChild(el('div', { style: 'white-space:pre-wrap;font-size:12px;color:var(--muted)', text: (res.log || []).join('\n') || '(no steps)' }));
  if (res.emails && res.emails.length) res.emails.forEach(e => inner.appendChild(el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px', text: `✉ ${e.recipient} — ${e.subject} (${e.delivery || ''})` })));
  if (res.navigate && res.navigate.url) inner.appendChild(el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px', text: `➡ would navigate to ${res.navigate.url}` }));
  box.appendChild(inner);
  if (cell && cell.parentElement) cell.parentElement.insertBefore(box, cell.nextSibling);
  else document.getElementById('pvBody').appendChild(box);
}

function pvDialog(spec) {
  const back = el('div', { class: 'modal-back show' });
  const foot = el('div', { class: 'foot' });
  (spec.buttons || []).filter(b => b.enabled).forEach(b => foot.appendChild(el('button', { class: b.action === 'navigate' ? 'btn primary' : 'btn', text: b.label + (b.action === 'navigate' ? ' (preview: no nav)' : ''), onclick: () => back.remove() })));
  if (!foot.children.length) foot.appendChild(el('button', { class: 'btn', text: 'Close', onclick: () => back.remove() }));
  back.appendChild(el('div', { class: 'modal' }, [el('h2', { text: spec.header || 'Dialog' }), el('div', { class: 'body' }, [el('div', { style: 'white-space:pre-wrap', text: spec.body || '' })]), foot]));
  document.body.appendChild(back);
}

// ---------------- Database tab ----------------
let dbSubs = [];

// ---- Reusable paginated + per-column-filtered table ----
// columns: [{ key, label, get(row)->str, cell(row)->html (optional), noFilter }]
// opts: { pageSize=10, empty, rowStyle(row)->str, bind(tableEl) }
const pagerState = {};
const PAGE_SIZE = 10;

function renderPagedTable(tableId, columns, rows, opts = {}) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const pageSize = opts.pageSize || PAGE_SIZE;
  const st = (pagerState[tableId] ||= { page: 0, filters: {} });
  const filtered = rows.filter(r => columns.every(c => {
    const fv = (st.filters[c.key] || '').trim().toLowerCase();
    if (!fv) return true;
    return String(c.get ? c.get(r) : (r[c.key] ?? '')).toLowerCase().includes(fv);
  }));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  st.page = Math.min(Math.max(0, st.page), pages - 1);
  const start = st.page * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  let html = '<tr>' + columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('') + '</tr>';
  html += '<tr class="filter-row">' + columns.map(c => c.noFilter ? '<th></th>'
    : `<th><input type="text" data-fk="${escapeHtml(c.key)}" value="${attr(st.filters[c.key] || '')}" placeholder="filter…"></th>`).join('') + '</tr>';
  if (pageRows.length) {
    html += pageRows.map(r => `<tr${opts.rowStyle && opts.rowStyle(r) ? ` style="${opts.rowStyle(r)}"` : ''}>` +
      columns.map(c => `<td>${c.cell ? c.cell(r) : escapeHtml(String(c.get ? c.get(r) : (r[c.key] ?? '')))}</td>`).join('') + '</tr>').join('');
  } else {
    html += `<tr><td colspan="${columns.length}" class="subtle" style="text-align:center;padding:20px">${escapeHtml(opts.empty || 'No matching records')}</td></tr>`;
  }
  table.innerHTML = html;

  table.querySelectorAll('.filter-row input').forEach(inp => {
    inp.oninput = () => {
      st.filters[inp.getAttribute('data-fk')] = inp.value;
      st.page = 0;
      renderPagedTable(tableId, columns, rows, opts);
      const again = table.querySelector(`.filter-row input[data-fk="${CSS.escape(inp.getAttribute('data-fk'))}"]`);
      if (again) { again.focus(); const v = again.value; again.value = ''; again.value = v; }
    };
  });

  const wrap = table.closest('.tablewrap') || table.parentElement;
  let pager = wrap.nextElementSibling;
  if (!pager || !pager.classList || !pager.classList.contains('pager')) { pager = el('div', { class: 'pager' }); wrap.after(pager); }
  pager.innerHTML = '';
  pager.appendChild(el('span', { class: 'subtle', style: 'font-size:12px', text: filtered.length ? `${start + 1}–${start + pageRows.length} of ${filtered.length}` : '0 of 0' }));
  pager.appendChild(el('div', { style: 'flex:1' }));
  const go = (p) => { st.page = p; renderPagedTable(tableId, columns, rows, opts); };
  const mk = (label, dis, fn) => el('button', { class: 'btn sm ghost', text: label, disabled: dis ? 'true' : null, onclick: fn });
  pager.appendChild(mk('« First', st.page <= 0, () => go(0)));
  pager.appendChild(mk('‹ Prev', st.page <= 0, () => go(st.page - 1)));
  pager.appendChild(el('span', { class: 'pill', style: 'font-size:12px', text: `Page ${st.page + 1} / ${pages}` }));
  pager.appendChild(mk('Next ›', st.page >= pages - 1, () => go(st.page + 1)));
  pager.appendChild(mk('Last »', st.page >= pages - 1, () => go(pages - 1)));
  const jump = el('input', { type: 'number', min: '1', max: String(pages), value: String(st.page + 1), style: 'width:62px', title: 'Jump to page' });
  jump.onchange = () => { let p = parseInt(jump.value, 10); if (!isNaN(p)) go(Math.max(0, Math.min(pages - 1, p - 1))); };
  pager.appendChild(jump);

  if (opts.bind) opts.bind(table);
}

async function renderDatabaseTab() {
  const fields = fieldElements(schema);
  renderPagedTable('schemaTable', [
    { key: 'key', label: 'Key', get: c => c.key },
    { key: 'type', label: 'Type', get: c => c.type },
    { key: 'label', label: 'Label', get: c => c.label },
    { key: 'required', label: 'Required', get: c => (c.required ? 'Yes' : '') },
  ], fields, { empty: 'No components defined' });

  dbSubs = await API.get(`/api/forms/${FORM_ID}/submissions`);
  document.getElementById('subCount').textContent = `(${dbSubs.length})`;
  const en = document.getElementById('editorName');
  en.value = localStorage.getItem('foms_editor') || '';
  en.oninput = () => localStorage.setItem('foms_editor', en.value);
  document.getElementById('subSearch').oninput = renderSubTable;
  document.getElementById('extractBtn').onclick = () => extractModal(null);
  document.getElementById('lookupUploadBtn').onclick = uploadLookup;
  document.getElementById('emailExtractBtn').onclick = emailExtractModal;
  renderSubTable();
  renderExtractTasks();
  renderLookups();

  const emails = await API.get(`/api/forms/${FORM_ID}/emails`);
  renderPagedTable('emailTable', [
    { key: 'id', label: 'ID', get: e => '#' + e.id },
    { key: 'recipient', label: 'To', get: e => e.recipient || '' },
    { key: 'subject', label: 'Subject', get: e => e.subject || '' },
    { key: 'sent_at', label: 'Sent', get: e => fmtDate(e.sent_at), noFilter: true },
  ], emails, { empty: 'No emails sent' });

  renderPagedTable('verTable', [
    { key: 'version_no', label: 'Version', get: v => 'v' + v.version_no },
    { key: 'published_at', label: 'Published At', get: v => fmtDate(v.published_at), noFilter: true },
    { key: 'live', label: 'Live', get: v => (v.id === form.published_version_id ? '● current' : '') },
    { key: '_act', label: '', noFilter: true, cell: v => `<button class="btn sm restore-btn" data-vid="${v.id}" data-vno="${v.version_no}">↩ Restore</button>` },
  ], form.versions, {
    empty: 'Not published yet',
    bind: t => t.querySelectorAll('.restore-btn').forEach(b => b.onclick = () => restoreVersion(b.getAttribute('data-vid'), b.getAttribute('data-vno'))),
  });
}

async function restoreVersion(vid, vno) {
  const ok = await confirmModal('Restore version v' + vno + '?',
    'This loads v' + vno + ' (schema + workflow) into the working copy and unpublishes the form so you can review it. Existing submissions are untouched. Click Publish afterwards to make it live again as a new version.', 'Restore');
  if (!ok) return;
  await API.post(`/api/forms/${FORM_ID}/versions/${vid}/restore`, {});
  toast('Restored v' + vno + ' into the working copy', 'ok');
  await loadForm();
  document.querySelector('.tabs .tab[data-tab="design"]').click();
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

function renderSubTable() {
  const fields = fieldElements(schema);
  const keys = fields.map(c => c.key);
  const labels = {}; fields.forEach(c => labels[c.key] = c.label);
  const q = (document.getElementById('subSearch').value || '').toLowerCase();
  // global search box narrows the row set; per-column filters refine within it
  const rows = dbSubs.filter(s => {
    if (!q) return true;
    return (s.uuid || '').toLowerCase().includes(q) || (s.stage || '').toLowerCase().includes(q) ||
      (s.status || '').toLowerCase().includes(q) || (s.modified_by || '').toLowerCase().includes(q) ||
      keys.some(k => cellValue(s.data[k]).toLowerCase().includes(q));
  });
  const columns = [
    { key: 'ref', label: 'Reference', get: s => s.uuid || '', cell: s => `<code title="${attr(s.uuid || '')}">${escapeHtml((s.uuid || '').slice(0, 10))}…</code>` },
    ...keys.map(k => ({ key: k, label: labels[k], get: s => cellValue(s.data[k]) })),
    { key: 'stage', label: 'Stage', get: s => s.stage || '' },
    { key: 'status', label: 'Status', get: s => s.status || '' },
    { key: 'modified_by', label: 'Modified By', get: s => s.modified_by || '' },
    { key: 'updated_at', label: 'Modified', get: s => fmtDate(s.updated_at), noFilter: true },
    { key: '_act', label: '', noFilter: true, cell: s =>
      (s.last_trace ? `<button class="btn sm ${s.last_ok === false ? 'danger' : 'ghost'} trace-sub" data-id="${s.id}">${s.last_ok === false ? '⚠ Trace' : 'Trace'}</button> ` : '') +
      `<button class="btn sm ghost edit-sub" data-id="${s.id}">✎ Edit</button>` },
  ];
  renderPagedTable('subTable', columns, rows, {
    empty: 'No matching submissions',
    rowStyle: s => (s.last_ok === false ? 'background:rgba(239,68,68,.13)' : ''),
    bind: t => {
      t.querySelectorAll('.edit-sub').forEach(b => b.onclick = () => { const sub = dbSubs.find(x => x.id == b.getAttribute('data-id')); if (sub) editSubmission(sub); });
      t.querySelectorAll('.trace-sub').forEach(b => b.onclick = () => { const sub = dbSubs.find(x => x.id == b.getAttribute('data-id')); if (sub) traceModal(sub); });
    },
  });
}

function traceModal(sub) {
  const list = (sub.traces && sub.traces.length) ? sub.traces : (sub.last_trace ? [sub.last_trace] : []);
  const back = el('div', { class: 'modal-back show' });
  const body = el('div', { class: 'body' });
  body.appendChild(el('p', { class: 'subtle', style: 'margin-top:0', text: `${list.length} workflow run(s) — newest first` }));
  if (!list.length) body.appendChild(el('div', { class: 'hint', text: 'No workflow runs recorded for this submission.' }));
  list.forEach((tr, i) => {
    const ok = tr.ok !== false && (!tr.errors || !tr.errors.length);
    const blk = el('div', { style: 'border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px' });
    blk.appendChild(el('div', { class: 'flex', style: 'gap:8px;margin-bottom:6px' }, [
      el('span', { class: 'badge ' + (ok ? 'published' : 'draft'), text: ok ? 'OK' : 'FAILED' }),
      el('span', { class: 'pill', style: 'font-size:11px', text: (tr.button || '') + (i === 0 ? ' · latest' : '') }),
      el('span', { class: 'subtle', style: 'font-size:12px;margin-left:auto', text: tr.at ? fmtDate(tr.at) : '' }),
    ]));
    if (tr.errors && tr.errors.length) {
      blk.appendChild(el('div', { class: 'hint', style: 'border-color:var(--red);color:#fca5a5;margin-bottom:8px', html: '⚠ ' + tr.errors.map(escapeHtml).join('<br>') }));
    }
    blk.appendChild(el('div', { style: 'white-space:pre-wrap;font-size:12px;color:var(--muted)', text: (tr.log || []).join('\n') || '(no steps)' }));
    if (tr.emails && tr.emails.length) {
      tr.emails.forEach(e => blk.appendChild(el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px', text: `✉ ${e.recipient} — ${e.subject} (${e.delivery || ''})` })));
    }
    body.appendChild(blk);
  });
  const m = el('div', { class: 'modal', style: 'width:600px' }, [
    el('h2', { text: 'Workflow traces · ' + (sub.uuid || '').slice(0, 10) + '…' }), body,
    el('div', { class: 'foot' }, [el('button', { class: 'btn', text: 'Close', onclick: () => back.remove() })]),
  ]);
  back.appendChild(m);
  back.addEventListener('mousedown', e => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
}

function editSubmission(sub) {
  const fields = fieldElements(schema);
  const data = Object.assign({}, sub.data);
  const back = el('div', { class: 'modal-back show' });
  const body = el('div', { class: 'body' });
  body.appendChild(el('p', { class: 'subtle', style: 'margin-top:0', html: `Editing <b>${escapeHtml((sub.uuid || '').slice(0, 12))}…</b>. Saving records your name and the time.` }));
  fields.forEach(c => {
    let inp;
    const v = data[c.key];
    if (c.type === 'file') {
      inp = el('input', { type: 'text', value: (v && v.name) ? v.name : '', readonly: 'true', style: 'opacity:.7' });
    } else if (c.type === 'textarea') { inp = el('textarea', { rows: 2 }); inp.value = v ?? ''; inp.oninput = () => data[c.key] = inp.value; }
    else if (c.type === 'select' || c.type === 'radio') {
      inp = el('select'); inp.appendChild(el('option', { value: '', text: '—' }));
      (c.options || []).forEach(o => inp.appendChild(el('option', { value: o, text: o })));
      inp.value = v ?? ''; inp.onchange = () => data[c.key] = inp.value;
    } else if (c.type === 'checkbox') {
      inp = el('input', { type: 'checkbox' }); inp.checked = (v === 'Yes' || v === true);
      inp.onchange = () => data[c.key] = inp.checked ? 'Yes' : '';
      body.appendChild(el('label', { class: 'checkbox-row', style: 'margin-bottom:10px' }, [inp, el('span', { text: c.label })])); return;
    } else { inp = el('input', { type: c.type === 'number' ? 'number' : (c.type === 'date' ? 'date' : 'text') }); inp.value = v ?? ''; inp.oninput = () => data[c.key] = inp.value; }
    body.appendChild(el('label', { class: 'field' }, [el('span', { text: c.label + (c.type === 'file' ? ' (file — not editable here)' : '') }), inp]));
  });
  // stage editor
  const stageSel = el('select');
  stageSel.appendChild(el('option', { value: '', text: '—' }));
  schema.stages.forEach(st => stageSel.appendChild(el('option', { value: st.name, text: st.name })));
  stageSel.value = sub.stage || '';
  body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Workflow stage' }), stageSel]));

  const close = () => back.remove();
  const save = async () => {
    const modified_by = (document.getElementById('editorName').value || '').trim() || 'unknown';
    await API.put(`/api/submissions/${sub.id}`, { data, stage: stageSel.value, modified_by });
    toast('Submission updated', 'ok'); close();
    dbSubs = await API.get(`/api/forms/${FORM_ID}/submissions`); renderSubTable();
  };
  const m = el('div', { class: 'modal', style: 'width:560px' }, [
    el('h2', { text: 'Edit submission' }), body,
    el('div', { class: 'foot' }, [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', { class: 'btn primary', text: 'Save to database', onclick: save }),
    ]),
  ]);
  back.appendChild(m);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.appendChild(back);
}

// ---------- Pre-fill lookups ----------
async function uploadLookup() {
  const inp = document.getElementById('lookupFile');
  const f = inp.files[0];
  if (!f) return toast('Choose a CSV or Excel file first', 'err');
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch(`/api/forms/${FORM_ID}/lookups`, { method: 'POST', body: fd });
  if (!r.ok) { toast('Upload failed', 'err'); return; }
  const lt = await r.json();
  toast(`Uploaded ${lt.name} (${lt.row_count} rows)`, 'ok');
  inp.value = '';
  renderLookups();
  configureLookup(lt);
}

async function renderLookups() {
  const box = document.getElementById('lookupList');
  box.innerHTML = '';
  const list = await API.get(`/api/forms/${FORM_ID}/lookups?rows=1`);
  if (!list.length) { box.appendChild(el('span', { class: 'subtle', style: 'font-size:12px', text: 'No lookup data uploaded.' })); return; }
  list.forEach(lt => {
    const head = el('div', { class: 'flex', style: 'gap:8px;flex-wrap:wrap;margin:14px 0 6px' }, [
      el('b', { text: `📄 ${lt.name}` }),
      el('span', { class: 'pill', style: 'font-size:11px', text: `${lt.row_count} rows · key ${lt.key_column || '?'} → ${lt.key_component || '(unset)'}` }),
      el('div', { style: 'flex:1' }),
      el('button', { class: 'btn sm ghost', text: '✎ Configure', onclick: () => configureLookup(lt) }),
      el('button', { class: 'btn sm danger', text: '✕ Delete', onclick: async () => { if (await confirmModal('Delete lookup?', `"${lt.name}" will be removed.`, 'Delete')) { await API.del(`/api/lookups/${lt.id}`); renderLookups(); } } }),
    ]);
    const tableId = 'lookupTable_' + lt.id;
    const wrap = el('div', { class: 'tablewrap' }, [el('table', { class: 'data', id: tableId })]);
    box.appendChild(head); box.appendChild(wrap);
    const cols = (lt.columns || []).map(c => ({ key: c, label: c, get: r => r[c] ?? '' }));
    renderPagedTable(tableId, cols.length ? cols : [{ key: '_e', label: '(no columns)', get: () => '' }], lt.rows || [], { empty: 'No rows in this lookup' });
  });
}

function configureLookup(lt) {
  const fields = fieldElements(schema);
  const compOpts = '<option value="">— none —</option>' + fields.map(f => `<option value="${f.key}">${escapeHtml(f.label)} (${f.key})</option>`).join('');
  const mapByCol = {}; (lt.mappings || []).forEach(m => mapByCol[m.col] = m.comp);
  const back = el('div', { class: 'modal-back show' });
  const body = el('div', { class: 'body' });
  body.appendChild(el('p', { class: 'subtle', style: 'margin-top:0', text: `${lt.name} · ${lt.row_count} rows` }));

  const keyColSel = el('select');
  (lt.columns || []).forEach(c => keyColSel.appendChild(el('option', { value: c, text: c })));
  keyColSel.value = lt.key_column || (lt.columns[0] || '');
  body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Key column (in file)' }), keyColSel]));

  const keyCompSel = el('select'); keyCompSel.innerHTML = compOpts; keyCompSel.value = lt.key_component || '';
  body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Matches form field' }), keyCompSel]));

  body.appendChild(el('div', { class: 'ruleblk' }, [el('h5', { text: 'Map columns → form fields' })]));
  const mapSels = {};
  (lt.columns || []).forEach(col => {
    const sel = el('select'); sel.innerHTML = compOpts; sel.value = mapByCol[col] || '';
    mapSels[col] = sel;
    body.appendChild(el('label', { class: 'field' }, [el('span', { text: col }), sel]));
  });

  const close = () => back.remove();
  const save = async () => {
    const mappings = Object.entries(mapSels).filter(([, s]) => s.value).map(([col, s]) => ({ col, comp: s.value }));
    await API.put(`/api/lookups/${lt.id}`, { key_column: keyColSel.value, key_component: keyCompSel.value, mappings });
    toast('Lookup configured', 'ok'); close(); renderLookups();
  };
  const m = el('div', { class: 'modal', style: 'width:520px' }, [
    el('h2', { text: 'Configure lookup' }), body,
    el('div', { class: 'foot' }, [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', { class: 'btn primary', text: 'Save', onclick: save }),
    ]),
  ]);
  back.appendChild(m);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.appendChild(back);
}

// ---------- Extract ----------
async function renderExtractTasks() {
  const box = document.getElementById('extractTasks');
  const tasks = await API.get(`/api/forms/${FORM_ID}/extract-tasks`);
  box.innerHTML = '';
  tasks.forEach(t => {
    const chip = el('span', { class: 'chip', title: 'Next run: ' + (t.next_run || '—') }, [
      el('span', { text: `⏱ ${t.name} · ${t.schedule} · ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} ${t.timezone} · ${t.file_type.toUpperCase()}` }),
      el('span', { class: 'x', text: '✎', title: 'Edit', style: 'cursor:pointer', onclick: () => extractModal(t) }),
      el('span', { class: 'x', text: '▶', title: 'Run now', style: 'cursor:pointer', onclick: async () => { const r = await API.post(`/api/extract-tasks/${t.id}/run`, {}); toast(r.ok ? ('Wrote ' + r.path) : 'Run failed', r.ok ? 'ok' : 'err'); } }),
      el('span', { class: 'x', text: '✕', title: 'Delete', onclick: async () => { await API.del(`/api/extract-tasks/${t.id}`); renderExtractTasks(); } }),
    ]);
    box.appendChild(chip);
  });
}

async function downloadBlob(url, payload, filename) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const blob = await r.blob();
  const u = URL.createObjectURL(blob);
  const a = el('a', { href: u, download: filename });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
}

async function downloadExtract(columns, fileType) {
  await downloadBlob(`/api/forms/${FORM_ID}/extract`, { columns, file_type: fileType }, `submissions.${fileType === 'xlsx' ? 'xlsx' : 'csv'}`);
}

function emailExtractModal() {
  const cols = [['id', 'ID'], ['sender', 'Sender'], ['recipient', 'Recipient'], ['subject', 'Subject'], ['body', 'Body'], ['attachment', 'Attachment'], ['sent_at', 'Sent At']];
  const chosen = new Set(cols.map(c => c[0]));
  const back = el('div', { class: 'modal-back show' });
  const body = el('div', { class: 'body' });
  body.appendChild(el('div', { class: 'subtle', style: 'font-size:12px;margin-bottom:6px', text: 'Columns to include:' }));
  const colBox = el('div', { class: 'wrap-gap', style: 'margin-bottom:12px' });
  cols.forEach(([k, l]) => {
    const cb = el('input', { type: 'checkbox' }); cb.checked = true;
    cb.onchange = () => { if (cb.checked) chosen.add(k); else chosen.delete(k); };
    colBox.appendChild(el('label', { class: 'checkbox-row' }, [cb, el('span', { text: l })]));
  });
  body.appendChild(colBox);
  const ftSel = el('select'); [['csv', 'CSV (.csv)'], ['xlsx', 'Excel (.xlsx)']].forEach(([v, l]) => ftSel.appendChild(el('option', { value: v, text: l }))); ftSel.value = 'xlsx';
  body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'File type' }), ftSel]));
  const close = () => back.remove();
  const proceed = async () => {
    const columns = cols.map(c => c[0]).filter(k => chosen.has(k));
    if (!columns.length) return toast('Pick at least one column', 'err');
    await downloadBlob(`/api/forms/${FORM_ID}/emails/extract`, { columns, file_type: ftSel.value }, `emails.${ftSel.value === 'xlsx' ? 'xlsx' : 'csv'}`);
    toast('Email log extracted', 'ok'); close();
  };
  const m = el('div', { class: 'modal', style: 'width:460px' }, [
    el('h2', { text: 'Extract email log' }), body,
    el('div', { class: 'foot' }, [el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }), el('button', { class: 'btn primary', text: 'Download', onclick: proceed })]),
  ]);
  back.appendChild(m);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.appendChild(back);
}

function extractModal(task) {
  const fields = fieldElements(schema);
  const allCols = [['id', 'ID'], ['stage', 'Stage'], ['status', 'Status'], ['created_at', 'Created'], ['modified_by', 'Modified By']]
    .concat(fields.map(f => [f.key, f.label]));
  const chosen = new Set(task ? task.columns : allCols.map(c => c[0]));
  const back = el('div', { class: 'modal-back show' });
  const body = el('div', { class: 'body' });

  const nameInp = el('input', { type: 'text', value: task ? task.name : 'Submissions extract' });
  body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Extract name' }), nameInp]));

  // columns
  body.appendChild(el('div', { class: 'subtle', style: 'font-size:12px;margin-bottom:6px', text: 'Columns to include:' }));
  const colBox = el('div', { class: 'wrap-gap', style: 'margin-bottom:12px' });
  allCols.forEach(([k, lbl]) => {
    const cb = el('input', { type: 'checkbox' }); cb.checked = chosen.has(k);
    cb.onchange = () => { if (cb.checked) chosen.add(k); else chosen.delete(k); };
    colBox.appendChild(el('label', { class: 'checkbox-row' }, [cb, el('span', { text: lbl })]));
  });
  body.appendChild(colBox);

  const ftSel = el('select'); [['csv', 'CSV (.csv)'], ['xlsx', 'Excel (.xlsx)']].forEach(([v, l]) => ftSel.appendChild(el('option', { value: v, text: l }))); ftSel.value = task ? task.file_type : 'xlsx';
  body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'File type' }), ftSel]));

  const schedSel = el('select');
  [['immediate', 'Immediate (download now)'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]
    .forEach(([v, l]) => schedSel.appendChild(el('option', { value: v, text: l })));
  schedSel.value = task ? task.schedule : 'immediate';
  body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Schedule' }), schedSel]));

  const schedBox = el('div', { class: 'ruleblk' });
  const hourInp = el('input', { type: 'number', min: '0', max: '23', value: task ? task.hour : 9 });
  const minInp = el('input', { type: 'number', min: '0', max: '59', value: task ? task.minute : 0 });
  const wdSel = el('select'); ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, i) => wdSel.appendChild(el('option', { value: i, text: d }))); wdSel.value = task ? task.weekday : 0;
  const dayInp = el('input', { type: 'number', min: '1', max: '31', value: task ? task.day : 1 });
  const tzSel = el('select');
  let tzs = []; try { tzs = Intl.supportedValuesOf('timeZone'); } catch (e) { tzs = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Singapore']; }
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  tzs.forEach(z => tzSel.appendChild(el('option', { value: z, text: z })));
  tzSel.value = task ? task.timezone : localTz;
  const folderInp = el('input', { type: 'text', value: task ? task.folder_path : '', placeholder: 'e.g. C:\\Users\\you\\Desktop\\extracts (on the FOMS machine)' });

  schedBox.appendChild(el('div', { class: 'flex', style: 'gap:8px' }, [
    el('label', { class: 'field', style: 'flex:1' }, [el('span', { text: 'Hour (0-23)' }), hourInp]),
    el('label', { class: 'field', style: 'flex:1' }, [el('span', { text: 'Minute' }), minInp]),
  ]));
  const wdField = el('label', { class: 'field' }, [el('span', { text: 'Day of week' }), wdSel]);
  const dayField = el('label', { class: 'field' }, [el('span', { text: 'Day of month' }), dayInp]);
  schedBox.appendChild(wdField); schedBox.appendChild(dayField);
  schedBox.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Timezone' }), tzSel]));
  schedBox.appendChild(el('label', { class: 'field' }, [el('span', { html: 'Save to folder <span class="subtle">(on the machine running FOMS)</span>' }), folderInp]));
  body.appendChild(schedBox);

  const syncSched = () => {
    const v = schedSel.value;
    schedBox.style.display = v === 'immediate' ? 'none' : '';
    wdField.style.display = v === 'weekly' ? '' : 'none';
    dayField.style.display = v === 'monthly' ? '' : 'none';
    hourInp.parentElement.parentElement.style.display = v === 'hourly' ? 'none' : '';
  };
  schedSel.onchange = syncSched; syncSched();

  const close = () => back.remove();
  const proceed = async () => {
    const columns = allCols.map(c => c[0]).filter(k => chosen.has(k));
    if (!columns.length) return toast('Pick at least one column', 'err');
    if (schedSel.value === 'immediate') {
      await downloadExtract(columns, ftSel.value); toast('Extract downloaded', 'ok'); close(); return;
    }
    const payload = {
      name: nameInp.value.trim() || 'Extract', columns, file_type: ftSel.value,
      schedule: schedSel.value, hour: +hourInp.value, minute: +minInp.value,
      weekday: +wdSel.value, day: +dayInp.value, timezone: tzSel.value,
      folder_path: folderInp.value.trim(), active: true,
    };
    if (task) await API.put(`/api/extract-tasks/${task.id}`, payload);
    else await API.post(`/api/forms/${FORM_ID}/extract-tasks`, payload);
    toast('Scheduled extract saved', 'ok'); close(); renderExtractTasks();
  };
  const m = el('div', { class: 'modal', style: 'width:560px' }, [
    el('h2', { text: task ? 'Edit scheduled extract' : 'Extract submissions' }), body,
    el('div', { class: 'foot' }, [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', { class: 'btn primary', text: 'Proceed', onclick: proceed }),
    ]),
  ]);
  back.appendChild(m);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.appendChild(back);
}

// ---------------- Workflow tab (Drawflow) ----------------
function populateWfButtons() {
  const sel = document.getElementById('wfButtonSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  buttonElements(schema).forEach(b => sel.appendChild(el('option', { value: b.key, text: `${b.label} (${b.key})` })));
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function initWorkflowTab() {
  if (!wfInited) {
    editor = new Drawflow(document.getElementById('drawflow'));
    editor.reroute = true;
    editor.start();
    buildWfPalette();
    setupWfDrop();
    document.getElementById('wfButtonSelect').onchange = switchWfButton;
    document.getElementById('wfClearBtn').onclick = () => { if (guard()) return; editor.clear(); addStartNode(); };
    document.getElementById('wfZoomIn').onclick = () => editor.zoom_in();
    document.getElementById('wfZoomOut').onclick = () => editor.zoom_out();
    document.getElementById('wfZoomReset').onclick = () => editor.zoom_reset();
    document.getElementById('wfDeleteBtn').onclick = () => {
      if (guard()) return;
      if (editor.node_selected) {
        const id = editor.node_selected.id.replace('node-', '');
        const node = editor.getNodeFromId(id);
        if (node && node.name === 'button_start') return toast('The start node cannot be deleted.', 'err');
        editor.removeNodeId(editor.node_selected.id);
      } else toast('Select a node first (click it).', 'err');
    };
    document.getElementById('wfCopyBtn').onclick = wfCopySelected;
    document.getElementById('wfCopyFlowBtn').onclick = wfCopyFlow;
    document.getElementById('wfPasteBtn').onclick = () => wfPaste();
    // Shift/Ctrl-click nodes to build a multi-selection (highlighted)
    document.getElementById('drawflow').addEventListener('click', e => {
      const nodeEl = e.target.closest('.drawflow-node');
      if (!nodeEl) { if (!e.shiftKey && !e.ctrlKey && !e.metaKey) wfClearSel(); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const id = nodeEl.id.replace('node-', '');
        if (nodeEl.classList.contains('nd-button_start')) return;
        if (wfSel.has(id)) { wfSel.delete(id); nodeEl.classList.remove('wf-multi'); }
        else { wfSel.add(id); nodeEl.classList.add('wf-multi'); }
      } else { wfClearSel(); }
    });
    // Ctrl+C / Ctrl+V on the workflow canvas (ignored while typing in a field)
    document.addEventListener('keydown', e => {
      const wfActive = document.getElementById('pane-workflow').classList.contains('active');
      if (!wfActive || !(e.ctrlKey || e.metaKey)) return;
      const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) return;   // let normal copy/paste work
      if (e.key === 'c' || e.key === 'C') { wfCopySelected(); }
      else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); wfPaste(); }
    });
    wfInited = true;
    currentWfButton = document.getElementById('wfButtonSelect').value;
    loadWfButton(currentWfButton);
  } else {
    populateWfButtons();
    editor.editor_mode = locked ? 'view' : 'edit';
  }
}

function buildWfPalette() {
  const box = document.getElementById('wfPalette'); box.innerHTML = '';
  WF_NODES.forEach(n => {
    const item = el('div', { class: 'palette-item', draggable: 'true' }, [el('span', { class: 'ic', text: n.ic }), el('span', { text: n.label })]);
    item.addEventListener('dragstart', e => e.dataTransfer.setData('wftype', n.type));
    box.appendChild(item);
  });
}
function setupWfDrop() {
  const c = document.getElementById('drawflow');
  c.addEventListener('dragover', e => e.preventDefault());
  c.addEventListener('drop', e => {
    e.preventDefault();
    if (guard()) return;
    const t = e.dataTransfer.getData('wftype');
    if (t) addWfNode(t, e.clientX, e.clientY);
  });
}

function nodeHtml(type, data) {
  const meta = WF_NODES.find(n => n.type === type) || { ic: '▶', label: type };
  let bodyInner = '';
  if (type === 'set_stage') {
    bodyInner = `<label>Stage</label><select df-stage>${optTags(schema.stages.map(s => s.name), data.stage)}</select>`;
  } else if (type === 'set_value') {
    const keys = fieldElements(schema).map(c => c.key);
    bodyInner = `<label>Field</label><select df-key>${optTags(keys, data.key)}</select>` +
      `<label>Value (supports {{field}})</label><input type="text" df-value value="${attr(data.value)}">`;
  } else if (type === 'send_email') {
    bodyInner = `<label>Email template</label><select df-emailid>${optTagsKV(schema.emails.map(e => [e.id, e.name]), data.emailid)}</select>`;
  } else if (type === 'http') {
    bodyInner = `<label>Method</label><select df-method>${optTags(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], data.method || 'GET')}</select>` +
      `<label>URL</label><input type="text" df-url value="${attr(data.url)}" placeholder="https://...">` +
      `<div class="nd-sep">Authorization</div>` +
      `<label>Auth method</label><select df-authtype>${optTagsKV([['none', 'None'], ['basic', 'Basic (user / password)'], ['bearer', 'Bearer token'], ['header', 'Custom header']], data.authtype || 'none', true)}</select>` +
      `<input type="text" df-authuser value="${attr(data.authuser)}" placeholder="Username (Basic)">` +
      `<input type="text" df-authpass value="${attr(data.authpass)}" placeholder="Password (Basic)">` +
      `<input type="text" df-authtoken value="${attr(data.authtoken)}" placeholder="Token (Bearer)">` +
      `<input type="text" df-headername value="${attr(data.headername)}" placeholder="Header name (e.g. X-API-Key)">` +
      `<input type="text" df-headervalue value="${attr(data.headervalue)}" placeholder="Header value (supports {{field}})">` +
      `<div class="nd-sep">Body</div>` +
      `<label>Body type</label><select df-bodytype>${optTagsKV([['none', 'None'], ['json', 'JSON'], ['xml', 'XML'], ['html', 'HTML'], ['form', 'Form-urlencoded'], ['text', 'Plain text']], data.bodytype || 'none', true)}</select>` +
      `<label>Body (supports {{field}})</label><textarea df-body rows="2">${escapeHtml(data.body || '')}</textarea>`;
  } else if (type === 'dialog') {
    bodyInner = `<label>Header</label><input type="text" df-header value="${attr(data.header)}" placeholder="Success">` +
      `<label>Body (supports {{field}})</label><textarea df-body rows="2">${escapeHtml(data.body || '')}</textarea>` +
      `<div class="nd-sep">Buttons (tick = shown)</div>` +
      `<label><select df-shownavigate class="nd-tick">${optTags(['no', 'yes'], data.shownavigate || 'no')}</select> Navigate</label>` +
      `<input type="text" df-navigatelabel value="${attr(data.navigatelabel || 'Navigate')}" placeholder="Navigate button label">` +
      `<input type="text" df-navigateurl value="${attr(data.navigateurl)}" placeholder="https://... (URL to open)">` +
      `<label><select df-showclosetab class="nd-tick">${optTags(['yes', 'no'], data.showclosetab || 'yes')}</select> Close browser tab</label>` +
      `<input type="text" df-closetablabel value="${attr(data.closetablabel || 'Close tab')}" placeholder="Close-tab button label">` +
      `<label><select df-showdismiss class="nd-tick">${optTags(['no', 'yes'], data.showdismiss || 'no')}</select> Dismiss (close dialog only)</label>` +
      `<input type="text" df-dismisslabel value="${attr(data.dismisslabel || 'OK')}" placeholder="Dismiss button label">`;
  } else if (type === 'navigate') {
    bodyInner = `<label>URL (supports {{field}})</label><input type="text" df-url value="${attr(data.url)}" placeholder="https://...">` +
      `<label>Open in</label><select df-newtab>${optTags(['no', 'yes'], data.newtab || 'no')}</select>` +
      `<div class="subtle" style="font-size:10px">yes = new tab; no = same tab</div>`;
  } else if (type === 'if') {
    const keys = fieldElements(schema).map(c => c.key);
    bodyInner = `<label>Field</label><select df-field>${optTags(keys, data.field)}</select>` +
      `<label>Data type</label><select df-dtype>${optTagsKV(DTYPES, data.dtype || 'string', true)}</select>` +
      `<label>Operator</label><select df-op>${optTags(['==', '!=', '>', '<', '>=', '<=', 'contains', 'empty', 'notempty'], data.op || '==')}</select>` +
      `<label>Value</label><input type="text" df-value value="${attr(data.value)}">` +
      `<div class="nd-sep">top output = TRUE · bottom = FALSE</div>`;
  } else if (type === 'switch') {
    const keys = fieldElements(schema).map(c => c.key);
    bodyInner = `<label>Field</label><select df-field>${optTags(keys, data.field)}</select>` +
      `<label>Data type</label><select df-dtype>${optTagsKV(DTYPES, data.dtype || 'string', true)}</select>` +
      `<label>Output 1 if value =</label><input type="text" df-case1 value="${attr(data.case1)}">` +
      `<label>Output 2 if value =</label><input type="text" df-case2 value="${attr(data.case2)}">` +
      `<label>Output 3 if value =</label><input type="text" df-case3 value="${attr(data.case3)}">` +
      `<div class="nd-sep">output 4 = default (no match)</div>`;
  } else if (type === 'validate') {
    bodyInner = `<div class="subtle" style="font-size:12px">Checks required & visible fields. Stops on failure.</div>`;
  } else if (type === 'save') {
    bodyInner = `<div class="subtle" style="font-size:12px">Persists the submission to the local database.</div>`;
  } else if (type === 'button_start') {
    bodyInner = `<div class="subtle" style="font-size:12px">Flow starts here when the button is clicked.</div>`;
  }
  return `<div class="nd-head">${meta.ic} ${meta.label}</div><div class="nd-body">${bodyInner}</div>`;
}
function optTags(arr, sel) { return arr.map(o => `<option value="${attr(o)}" ${o == sel ? 'selected' : ''}>${escapeHtml(o)}</option>`).join(''); }
function optTagsKV(pairs, sel, noBlank) { return (noBlank ? '' : '<option value="">— select —</option>') + pairs.map(([v, l]) => `<option value="${attr(v)}" ${v == sel ? 'selected' : ''}>${escapeHtml(l)}</option>`).join(''); }
const DTYPES = [['string', 'String / text'], ['char', 'Character'], ['number', 'Number'], ['date', 'Date'], ['datetime', 'Date & time'], ['email', 'Email'], ['boolean', 'Boolean (yes/no)']];
function attr(s) { return String(s ?? '').replace(/"/g, '&quot;'); }

function dfPos(clientX, clientY) {
  const rect = editor.precanvas.getBoundingClientRect();
  const z = editor.zoom;
  return { x: (clientX - rect.x) / z, y: (clientY - rect.y) / z };
}
function addWfNode(type, clientX, clientY) {
  const { x, y } = dfPos(clientX, clientY);
  const defaults = type === 'http' ? { method: 'GET', url: '', authtype: 'none', authuser: '', authpass: '', authtoken: '', headername: '', headervalue: '', bodytype: 'none', body: '' }
    : type === 'dialog' ? { header: 'Success', body: '', shownavigate: 'no', navigatelabel: 'Navigate', navigateurl: '', showclosetab: 'yes', closetablabel: 'Close tab', showdismiss: 'no', dismisslabel: 'OK' }
    : type === 'navigate' ? { url: '', newtab: 'no' }
    : type === 'if' ? { field: '', dtype: 'string', op: '==', value: '' }
    : type === 'switch' ? { field: '', dtype: 'string', case1: '', case2: '', case3: '' }
    : {};
  const outs = type === 'if' ? 2 : type === 'switch' ? 4 : 1;
  editor.addNode(type, 1, outs, x, y, 'nd-' + type, defaults, nodeHtml(type, defaults));
}
// ---- Copy / paste nodes — single, multiple (Shift/Ctrl-click) or whole flow ----
// Works within a flow and across flows/forms (clipboard kept in localStorage).
let wfSel = new Set();   // ids of nodes in the multi-selection

function wfClearSel() {
  wfSel.forEach(id => { const n = document.getElementById('node-' + id); if (n) n.classList.remove('wf-multi'); });
  wfSel.clear();
}

// Snapshot the given node ids + the connections *between* them (start node excluded).
function wfCollect(ids) {
  const g = editor.export();
  const mod = g.drawflow[Object.keys(g.drawflow)[0]] || { data: {} };
  const gd = mod.data || {};
  const keep = new Set(ids.map(String).filter(id => gd[id] && gd[id].name !== 'button_start'));
  const nodes = [...keep].map(id => ({ tmpid: id, name: gd[id].name, data: gd[id].data || {}, x: gd[id].pos_x, y: gd[id].pos_y }));
  const conns = [];
  keep.forEach(id => {
    Object.entries(gd[id].outputs || {}).forEach(([op, o]) => {
      (o.connections || []).forEach(c => {
        if (keep.has(String(c.node))) conns.push({ from: id, fromPort: op, to: String(c.node), toPort: c.output });
      });
    });
  });
  return { nodes, conns };
}

function wfCopySelected() {
  if (!editor) return;
  let ids = [...wfSel];
  if (!ids.length && editor.node_selected) ids = [editor.node_selected.id.replace('node-', '')];
  ids = ids.filter(id => { const n = editor.getNodeFromId(id); return n && n.name !== 'button_start'; });
  if (!ids.length) return toast('Select node(s) first — Shift/Ctrl-click to pick several.', 'err');
  const clip = wfCollect(ids);
  localStorage.setItem('foms_wf_clip', JSON.stringify(clip));
  toast(`Copied ${clip.nodes.length} node(s)${clip.conns.length ? ' + links' : ''} — paste anywhere`, 'ok');
}

function wfCopyFlow() {
  if (!editor) return;
  const g = editor.export();
  const mod = g.drawflow[Object.keys(g.drawflow)[0]] || { data: {} };
  const ids = Object.keys(mod.data || {}).filter(id => mod.data[id].name !== 'button_start');
  if (!ids.length) return toast('This flow has no nodes (besides the start node) to copy.', 'err');
  localStorage.setItem('foms_wf_clip', JSON.stringify(wfCollect(ids)));
  toast(`Copied the whole flow (${ids.length} node(s)) — paste into any button`, 'ok');
}

function wfPaste() {
  if (guard()) return;
  let clip = null;
  try { clip = JSON.parse(localStorage.getItem('foms_wf_clip') || 'null'); } catch (e) {}
  if (clip && clip.name && !clip.nodes) clip = { nodes: [{ tmpid: '1', name: clip.name, data: clip.data || {}, x: null, y: null }], conns: [] };  // legacy
  if (!clip || !clip.nodes || !clip.nodes.length) return toast('Nothing to paste — copy node(s) first.', 'err');
  const rect = document.getElementById('drawflow').getBoundingClientRect();
  const base = dfPos(rect.x + 90, rect.y + 80);
  const xs = clip.nodes.map(n => n.x).filter(v => v != null);
  const ys = clip.nodes.map(n => n.y).filter(v => v != null);
  const minx = xs.length ? Math.min(...xs) : 0, miny = ys.length ? Math.min(...ys) : 0;
  const idmap = {};
  clip.nodes.forEach((n, i) => {
    const data = Object.assign({}, n.data || {});
    const outs = n.name === 'if' ? 2 : n.name === 'switch' ? 4 : 1;
    const px = (n.x != null) ? base.x + (n.x - minx) : base.x + i * 28;
    const py = (n.y != null) ? base.y + (n.y - miny) : base.y + i * 28;
    idmap[n.tmpid] = editor.addNode(n.name, 1, outs, px, py, 'nd-' + n.name, data, nodeHtml(n.name, data));
  });
  (clip.conns || []).forEach(c => {
    if (idmap[c.from] != null && idmap[c.to] != null) {
      try { editor.addConnection(idmap[c.from], idmap[c.to], c.fromPort, c.toPort); } catch (e) {}
    }
  });
  wfClearSel();
  toast(`Pasted ${clip.nodes.length} node(s)`, 'ok');
}

function addStartNode() {
  const btn = buttonElements(schema).find(b => b.key === currentWfButton);
  const data = { label: btn ? btn.label : currentWfButton, key: currentWfButton };
  editor.addNode('button_start', 0, 1, 60, 140, 'nd-button_start', data, nodeHtml('button_start', data));
}
function switchWfButton() {
  if (currentWfButton != null) workflow[currentWfButton] = editor.export();
  currentWfButton = document.getElementById('wfButtonSelect').value;
  loadWfButton(currentWfButton);
}
function loadWfButton(key) {
  wfClearSel();
  editor.clear();
  const saved = workflow[key];
  if (saved && saved.drawflow) editor.import(saved); else addStartNode();
  editor.editor_mode = locked ? 'view' : 'edit';
}
function syncWorkflow() { if (wfInited && currentWfButton != null) workflow[currentWfButton] = editor.export(); }

// ---------------- Export (choose what to include) ----------------
document.getElementById('exportBtn').onclick = async () => {
  if (!locked) { try { await save(true); } catch (e) {} }   // export the latest working copy
  const opts = [
    ['schema', 'Form schema (design & layout)', true],
    ['workflow', 'Workflow (per-button flows)', true],
    ['lookups', 'Lookup tables + scheduled extracts', true],
    ['submissions', 'Submission data + email log (unique per form — optional)', false],
    ['versions', 'Published version history', false],
  ];
  const chosen = {}; opts.forEach(([k, , d]) => chosen[k] = d);
  const back = el('div', { class: 'modal-back show' });
  const body = el('div', { class: 'body' }, [el('p', { class: 'subtle', style: 'margin-top:0', text: 'Choose what to include in the export file:' })]);
  opts.forEach(([k, label, d]) => {
    const cb = el('input', { type: 'checkbox' }); cb.checked = d;
    cb.onchange = () => chosen[k] = cb.checked;
    body.appendChild(el('label', { class: 'checkbox-row', style: 'margin-bottom:8px' }, [cb, el('span', { text: label })]));
  });
  body.appendChild(el('p', { class: 'subtle', style: 'font-size:11px;margin:6px 0 0', text: 'Tip: keep “Form schema” ticked if you intend to import this file as a new form.' }));
  const close = () => back.remove();
  const proceed = async () => {
    if (!Object.values(chosen).some(Boolean)) return toast('Pick at least one section', 'err');
    const fname = (form.name || 'form').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') + '_export.json';
    await downloadBlob(`/api/forms/${FORM_ID}/export`, { include: chosen }, fname);
    toast('Form exported', 'ok'); close();
  };
  back.appendChild(el('div', { class: 'modal', style: 'width:480px' }, [
    el('h2', { text: 'Export form' }), body,
    el('div', { class: 'foot' }, [el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }), el('button', { class: 'btn primary', text: '⤓ Download', onclick: proceed })]),
  ]));
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.appendChild(back);
};

// ---------------- Save / Publish / Unpublish ----------------
document.getElementById('saveBtn').onclick = () => save();
async function save(silent) {
  syncWorkflow();
  await API.post(`/api/forms/${FORM_ID}/save`, { schema, workflow });
  if (!silent) toast('Saved', 'ok');
}

document.getElementById('publishBtn').onclick = async () => {
  await save(true);
  let migrate = false;
  if (form.versions.length > 0) {
    const res = await modal({
      title: 'Re-publish with changes', okLabel: 'Publish',
      bodyHtml: `<p class="subtle" style="margin-top:0">This form already has published versions. Choose how your schema/flow changes apply to <b>previously submitted</b> forms:</p>`,
      fields: [{ name: 'mode', label: 'Apply changes to', type: 'select', options: [
        { value: 'new', label: 'Only NEW submissions from now on (keep old ones on old schema)' },
        { value: 'all', label: 'ALL forms incl. previously submitted (migrate to new schema)' },
      ]}],
    });
    if (!res) return;
    migrate = res.mode === 'all';
  }
  const r = await API.post(`/api/forms/${FORM_ID}/publish`, { migrate });
  toast(`Published v${r.version_no}` + (r.migrated_submissions ? ` · migrated ${r.migrated_submissions}` : ''), 'ok');
  showPublishedOptions();
  await loadForm();
};

function showPublishedOptions() {
  modal({
    title: '🚀 Form Published', okLabel: 'New Form',
    bodyHtml: `<p class="subtle" style="margin-top:0">Your form is live. Where would you like to go?</p>
      <div class="flex" style="gap:10px;margin-top:10px">
        <a class="btn" href="/forms/${FORM_ID}/summary">☰ Summary Page</a>
        <a class="btn primary" href="/forms/${FORM_ID}/fill" target="_blank">↗ New Form</a>
      </div>`,
  }).then(r => { if (r !== null) window.open(`/forms/${FORM_ID}/fill`, '_blank'); });
}

document.getElementById('unpublishBtn').onclick = async () => {
  if (!await confirmModal('Unpublish form?', 'Editing will be re-enabled. The published version stays saved as a backup.', 'Unpublish')) return;
  await API.post(`/api/forms/${FORM_ID}/unpublish`, {});
  toast('Unpublished — you can edit now', 'ok');
  await loadForm();
};

loadForm();
