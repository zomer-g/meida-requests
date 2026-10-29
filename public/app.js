// Single-page portal: #/ list, #/r/<id> request, #/new new request, #/admin users.

import { renderActivity } from './activity.js'; // activity feed panel on the request page

const view = document.getElementById('view');
let me = null;
let meta = null;

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

function statusPill(status) {
  const cls = status === 'Closed' ? 'closed' : status === 'סירוב' ? 'refused' : status === 'מידע התקבל' ? 'received' : '';
  const label = meta?.fields?.Status?.options?.find((o) => o.value === status)?.label || status || '—';
  return h('span', { class: `pill ${cls}` }, label === 'Closed' ? 'סגורה' : label === 'New' ? 'חדשה' : label);
}

function setActiveNav(hash) {
  for (const a of document.querySelectorAll('#nav > a:not(.button)')) {
    a.classList.toggle('active', a.getAttribute('href') === hash || (hash.startsWith('#/r/') && a.getAttribute('href') === '#/'));
  }
}

// ---------- list ----------

const listState = { q: '', status: 'open', page: 0 };

async function renderList() {
  const statusOptions = meta.fields.Status?.options || [];
  const search = h('input', { type: 'search', placeholder: 'חיפוש לפי שם בקשה או מספר', value: listState.q, 'aria-label': 'חיפוש' });
  const status = h('select', { 'aria-label': 'סטטוס' },
    h('option', { value: 'open' }, 'בקשות פתוחות'),
    h('option', { value: 'all' }, 'כל הבקשות'),
    statusOptions.map((o) => h('option', { value: o.value }, o.value === 'Closed' ? 'סגורה' : o.value === 'New' ? 'חדשה' : o.label)));
  status.value = listState.status;
  const body = h('div', {}, h('p', { class: 'muted' }, 'טוען…'));

  const load = async () => {
    body.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
    const params = new URLSearchParams({ q: listState.q, status: listState.status, page: listState.page });
    try {
      const data = await api(`/requests?${params}`);
      if (!data.records.length) return body.replaceChildren(h('p', { class: 'notice' }, 'לא נמצאו בקשות.'));
      const rows = data.records.map((r) => h('tr', { onclick: () => { location.hash = `#/r/${r.Id}`; } },
        h('td', { class: 'num' }, r.CaseNumber),
        h('td', {}, h('a', { href: `#/r/${r.Id}` }, r.request_name__c || '(ללא שם)')),
        h('td', { class: 'hide-sm' }, r.request_org_name__r?.Name || ''),
        h('td', {}, statusPill(r.Status)),
        h('td', { class: 'hide-sm' }, r.metapel_bakasha__r?.Name || ''),
        me.role === 'admin' ? h('td', { class: 'hide-sm' }, r.Owner?.Name || '') : null,
        h('td', { class: 'num hide-sm' }, fmtDate(r.request_date__c)),
        h('td', { class: 'num hide-sm' }, fmtDate(r.LastModifiedDate))));
      body.replaceChildren(
        h('div', { class: 'table-wrap card', style: 'padding:0' }, h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'מס׳'), h('th', {}, 'שם הבקשה'), h('th', { class: 'hide-sm' }, 'גוף מבוקש'), h('th', {}, 'סטטוס'),
            h('th', { class: 'hide-sm' }, 'מטפל/ת'), me.role === 'admin' ? h('th', { class: 'hide-sm' }, 'בעלים') : null,
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

  view.replaceChildren(
    h('div', { class: 'record-head' },
      h('div', {}, h('h1', {}, 'בקשות חופש מידע'),
        h('p', { class: 'muted' }, me.role === 'admin' ? 'כל הבקשות בארגון' : `הבקשות של ${me.ownerName || 'הקליניקה'}`)),
      h('a', { class: 'button is-primary', href: '#/new' }, '+ בקשה חדשה')),
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, search), h('div', {}, status)),
    body);
  load();
}

// ---------- form fields ----------

function lookupInput(f, value) {
  const wrap = h('div', { class: 'lookup' });
  let current = value; // { id, name } | null
  const render = () => {
    if (current?.id) {
      wrap.replaceChildren(h('div', { class: 'chosen' }, h('span', {}, current.name),
        h('button', { type: 'button', title: 'ניקוי', 'aria-label': `ניקוי ${f.label}`, onclick: () => { current = null; render(); wrap.querySelector('input')?.focus(); } }, '×')));
      return;
    }
    const input = h('input', { type: 'text', placeholder: 'הקלידו לפחות 2 תווים לחיפוש…', 'aria-label': f.label, autocomplete: 'off' });
    const list = h('ul', { hidden: true, role: 'listbox' });
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) { list.hidden = true; return; }
        try {
          const { records } = await api(`/lookup/${f.lookup}?q=${encodeURIComponent(q)}`);
          list.replaceChildren(...(records.length ? records.map((r) => h('li', { role: 'option', onmousedown: (e) => { e.preventDefault(); current = { id: r.id, name: r.name }; render(); } },
            r.name, r.sub ? h('small', {}, r.sub) : null)) : [h('li', { class: 'muted' }, 'לא נמצאו תוצאות')]));
          list.hidden = false;
        } catch (e) { toast(e.message, true); }
      }, 300);
    });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    wrap.replaceChildren(input, list);
  };
  render();
  wrap.getValue = () => current?.id || null;
  return wrap;
}

