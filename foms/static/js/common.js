// Shared helpers: API client, toasts, modal, small DOM utilities.
const API = {
  async req(method, url, data) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (data !== undefined) opt.body = JSON.stringify(data);
    const r = await fetch(url, opt);
    let payload = null;
    try { payload = await r.json(); } catch (e) { payload = null; }
    if (!r.ok) {
      const msg = (payload && (payload.description || payload.error)) || r.statusText;
      const err = new Error(msg); err.status = r.status; err.payload = payload;
      throw err;
    }
    return payload;
  },
  get(u) { return this.req('GET', u); },
  post(u, d) { return this.req('POST', u, d); },
  put(u, d) { return this.req('PUT', u, d); },
  del(u) { return this.req('DELETE', u); },
};

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c == null) return;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
}

function toast(msg, kind = '') {
  let box = document.getElementById('toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.appendChild(box); }
  const t = el('div', { class: 'toast ' + kind, text: msg });
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

// Generic modal. fields: [{name,label,type,value,options,placeholder,required}]
// Returns a Promise resolving to the collected values, or null if cancelled.
function modal({ title, fields = [], okLabel = 'Save', bodyHtml = null }) {
  return new Promise(resolve => {
    const back = el('div', { class: 'modal-back show' });
    const body = el('div', { class: 'body' });
    const inputs = {};
    if (bodyHtml) body.innerHTML = bodyHtml;
    fields.forEach(f => {
      const wrap = el('label', { class: 'field' }, [el('span', { text: f.label })]);
      let inp;
      if (f.type === 'textarea') inp = el('textarea', { placeholder: f.placeholder || '' });
      else if (f.type === 'select') {
        inp = el('select');
        (f.options || []).forEach(o => inp.appendChild(el('option', { value: o.value, text: o.label })));
      } else inp = el('input', { type: f.type || 'text', placeholder: f.placeholder || '' });
      if (f.value != null) inp.value = f.value;
      inputs[f.name] = inp;
      wrap.appendChild(inp);
      body.appendChild(wrap);
    });
    const close = (val) => { back.remove(); resolve(val); };
    const okBtn = el('button', { class: 'btn primary', text: okLabel, onclick: () => {
      const out = {};
      for (const [k, v] of Object.entries(inputs)) out[k] = v.value;
      close(out);
    }});
    const modalEl = el('div', { class: 'modal' }, [
      el('h2', { text: title }),
      body,
      el('div', { class: 'foot' }, [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => close(null) }),
        okBtn,
      ]),
    ]);
    back.appendChild(modalEl);
    back.addEventListener('mousedown', e => { if (e.target === back) close(null); });
    document.body.appendChild(back);
    const first = Object.values(inputs)[0]; if (first) first.focus();
    modalEl.addEventListener('keydown', e => { if (e.key === 'Enter' && fields.length <= 1 && (!fields[0] || fields[0].type !== 'textarea')) okBtn.click(); });
  });
}

async function confirmModal(title, message, okLabel = 'Delete') {
  const res = await modal({ title, bodyHtml: `<p class="subtle" style="margin:0 0 6px">${message}</p>`, okLabel });
  return res !== null;
}

// ===================== Theme =====================
// Portal-wide colour themes. `system` follows the OS; the rest are explicit.
// The selected preference is stored in localStorage and applied on every page
// (an inline script in base.html applies it before paint to avoid a flash).
const THEMES = [
  { id: 'system', name: 'System default', desc: 'Match your OS setting',  swatch: ['#0f1220', '#f5f6fb', '#6366f1'] },
  { id: 'indigo', name: 'Indigo Night',   desc: 'Dark (default)',         swatch: ['#0f1220', '#1d2138', '#6366f1'] },
  { id: 'light',  name: 'Daylight',       desc: 'Light',                  swatch: ['#f5f6fb', '#ffffff', '#6366f1'] },
  { id: 'ocean',  name: 'Deep Ocean',     desc: 'Dark teal',              swatch: ['#071a24', '#0e2c3c', '#22d3ee'] },
  { id: 'forest', name: 'Forest',         desc: 'Dark green',             swatch: ['#0b1510', '#13291d', '#34d399'] },
  { id: 'rose',   name: 'Rosé',           desc: 'Warm dark',              swatch: ['#1a0f15', '#2c1925', '#fb7185'] },
];
const THEME_KEY = 'foms-theme';

