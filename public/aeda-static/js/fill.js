// ===================== Form fill (runtime) =====================
let rt = null, schema = null;
let data = {};          // current field values
let role = '', stage = '';
let editRef = EDIT_SUBMISSION || null;   // may be a UUID or numeric id
let submissionId = null;                 // resolved numeric id
let subUuid = '';                        // for display
let registry = [];      // [{el, section, node, input, kind}]

async function load() {
  rt = await API.get(`/api/aeda/forms/${FORM_ID}/runtime`);
  schema = rt.schema; schemaElements(schema);
  document.getElementById('formTitle').textContent = rt.form.name;
  document.getElementById('backLink').href = `/aeda/forms/${FORM_ID}/summary`;
  if (rt.form.status !== 'published') {
    const b = document.getElementById('statusBadge'); b.style.display = ''; b.textContent = 'draft preview'; b.className = 'badge draft';
  }

  const rs = document.getElementById('roleSelect');
  rs.innerHTML = '<option value="">— any —</option>' + schema.roles.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
  const roleParam = new URLSearchParams(location.search).get('role');
  if (roleParam && schema.roles.some(r => r.name === roleParam)) { role = roleParam; rs.value = roleParam; }
  rs.onchange = () => { role = rs.value; renderForm(); };
  const ss = document.getElementById('stageSelect');
  ss.innerHTML = '<option value="">— none —</option>' + schema.stages.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
  ss.onchange = () => { stage = ss.value; renderForm(); };

  if (editRef) {
    const sub = await API.get(`/api/aeda/submissions/resolve/${encodeURIComponent(editRef)}`);
    submissionId = sub.id; subUuid = sub.uuid || '';
    data = sub.data || {}; stage = sub.stage || ''; ss.value = stage;
  } else {
    fieldElements(schema).forEach(c => { if ((c.default ?? '') !== '' && (data[c.key] == null || data[c.key] === '')) data[c.key] = resolveTokens(c.default, data); });
  }

  document.getElementById('crumbs').innerHTML =
    `<a href="/aeda/projects/${rt.form.project_id}">${rt.project_name}</a> / <a href="/aeda/forms/${FORM_ID}/summary">${rt.form.name}</a> / <b>${subUuid ? 'Edit ' + subUuid.slice(0, 12) + '…' : 'New'}</b>`;

  document.getElementById('buttonBar').style.display = 'none';
  renderForm();
}

