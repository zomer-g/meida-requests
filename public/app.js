// Single-page portal: #/ requests (all boards or the user's own), #/b/<group> one board,
// #/r/<id> request, #/new or #/b/<group>/new new request, #/admin users, #/admin/groups,
// #/admin/log edit log, #/admin/access access log.

import { renderActivity } from './activity.js'; // activity feed panel on the request page

const view = document.getElementById('view');
let me = null;
let meta = null;
let boards = [];

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = `/xhost-auth/login?return_to=${encodeURIComponent(location.pathname + location.hash)}`; throw new Error('redirect'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `שגיאה ${res.status}`), { status: res.status, data });
  return data;
}

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('he-IL') : '');
const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');
const isAdmin = () => me.role === 'admin';

function statusPill(status) {
  const cls = status === 'Closed' ? 'closed' : status === 'סירוב' ? 'refused' : status === 'מידע התקבל' ? 'received' : '';
  const label = meta?.fields?.Status?.options?.find((o) => o.value === status)?.label || status || '—';
  return h('span', { class: `pill ${cls}` }, label === 'Closed' ? 'סגורה' : label === 'New' ? 'חדשה' : label);
}

function setActiveNav(hash) {
  for (const a of document.querySelectorAll('#nav > a:not(.button)')) {
    const href = a.getAttribute('href');
    const requests = href === '#/' && (hash === '#/' || hash.startsWith('#/r/') || hash.startsWith('#/b/'));
    a.classList.toggle('active', href === hash || requests);
  }
}

const boardById = (id) => boards.find((b) => b.id === id) || null;

// ---------- list ----------

const listState = { q: '', status: 'open', page: 0 };

async function renderList(boardId) {
  // Students and employees have exactly one board: their group's.
  if (!me.seesAll) boardId = me.group?.id ?? null;
  const board = boardById(boardId);
  if (!me.seesAll && !board) {
    return view.replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'לא הוגדרה לך קבוצה'),
      h('p', {}, 'כדי לראות בקשות, מנהל/ת המערכת צריך/ה לשייך אותך לקליניקה או לעובדי התנועה.')));
  }
  const statusOptions = meta.fields.Status?.options || [];
  const search = h('input', { type: 'search', placeholder: 'חיפוש לפי שם בקשה או מספר', value: listState.q, 'aria-label': 'חיפוש' });
  const status = h('select', { 'aria-label': 'סטטוס' },
    h('option', { value: 'open' }, 'בקשות פתוחות'),
    h('option', { value: 'all' }, 'כל הבקשות'),
    statusOptions.map((o) => h('option', { value: o.value }, o.value === 'Closed' ? 'סגורה' : o.value === 'New' ? 'חדשה' : o.label)));
  status.value = listState.status;
  const body = h('div', {}, h('p', { class: 'muted' }, 'טוען…'));
  const showBoard = me.seesAll && !board;

  const load = async () => {
    body.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
    const params = new URLSearchParams({ q: listState.q, status: listState.status, page: listState.page });
    if (board) params.set('board', board.id);
    try {
      const data = await api(`/requests?${params}`);
      if (!data.records.length) return body.replaceChildren(h('p', { class: 'notice' }, 'לא נמצאו בקשות.'));
      const rows = data.records.map((r) => h('tr', { onclick: () => { location.hash = `#/r/${r.Id}`; } },
        h('td', { class: 'num' }, r.CaseNumber),
        h('td', {}, h('a', { href: `#/r/${r.Id}` }, r.request_name__c || '(ללא שם)')),
        h('td', { class: 'hide-sm' }, r.request_org_name__r?.Name || ''),
        h('td', {}, statusPill(r.Status)),
        h('td', { class: 'hide-sm' }, r.metapel_bakasha__r?.Name || ''),
        showBoard ? h('td', { class: 'hide-sm' }, r.board || '') : null,
        me.seesAll ? h('td', { class: 'hide-sm' }, r.Owner?.Name || '') : null,
        h('td', { class: 'num hide-sm' }, fmtDate(r.request_date__c)),
        h('td', { class: 'num hide-sm' }, fmtDate(r.LastModifiedDate))));
      body.replaceChildren(
        h('div', { class: 'table-wrap card', style: 'padding:0' }, h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'מס׳'), h('th', {}, 'שם הבקשה'), h('th', { class: 'hide-sm' }, 'גוף מבוקש'), h('th', {}, 'סטטוס'),
            h('th', { class: 'hide-sm' }, 'מטפל/ת'), showBoard ? h('th', { class: 'hide-sm' }, 'לוח') : null,
            me.seesAll ? h('th', { class: 'hide-sm' }, 'בעלים') : null,
            h('th', { class: 'hide-sm' }, 'הוגשה'), h('th', { class: 'hide-sm' }, 'עודכנה'))),
          h('tbody', {}, rows))),
        h('div', { class: 'pager' },
          h('button', { class: 'button is-small', disabled: listState.page === 0, onclick: () => { listState.page--; load(); } }, '→ הקודם'),
          h('span', { class: 'muted' }, `עמוד ${listState.page + 1}`),
          h('button', { class: 'button is-small', disabled: !data.hasMore, onclick: () => { listState.page++; load(); } }, 'הבא ←')));
    } catch (e) {
      body.replaceChildren(h('p', { class: 'notice error' }, e.message));
    }
  };

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { listState.q = search.value.trim(); listState.page = 0; load(); }, 350); });
  status.addEventListener('change', () => { listState.status = status.value; listState.page = 0; load(); });

  const tabs = me.seesAll
    ? h('nav', { class: 'tabs', 'aria-label': 'לוחות' },
      h('a', { href: '#/', class: board ? null : 'active', onclick: () => { listState.page = 0; } }, 'כל הלוחות'),
      boards.map((b) => h('a', { href: `#/b/${b.id}`, class: board?.id === b.id ? 'active' : null, onclick: () => { listState.page = 0; } }, b.name)))
    : null;

  view.replaceChildren(
    h('div', { class: 'record-head' },
      h('div', {}, h('h1', {}, board ? `בקשות · ${board.name}` : 'בקשות חופש מידע'),
        h('p', { class: 'muted' }, board ? (board.kind === 'staff' ? 'הבקשות של עובדי התנועה (כל מי שאינו קליניקה)' : `הבקשות של ${board.name}`) : 'כל הבקשות בכל הלוחות')),
      h('a', { class: 'button is-primary', href: board ? `#/b/${board.id}/new` : '#/new' }, '+ בקשה חדשה')),
    ...(tabs ? [tabs] : []),
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, search), h('div', {}, status)),
    body);
  load();
}

// ---------- form fields ----------

