// Activity feed panel on a request: composer (text + files) and the posts, newest first.
// Helpers come from app.js so the panel looks and behaves like the rest of the page.

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.csv,.txt,.zip';
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const fmtSize = (n) => (n === null || n === undefined ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

export function renderActivity(caseId, { h, api, toast, fmtDateTime, toLogin, showErrors, clearErrors }) {
  const list = h('div', { class: 'feed' }, h('p', { class: 'muted' }, 'טוען…'));
  const text = h('textarea', { id: 'feed_text', maxlength: 10000, placeholder: 'מה עשיתם בבקשה? למשל: שלחנו תזכורת לממונה, התקבלה תשובה חלקית…' });
  const files = h('input', { id: 'feed_files', type: 'file', multiple: true, accept: ACCEPT, 'aria-describedby': 'feed_files_help' });
  const send = h('button', { class: 'button is-primary', type: 'submit' }, 'פרסום עדכון');

  const load = async () => {
    try {
      const { posts } = await api(`/requests/${caseId}/activity`);
      if (!posts.length) return list.replaceChildren(h('p', { class: 'muted' }, 'אין עדיין עדכונים.'));
      list.replaceChildren(...posts.map((p) => h('article', { class: 'post' },
        h('div', { class: 'when' }, h('strong', {}, p.author.name || p.author.email), p.author.email && p.author.name !== p.author.email ? h('span', { dir: 'ltr' }, ` ${p.author.email}`) : null, ` · ${fmtDateTime(p.at)}`),
        p.text ? h('div', { class: 'text' }, p.text) : null,
        p.files.length ? h('ul', { class: 'files' }, p.files.map((f) => h('li', {},
          h('a', { href: `/api/requests/${caseId}/activity/files/${f.id}`, download: f.name }, f.name),
          f.size !== null ? h('span', { class: 'muted' }, ` (${fmtSize(f.size)})`) : null))) : null)));
    } catch (e) {
      list.replaceChildren(h('p', { class: 'notice error' }, e.message));
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const chosen = [...files.files];
    const big = chosen.find((f) => f.size > MAX_FILE_BYTES);
    const error = !text.value.trim() && !chosen.length ? { id: 'feed_text', label: 'עדכון חדש', message: 'יש לכתוב עדכון או לצרף קובץ' }
      : chosen.length > MAX_FILES ? { id: 'feed_files', label: 'קבצים מצורפים', message: `אפשר לצרף עד ${MAX_FILES} קבצים` }
        : big ? { id: 'feed_files', label: 'קבצים מצורפים', message: `הקובץ ${big.name} גדול מ-10MB` } : null;
    if (error) return showErrors(form, [error]);
    clearErrors(form);
    const body = new FormData();
    body.append('text', text.value);
    for (const f of chosen) body.append('files', f, f.name);
    send.disabled = true;
    try {
      const res = await fetch(`/api/requests/${caseId}/activity`, { method: 'POST', body });
      if (res.status === 401) { toLogin(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showErrors(form, [{ message: res.status === 413 ? 'הקבצים גדולים מדי' : data.error || `שגיאה ${res.status}` }]);
      if (data.failed?.length) toast(`העדכון פורסם, אבל לא הועלו: ${data.failed.join(', ')}`, true);
      else toast('העדכון פורסם');
      text.value = '';
      files.value = '';
      load();
    } catch (err) { toast(err.message, true); } finally { send.disabled = false; }
  };

  load();
  return h('section', { class: 'card' },
    h('h2', { id: 'feed_title' }, 'עדכונים ופעילות'),
    h('form', { class: 'composer', onsubmit: onSubmit, novalidate: true, 'aria-labelledby': 'feed_title' },
      h('div', { class: 'field' }, h('label', { for: 'feed_text' }, 'עדכון חדש'), text),
      h('div', { class: 'field' }, h('label', { for: 'feed_files' }, 'קבצים מצורפים'), files,
        h('span', { class: 'help', id: 'feed_files_help' }, `עד ${MAX_FILES} קבצים, עד 10MB כל אחד: PDF, Office, תמונות, CSV, TXT, ZIP`)),
      h('div', {}, send)),
    list);
}