function buildInput(c, readonly) {
  const v = data[c.key] ?? '';
  let inp;
  if (c.type === 'textarea') { inp = el('textarea', { placeholder: c.placeholder || '' }); inp.value = v; }
  else if (c.type === 'select') {
    inp = el('select');
    inp.appendChild(el('option', { value: '', text: c.placeholder || '— select —' }));
    (c.options || []).forEach(o => inp.appendChild(el('option', { value: o, text: o })));
    inp.value = v;
  } else if (c.type === 'radio') {
    inp = el('div', { class: 'wrap-gap', 'data-key': c.key });
    (c.options || []).forEach(o => {
      const r = el('input', { type: 'radio', name: c.key, value: o }); if (v === o) r.checked = true;
      r.onchange = () => { data[c.key] = o; applyDynamic(); };
      inp.appendChild(el('label', { class: 'checkbox-row' }, [r, el('span', { text: o })]));
    });
    return inp;
  } else if (c.type === 'checkbox') {
    inp = el('input', { type: 'checkbox' }); inp.checked = (v === true || v === 'true' || v === 'Yes');
    inp.onchange = () => { data[c.key] = inp.checked ? 'Yes' : ''; applyDynamic(); };
    return el('label', { class: 'checkbox-row' }, [inp, el('span', { text: 'Yes' })]);
  } else if (c.type === 'file') {
    const fi = el('input', { type: 'file', 'data-key': c.key });
    fi.onchange = () => {
      const f = fi.files[0];
      if (!f) { data[c.key] = null; applyDynamic(); return; }
      const fr = new FileReader();
      fr.onload = () => { data[c.key] = { name: f.name, type: f.type, size: f.size, data: fr.result }; applyDynamic(); };
      fr.readAsDataURL(f);
    };
    const cont = el('div', {}, [fi]);
    if (v && v.name) cont.appendChild(el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px', text: 'Current: ' + v.name }));
    return cont;
  } else {
    inp = el('input', { type: c.type === 'number' ? 'number' : (c.type === 'date' ? 'date' : (c.type === 'email' ? 'email' : 'text')), placeholder: c.placeholder || '' });
    inp.value = v;
  }
  inp.setAttribute('data-key', c.key);
  if (!(c.calc || '').trim()) inp.oninput = () => { data[c.key] = inp.value; applyDynamic(); };
  return inp;
}

function widthClass(w) { return 'frm-cell w-' + (['half', 'third', 'quarter'].includes(w) ? w : 'full'); }

function makeFieldWrap(c, section) {
  const calc = (c.calc || '').trim();
  const inp = buildInput(c, false);
  const wrap = el('label', { class: 'field ' + widthClass(c.width), style: 'margin:0' }, [
    el('span', { html: c.label + (c.required ? ' <span style="color:var(--red)">*</span>' : '') + (calc ? ' <span class="pill" style="font-size:10px">calculated</span>' : '') }),
    inp,
  ]);
  registry.push({ el: c, section, node: wrap, input: inp, kind: 'field' });
  return wrap;
}

function makeButton(c, section) {
  const btn = el('button', { class: 'btn ' + (c.style === 'primary' ? 'primary' : ''), text: c.label, onclick: () => runButton(c) });
  if (c.color) { btn.style.background = c.color; btn.style.borderColor = c.color; btn.style.color = '#fff'; }
  const al = c.align === 'center' ? 'al-center' : c.align === 'right' ? 'al-right' : 'al-left';
  const wrap = el('div', { class: `btn-cell ${al} ${widthClass(c.width)}` }, [btn]);
  registry.push({ el: c, section, node: wrap, btn, kind: 'button' });
  return wrap;
}

function makeHeading(c, section) {
  const h = el('h3', { class: widthClass(c.width), text: c.label, style: 'margin:10px 0 0;border-bottom:1px solid var(--border);padding-bottom:6px' });
  registry.push({ el: c, section, node: h, kind: 'heading' });
  return h;
}

function renderChild(c, section, container) {
  if (c.type === 'http') return;   // API Fetch — behaviour-only, wired after render
  if (c.type === 'heading') container.appendChild(makeHeading(c, section));
  else if (c.type === 'button') container.appendChild(makeButton(c, section));
  else if (isContentType(c.type)) {
    // Shared builders live in common.js (also used by the designer Preview tab).
    const node = c.type === 'downloads' ? buildDownloads(c)
      : c.type === 'docview' ? buildDocView(c, data)
      : buildWmDownload(c, data);
    registry.push({ el: c, section, node, kind: 'content' });
    container.appendChild(node);
  }
  else container.appendChild(makeFieldWrap(c, section));
}

function renderForm() {
  const body = document.getElementById('formBody');
  body.innerHTML = ''; registry = [];
  schemaElements(schema).forEach(elx => {
    if (elx.type === 'section') {
      const box = el('div', { style: 'flex:0 0 100%;border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start' }, [
        el('div', { style: 'flex:0 0 100%;font-weight:700', text: elx.label }),
      ]);
      registry.push({ el: elx, section: null, node: box, kind: 'section' });
      (elx.children || []).forEach(ch => renderChild(ch, elx, box));
      body.appendChild(box);
    } else {
      renderChild(elx, null, body);
    }
  });
  applyDynamic();
  wireApiFetch();
}

// ---- In-form API Fetch: on Enter in the trigger field, call the endpoint and
// map the JSON response into the configured fields (no page reload, no toast). ----
function httpComponents() { return eachField(schema).map(x => x.el).filter(e => e.type === 'http'); }

function wireApiFetch() {
  httpComponents().forEach(comp => {
    if (!comp.trigger) return;
    const reg = registry.find(r => r.kind === 'field' && r.el.key === comp.trigger);
    if (!reg) return;
    const inp = reg.node.querySelector('[data-key]');
    if (!inp) return;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apiFetch(comp, reg); } });
    if (!reg.node.querySelector('.api-hint') && !reg.node.querySelector('.api-status')) {
      reg.node.appendChild(el('div', { class: 'subtle api-hint', style: 'font-size:11px;margin-top:4px', text: '↵ Press Enter to fetch & auto-fill' }));
    }
  });
}

function setApiStatus(reg, msg, isErr) {
  const hint = reg.node.querySelector('.api-hint'); if (hint) hint.remove();
  let s = reg.node.querySelector('.api-status');
  if (!s) { s = el('div', { class: 'subtle api-status', style: 'font-size:11px;margin-top:4px' }); reg.node.appendChild(s); }
  s.textContent = msg; s.style.color = isErr ? 'var(--red)' : 'var(--green)';
}