function getThemePref() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { return 'system'; }
}
// Map a preference to the actual data-theme value to put on <html>.
function resolveTheme(pref) {
  if (pref === 'system') {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'indigo';
  }
  return pref;
}
function applyTheme(pref) {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
}

// Keep `system` in sync if the OS theme changes while the page is open.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getThemePref() === 'system') applyTheme('system');
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString();
}

function uid(prefix = 'id') { return prefix + '_' + Math.random().toString(36).slice(2, 9); }

// ---- Schema element model (sections / fields / buttons + rules) ----
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'email', 'select', 'radio', 'checkbox', 'file'];
// Content elements: carry designer-uploaded files but collect no data from the user.
const CONTENT_TYPES = ['downloads', 'docview', 'wmdownload'];
function isContentType(t) { return CONTENT_TYPES.includes(t); }
const WIDTHS = { full: '100%', half: '50%', third: '33.33%', quarter: '25%' };

// Replace {{token}} placeholders in watermark / reference text. Supports any
// form field key plus the special tokens _timestamp, _datetime, _date, _time.
function resolveTokens(text, data) {
  if (!text) return '';
  const now = new Date();
  const special = {
    _timestamp: now.toLocaleString(),
    _datetime: now.toLocaleString(),
    _now: now.toLocaleString(),
    _date: now.toLocaleDateString(),
    _time: now.toLocaleTimeString(),
    _uuid: (data && data.uuid) ? String(data.uuid) : '',
  };
  return String(text).replace(/\{\{?\s*([\w.\-]+)\s*\}?\}/g, (m, k) => {
    if (k in special) return special[k];
    const v = (data || {})[k];
    if (v == null || v === '') return '';
    return (typeof v === 'object') ? (v.name || '') : String(v);
  });
}