function fieldControl(f, record) {
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
      control = lookupInput(f, v ? { id: v, name: rel?.Name || v } : null);
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

function buildForm(record) {
  const controls = [];
  const sections = meta.sections.map((s, i) => {
    const fields = s.fields.map((f) => { const c = fieldControl(f, record); controls.push(c); return c; });
    return h('details', { class: 'section card', open: i === 0 || null },
      h('summary', {}, h('h2', {}, s.title)),
      h('div', { class: 'form-grid' }, fields));
  });
  const values = () => Object.fromEntries(controls.map((c) => [c.dataset.name, c.control.getValue()]));
  return { sections, values };
}

// ---------- record ----------

async function renderRecord(id) {
  view.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
  let data;
  try { data = await api(`/requests/${id}`); } catch (e) { return view.replaceChildren(h('p', { class: 'notice error' }, e.message), h('p', {}, h('a', { href: '#/' }, '→ חזרה לרשימה'))); }
  const r = data.record;
  const form = buildForm(r);
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
      h('div', { class: 'when' }, `${fmtDateTime(a.at)} · ${a.email} · ${a.action === 'create' ? 'יצירה' : 'עדכון'}`),
      a.action === 'update' ? h('div', {}, Object.keys(a.changes || {}).map((k) => h('code', {}, meta.fields[k]?.label || k)).flatMap((x, i) => (i ? [', ', x] : [x]))) : null)))
    : h('p', { class: 'muted' }, 'אין עדיין שינויים מהפורטל.');

  view.replaceChildren(
    h('p', {}, h('a', { href: '#/' }, '→ חזרה לרשימה')),
    h('div', { class: 'record-head' },
      h('div', {}, h('h1', {}, r.request_name__c || '(ללא שם)'),
        h('div', { class: 'meta' },
          h('span', {}, `בקשה מס׳ ${r.CaseNumber}`), statusPill(r.Status),
          h('span', {}, `בעלים: ${r.Owner?.Name || ''}`),
          h('span', {}, `נוצרה ${fmtDate(r.CreatedDate)}`),
          h('span', {}, `עודכנה ${fmtDateTime(r.LastModifiedDate)}`)))),
    h('form', { onsubmit: onSubmit, novalidate: true }, form.sections, h('div', { class: 'actions' }, save, h('a', { class: 'button', href: '#/' }, 'ביטול'))),
    renderActivity(r.Id, { h, api, toast, fmtDateTime }), // activity feed (public/activity.js)
    h('section', { class: 'card' }, h('h2', {}, 'היסטוריית שינויים בפורטל'), history));
}

// ---------- new ----------

async function renderNew() {
  const form = buildForm(null);
  const defaults = { Status: 'New', request_date__c: new Date().toISOString().slice(0, 10) };
  for (const [k, v] of Object.entries(defaults)) {
    const el = form.sections.flatMap((s) => [...s.querySelectorAll(`#f_${k}`)])[0];
    if (el) el.value = v;
  }
  let ownerSelect = null;
  if (me.role === 'admin') {
    ownerSelect = h('select', { id: 'f_owner' }, h('option', { value: '' }, '— אני (משתמש ה-API) —'));
    api('/admin/owners').then(({ records }) => ownerSelect.append(...records.map((u) => h('option', { value: u.id }, u.name)))).catch(() => {});
  }
  const submit = h('button', { class: 'button is-primary', type: 'submit' }, 'יצירת הבקשה');
  const onSubmit = async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const res = await api('/requests', { method: 'POST', body: { fields: form.values(), ownerId: ownerSelect?.value || null } });
      toast(`נוצרה בקשה מס׳ ${res.caseNumber}`);
      location.hash = `#/r/${res.id}`;
    } catch (err) { toast(err.message, true); } finally { submit.disabled = false; }
  };
  view.replaceChildren(
    h('p', {}, h('a', { href: '#/' }, '→ חזרה לרשימה')),
    h('h1', {}, 'בקשת מידע חדשה'),
    h('p', { class: 'muted' }, me.role === 'admin' ? 'הבקשה תשויך לבעלים שתבחרו.' : `הבקשה תשויך ל${me.ownerName || 'קליניקה שלך'}.`),
    h('form', { onsubmit: onSubmit, novalidate: true },
      ownerSelect ? h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', { for: 'f_owner' }, 'בעלי הבקשה בסיילספורס'), ownerSelect)) : null,
      form.sections,
      h('div', { class: 'actions' }, submit, h('a', { class: 'button', href: '#/' }, 'ביטול'))));
}

// ---------- admin ----------