function syncInputsFromData() {
  registry.forEach(r => {
    if (r.kind !== 'field') return;
    const v = data[r.el.key];
    if (r.el.type === 'checkbox') { const c = r.node.querySelector('input[type=checkbox]'); if (c) c.checked = (v === 'Yes' || v === true); }
    else if (r.el.type === 'radio') { r.node.querySelectorAll('input[type=radio]').forEach(rd => rd.checked = (rd.value === v)); }
    else { const inp = r.node.querySelector('[data-key]'); if (inp && 'value' in inp) inp.value = (v == null ? '' : v); }
  });
}

async function apiFetch(comp, reg) {
  setApiStatus(reg, '⏳ Fetching…');
  let res;
  try { res = await API.post(`/api/aeda/forms/${FORM_ID}/http-fetch`, { key: comp.key, data }); }
  catch (e) { setApiStatus(reg, '⚠ ' + e.message, true); return; }
  if (!res.ok || res.json == null) { setApiStatus(reg, '⚠ ' + (res.error || ('No JSON returned (status ' + res.status + ')')), true); return; }
  const root = getByPath(res.json, comp.rootPath);
  let n = 0;
  (comp.mappings || []).forEach(m => {
    if (!m.field) return;
    const v = getByPath(root, m.path);
    if (v === undefined) return;
    data[m.field] = (v === null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
    n++;
  });
  syncInputsFromData();
  applyDynamic();
  setApiStatus(reg, `✓ Auto-filled ${n} field(s)`);
}

// Pre-fill mapped fields from uploaded lookup data when the key field matches.
function applyLookups() {
  (rt.lookups || []).forEach(lk => {
    const keyVal = String(data[lk.key_component] ?? '').trim();
    if (!keyVal) return;
    const row = (lk.rows || []).find(r => String(r[lk.key_column] ?? '').trim() === keyVal);
    if (!row) return;
    (lk.mappings || []).forEach(m => {
      if (m.comp && (m.col in row)) {
        data[m.comp] = row[m.col];
        const reg = registry.find(r => r.kind === 'field' && r.el.key === m.comp);
        if (reg) { const inp = reg.node.querySelector('[data-key]'); if (inp && 'value' in inp) inp.value = data[m.comp]; }
      }
    });
  });
}

// Live: recompute calc fields, then toggle visibility / read-only of everything.
function applyDynamic() {
  applyLookups();
  // 1) calculated values
  registry.forEach(r => {
    if (r.kind === 'field' && (r.el.calc || '').trim()) {
      const out = evalFormula(r.el.calc, data, data[r.el.key]);
      if (out !== undefined) {
        data[r.el.key] = out;
        const inp = r.node.querySelector('[data-key]');
        if (inp && 'value' in inp) inp.value = out;
      }
    }
  });
  // 2) visibility + read-only
  let anyBtnVisible = false;
  registry.forEach(r => {
    if (r.kind === 'section') {
      const vis = ruleVisible(r.el, role, stage) && evalFormula(r.el.visibleWhen, data) !== false;
      r.node.classList.toggle('is-hidden', !vis);
      return;
    }
    const vis = effVisibleFull(r.el, r.section, role, stage, data);
    r.node.classList.toggle('is-hidden', !vis);
    if (r.kind === 'button' && vis) { anyBtnVisible = true; r.btn.disabled = effReadonlyFull(r.el, r.section, role, stage, data); }
    if (r.kind === 'field') {
      const ro = effReadonlyFull(r.el, r.section, role, stage, data);
      r.node.querySelectorAll('input,select,textarea').forEach(inp => {
        if (inp.type === 'radio' || inp.type === 'checkbox') inp.disabled = ro;
        else { if (ro) inp.setAttribute('readonly', 'true'); else inp.removeAttribute('readonly'); }
        inp.style.opacity = ro ? '.65' : '';
      });
    }
  });
  const note = document.getElementById('noBtnNote');
  if (note) note.style.display = anyBtnVisible ? 'none' : '';
}

function hasValidateNode(key) {
  const g = (rt.workflow || {})[key];
  if (!g || !g.drawflow) return false;
  for (const mod of Object.values(g.drawflow)) {
    for (const n of Object.values(mod.data || {})) if (n.name === 'validate') return true;
  }
  return false;
}

function visibleFieldKeys() {
  return registry.filter(r => r.kind === 'field' && effVisibleFull(r.el, r.section, role, stage, data)).map(r => r.el.key);
}

// Validate currently-visible fields -> [{entry, message}]
function clientErrors() {
  const pairs = [];
  registry.forEach(r => {
    if (r.kind !== 'field') return;
    if (!effVisibleFull(r.el, r.section, role, stage, data)) return;   // skip hidden
    const m = validateField(r.el, data);
    if (m) pairs.push({ entry: r, message: m });
  });
  return pairs;
}

function clearFieldErrors() {
  registry.forEach(r => {
    if (r.kind === 'field') { r.node.classList.remove('invalid'); const e = r.node.querySelector('.field-error'); if (e) e.remove(); }
  });
  document.getElementById('errors').style.display = 'none';
}

function setFieldError(entry, msg) {
  entry.node.classList.add('invalid');
  let e = entry.node.querySelector('.field-error');
  if (!e) { e = el('div', { class: 'field-error' }); entry.node.appendChild(e); }
  e.textContent = msg;
}

// Show error pairs on their fields; unmatched messages go to the inline box.
function showErrorsOnFields(pairs, extra) {
  clearFieldErrors();
  pairs.forEach(p => setFieldError(p.entry, p.message));
  const box = document.getElementById('errors');
  if (extra && extra.length) { box.style.display = ''; box.innerHTML = '⚠ ' + extra.join('<br>'); }
  if (pairs.length) pairs[0].entry.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else if (extra && extra.length) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Map server error strings (e.g. "'Label' is required.") back to fields.
function mapServerErrors(strings) {
  const pairs = [], extra = [];
  (strings || []).forEach(s => {
    const r = registry.find(x => x.kind === 'field' && s.includes(`'${x.el.label}'`));
    if (r) pairs.push({ entry: r, message: s }); else extra.push(s);
  });
  return { pairs, extra };
}

async function runButton(b) {
  applyDynamic();
  clearFieldErrors();
  if (hasValidateNode(b.key)) {
    const pairs = clientErrors();
    if (pairs.length) { showErrorsOnFields(pairs); return; }   // block before hitting server
  }
  const payload = { button_key: b.key, data, role, stage, submission_id: submissionId, visible_keys: visibleFieldKeys() };
  if ((schema.emails || []).some(e => e.attachPdf) && window.jspdf) {
    payload.pdf_base64 = pdfBase64();
    payload.pdf_filename = (rt.form.name || 'form').replace(/\s+/g, '_') + '.pdf';
  }
  const res = await API.post(`/api/aeda/forms/${FORM_ID}/run-button`, payload);

  // Apply whatever the workflow changed — even if it stopped partway — so the
  // form's visibility / read-only / validation reflect the new state immediately.
  if (res.data) data = res.data;
  if (res.stage) { stage = res.stage; document.getElementById('stageSelect').value = stage; }
  if (res.saved_submission_id) submissionId = res.saved_submission_id;
  renderForm();

  if (res.errors && res.errors.length) {
    const { pairs, extra } = mapServerErrors(res.errors);
    showErrorsOnFields(pairs, extra);
    return;   // flow stopped — don't show dialogs
  }
  (res.dialogs || []).forEach(showDialog);
  if (res.navigate && res.navigate.url) {
    if (res.navigate.newtab) window.open(res.navigate.url, '_blank');
    else window.location.href = res.navigate.url;
  }
}

function pdfBase64() {
  try { return buildFormPdf(schema, data, { formName: rt.form.name, role, stage }).output('datauristring').split(',')[1]; }
  catch (e) { return null; }
}

function showDialog(spec) {
  const back = el('div', { class: 'modal-back show' });
  const foot = el('div', { class: 'foot' });
  (spec.buttons || []).filter(b => b.enabled).forEach(b => {
    const cls = b.action === 'navigate' ? 'btn primary' : 'btn';
    foot.appendChild(el('button', { class: cls, text: b.label, onclick: () => {
      if (b.action === 'navigate') { if (b.url) window.location.href = b.url; else toast('No URL configured on the Navigate button.', 'err'); }
      else if (b.action === 'closeTab') { back.remove(); window.open('', '_self'); window.close(); }
      else { back.remove(); }
    }}));
  });
  if (!foot.children.length) foot.appendChild(el('button', { class: 'btn', text: 'Close', onclick: () => back.remove() }));
  const m = el('div', { class: 'modal' }, [
    el('h2', { text: spec.header || 'Notice' }),
    el('div', { class: 'body' }, [el('div', { style: 'white-space:pre-wrap', text: spec.body || '' })]),
    foot,
  ]);
  back.appendChild(m);
  document.body.appendChild(back);
}

load();
