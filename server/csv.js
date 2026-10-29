// CSV import of portal users: column 1 = name, column 2 = email. Accepts comma, semicolon or tab
// separated files (Excel's choice depends on the locale), quoted fields, CRLF and a UTF-8 BOM.

function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const count = (ch) => line.split(ch).length - 1;
  return [',', ';', '\t'].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');
}

export function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.trim() === '') { quoted = true; field = ''; } else if (ch === delim) { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const EMAIL_RE = /^[^@\s<>()[\],;:"]+@[^@\s<>()[\],;:"]+\.[a-z]{2,}$/i;
export const isEmail = (v) => EMAIL_RE.test(v);

// → { rows: [{ line, name, email, error? }], header: bool }. Duplicate emails after the first are errors.
export function parsePeople(text) {
  const raw = parseCsv(text);
  const out = [];
  const seen = new Map();
  let header = false;
  raw.forEach((cols, i) => {
    const line = i + 1;
    if (cols.every((c) => !c.trim())) return;
    const name = (cols[0] || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const email = (cols[1] || '').trim().replace(/^mailto:/i, '').replace(/^<|>$/g, '').toLowerCase();
    if (!out.length && !header && !email.includes('@')) { header = true; return; }
    const row = { line, name, email };
    if (!email) row.error = 'חסרה כתובת מייל';
    else if (!isEmail(email)) row.error = 'כתובת מייל לא תקינה';
    else if (!name) row.error = 'חסר שם';
    else if (seen.has(email)) row.error = `כפול (כבר מופיע בשורה ${seen.get(email)})`;
    if (!row.error) seen.set(email, line);
    out.push(row);
  });
  return { rows: out, header };
}