// ctx.groupId: the request's group, which decides who may be picked as handler.
function lookupInput(f, value, ctx = {}) {
  const wrap = h('div', { class: 'lookup' });
  const isHandler = f.lookup === 'handler';
  const minChars = isHandler ? 0 : 2;
  let current = value; // { id, name } | null
  const render = () => {
    if (current?.id) {
      wrap.replaceChildren(h('div', { class: 'chosen' }, h('span', {}, current.name),
        h('button', { type: 'button', title: 'ניקוי', 'aria-label': `ניקוי ${f.label}`, onclick: () => { current = null; render(); wrap.querySelector('input')?.focus(); } }, '×')));
      return;
    }
    const input = h('input', { type: 'text', placeholder: isHandler ? 'בחירה מתוך חברי הקבוצה…' : 'הקלידו לפחות 2 תווים לחיפוש…', 'aria-label': f.label, autocomplete: 'off' });
    const list = h('ul', { hidden: true, role: 'listbox' });
    let timer;
    const search = async () => {
      const q = input.value.trim();
      if (q.length < minChars) { list.hidden = true; return; }
      try {
        const params = new URLSearchParams({ q });
        if (isHandler && ctx.groupId) params.set('group', ctx.groupId);
        const { records } = await api(`/lookup/${f.lookup}?${params}`);
        list.replaceChildren(...(records.length ? records.map((r) => h('li', { role: 'option', onmousedown: (e) => { e.preventDefault(); current = { id: r.id, name: r.name }; render(); } },
          r.name, r.sub ? h('small', {}, r.sub) : null)) : [h('li', { class: 'muted' }, isHandler ? 'אין בקבוצה משתמשים מקושרים לסיילספורס' : 'לא נמצאו תוצאות')]));
        list.hidden = false;
      } catch (e) { toast(e.message, true); }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
    if (isHandler) input.addEventListener('focus', search);
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    wrap.replaceChildren(input, list);
  };
  render();
  wrap.getValue = () => current?.id || null;
  return wrap;
}

function fieldControl(f, record, ctx) {
  const v = record?.[f.name] ?? null;
  const id = `f_${f.name}`;
  const disabled = record ? !f.updateable : !f.createable;
  let control;
  switch (f.type) {
    case 'textarea':
      control = h('textarea', { id, disabled, maxlength: f.length || null }, v ?? '');
      break;
    case 'picklist':
      control = h('select', { id, disabled }, h('option', { value: '' }, '— בחירה —'),
        f.options.map((o) => h('option', { value: o.value }, o.label)));
      control.value = v ?? '';
      if (v && control.value !== v) control.prepend(h('option', { value: v, selected: true }, v)); // inactive value
      break;
    case 'multipicklist': {
      const chosen = new Set(v ? v.split(';') : []);
      control = h('div', { class: 'multi', id }, f.options.map((o) => h('label', {}, h('input', { type: 'checkbox', value: o.value, checked: chosen.has(o.value), disabled }), o.label)));
      control.getValue = () => [...control.querySelectorAll('input:checked')].map((i) => i.value);
      break;
    }
    case 'boolean':
      control = h('input', { id, type: 'checkbox', checked: !!v, disabled });
      control.getValue = () => control.checked;
      break;
    case 'date':
      control = h('input', { id, type: 'date', value: v ?? '', disabled });
      break;
    case 'datetime': {
      const local = v ? new Date(new Date(v).getTime() - new Date(v).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
      control = h('input', { id, type: 'datetime-local', value: local, disabled });
      control.getValue = () => (control.value ? new Date(control.value).toISOString() : null);
      break;
    }
    case 'double': case 'int': case 'currency': case 'percent':
      control = h('input', { id, type: 'number', step: 'any', value: v ?? '', disabled, inputmode: 'decimal' });
      break;
    case 'url':
      control = h('input', { id, type: 'url', value: v ?? '', disabled, dir: 'ltr', maxlength: f.length || null });
      break;
    case 'reference': {
      const rel = record?.[f.name.replace(/__c$/, '__r')];
      control = lookupInput(f, v ? { id: v, name: rel?.Name || v } : null, ctx);
      break;
    }
    default:
      control = h('input', { id, type: 'text', value: v ?? '', disabled, maxlength: f.length || null });
  }
  if (!control.getValue) control.getValue = () => (control.value === '' ? null : control.value);
  const isCheck = f.type === 'boolean';
  const wrap = h('div', { class: `field${f.wide ? ' wide' : ''}${isCheck ? ' check' : ''}` },
    isCheck ? control : null,
    h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, '*') : null),
    isCheck ? null : control,
    f.help && !isCheck ? h('span', { class: 'help' }, f.help) : null);
  wrap.dataset.name = f.name;
  wrap.control = control;
  return wrap;
}

function buildForm(record, ctx) {
  const controls = [];
  const sections = meta.sections.map((s, i) => {
    const fields = s.fields.map((f) => { const c = fieldControl(f, record, ctx); controls.push(c); return c; });
    return h('details', { class: 'section card', open: i === 0 || null },
      h('summary', {}, h('h2', {}, s.title)),
      h('div', { class: 'form-grid' }, fields));
  });
  const values = () => Object.fromEntries(controls.map((c) => [c.dataset.name, c.control.getValue()]));
  return { sections, values };
}

// ---------- change log rendering (record history and admin log) ----------

const ACTIONS = {
  create: 'יצירת בקשה', update: 'עדכון בקשה',
  user_create: 'הוספת משתמש', user_update: 'עדכון משתמש', user_upsert: 'עדכון משתמש', user_delete: 'הסרת משתמש',
  group_create: 'הוספת קבוצה', group_update: 'עדכון קבוצה', import: 'ייבוא משתמשים',
  post: 'עדכון פעילות',
};

const shortValue = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
};

function changeList(a) {
  const c = a.changes || {};
  if (a.action === 'import') {
    const parts = [`נוספו ${c.added?.length || 0}`, `עודכנו ${c.updated?.length || 0}`, `שורות שגויות ${c.invalid?.length || 0}`];
    if (c.contactErrors?.length) parts.push(`ללא איש קשר ${c.contactErrors.length}`);
    return h('details', { class: 'changes' }, h('summary', {}, parts.join(' · ')),
      h('ul', {},
        (c.added || []).map((e) => h('li', { dir: 'ltr' }, `+ ${e}`)),
        (c.updated || []).map((e) => h('li', { dir: 'ltr' }, `~ ${e}`)),
        (c.invalid || []).map((r) => h('li', {}, `שורה ${r.line}: ${r.error} `, h('span', { dir: 'ltr' }, r.email || '')))));
  }
  const entries = Object.entries(c);
  if (!entries.length) return null;
  const structured = entries.every(([, v]) => v && typeof v === 'object' && 'to' in v);
  return h('ul', { class: 'changes' }, entries.map(([k, v]) => (structured
    ? h('li', {}, h('code', {}, v.label || meta.fields[k]?.label || k), ': ',
      a.action === 'create' ? null : [h('span', { class: 'from' }, shortValue(v.fromText ?? v.from)), ' ← '],
      h('span', { class: 'to' }, shortValue(v.toText ?? v.to)))
    : h('li', {}, h('code', {}, meta.fields[k]?.label || k), ': ', shortValue(v)))));
}