// ===================== File-based content components =====================
// Shared by the Fill page and the designer Preview/Test tab so both render
// identically. Each builder returns a DOM node; the caller registers it for
// visibility and passes the current data object (form values) for tokens.
function cWidthClass(w) { return 'frm-cell w-' + (['half', 'third', 'quarter'].includes(w) ? w : 'full'); }
function dataUrlToUint8(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function dataUrlToBlob(dataUrl) {
  const meta = String(dataUrl).split(',')[0] || '';
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  return new Blob([dataUrlToUint8(dataUrl)], { type: mime });
}
function saveBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = el('a', { href: u, download: name || 'download' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}
function isPdfFile(f) { return !!f && ((f.type || '').includes('pdf') || /\.pdf$/i.test(f.name || '')); }
function isImageFile(f) { return !!f && ((f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '')); }

// Watermark fonts → pdf-lib StandardFonts + CSS canvas fonts.
const WM_FONTS = {
  'Helvetica':      { pdf: 'Helvetica',     css: 'Helvetica, Arial, sans-serif',  weight: 'normal' },
  'Helvetica-Bold': { pdf: 'HelveticaBold', css: 'Helvetica, Arial, sans-serif',  weight: 'bold' },
  'Times-Roman':    { pdf: 'TimesRoman',    css: '"Times New Roman", Times, serif', weight: 'normal' },
  'Courier':        { pdf: 'Courier',       css: '"Courier New", monospace',      weight: 'normal' },
  'Courier-Bold':   { pdf: 'CourierBold',   css: '"Courier New", monospace',      weight: 'bold' },
};
function wmOptsFor(c, data) {
  return {
    text: resolveTokens(c.wmText || '', data) || 'CONFIDENTIAL',
    size: Math.max(8, Number(c.wmFontSize) || 28),
    font: WM_FONTS[c.wmFont] ? c.wmFont : 'Helvetica-Bold',
    rows: Math.min(3, Math.max(1, Number(c.wmRows) || 3)),
  };
}

// 1) Download Files — read-only downloads pre-uploaded by the designer.
function buildDownloads(c) {
  const wrap = el('div', { class: cWidthClass(c.width), style: 'flex:0 0 100%' }, [
    el('div', { style: 'font-weight:600;margin-bottom:6px', text: c.label }),
  ]);
  const list = el('div', { class: 'dl-list' });
  (c.files || []).forEach(f => list.appendChild(el('a', { class: 'btn sm', download: f.name, href: f.data, text: '⬇ ' + f.name })));
  if (!(c.files || []).length) list.appendChild(el('span', { class: 'subtle', text: 'No files available.' }));
  wrap.appendChild(list);
  return wrap;
}

// 2) Secure Viewer — view-only reference doc (no copy/download; tracing watermark).
function buildDocView(c, data) {
  const wrap = el('div', { class: cWidthClass(c.width), style: 'flex:0 0 100%' }, [
    el('div', { style: 'font-weight:600;margin-bottom:6px', text: c.label }),
  ]);
  const viewer = el('div', { class: 'secure-viewer' });
  const content = el('div', { class: 'secure-content', style: `max-height:${c.viewHeight || 480}px` });
  const wmText = resolveTokens(c.wmText || 'CONFIDENTIAL', data) || 'CONFIDENTIAL';
  const fmap = WM_FONTS[c.wmFont] || WM_FONTS['Helvetica-Bold'];
  const rows = Math.min(3, Math.max(1, Number(c.wmRows) || 3));
  const overlay = el('div', { class: 'secure-wm', 'aria-hidden': 'true',
    style: `font-size:${Math.max(8, Number(c.wmFontSize) || 28)}px;font-family:${fmap.css};font-weight:${fmap.weight}` });
  for (let r = 0; r < rows; r++) overlay.appendChild(el('div', { class: 'secure-wm-row', text: (wmText + '  ').repeat(6) }));
  viewer.appendChild(content);
  viewer.appendChild(overlay);
  ['contextmenu', 'dragstart', 'copy', 'cut', 'selectstart'].forEach(ev => viewer.addEventListener(ev, e => e.preventDefault()));
  renderSecureInto(c.file, content);
  wrap.appendChild(viewer);
  wrap.appendChild(el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px',
    text: 'View-only — copy and download are disabled. Note: screenshots cannot be technically prevented.' }));
  return wrap;
}

async function renderSecureInto(file, container) {
  if (!file || !file.data) { container.appendChild(el('div', { class: 'subtle', style: 'padding:20px', text: 'No document to display.' })); return; }
  try {
    if (isPdfFile(file)) {
      if (!window.pdfjsLib) throw new Error('viewer library not loaded');
      const pdf = await pdfjsLib.getDocument({ data: dataUrlToUint8(file.data) }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.4 });
        const canvas = el('canvas', { class: 'secure-page' });
        canvas.width = viewport.width; canvas.height = viewport.height;
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    } else if (isImageFile(file)) {
      const img = new Image();
      img.onload = () => {
        const cv = el('canvas', { class: 'secure-page' });
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        container.appendChild(cv);
      };
      img.src = file.data;
    } else {
      container.appendChild(el('div', { class: 'subtle', style: 'padding:20px', text: 'Preview is available for PDF and image files only.' }));
    }
  } catch (e) {
    container.appendChild(el('div', { class: 'subtle', style: 'padding:20px', text: 'Could not render document: ' + e.message }));
  }
}

