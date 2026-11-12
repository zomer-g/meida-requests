// API docs page (/api-docs): fills in the server address, the code examples and the field table.
// Field names come from /api-docs/schema.json (public). Labels, types and allowed values come
// from Salesforce: through the portal's /api/meta when signed in, or /api/v1/fields with a token
// the reader pastes (kept in memory only).

const base = `${location.origin}/api/v1`;
for (const el of document.querySelectorAll('[data-base]')) el.textContent = base;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const EXAMPLES = {
  curl: `# Check the token
curl -sS ${base}/ping \\
  -H "Authorization: Bearer $API_TOKEN" -H "X-Client-Name: my-system"

# Create a request
curl -sS -X POST ${base}/requests \\
  -H "Authorization: Bearer $API_TOKEN" -H "X-Client-Name: my-system" \\
  -H "Content-Type: application/json" \\
  --data @request.json

# Update a request by its case number
curl -sS -X PATCH ${base}/requests/00012346 \\
  -H "Authorization: Bearer $API_TOKEN" -H "X-Client-Name: my-system" \\
  -H "Content-Type: application/json" \\
  -d '{"fields": {"Answer__c": "..."}}'`,
  python: `import os, requests

BASE = "${base}"
S = requests.Session()
S.headers.update({
    "Authorization": f"Bearer {os.environ['API_TOKEN']}",
    "X-Client-Name": "my-system",
})

# Find by the authority's reference, create if missing
found = S.get(f"{BASE}/requests", params={"asmahta": "2026-1234"}).json()["records"]
if not found:
    r = S.post(f"{BASE}/requests", json={
        "board": "המרכז הבינתחומי",
        "fields": {
            "request_name__c": "פרוטוקולי ועדת המכרזים 2025",
            "Description": "בקשה לקבלת כל הפרוטוקולים",
            "Status": "New",
            "asmahta_gov_number__c": "2026-1234",
            "request_org_name__c": {"name": "משרד הבריאות"},
            "request_initiator__c": {"email": "person@example.org"},
            "metapel_bakasha__c": {"email": "student@example.ac.il"},
            "Origin": "Web",
        },
    })
    if r.status_code != 201:
        raise RuntimeError(r.json()["message"])
    print("created", r.json()["caseNumber"])`,
  node: `const BASE = '${base}';
const headers = {
  Authorization: \`Bearer \${process.env.API_TOKEN}\`,
  'X-Client-Name': 'my-system',
  'Content-Type': 'application/json',
};

const current = await (await fetch(\`\${BASE}/requests/00012346\`, { headers })).json();
const res = await fetch(\`\${BASE}/requests/00012346\`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({
    lastModified: current.lastModified, // refuse to overwrite a newer change (409)
    fields: { Status: 'Answered', first_Answerd__c: '2026-12-01' },
  }),
});
const body = await res.json();
if (!res.ok) throw new Error(\`\${res.status} \${body.error}: \${body.message}\`);
console.log('changed', body.changed);`,
};
for (const el of document.querySelectorAll('[data-example]')) el.textContent = EXAMPLES[el.dataset.example];

const TYPE_LABELS = {
  string: 'טקסט', textarea: 'טקסט ארוך', url: 'קישור', email: 'מייל', phone: 'טלפון', date: 'תאריך', datetime: 'תאריך ושעה',
  boolean: 'כן/לא', double: 'מספר', int: 'מספר שלם', currency: 'סכום', percent: 'אחוז',
  picklist: 'רשימה', multipicklist: 'רשימה (כמה ערכים)', reference: 'שדה בחירה',
};
const LOOKUP_LABELS = { Account: 'גוף ציבורי (Account)', Contact: 'איש קשר (Contact)', PortalUser: 'משתמש/ת פורטל', handler: 'משתמש/ת פורטל' };

const tableBox = document.getElementById('fields-table');
let schema = null;