// ---------- record ----------

async function renderRecord(id) {
  view.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
  let data;
  try { data = await api(`/requests/${id}`); } catch (e) { return view.replaceChildren(h('p', { class: 'notice error' }, e.message), h('p', {}, h('a', { href: '#/' }, '→ חזרה לרשימה'))); }
  const r = data.record;
  const back = data.group && me.seesAll ? `#/b/${data.group.id}` : '#/';
  const form = buildForm(r, { groupId: data.group?.id });
  const save = h('button', { class: 'button is-primary', type: 'submit' }, 'שמירת שינויים');

  const onSubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const res = await api(`/requests/${r.Id}`, { method: 'PATCH', body: { fields: form.values() } });
      toast(res.changed ? `נשמרו ${res.changed} שינויים` : 'לא היו שינויים');
      if (res.changed) renderRecord(r.Id);
    } catch (err) { toast(err.message, true); } finally { save.disabled = false; }
  };

  const history = data.history.length
    ? h('ul', { class: 'history' }, data.history.map((a) => h('li', {},
      h('div', { class: 'when' }, `${fmtDateTime(a.at)} · ${a.email} · ${ACTIONS[a.action] || a.action}`),
      a.action === 'post' ? h('div', {}, a.changes?.files?.length ? `קבצים: ${a.changes.files.join(', ')}` : 'ללא קבצים') : null, // activity feed
      a.action === 'update' ? changeList(a) : null)))
    : h('p', { class: 'muted' }, 'אין עדיין שינויים מהפורטל.');

  view.replaceChildren(
    h('p', {}, h('a', { href: back }, '→ חזרה לרשימה')),
    h('div', { class: 'record-head' },
      h('div', {}, h('h1', {}, r.request_name__c || '(ללא שם)'),
        h('div', { class: 'meta' },
          h('span', {}, `בקשה מס׳ ${r.CaseNumber}`), statusPill(r.Status),
          data.group ? h('span', {}, `לוח: ${data.group.name}`) : null,
          h('span', {}, `בעלים: ${r.Owner?.Name || ''}`),
          h('span', {}, `נוצרה ${fmtDate(r.CreatedDate)}`),
          h('span', {}, `עודכנה ${fmtDateTime(r.LastModifiedDate)}`)))),
    h('form', { onsubmit: onSubmit, novalidate: true }, form.sections, h('div', { class: 'actions' }, save, h('a', { class: 'button', href: back }, 'ביטול'))),
    renderActivity(r.Id, { h, api, toast, fmtDateTime }), // activity feed (public/activity.js)
    h('section', { class: 'card' }, h('h2', {}, 'היסטוריית שינויים בפורטל'), history));
}

// ---------- new ----------

async function renderNew(boardId) {
  if (!me.seesAll) boardId = me.group?.id ?? null;
  let board = boardById(boardId);
  if (!me.seesAll && !board) { location.hash = '#/'; return; }
  const back = board && me.seesAll ? `#/b/${board.id}` : '#/';
  // Managers starting from "all boards" choose the board first; the handler picker depends on it.
  const boardSelect = me.seesAll
    ? h('select', { id: 'f_board' }, h('option', { value: '' }, '— בחירה —'), boards.map((b) => h('option', { value: b.id }, b.name)))
    : null;
  if (boardSelect && board) boardSelect.value = board.id;
  const ctx = { groupId: board?.id ?? null };
  const form = buildForm(null, ctx);
  const defaults = { Status: 'New', request_date__c: new Date().toISOString().slice(0, 10) };
  for (const [k, v] of Object.entries(defaults)) {
    const el = form.sections.flatMap((s) => [...s.querySelectorAll(`#f_${k}`)])[0];
    if (el) el.value = v;
  }
  const ownerNote = h('p', { class: 'muted' });
  const describeOwner = () => {
    if (!board) return ownerNote.replaceChildren('בחרו לוח. הבקשה תשויך לבעלים של הלוח שנבחר.');
    if (board.kind === 'clinic') return ownerNote.replaceChildren(`הבקשה תשויך ל${board.newOwnerName || board.name} בסיילספורס.`);
    if (board.newOwnerName) return ownerNote.replaceChildren(`הבקשה תשויך למשתמש הסיילספורס שלך: ${board.newOwnerName}.`);
    return ownerNote.replaceChildren(h('span', { class: 'notice error', style: 'display:block' }, 'לא שויך לך משתמש סיילספורס, ולכן אי אפשר לפתוח בקשה בלוח עובדי התנועה. יש לפנות לאדמין המערכת.'));
  };
  describeOwner();
  boardSelect?.addEventListener('change', () => { board = boardById(Number(boardSelect.value)); ctx.groupId = board?.id ?? null; describeOwner(); });

  const submit = h('button', { class: 'button is-primary', type: 'submit' }, 'יצירת הבקשה');
  const onSubmit = async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const res = await api('/requests', { method: 'POST', body: { fields: form.values(), boardId: board?.id ?? null } });
      toast(`נוצרה בקשה מס׳ ${res.caseNumber}`);
      location.hash = `#/r/${res.id}`;
    } catch (err) { toast(err.message, true); } finally { submit.disabled = false; }
  };
  view.replaceChildren(
    h('p', {}, h('a', { href: back }, '→ חזרה לרשימה')),
    h('h1', {}, board && !me.seesAll ? `בקשת מידע חדשה · ${board.name}` : 'בקשת מידע חדשה'),
    ownerNote,
    h('form', { onsubmit: onSubmit, novalidate: true },
      boardSelect ? h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', { for: 'f_board' }, 'לוח', h('span', { class: 'req' }, '*')), boardSelect)) : null,
      form.sections,
      h('div', { class: 'actions' }, submit, h('a', { class: 'button', href: back }, 'ביטול'))));
}

// ---------- admin: users ----------

async function readCsvFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1255').decode(buf); } // Hebrew Excel
}