// 3) Watermarked Download — download only; stamped with the resolved watermark.
function buildWmDownload(c, data) {
  const wrap = el('div', { class: cWidthClass(c.width), style: 'flex:0 0 100%' }, [
    el('div', { style: 'font-weight:600;margin-bottom:6px', text: c.label }),
  ]);
  if (!c.file || !c.file.data) {
    wrap.appendChild(el('span', { class: 'subtle', text: 'No file available.' }));
    return wrap;
  }
  const btn = el('button', { class: 'btn primary', text: '⬇ Download ' + c.file.name });
  btn.onclick = async () => {
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Preparing…';
    try { await downloadWatermarkedFile(c, data); }
    catch (e) { toast('Could not watermark file: ' + e.message, 'err'); }
    btn.disabled = false; btn.textContent = orig;
  };
  wrap.appendChild(btn);
  wrap.appendChild(el('div', { class: 'subtle', style: 'font-size:11px;margin-top:4px',
    text: 'Your download will be watermarked with: ' + (resolveTokens(c.wmText || '', data) || 'CONFIDENTIAL') }));
  return wrap;
}

async function downloadWatermarkedFile(c, data) {
  const f = c.file;
  const opts = wmOptsFor(c, data);
  if (isPdfFile(f)) {
    if (!window.PDFLib) throw new Error('PDF library not loaded');
    saveBlob(await watermarkPdf(f.data, opts), f.name);
  } else if (isImageFile(f)) {
    saveBlob(await watermarkImage(f.data, opts), (f.name.replace(/\.\w+$/, '') || 'file') + '.png');
  } else {
    toast('Watermarking supports PDF & images — downloading the original.', '');
    saveBlob(dataUrlToBlob(f.data), f.name);
  }
}

// Stamp up to opts.rows evenly-spaced diagonal rows of repeated text per page.
async function watermarkPdf(dataUrl, opts) {
  const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
  const doc = await PDFDocument.load(dataUrlToUint8(dataUrl));
  const fmap = WM_FONTS[opts.font] || WM_FONTS['Helvetica-Bold'];
  const font = await doc.embedFont(StandardFonts[fmap.pdf] || StandardFonts.HelveticaBold);
  const size = opts.size, text = opts.text;
  const tw = font.widthOfTextAtSize(text, size), gap = size * 2.5;
  doc.getPages().forEach(page => {
    const { width, height } = page.getSize();
    for (let r = 0; r < opts.rows; r++) {
      const y = height * (r + 1) / (opts.rows + 1) - size / 2;
      for (let x = -tw; x < width + tw; x += tw + gap) {
        page.drawText(text, { x, y, size, font, color: rgb(0.5, 0.5, 0.5), opacity: 0.2, rotate: degrees(30) });
      }
    }
  });
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

function watermarkImage(dataUrl, opts) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = el('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const fmap = WM_FONTS[opts.font] || WM_FONTS['Helvetica-Bold'];
      const size = opts.size;
      ctx.font = `${fmap.weight} ${size}px ${fmap.css}`;
      ctx.fillStyle = 'rgba(120,120,120,0.30)';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(opts.text).width, gap = size * 3;
      ctx.save();
      ctx.translate(cv.width / 2, cv.height / 2); ctx.rotate(-Math.PI / 6); ctx.translate(-cv.width / 2, -cv.height / 2);
      for (let r = 0; r < opts.rows; r++) {
        const y = cv.height * (r + 1) / (opts.rows + 1);
        for (let x = -tw; x < cv.width + tw; x += tw + gap) ctx.fillText(opts.text, x, y);
      }
      ctx.restore();
      cv.toBlob(b => b ? resolve(b) : reject(new Error('canvas export failed')), 'image/png');
    };
    img.onerror = () => reject(new Error('could not load image'));
    img.src = dataUrl;
  });
}

function blankRules() {
  return { visibleRoles: [], visibleStages: [], readonlyRoles: [], readonlyStages: [] };
}

// Returns the canonical ordered elements array, migrating legacy schemas
// (flat `components` + separate `buttons`) into the new tree in place.
function schemaElements(schema) {
  if (!schema.elements) {
    const els = [];
    (schema.components || []).forEach(c => {
      els.push(normalizeEl(c));
    });
    (schema.buttons || []).forEach(b => {
      els.push(normalizeEl({ ...b, type: 'button' }));
    });
    if (!els.length) els.push(normalizeEl({ id: uid('btn'), type: 'button', key: 'submit', label: 'Submit', style: 'primary' }));
    schema.elements = els;
    delete schema.components; delete schema.buttons;
  }
  schema.elements.forEach(normalizeEl);
  return schema.elements;
}