// sections: [{ title, fields: [{ name, required, label?, type?, length?, help?, options?, lookup?, createable?, updateable? }] }]
function renderFields(sections, detailed) {
  tableBox.replaceChildren(...sections.map((s) => h('section', { class: 'field-section' },
    h('h3', {}, s.title),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('caption', { class: 'sr-only' }, `שדות המקטע ${s.title}`),
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, 'שם ה-API'),
        detailed ? h('th', { scope: 'col' }, 'תווית') : null,
        h('th', { scope: 'col' }, 'סוג'),
        detailed ? h('th', { scope: 'col' }, 'ערכים מותרים / הערות') : null)),
      h('tbody', {}, s.fields.map((f) => h('tr', {},
        h('td', { dir: 'ltr' }, h('code', {}, f.name), f.required ? h('strong', { title: 'שדה חובה' }, ' *') : null),
        detailed ? h('td', {}, f.label || '') : null,
        h('td', {}, f.type ? `${TYPE_LABELS[f.type] || f.type}${f.type === 'string' && f.length ? ` (עד ${f.length})` : ''}`
          : f.lookup ? `שדה בחירה: ${LOOKUP_LABELS[f.lookup] || f.lookup}` : ''),
        detailed ? h('td', {},
          f.lookup ? h('div', {}, `מצביע על: ${LOOKUP_LABELS[f.lookup] || f.lookup}`) : null,
          f.options?.length ? h('ul', { class: 'options' }, f.options.map((o) => h('li', {},
            h('code', { dir: 'ltr' }, o.value), o.label && o.label !== o.value ? ` – ${o.label}` : ''))) : null,
          f.help ? h('div', { class: 'muted' }, f.help) : null,
          f.createable === false ? h('div', { class: 'muted' }, 'לא ניתן למלא ביצירה') : null,
          f.updateable === false ? h('div', { class: 'muted' }, 'לא ניתן לעדכן') : null) : null))))))));
}

function setSource(text) {
  document.getElementById('fields-source').textContent = text;
}

async function loadSchema() {
  try {
    schema = await (await fetch('/api-docs/schema.json')).json();
    const status = document.getElementById('api-status');
    if (!schema.enabled) {
      status.hidden = false;
      status.classList.add('error');
      status.textContent = 'ה-API עדיין לא הופעל בשרת הזה: לא הוגדר טוקן (API_TOKEN). עד שיוגדר, כל קריאה תחזיר 503.';
    }
    renderFields(schema.sections.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f, lookup: schema.lookups[f.name] })) })), false);
  } catch {
    tableBox.replaceChildren(h('p', { class: 'notice error' }, 'לא ניתן לטעון את רשימת השדות.'));
  }
}

// Signed in to the portal: the same field data the portal form uses.
async function tryPortal() {
  try {
    const res = await fetch('/api/meta', { credentials: 'same-origin' });
    if (!res.ok) return false;
    const meta = await res.json();
    renderFields(meta.sections.map((s) => ({
      title: s.title,
      fields: s.fields.map((f) => ({ ...f, lookup: f.lookup === 'handler' ? 'PortalUser' : f.lookup })),
    })), true);
    document.getElementById('token-form').hidden = true;
    setSource('השדות נטענו מסיילספורס דרך החיבור שלך לפורטל, עם התוויות, הסוגים והערכים המותרים.');
    return true;
  } catch {
    return false;
  }
}

document.getElementById('token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('fields-error');
  err.hidden = true;
  const token = document.getElementById('token').value.trim();
  if (!token) { err.textContent = 'יש להדביק טוקן'; err.hidden = false; return; }
  try {
    const res = await fetch('/api/v1/fields', { headers: { Authorization: `Bearer ${token}`, 'X-Client-Name': 'api-docs' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `שגיאה ${res.status}`);
    renderFields(body.sections, true);
    setSource('השדות נטענו מסיילספורס עם הטוקן, עם התוויות, הסוגים והערכים המותרים.');
    document.getElementById('token').value = '';
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

await loadSchema();
await tryPortal();