function importCard(groups, onDone) {
  const group = h('select', { id: 'i_group' }, h('option', { value: '' }, '— בחירה —'), groups.map((g) => h('option', { value: g.id }, g.name)));
  const role = h('select', { id: 'i_role' }, h('option', { value: 'student' }, 'סטודנט'), h('option', { value: 'employee' }, 'עובד'));
  const file = h('input', { type: 'file', id: 'i_file', accept: '.csv,text/csv,text/plain' });
  const out = h('div');
  let text = null;

  const preview = async () => {
    out.replaceChildren();
    if (!file.files[0] || !group.value) return;
    text = await readCsvFile(file.files[0]);
    try {
      const p = await api('/admin/import/preview', { method: 'POST', body: { groupId: group.value, role: role.value, text } });
      const label = { new: 'חדש', update: 'עדכון', same: 'קיים', invalid: 'שגוי' };
      const go = h('button', { class: 'button is-primary', disabled: !(p.counts.new + p.counts.update) }, `ייבוא ${p.counts.new + p.counts.update} משתמשים ל${p.group.name}`);
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const r = await api('/admin/import', { method: 'POST', body: { groupId: group.value, role: role.value, text } });
          toast(`נוספו ${r.added}, עודכנו ${r.updated}${r.contactErrors.length ? `, ${r.contactErrors.length} בלי איש קשר בסיילספורס` : ''}`, r.contactErrors.length > 0);
          onDone();
        } catch (err) { toast(err.message, true); go.disabled = false; }
      });
      out.replaceChildren(
        h('p', {}, `${p.header ? 'שורת הכותרת דולגה. ' : ''}חדשים: ${p.counts.new} · עדכונים: ${p.counts.update} · קיימים ללא שינוי: ${p.counts.same} · שגויים (לא ייובאו): ${p.counts.invalid}`),
        h('div', { class: 'table-wrap', style: 'max-height:340px;overflow-y:auto' }, h('table', { class: 'plain' },
          h('thead', {}, h('tr', {}, h('th', {}, 'שורה'), h('th', {}, 'שם'), h('th', {}, 'מייל'), h('th', {}, 'מצב'), h('th', {}, 'הערה'))),
          h('tbody', {}, p.rows.map((r) => h('tr', { class: r.status === 'invalid' ? 'bad' : null },
            h('td', { class: 'num' }, r.line), h('td', {}, r.name), h('td', { dir: 'ltr' }, r.email),
            h('td', {}, h('span', { class: `pill ${r.status === 'invalid' ? 'refused' : r.status === 'new' ? 'received' : ''}` }, label[r.status])),
            h('td', {}, r.error || r.note || '')))))),
        h('div', { style: 'margin-top:14px' }, go));
    } catch (err) { out.replaceChildren(h('p', { class: 'notice error' }, err.message)); }
  };
  for (const el of [group, role, file]) el.addEventListener('change', preview);

  return h('div', { class: 'card' },
    h('h2', {}, 'ייבוא משתמשים מקובץ CSV'),
    h('p', { class: 'muted' }, 'עמודה ראשונה: שם, עמודה שנייה: כתובת מייל של Google. שורת כותרת מזוהה ומדלגים עליה. משתמש שכבר קיים יועבר לקבוצה שנבחרה (התפקיד שלו לא משתנה). לפני הייבוא תוצג תצוגה מקדימה.'),
    h('div', { class: 'form-grid' },
      h('div', { class: 'field' }, h('label', { for: 'i_group' }, 'קבוצה', h('span', { class: 'req' }, '*')), group),
      h('div', { class: 'field' }, h('label', { for: 'i_role' }, 'תפקיד למשתמשים חדשים'), role),
      h('div', { class: 'field wide' }, h('label', { for: 'i_file' }, 'קובץ CSV'), file)),
    out);
}