// Ensure an element has a rules object (migrating old visibleRoles/visibleStages)
// and a children array if it's a section.
function normalizeEl(el) {
  if (!el.rules) {
    el.rules = blankRules();
    if (el.visibleRoles) el.rules.visibleRoles = el.visibleRoles;
    if (el.visibleStages) el.rules.visibleStages = el.visibleStages;
  }
  el.rules.readonlyRoles ||= [];
  el.rules.readonlyStages ||= [];
  delete el.visibleRoles; delete el.visibleStages;
  // conditional (formula) rules — apply to fields, sections & buttons
  el.visibleWhen ||= '';
  el.readonlyWhen ||= '';
  // layout
  el.width ||= 'full';                 // full | half | third | quarter
  if (el.type === 'button') el.align ||= 'left';   // left | center | right
  if (el.pdf === undefined) el.pdf = true;         // include in generated PDF?
  if (el.type === 'section') { el.children ||= []; el.children.forEach(normalizeEl); }
  else if (el.type === 'http') {
    // in-form API Fetch component (behaviour, not a data field)
    el.method ||= 'GET'; el.url ??= ''; el.authtype ||= 'none';
    el.authuser ??= ''; el.authpass ??= ''; el.authtoken ??= '';
    el.headername ??= ''; el.headervalue ??= ''; el.bodytype ||= 'none'; el.body ??= '';
    el.trigger ??= ''; el.rootPath ??= ''; el.mappings ||= [];
  }
  else if (el.type === 'downloads') {
    // Files the form user may download (read-only). [{name,type,size,data}]
    el.files ||= [];
  }
  else if (el.type === 'docview') {
    // A single reference file shown view-only (no copy/download). Optional
    // tracing watermark overlay (wmText) supporting {{tokens}}.
    if (el.file === undefined) el.file = null;
    el.viewHeight ||= 480;
    el.wmText ??= '';
    el.wmFontSize ||= 28;
    el.wmFont ||= 'Helvetica-Bold';
    el.wmRows ||= 3;            // diagonal watermark rows (max 3)
  }
  else if (el.type === 'wmdownload') {
    // A single file the user may ONLY download; stamped with a watermark
    // (wmText) of static text and/or {{field}} / {{_timestamp}} tokens.
    if (el.file === undefined) el.file = null;
    el.wmText ??= '';
    el.wmFontSize ||= 28;
    el.wmFont ||= 'Helvetica-Bold';
    el.wmRows ||= 3;            // diagonal watermark rows per page (max 3)
  }
  else if (FIELD_TYPES.includes(el.type)) {
    el.default ??= '';
    el.calc ??= '';
    el.validation ||= {};
    const v = el.validation;
    v.preset ||= 'none'; v.regex ??= ''; v.minLength ??= ''; v.maxLength ??= '';
    v.formula ??= ''; v.message ??= '';
  }
  return el;
}

// ---- Formula / expression engine ----------------------------------------
// Designers reference other fields with {fieldKey}. Helpers available in
// expressions: len(x), num(x), isEmail(x), isNumber(x), matches(x, regex),
// upper(x), lower(x). `value` = the current field's value.
function evalFormula(expr, data, value) {
  if (expr == null || String(expr).trim() === '') return undefined;
  const code = String(expr).replace(/\{([\w.\-]+)\}/g, (m, k) => `(data[${JSON.stringify(k)}])`);
  try {
    const fn = new Function('data', 'value', `"use strict";
      const len = x => (x==null?0:String(x).length);
      const num = x => Number(x===''||x==null?0:x);
      const isEmail = x => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(x==null?'':x));
      const isNumber = x => x!=='' && x!=null && !isNaN(Number(x));
      const matches = (x,re) => { try { return new RegExp(re).test(String(x==null?'':x)); } catch(e){ return false; } };
      const upper = x => String(x==null?'':x).toUpperCase();
      const lower = x => String(x==null?'':x).toLowerCase();
      const now = () => new Date().toLocaleString();
      const today = () => new Date().toLocaleDateString();
      const nowTime = () => new Date().toLocaleTimeString();
      return (${code});`);
    return fn(data || {}, value);
  } catch (e) { console.warn('Formula error:', expr, e.message); return undefined; }
}

