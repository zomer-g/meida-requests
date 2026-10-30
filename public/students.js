// "הסטודנטים שלי": a manager adds, imports (CSV) and removes the students of their own group.
// The server (/api/team/*) enforces the group and the role; admins choose the group here.

async function readCsvFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1255').decode(buf); } // Hebrew Excel
}

const STATUS = { new: 'חדש', update: 'עדכון', same: 'קיים', invalid: 'שגוי', blocked: 'לא ישתנה' };

export async function renderStudents(view, { h, api, toast, me, boards }) {
  if (!['manager', 'admin'].includes(me.role)) { location.hash = '#/'; return; }
  const isAdmin = me.role === 'admin';
  let groupId = isAdmin ? (renderStudents.groupId || boards.find((b) => b.kind === 'clinic')?.id || boards[0]?.id) : null;
  const q = () => (groupId ? `?groupId=${groupId}` : '');
  const withGroup = (body) => (groupId ? { ...body, groupId } : body);

  view.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
  let data;
  try { data = await api(`/team/students${q()}`); } catch (e) { return view.replaceChildren(h('h1', {}, 'הסטודנטים שלי'), h('p', { class: 'notice error' }, e.message)); }
  const reload = () => renderStudents(view, { h, api, toast, me, boards });

  // ---- add one student ----
  const email = h('input', { type: 'email', id: 's_email', dir: 'ltr', required: true, autocomplete: 'off', placeholder: 'name@gmail.com', 'aria-describedby': 's_email_help' });
  const name = h('input', { type: 'text', id: 's_name', required: true, autocomplete: 'off' });
  const add = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/team/students', { method: 'POST', body: withGroup({ email: email.value, name: name.value }) });
      toast(r.contactError ? `נשמר, אבל לא נוצר איש קשר בסיילספורס: ${r.contactError}` : 'הסטודנט/ית נשמר/ה', !!r.contactError);
      reload();
    } catch (err) { toast(err.message, true); }
  };

  // ---- CSV import ----
  const file = h('input', { type: 'file', id: 's_file', accept: '.csv,text/csv,text/plain', 'aria-describedby': 's_file_help' });
  const out = h('div', { 'aria-live': 'polite' });
  file.addEventListener('change', async () => {
    out.replaceChildren();
    if (!file.files[0]) return;
    const text = await readCsvFile(file.files[0]);
    try {
      const p = await api('/team/import/preview', { method: 'POST', body: withGroup({ text }) });
      const n = p.counts.new + p.counts.update;
      const go = h('button', { class: 'button is-primary', type: 'button', disabled: !n }, `ייבוא ${n} סטודנטים ל${p.group.name}`);
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const r = await api('/team/import', { method: 'POST', body: withGroup({ text }) });
          toast(`נוספו ${r.added}, עודכנו ${r.updated}${r.contactErrors.length ? `, ${r.contactErrors.length} בלי איש קשר בסיילספורס` : ''}`, r.contactErrors.length > 0);
          reload();
        } catch (err) { toast(err.message, true); go.disabled = false; }
      });
      out.replaceChildren(
        h('p', {}, `${p.header ? 'שורת הכותרת דולגה. ' : ''}חדשים: ${p.counts.new} · עדכוני שם: ${p.counts.update} · קיימים ללא שינוי: ${p.counts.same} · שגויים: ${p.counts.invalid} · רשומים בקבוצה או תפקיד אחר (לא ישתנו): ${p.counts.blocked}`),
        h('div', { class: 'table-wrap scroll-box' }, h('table', { class: 'plain' },
          h('caption', { class: 'sr-only' }, 'תצוגה מקדימה של הייבוא'),
          h('thead', {}, h('tr', {}, ['שורה', 'שם', 'מייל', 'מצב', 'הערה'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, p.rows.map((r) => h('tr', { class: ['invalid', 'blocked'].includes(r.status) ? 'bad' : null },
            h('td', { class: 'num' }, r.line), h('td', {}, r.name), h('td', { dir: 'ltr' }, r.email),
            h('td', {}, h('span', { class: `pill ${['invalid', 'blocked'].includes(r.status) ? 'refused' : r.status === 'new' ? 'received' : ''}` }, STATUS[r.status])),
            h('td', {}, r.error || r.note || '')))))),
        h('div', { class: 'mt' }, go));
    } catch (err) { out.replaceChildren(h('p', { class: 'notice error' }, err.message)); }
  });

  // ---- list ----
  const remove = async (s) => {
    if (!confirm(`להסיר את הגישה של ${s.name || s.email}? איש הקשר בסיילספורס לא יימחק.`)) return;
    try { await api(`/team/students/${encodeURIComponent(s.email)}${q()}`, { method: 'DELETE' }); toast('הגישה הוסרה'); reload(); } catch (err) { toast(err.message, true); }
  };
  const rename = async (s) => {
    const v = prompt(`שם חדש עבור ${s.email}`, s.name || '');
    if (v === null || !v.trim()) return;
    try { await api('/team/students', { method: 'POST', body: withGroup({ email: s.email, name: v }) }); toast('השם עודכן'); reload(); } catch (err) { toast(err.message, true); }
  };

  let picker = null;
  if (isAdmin) {
    picker = h('select', { id: 's_group' }, boards.map((b) => h('option', { value: b.id, selected: b.id === groupId }, b.name)));
    picker.addEventListener('change', () => { renderStudents.groupId = Number(picker.value); reload(); });
  }

  const isStaff = data.group.kind === 'staff';
  view.replaceChildren(...[
    h('h1', {}, `הסטודנטים של ${data.group.name}`),
    h('p', { class: 'muted' }, 'כאן מוסיפים, טוענים מקובץ ומסירים סטודנטים של הקבוצה. סטודנט/ית רואה רק את הלוח של הקבוצה ויכול/ה להיבחר כמטפל/ת בבקשות שלה. שינוי תפקיד, מעבר בין קבוצות והוספת עובדים או מנהלים נעשים רק ע״י אדמין. ', h('a', { href: '#/help' }, 'מדריך למנהלים')),
    picker ? h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', { for: 's_group' }, 'קבוצה'), picker)) : null,
    isStaff ? h('p', { class: 'notice' }, 'בקבוצת עובדי התנועה אין בדרך כלל סטודנטים. עובדים ומנהלים מוסיף האדמין.') : null,
    h('form', { class: 'card', onsubmit: add, novalidate: false },
      h('h2', {}, 'הוספת סטודנט/ית'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: 's_name' }, 'שם מלא', h('span', { class: 'req', 'aria-hidden': 'true' }, '*')), name),
        h('div', { class: 'field' }, h('label', { for: 's_email' }, 'מייל Google', h('span', { class: 'req', 'aria-hidden': 'true' }, '*')), email,
          h('span', { class: 'help', id: 's_email_help' }, 'הכתובת שאיתה הסטודנט/ית מתחבר/ת ל-Google.'))),
      h('div', { class: 'mt' }, h('button', { class: 'button is-primary', type: 'submit' }, 'הוספה'))),
    h('div', { class: 'card' },
      h('h2', {}, 'טעינת רשימה מקובץ CSV'),
      h('div', { class: 'field' }, h('label', { for: 's_file' }, 'קובץ CSV'), file,
        h('span', { class: 'help', id: 's_file_help' }, 'עמודה ראשונה: שם, עמודה שנייה: מייל. שורת כותרת מזוהה ומדלגים עליה. לפני הייבוא תוצג תצוגה מקדימה.')),
      out),
    h('div', { class: 'card table-wrap' },
      h('h2', {}, `סטודנטים (${data.students.length})`),
      data.students.length ? h('table', { class: 'plain' },
        h('caption', { class: 'sr-only' }, `סטודנטים של ${data.group.name}`),
        h('thead', {}, h('tr', {}, ['שם', 'מייל', 'איש קשר בסיילספורס', 'פעולות'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, data.students.map((s) => h('tr', {},
          h('td', {}, s.name || ''), h('td', { dir: 'ltr' }, s.email),
          h('td', {}, s.linked ? h('span', { class: 'pill received' }, 'מקושר') : h('span', { class: 'pill refused', title: s.contact_error || '' }, 'לא מקושר')),
          h('td', {},
            h('button', { class: 'button is-small', type: 'button', onclick: () => rename(s), 'aria-label': `עריכת השם של ${s.name || s.email}` }, 'עריכת שם'), ' ',
            h('button', { class: 'button is-small is-danger', type: 'button', onclick: () => remove(s), 'aria-label': `הסרת ${s.name || s.email}` }, 'הסרה'))))))
        : h('p', { class: 'muted' }, 'אין עדיין סטודנטים בקבוצה.')),
  ].filter(Boolean)); // replaceChildren would print a null
}