async function renderAdmin() {
  if (!isAdmin()) { location.hash = '#/'; return; }
  view.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
  const [{ users, envAdmins, roles }, { groups }, { records: owners }] = await Promise.all([api('/admin/users'), api('/admin/groups'), api('/admin/owners')]);
  const isStaffGroup = (id) => groups.find((g) => g.id === Number(id))?.kind === 'staff';
  // Staff users are mapped to their own Salesforce user (clinic users create under the clinic's).
  const clinicOwnerIds = new Set(groups.filter((g) => g.kind === 'clinic').flatMap((g) => g.sf_owner_ids));
  const staffOwners = owners.filter((o) => !clinicOwnerIds.has(o.id));
  const norm = (v) => String(v || '').replace(/["'׳״`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const suggestOwner = (mail, fullName) => staffOwners.find((o) => mail && norm(o.email) === norm(mail))
    || staffOwners.find((o) => fullName && norm(o.name) === norm(fullName)) || null;
  const ownerOptions = (sel) => [h('option', { value: '' }, '— לא שויך —'), ...staffOwners.map((o) => h('option', { value: o.id, selected: o.id === sel }, o.name))];
  const groupOptions = (sel) => [h('option', { value: '' }, '— ללא —'), ...groups.map((g) => h('option', { value: g.id, selected: g.id === sel }, g.name))];
  const roleOptions = (sel) => roles.map((r) => h('option', { value: r.value, selected: r.value === sel }, r.label));

  const email = h('input', { type: 'email', placeholder: 'name@gmail.com', required: true, dir: 'ltr', id: 'u_email' });
  const name = h('input', { type: 'text', id: 'u_name' });
  const role = h('select', { id: 'u_role' }, roleOptions('student'));
  const group = h('select', { id: 'u_group' }, groupOptions(null));
  const sfUser = h('select', { id: 'u_sfuser', disabled: true }, ownerOptions(null));
  const sfHint = h('span', { class: 'help' }, 'רק לעובדי התנועה: בקשות שהם פותחים יהיו בבעלות המשתמש הזה בסיילספורס.');
  const refreshSfUser = () => {
    sfUser.disabled = !isStaffGroup(group.value);
    if (sfUser.disabled) { sfUser.value = ''; return; }
    const s = suggestOwner(email.value.trim(), name.value);
    if (s && !sfUser.dataset.touched) {
      sfUser.value = s.id;
      sfHint.textContent = `הוצע לפי ${norm(s.email) === norm(email.value) ? 'המייל' : 'השם'}: ${s.name}. אפשר לשנות.`;
    }
  };
  for (const el of [email, name, group]) el.addEventListener('change', refreshSfUser);
  sfUser.addEventListener('change', () => { sfUser.dataset.touched = '1'; });

  const save = async (body, msg = 'המשתמש נשמר') => {
    try {
      const r = await api('/admin/users', { method: 'POST', body });
      toast(r.contactError ? `נשמר, אבל לא נוצר איש קשר בסיילספורס: ${r.contactError}` : msg, !!r.contactError);
    } catch (err) { toast(err.message, true); }
    renderAdmin();
  };
  const add = (e) => {
    e.preventDefault();
    save({ email: email.value, name: name.value, role: role.value, groupId: group.value, ...(isStaffGroup(group.value) ? { sfUserId: sfUser.value || null } : {}) });
  };
  const remove = async (u) => {
    if (!confirm(`להסיר את הגישה של ${u.email}? איש הקשר שלו בסיילספורס לא יימחק.`)) return;
    try { await api(`/admin/users/${encodeURIComponent(u.email)}`, { method: 'DELETE' }); toast('הגישה הוסרה'); renderAdmin(); } catch (err) { toast(err.message, true); }
  };
  const relink = async (u) => {
    try {
      const r = await api(`/admin/users/${encodeURIComponent(u.email)}/contact`, { method: 'POST' });
      toast(r.ok ? 'המשתמש קושר לאיש קשר' : r.contactError, !r.ok);
      renderAdmin();
    } catch (err) { toast(err.message, true); }
  };

  const filter = h('select', { 'aria-label': 'סינון לפי קבוצה' }, h('option', { value: '' }, 'כל הקבוצות'), groups.map((g) => h('option', { value: g.id }, g.name)));
  const tbody = h('tbody');
  const fill = () => {
    const shown = users.filter((u) => !filter.value || u.group_id === Number(filter.value));
    tbody.replaceChildren(
      ...envAdmins.filter((e) => !users.some((u) => u.email === e)).map((e) => h('tr', {}, h('td', { dir: 'ltr' }, e), h('td', {}, ''), h('td', {}, 'אדמין (קבוע בהגדרות)'), h('td', {}, ''), h('td', {}, ''), h('td', {}, ''), h('td', {}, ''))),
      ...shown.map((u) => {
        const envAdmin = envAdmins.includes(u.email);
        const rs = h('select', { 'aria-label': `תפקיד של ${u.email}`, disabled: envAdmin }, roleOptions(envAdmin ? 'admin' : u.role));
        const gs = h('select', { 'aria-label': `קבוצה של ${u.email}` }, groupOptions(u.group_id));
        rs.addEventListener('change', () => save({ email: u.email, role: rs.value, groupId: gs.value }, 'התפקיד עודכן'));
        gs.addEventListener('change', () => save({ email: u.email, role: u.role, groupId: gs.value }, 'הקבוצה עודכנה'));
        let sfCell = h('span', { class: 'muted' }, 'משתמש הקליניקה');
        if (isStaffGroup(u.group_id)) {
          const us = h('select', { 'aria-label': `משתמש סיילספורס של ${u.email}` }, ownerOptions(u.sf_user_id));
          us.addEventListener('change', () => save({ email: u.email, role: u.role, groupId: u.group_id, sfUserId: us.value || null }, 'משתמש הסיילספורס עודכן'));
          const s = !u.sf_user_id && suggestOwner(u.email, u.name);
          sfCell = h('div', { class: 'sf-user' }, us,
            u.sf_user_id ? null : h('span', { class: 'pill refused' }, 'לא שויך'),
            s ? h('button', { class: 'button is-small', type: 'button', onclick: () => save({ email: u.email, role: u.role, groupId: u.group_id, sfUserId: s.id }, `שויך ל${s.name}`) }, `שיוך ל${s.name} (הצעה)`) : null);
        }
        return h('tr', { class: 'static' },
          h('td', { dir: 'ltr' }, u.email), h('td', {}, u.name || ''), h('td', {}, rs), h('td', {}, gs), h('td', {}, sfCell),
          h('td', {}, u.sf_contact_id
            ? h('span', { class: 'pill received', title: u.sf_contact_id }, 'מקושר')
            : h('span', {}, h('span', { class: 'pill refused', title: u.contact_error || '' }, 'אין איש קשר'), ' ',
              h('button', { class: 'button is-small', onclick: () => relink(u) }, 'ניסיון חוזר'))),
          h('td', {}, h('button', { class: 'button is-small is-danger', onclick: () => remove(u) }, 'הסרה')));
      }));
  };
  filter.addEventListener('change', fill);
  fill();

  view.replaceChildren(
    h('h1', {}, 'ניהול משתמשים'),
    h('p', { class: 'muted' }, 'הכניסה היא עם חשבון Google. רק כתובות שמופיעות כאן יכולות להיכנס. סטודנטים ועובדים רואים רק את הלוח של הקבוצה שלהם; מנהלים ואדמינים רואים את כל הלוחות; רק אדמינים מנהלים משתמשים וקבוצות. לכל משתמש נוצר או מקושר איש קשר בסיילספורס (לפי המייל), כדי שאפשר יהיה לבחור בו כמטפל/ת בבקשה.'),
    h('form', { class: 'card', onsubmit: add },
      h('h2', {}, 'הוספה או עדכון'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: 'u_email' }, 'מייל Google', h('span', { class: 'req' }, '*')), email),
        h('div', { class: 'field' }, h('label', { for: 'u_name' }, 'שם'), name),
        h('div', { class: 'field' }, h('label', { for: 'u_role' }, 'תפקיד'), role),
        h('div', { class: 'field' }, h('label', { for: 'u_group' }, 'קבוצה', h('span', { class: 'req' }, '*')), group),
        h('div', { class: 'field' }, h('label', { for: 'u_sfuser' }, 'משתמש סיילספורס'), sfUser, sfHint)),
      h('div', { style: 'margin-top:14px' }, h('button', { class: 'button is-primary', type: 'submit' }, 'שמירה'))),
    importCard(groups, renderAdmin),
    h('div', { class: 'card table-wrap' },
      h('div', { class: 'card-head' }, h('h2', {}, `משתמשים עם גישה (${users.length})`), h('div', {}, filter)),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'מייל'), h('th', {}, 'שם'), h('th', {}, 'תפקיד'), h('th', {}, 'קבוצה'), h('th', {}, 'משתמש סיילספורס'), h('th', {}, 'איש קשר בסיילספורס'), h('th', {}, ''))),
        tbody)));
}

// ---------- admin: groups ----------