async function renderAdmin() {
  if (me.role !== 'admin') { location.hash = '#/'; return; }
  view.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
  const [{ users, envAdmins }, { records: owners }, { entries }] = await Promise.all([api('/admin/users'), api('/admin/owners'), api('/admin/audit')]);

  const email = h('input', { type: 'email', placeholder: 'name@gmail.com', required: true, dir: 'ltr', id: 'u_email' });
  const name = h('input', { type: 'text', id: 'u_name' });
  const role = h('select', { id: 'u_role' }, h('option', { value: 'clinic' }, 'קליניקה / מטפל'), h('option', { value: 'admin' }, 'מנהל (רואה הכל)'));
  const owner = h('select', { id: 'u_owner' }, h('option', { value: '' }, '— בחירה —'), owners.map((o) => h('option', { value: o.id }, o.name)));
  role.addEventListener('change', () => { owner.disabled = role.value === 'admin'; });

  const add = async (e) => {
    e.preventDefault();
    try {
      await api('/admin/users', { method: 'POST', body: { email: email.value, name: name.value, role: role.value, ownerId: owner.value } });
      toast('המשתמש נשמר');
      renderAdmin();
    } catch (err) { toast(err.message, true); }
  };
  const remove = async (u) => {
    if (!confirm(`להסיר את הגישה של ${u.email}?`)) return;
    try { await api(`/admin/users/${encodeURIComponent(u.email)}`, { method: 'DELETE' }); toast('הגישה הוסרה'); renderAdmin(); } catch (err) { toast(err.message, true); }
  };

  view.replaceChildren(
    h('h1', {}, 'ניהול משתמשים'),
    h('p', { class: 'muted' }, 'הכניסה היא עם חשבון Google. רק כתובות שמופיעות כאן יכולות להיכנס. משתמש קליניקה רואה ומעדכן רק בקשות שהבעלים שלהן בסיילספורס הוא הקליניקה שלו.'),
    h('form', { class: 'card', onsubmit: add },
      h('h2', {}, 'הוספה או עדכון'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: 'u_email' }, 'מייל Google', h('span', { class: 'req' }, '*')), email),
        h('div', { class: 'field' }, h('label', { for: 'u_name' }, 'שם'), name),
        h('div', { class: 'field' }, h('label', { for: 'u_role' }, 'הרשאה'), role),
        h('div', { class: 'field' }, h('label', { for: 'u_owner' }, 'קליניקה (בעלי הבקשות בסיילספורס)'), owner)),
      h('div', { style: 'margin-top:14px' }, h('button', { class: 'button is-primary', type: 'submit' }, 'שמירה'))),
    h('div', { class: 'card table-wrap' },
      h('h2', {}, 'משתמשים עם גישה'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'מייל'), h('th', {}, 'שם'), h('th', {}, 'הרשאה'), h('th', {}, 'קליניקה'), h('th', {}, ''))),
        h('tbody', {},
          envAdmins.map((e) => h('tr', {}, h('td', { dir: 'ltr' }, e), h('td', {}, ''), h('td', {}, 'מנהל (קבוע בהגדרות)'), h('td', {}, ''), h('td', {}, ''))),
          users.map((u) => h('tr', {}, h('td', { dir: 'ltr' }, u.email), h('td', {}, u.name || ''), h('td', {}, u.role === 'admin' ? 'מנהל' : 'קליניקה'),
            h('td', {}, u.sf_owner_name || ''), h('td', {}, h('button', { class: 'button is-small is-danger', onclick: () => remove(u) }, 'הסרה'))))))),
    h('div', { class: 'card table-wrap' },
      h('h2', {}, 'פעילות אחרונה'),
      entries.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'מתי'), h('th', {}, 'מי'), h('th', {}, 'פעולה'), h('th', {}, 'בקשה'))),
        h('tbody', {}, entries.map((a) => h('tr', { onclick: a.case_id ? () => { location.hash = `#/r/${a.case_id}`; } : null },
          h('td', { class: 'num' }, fmtDateTime(a.at)), h('td', { dir: 'ltr' }, a.email),
          h('td', {}, { create: 'יצירת בקשה', update: 'עדכון בקשה', user_upsert: 'עדכון משתמש', user_delete: 'הסרת משתמש' }[a.action] || a.action),
          h('td', {}, a.case_number || (a.changes?.email ?? '')))))) : h('p', { class: 'muted' }, 'אין עדיין פעילות.')));
}

// ---------- boot ----------

async function route() {
  const hash = location.hash || '#/';
  setActiveNav(hash);
  window.scrollTo(0, 0);
  try {
    if (hash.startsWith('#/r/')) return await renderRecord(hash.slice(4));
    if (hash === '#/new') return await renderNew();
    if (hash === '#/admin') return await renderAdmin();
    return await renderList();
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
  document.getElementById('who').replaceChildren(h('span', {}, `${me.name || me.email} · `), h('a', { href: '/xhost-auth/logout?return_to=/' }, 'התנתקות'));
  document.getElementById('nav').hidden = false;
  if (me.role === 'admin') document.querySelector('[data-admin]').hidden = false;
  try { meta = await api('/meta'); } catch (e) { return view.replaceChildren(h('p', { class: 'notice error' }, `לא ניתן לטעון את הגדרות סיילספורס: ${e.message}`)); }
  window.addEventListener('hashchange', route);
  route();
}

boot();