const VALIDATION_PRESETS = {
  none:    { label: 'None', regex: '' },
  email:   { label: 'Email address', regex: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
  digits:  { label: 'Numbers only', regex: '^[0-9]+$' },
  letters: { label: 'Letters only', regex: '^[A-Za-z ]+$' },
  alnum:   { label: 'Letters & numbers', regex: '^[A-Za-z0-9 ]+$' },
  phone10: { label: 'Phone — exactly 10 digits', regex: '^[0-9]{10}$' },
  custom:  { label: 'Custom regex…', regex: '' },
};

// label lookup + token preview ({{key}} / {key} -> [Label])
function labelForKey(schema, key) {
  const f = fieldElements(schema).find(x => x.key === key);
  return f ? f.label : null;
}
function tokenPreview(schema, text) {
  if (!text) return '';
  return String(text).replace(/\{\{?\s*([\w.\-]+)\s*\}?\}/g, (m, k) => {
    const lbl = labelForKey(schema, k);
    return lbl ? `[${lbl}]` : m;
  });
}

// Returns an error string, or null if the field value is valid.
function validateField(el, data) {
  const value = data[el.key];
  if (el.type === 'file') {
    const has = value && typeof value === 'object' && value.name;
    if (el.required && !has) return `'${el.label}' is required.`;
    return null;
  }
  const empty = value == null || String(value).trim() === '';
  if (el.required && empty) return `'${el.label}' is required.`;
  if (empty) return null;                       // optional + empty -> ok
  const s = String(value);
  const v = el.validation || {};
  // built-in by type
  if (el.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return `'${el.label}' must be a valid email address.`;
  if (el.type === 'number' && isNaN(Number(s))) return `'${el.label}' must be a number.`;
  // preset / regex
  let regex = '';
  if (v.preset && v.preset !== 'none' && v.preset !== 'custom') regex = (VALIDATION_PRESETS[v.preset] || {}).regex;
  else if (v.preset === 'custom') regex = v.regex || '';
  if (regex) { try { if (!new RegExp(regex).test(s)) return v.message || `'${el.label}' has an invalid format.`; } catch (e) {} }
  // length
  if (v.minLength && s.length < Number(v.minLength)) return v.message || `'${el.label}' must be at least ${v.minLength} characters.`;
  if (v.maxLength && s.length > Number(v.maxLength)) return v.message || `'${el.label}' must be at most ${v.maxLength} characters.`;
  // formula (must evaluate truthy)
  if (v.formula && String(v.formula).trim()) {
    if (evalFormula(v.formula, data, value) === false) return v.message || `'${el.label}' is invalid.`;
  }
  return null;
}

// Effective visibility/readonly = role/stage rules + section cascade + formulas.
function effVisibleFull(el, section, role, stage, data) {
  if (!effVisible(el, section, role, stage)) return false;
  if (section && evalFormula(section.visibleWhen, data) === false) return false;
  if (evalFormula(el.visibleWhen, data) === false) return false;
  return true;
}
function effReadonlyFull(el, section, role, stage, data) {
  if (effReadonly(el, section, role, stage)) return true;
  if (section && evalFormula(section.readonlyWhen, data) === true) return true;
  if (evalFormula(el.readonlyWhen, data) === true) return true;
  if (el.calc && String(el.calc).trim()) return true;   // calculated => read-only
  return false;
}

// Yields { el, section } for every field/heading element (descends sections).
function eachField(schema) {
  const out = [];
  schemaElements(schema).forEach(el => {
    if (el.type === 'section') (el.children || []).forEach(c => out.push({ el: c, section: el }));
    else out.push({ el, section: null });
  });
  return out;
}

function fieldElements(schema) { return eachField(schema).filter(x => FIELD_TYPES.includes(x.el.type)).map(x => x.el); }
function buttonElements(schema) { return eachField(schema).filter(x => x.el.type === 'button').map(x => x.el); }

// Build a styled PDF of a submission (only fields visible for role/stage/data).
// Requires jsPDF (window.jspdf) loaded on the page.
function buildFormPdf(schema, data, opts) {
  opts = opts || {};
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const M = 40, W = 515; let y = 52;
  const role = opts.role || '', stage = opts.stage || '';
  doc.setTextColor(20); doc.setFontSize(18); doc.setFont(undefined, 'bold');
  doc.text(opts.formName || 'Form', M, y); doc.setFont(undefined, 'normal');
  y += 8; doc.setDrawColor(210); doc.setLineWidth(1); doc.line(M, y, M + W, y); y += 18;

  // Inclusion is governed solely by the per-element "Include in PDF" flag,
  // which overrides form visibility rules (so internal fields can be excluded).
  const inPdf = (e) => e.pdf !== false;
  const field = (c, section) => {
    if (!inPdf(c)) return;
    let v = data[c.key]; if (v && typeof v === 'object' && v.name) v = '[file] ' + v.name;
    v = (v == null || v === '') ? '—' : String(v);
    if (y > 770) { doc.addPage(); y = 50; }
    doc.setFontSize(9); doc.setTextColor(110); doc.text(String(c.label), M, y + 14);
    doc.setFontSize(11); doc.setTextColor(20);
    const lines = doc.splitTextToSize(v, W); doc.text(lines, M, y + 29);
    y += 30 + lines.length * 14;
  };
  schemaElements(schema).forEach(elx => {
    if (elx.type === 'section') {
      if (!inPdf(elx)) return;
      if (y > 760) { doc.addPage(); y = 50; }
      y += 8; doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(17, 72, 122);
      doc.text(elx.label, M, y + 14); doc.setFont(undefined, 'normal');
      doc.setDrawColor(220); doc.setLineWidth(.5); doc.line(M, y + 20, M + W, y + 20); y += 32;
      (elx.children || []).forEach(ch => { if (FIELD_TYPES.includes(ch.type)) field(ch, elx); });
    } else if (elx.type === 'heading') {
      if (!inPdf(elx)) return;
      if (y > 760) { doc.addPage(); y = 50; }
      y += 8; doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.text(elx.label, M, y + 14);
      doc.setFont(undefined, 'normal'); y += 26;
    } else if (FIELD_TYPES.includes(elx.type)) {
      field(elx, null);
    }
  });
  return doc;
}

// Read a nested value from parsed JSON using a dotted path ("data.user.0.name").
// Empty path returns the object itself.
function getByPath(obj, path) {
  if (path == null || String(path).trim() === '') return obj;
  return String(path).trim().split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Display a stored value in a table cell (files show their name).
function cellValue(v) {
  if (v == null) return '';
  if (typeof v === 'object') return v.name ? ('📎 ' + v.name) : JSON.stringify(v);
  return String(v);
}

function ruleVisible(el, role, stage) {
  const r = (el && el.rules) || {};
  const vr = r.visibleRoles || [], vs = r.visibleStages || [];
  return (!vr.length || vr.includes(role)) && (!vs.length || vs.includes(stage));
}
function ruleReadonly(el, role, stage) {
  const r = (el && el.rules) || {};
  const rr = r.readonlyRoles || [], rs = r.readonlyStages || [];
  return (rr.length && rr.includes(role)) || (rs.length && rs.includes(stage));
}
// Effective rules combine the parent section with the element.
function effVisible(el, section, role, stage) {
  if (section && !ruleVisible(section, role, stage)) return false;
  return ruleVisible(el, role, stage);
}
function effReadonly(el, section, role, stage) {
  if (section && ruleReadonly(section, role, stage)) return true;
  return ruleReadonly(el, role, stage);
}