async function renderGroups() {
  if (!isAdmin()) { location.hash = '#/'; return; }
  view.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
  const [{ groups }, { records: owners }] = await Promise.all([api('/admin/groups'), api('/admin/owners')]);
  const clinicOwner = new Map(groups.filter((g) => g.kind === 'clinic').flatMap((g) => g.sf_owner_ids.map((id) => [id, g])));

  const groupForm = (g) => {
    const isStaff = g?.kind === 'staff';
    const key = g ? g.id : 'new';
    const name = h('input', { type: 'text', id: `g_name_${key}`, value: g?.name || '', required: true });
    const ownerIds = h('select', { id: `g_owners_${key}`, multiple: true, size: 6 },
      owners.filter((o) => !clinicOwner.has(o.id) || clinicOwner.get(o.id).id === g?.id)
        .map((o) => h('option', { value: o.id, selected: g?.sf_owner_ids?.includes(o.id) }, o.name)));
    const defaultOwner = h('select', { id: `g_default_${key}` }, h('option', { value: '' }, '— הראשון ברשימה —'),
      owners.map((o) => h('option', { value: o.id, selected: o.id === g?.default_owner_id }, o.name)));
    const submit = async (e) => {
      e.preventDefault();
      const body = { name: name.value, sf_owner_ids: [...ownerIds.selectedOptions].map((o) => o.value), default_owner_id: defaultOwner.value || null };
      try {
        await api(g ? `/admin/groups/${g.id}` : '/admin/groups', { method: g ? 'PATCH' : 'POST', body });
        toast('הקבוצה נשמרה');
        boards = (await api('/boards')).boards;
        renderGroups();
      } catch (err) { toast(err.message, true); }
    };
    return h('form', { class: 'card', onsubmit: submit },
      h('h2', {}, g ? g.name : 'הוספת קליניקה'),
      g ? h('p', { class: 'muted' }, `${isStaff ? 'עובדי התנועה: כל בקשה שהבעלים שלה אינו משתמש של קליניקה.' : 'קליניקה: הבקשות שהבעלים שלהן הוא אחד המשתמשים שנבחרו.'} ${g.members} משתמשים בקבוצה.`) : null,
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: `g_name_${key}` }, 'שם', h('span', { class: 'req' }, '*')), name),
        isStaff
          ? h('p', { class: 'help' }, 'בקשה חדשה בלוח הזה תהיה בבעלות משתמש הסיילספורס האישי של מי שפתח/ה אותה (משויך בעמוד המשתמשים).')
          : h('div', { class: 'field' }, h('label', { for: `g_default_${key}` }, 'בעלים לבקשות חדשות מהלוח'), defaultOwner,
            h('span', { class: 'help' }, 'כל חברי הקליניקה פותחים בקשות בבעלות המשתמש הזה. חייב להיות אחד המשתמשים של הקליניקה.')),
        isStaff ? null : h('div', { class: 'field wide' }, h('label', { for: `g_owners_${key}` }, 'משתמשי סיילספורס שהבקשות שלהם שייכות לקליניקה', h('span', { class: 'req' }, '*')), ownerIds,
          h('span', { class: 'help' }, 'Ctrl / Cmd ללחיצה על כמה משתמשים. משתמש יכול להשתייך לקליניקה אחת בלבד.'))),
      h('div', { style: 'margin-top:14px' }, h('button', { class: 'button is-primary', type: 'submit' }, g ? 'שמירה' : 'הוספת הקליניקה')));
  };

  view.replaceChildren(
    h('h1', {}, 'קבוצות ולוחות'),
    h('p', { class: 'muted' }, 'לכל קבוצה יש לוח בקשות משלה. בקשה שייכת לקליניקה לפי הבעלים שלה בסיילספורס; כל השאר שייכות לעובדי התנועה.'),
    ...groups.map((g) => groupForm(g)),
    groupForm(null));
}

// ---------- admin: log ----------

const logState = { email: '', case: '', action: '', from: '', to: '', page: 0 };

async function renderLog() {
  if (!isAdmin()) { location.hash = '#/'; return; }
  const email = h('select', { id: 'l_email' }, h('option', { value: '' }, 'כל המשתמשים'));
  const action = h('select', { id: 'l_action' }, h('option', { value: '' }, 'כל הפעולות'));
  const caseNo = h('input', { type: 'text', id: 'l_case', inputmode: 'numeric', value: logState.case, placeholder: 'למשל 12345' });
  const from = h('input', { type: 'date', id: 'l_from', value: logState.from });
  const to = h('input', { type: 'date', id: 'l_to', value: logState.to });
  const body = h('div', {}, h('p', { class: 'muted' }, 'טוען…'));
  let facetsFilled = false;

  const load = async () => {
    body.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
    const params = new URLSearchParams(Object.entries(logState).filter(([, v]) => v !== ''));
    try {
      const data = await api(`/admin/audit?${params}`);
      if (!facetsFilled) {
        email.append(...data.emails.map((e) => h('option', { value: e }, e)));
        action.append(...data.actions.map((a) => h('option', { value: a }, ACTIONS[a] || a)));
        email.value = logState.email; action.value = logState.action;
        facetsFilled = true;
      }
      if (!data.entries.length) return body.replaceChildren(h('p', { class: 'notice' }, 'אין רשומות שמתאימות לסינון.'));
      const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
      body.replaceChildren(
        h('p', { class: 'muted' }, `${data.total} רשומות`),
        h('div', { class: 'card table-wrap', style: 'padding:0' }, h('table', { class: 'log' },
          h('thead', {}, h('tr', {}, h('th', {}, 'מתי'), h('th', {}, 'מי'), h('th', {}, 'פעולה'), h('th', {}, 'בקשה / יעד'), h('th', { class: 'hide-sm' }, 'קבוצה'), h('th', {}, 'פירוט'))),
          h('tbody', {}, data.entries.map((a) => h('tr', { class: 'static' },
            h('td', { class: 'num' }, fmtDateTime(a.at)),
            h('td', { dir: 'ltr' }, a.email),
            h('td', {}, ACTIONS[a.action] || a.action),
            h('td', {}, a.case_id ? h('a', { href: `#/r/${a.case_id}` }, a.case_number || a.case_id) : h('span', { dir: 'auto' }, a.target || a.changes?.email || '')),
            h('td', { class: 'hide-sm' }, a.group_name || ''),
            h('td', {}, changeList(a))))))),
        h('div', { class: 'pager' },
          h('button', { class: 'button is-small', disabled: logState.page === 0, onclick: () => { logState.page--; load(); } }, '→ הקודם'),
          h('span', { class: 'muted' }, `עמוד ${logState.page + 1} מתוך ${pages}`),
          h('button', { class: 'button is-small', disabled: logState.page + 1 >= pages, onclick: () => { logState.page++; load(); } }, 'הבא ←')));
    } catch (e) { body.replaceChildren(h('p', { class: 'notice error' }, e.message)); }
  };

  const apply = () => {
    Object.assign(logState, { email: email.value, action: action.value, case: caseNo.value.replace(/\D/g, ''), from: from.value, to: to.value, page: 0 });
    load();
  };
  for (const el of [email, action, from, to]) el.addEventListener('change', apply);
  let timer;
  caseNo.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 400); });
  const reset = h('button', { class: 'button is-small', type: 'button', onclick: () => {
    Object.assign(logState, { email: '', case: '', action: '', from: '', to: '', page: 0 });
    email.value = ''; action.value = ''; caseNo.value = ''; from.value = ''; to.value = '';
    load();
  } }, 'ניקוי סינון');

  view.replaceChildren(
    h('h1', {}, 'יומן עריכות'),
    h('p', { class: 'muted' }, 'כל שינוי שנעשה דרך הפורטל: יצירה ועדכון של בקשות (שדה אחרי שדה, מה היה ומה נהיה), ניהול משתמשים וקבוצות וייבוא. מי נכנס ומה פתח מופיע ב',
      h('a', { href: '#/admin/access' }, 'יומן הגישה'), '.'),
    h('div', { class: 'card filters' },
      h('div', { class: 'field' }, h('label', { for: 'l_email' }, 'משתמש'), email),
      h('div', { class: 'field' }, h('label', { for: 'l_case' }, 'מספר בקשה'), caseNo),
      h('div', { class: 'field' }, h('label', { for: 'l_action' }, 'פעולה'), action),
      h('div', { class: 'field' }, h('label', { for: 'l_from' }, 'מתאריך'), from),
      h('div', { class: 'field' }, h('label', { for: 'l_to' }, 'עד תאריך'), to),
      h('div', { class: 'field reset' }, reset)),
    body);
  load();
}

// ---------- admin: access log ----------

const ACCESS_KINDS = { session: 'כניסה למערכת', read: 'צפייה', write: 'שינוי', denied: 'ניסיון שנדחה', error: 'שגיאה' };
const ACCESS_ACTIONS = {
  sign_in: 'כניסה (התחברות חדשה)', app_open: 'פתיחת הפורטל', app_config: 'טעינת הגדרות', list_requests: 'רשימת בקשות / לוח',
  view_request: 'צפייה בבקשה', update_request: 'עדכון בקשה', create_request: 'יצירת בקשה', view_activity: 'צפייה בעדכוני פעילות',
  post_activity: 'הוספת עדכון פעילות', download_file: 'הורדת קובץ', lookup: 'חיפוש לשדה בחירה',
  admin_users: 'ניהול משתמשים', admin_groups: 'ניהול קבוצות', admin_import: 'ייבוא משתמשים', admin_view_edit_log: 'צפייה ביומן העריכות',
  admin_view_access_log: 'צפייה ביומן הגישה', admin_other: 'ניהול', other: 'אחר',
};
const DENY_REASONS = { no_access: 'אין לו/ה גישה לפורטל', admin_only: 'עמוד לאדמין בלבד', outside_board: 'בקשה מחוץ ללוח שלו/ה', forbidden: 'אין הרשאה', not_signed_in: 'לא מחובר/ת' };

function uaShort(ua) {
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'אחר';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

const accessState = { email: '', kind: '', case: '', from: '', to: '', denied: false, page: 0 };

async function renderAccess() {
  if (!isAdmin()) { location.hash = '#/'; return; }
  const field = (id, label, control) => h('div', { class: 'field' }, h('label', { for: id }, label), control);
  const email = h('select', { id: 'a_email' }, h('option', { value: '' }, 'כל המשתמשים'));
  const kind = h('select', { id: 'a_kind' }, h('option', { value: '' }, 'כל הסוגים'), Object.entries(ACCESS_KINDS).map(([v, l]) => h('option', { value: v }, l)));
  const caseNo = h('input', { type: 'text', id: 'a_case', inputmode: 'numeric', autocomplete: 'off', 'aria-describedby': 'a_case_help' });
  const from = h('input', { type: 'date', id: 'a_from' });
  const to = h('input', { type: 'date', id: 'a_to' });
  const denied = h('input', { type: 'checkbox', id: 'a_denied' });
  const exportLink = h('a', { class: 'button is-small', download: true }, 'ייצוא ל-CSV');
  const summaryBody = h('div', {}, h('p', { class: 'muted' }, 'טוען…'));
  const resultsHeading = h('h2', { id: 'a_results', tabindex: '-1' }, 'ציר זמן');
  const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const body = h('div');

  const params = (withPage) => new URLSearchParams(Object.entries({ ...accessState, denied: accessState.denied ? '1' : '', page: withPage ? accessState.page : '' })
    .filter(([, v]) => v !== '' && v !== false && v !== null));
  const syncInputs = () => {
    email.value = accessState.email; kind.value = accessState.kind; caseNo.value = accessState.case;
    from.value = accessState.from; to.value = accessState.to; denied.checked = accessState.denied;
  };

  const loadSummary = async () => {
    try {
      const data = await api(`/admin/access/summary?${new URLSearchParams(Object.entries({ from: accessState.from, to: accessState.to }).filter(([, v]) => v))}`);
      email.replaceChildren(h('option', { value: '' }, 'כל המשתמשים'), ...data.users.map((u) => h('option', { value: u.email }, u.name ? `${u.name} (${u.email})` : u.email)));
      email.value = accessState.email;
      retention.textContent = `רשומות נשמרות ${data.retentionDays} ימים ונמחקות אוטומטית אחר כך.`;
      summaryBody.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'plain' },
        h('caption', { class: 'sr-only' }, 'סיכום פעילות לפי משתמש'),
        h('thead', {}, h('tr', {}, ['משתמש', 'תפקיד', 'קבוצה', 'נראה לאחרונה', 'כניסות', 'פעולות', 'ניסיונות שנדחו'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, data.users.map((u) => h('tr', { class: u.denied ? 'bad' : null },
          h('th', { scope: 'row' }, h('button', {
            type: 'button', class: 'linklike', 'aria-label': `הצגת ציר הזמן של ${u.name || u.email}`,
            onclick: () => { Object.assign(accessState, { email: u.email, page: 0 }); syncInputs(); loadTimeline(true); },
          }, u.name || u.email), u.name ? h('small', { dir: 'ltr', class: 'muted block' }, u.email) : null),
          h('td', {}, u.portalUser || u.role ? u.role || '' : h('span', { class: 'pill refused' }, 'לא משתמש/ת בפורטל')),
          h('td', {}, u.group || ''),
          h('td', { class: 'num' }, u.last_seen ? fmtDateTime(u.last_seen) : 'עדיין לא נכנס/ה'),
          h('td', { class: 'num' }, u.sessions), h('td', { class: 'num' }, u.actions),
          h('td', { class: 'num' }, u.denied ? h('strong', {}, u.denied) : 0)))))));
    } catch (e) { summaryBody.replaceChildren(h('p', { class: 'notice error' }, e.message)); }
  };

  const loadTimeline = async (focus = false) => {
    exportLink.href = `/api/admin/access.csv?${params(false)}`;
    status.textContent = 'טוען…';
    try {
      const data = await api(`/admin/access?${params(true)}`);
      const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
      status.textContent = `${data.total} רשומות${data.total ? ` · עמוד ${accessState.page + 1} מתוך ${pages}` : ''}`;
      if (!data.entries.length) body.replaceChildren(h('p', { class: 'notice' }, 'אין רשומות שמתאימות לסינון.'));
      else {
        body.replaceChildren(
          h('div', { class: 'card table-wrap', style: 'padding:0' }, h('table', { class: 'log plain' },
            h('caption', { class: 'sr-only' }, 'ציר זמן של כניסות ופעולות, מהחדש לישן'),
            h('thead', {}, h('tr', {}, ['מתי', 'מי', 'סוג', 'פעולה', 'בקשה', 'תוצאה', 'כתובת IP', 'דפדפן'].map((t, i) => h('th', { scope: 'col', class: i > 5 ? 'hide-sm' : null }, t)))),
            h('tbody', {}, data.entries.map((a) => h('tr', { class: a.kind === 'denied' ? 'bad' : null },
              h('td', { class: 'num' }, fmtDateTime(a.at)),
              h('td', { dir: 'ltr' }, a.email || ''),
              h('td', {}, h('span', { class: `pill ${a.kind === 'denied' || a.kind === 'error' ? 'refused' : a.kind === 'session' ? 'received' : ''}` }, ACCESS_KINDS[a.kind] || a.kind)),
              h('td', {}, ACCESS_ACTIONS[a.action] || a.action, a.route ? h('small', { class: 'muted block', dir: 'ltr' }, `${a.method || ''} ${a.route}`) : null),
              h('td', {}, a.case_id
                ? [h('a', { href: `#/r/${a.case_id}` }, a.case_number || 'בקשה'),
                  a.kind === 'write' && a.case_number ? h('small', { class: 'block' }, h('a', {
                    href: '#/admin/log', onclick: () => Object.assign(logState, { email: '', action: '', from: '', to: '', page: 0, case: String(a.case_number).replace(/^0+/, '') }),
                  }, 'פירוט השינויים')) : null]
                : ''),
              h('td', {}, a.kind === 'denied' ? DENY_REASONS[a.reason] || a.reason || 'נדחה' : a.status ? (a.status < 400 ? 'הצליח' : `שגיאה ${a.status}`) : ''),
              h('td', { class: 'hide-sm', dir: 'ltr' }, a.ip || ''),
              h('td', { class: 'hide-sm', title: a.user_agent || '' }, uaShort(a.user_agent))))))),
          h('nav', { class: 'pager', 'aria-label': 'דפדוף בציר הזמן' },
            h('button', { class: 'button is-small', type: 'button', disabled: accessState.page === 0, onclick: () => { accessState.page--; loadTimeline(true); } }, '→ הקודם'),
            h('span', { class: 'muted' }, `עמוד ${accessState.page + 1} מתוך ${pages}`),
            h('button', { class: 'button is-small', type: 'button', disabled: accessState.page + 1 >= pages, onclick: () => { accessState.page++; loadTimeline(true); } }, 'הבא ←')));
      }
    } catch (e) { status.textContent = ''; body.replaceChildren(h('p', { class: 'notice error', role: 'alert' }, e.message)); }
    if (focus) resultsHeading.focus();
  };

  const apply = (e) => {
    e.preventDefault();
    Object.assign(accessState, { email: email.value, kind: kind.value, case: caseNo.value.replace(/\D/g, ''), from: from.value, to: to.value, denied: denied.checked, page: 0 });
    loadSummary();
    loadTimeline(true);
  };
  const reset = () => {
    Object.assign(accessState, { email: '', kind: '', case: '', from: '', to: '', denied: false, page: 0 });
    syncInputs();
    loadSummary();
    loadTimeline(true);
  };
  const retention = h('span');

  view.replaceChildren(
    h('h1', {}, 'יומן גישה'),
    h('p', { class: 'muted' }, 'מי נכנס לפורטל, מתי, ומה פתח או עשה, כולל ניסיונות שנדחו (חשבון Google בלי גישה, בקשה מחוץ ללוח, עמוד אדמין). הפירוט שדה אחרי שדה של כל שינוי נמצא ב',
      h('a', { href: '#/admin/log' }, 'יומן העריכות'), '. ', retention),
    h('section', { class: 'card', 'aria-labelledby': 'a_summary' }, h('h2', { id: 'a_summary' }, 'סיכום לפי משתמש'), summaryBody),
    h('section', { 'aria-labelledby': 'a_results' },
      h('form', { class: 'card filters', role: 'search', 'aria-label': 'סינון יומן הגישה', onsubmit: apply },
        field('a_email', 'משתמש', email),
        field('a_kind', 'סוג אירוע', kind),
        h('div', { class: 'field' }, h('label', { for: 'a_case' }, 'מספר בקשה'), caseNo, h('span', { class: 'help', id: 'a_case_help' }, 'ספרות בלבד, למשל 15277')),
        field('a_from', 'מתאריך', from),
        field('a_to', 'עד תאריך', to),
        h('div', { class: 'field check' }, denied, h('label', { for: 'a_denied' }, 'רק ניסיונות שנדחו')),
        h('div', { class: 'field reset' }, h('div', { class: 'row-actions' },
          h('button', { class: 'button is-primary is-small', type: 'submit' }, 'סינון'),
          h('button', { class: 'button is-small', type: 'button', onclick: reset }, 'ניקוי'), exportLink))),
      h('div', { class: 'card-head' }, resultsHeading),
      status,
      body));
  syncInputs();
  loadSummary();
  loadTimeline();
}

// ---------- boot ----------

async function route() {
  const hash = location.hash || '#/';
  setActiveNav(hash);
  window.scrollTo(0, 0);
  try {
    let m;
    if (hash.startsWith('#/r/')) return await renderRecord(hash.slice(4));
    if ((m = hash.match(/^#\/b\/(\d+)\/new$/))) return await renderNew(Number(m[1]));
    if ((m = hash.match(/^#\/b\/(\d+)$/))) return await renderList(Number(m[1]));
    if (hash === '#/new') return await renderNew(null);
    if (hash === '#/admin') return await renderAdmin();
    if (hash === '#/admin/groups') return await renderGroups();
    if (hash === '#/admin/log') return await renderLog();
    if (hash === '#/admin/access') return await renderAccess();
    return await renderList(null);
  } catch (e) {
    if (e.message !== 'redirect') view.replaceChildren(h('p', { class: 'notice error' }, e.message));
  }
}

async function boot() {
  try {
    me = await api('/me');
  } catch (e) {
    if (e.status === 403) {
      view.replaceChildren(h('div', { class: 'card' },
        h('h1', {}, 'אין לך עדיין גישה'),
        h('p', {}, `נכנסת כ-${e.data?.email || ''}. כדי לקבל גישה, צרו קשר עם צוות התנועה לחופש המידע ובקשו שיוסיפו את הכתובת.`),
        h('a', { class: 'button', href: '/xhost-auth/logout?return_to=/' }, 'התנתקות')));
    } else if (e.message !== 'redirect') view.replaceChildren(h('p', { class: 'notice error' }, e.message));
    return;
  }
  const who = [me.name || me.email, me.roleLabel, me.seesAll ? null : me.group?.name].filter(Boolean).join(' · ');
  document.getElementById('who').replaceChildren(h('span', {}, `${who} · `), h('a', { href: '/xhost-auth/logout?return_to=/' }, 'התנתקות'));
  document.getElementById('nav').hidden = false;
  if (isAdmin()) for (const a of document.querySelectorAll('[data-admin]')) a.hidden = false;
  try {
    [meta, { boards }] = await Promise.all([api('/meta'), api('/boards')]);
  } catch (e) { return view.replaceChildren(h('p', { class: 'notice error' }, `לא ניתן לטעון את הגדרות סיילספורס: ${e.message}`)); }
  window.addEventListener('hashchange', route);
  route();
}

boot();
