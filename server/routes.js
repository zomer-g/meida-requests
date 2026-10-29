import express from 'express';
import { sf, query, isId, soqlString, soqlContains, SalesforceError } from './salesforce.js';
import { getMeta } from './meta.js';
import { EDITABLE_FIELDS, REQUEST_RECORD_TYPE, LOOKUPS } from './fields.js';
import { requireUser, requireAdmin, sameOrigin, adminEmails } from './auth.js';
import { audit, auditFor, recentAudit, listUsers, upsertUser, deleteUser } from './db.js';

export const api = express.Router();
api.use(express.json({ limit: '200kb' }));
api.use(sameOrigin);
api.use(requireUser);

const PAGE_SIZE = 50;
const LIST_FIELDS = [
  'Id', 'CaseNumber', 'request_name__c', 'Status', 'request_date__c', 'LastModifiedDate',
  'request_org_name__r.Name', 'metapel_bakasha__r.Name', 'Owner.Name',
];
const LOOKUP_NAMES = Object.keys(LOOKUPS).map((f) => f.replace(/__c$/, '__r.Name'));

// Every query on Case goes through this: request record type, plus the clinic's owner for clinic users.
function scope(user) {
  const parts = [`RecordType.DeveloperName = '${REQUEST_RECORD_TYPE}'`];
  if (user.role !== 'admin') parts.push(isId(user.ownerId) ? `OwnerId = '${user.ownerId}'` : 'Id = null');
  return parts.join(' AND ');
}

export async function loadCase(user, id) {
  if (!isId(id)) return null;
  const fields = ['Id', 'CaseNumber', 'OwnerId', 'Owner.Name', 'CreatedDate', 'LastModifiedDate', 'ClosedDate', ...EDITABLE_FIELDS, ...LOOKUP_NAMES];
  const r = await query(`SELECT ${[...new Set(fields)].join(', ')} FROM Case WHERE Id = '${id}' AND ${scope(user)} LIMIT 1`);
  return r.records[0] || null;
}

// Turns form input into Salesforce values, accepting only portal fields and valid values.
function cleanInput(meta, input, mode) {
  const out = {};
  const errors = [];
  for (const [name, raw] of Object.entries(input || {})) {
    const f = meta.fields[name];
    if (!f || !(mode === 'create' ? f.createable : f.updateable)) continue;
    let v = raw;
    if (v === '' || v === undefined) v = null;
    if (v !== null) {
      switch (f.type) {
        case 'boolean': v = v === true || v === 'true'; break;
        case 'double': case 'currency': case 'percent': case 'int':
          v = Number(v); if (!Number.isFinite(v)) errors.push(`${f.label}: מספר לא תקין`); break;
        case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${f.label}: תאריך לא תקין`); break;
        case 'datetime': if (Number.isNaN(Date.parse(v))) errors.push(`${f.label}: תאריך ושעה לא תקינים`); else v = new Date(v).toISOString(); break;
        case 'reference': if (!isId(v)) errors.push(`${f.label}: ערך לא תקין`); break;
        case 'picklist': if (!f.options.some((o) => o.value === v)) errors.push(`${f.label}: ערך לא ברשימה`); break;
        case 'multipicklist': {
          const list = Array.isArray(v) ? v : String(v).split(';');
          if (list.some((x) => !f.options.some((o) => o.value === x))) errors.push(`${f.label}: ערך לא ברשימה`);
          v = list.length ? list.join(';') : null;
          break;
        }
        default: v = String(v); if (f.length && v.length > f.length) errors.push(`${f.label}: ארוך מדי`);
      }
    }
    out[name] = v;
  }
  return { out, errors };
}

function sfMessage(e) {
  if (e.message?.startsWith('Salesforce token failed')) return 'החיבור לסיילספורס נכשל: פרטי ה-API (SF_CLIENT_ID / SF_CLIENT_SECRET) חסרים או שגויים';
  if (!(e instanceof SalesforceError)) return 'שגיאה פנימית';
  return (Array.isArray(e.errors) ? e.errors : [e.errors]).map((x) => x?.message).filter(Boolean).join('; ') || e.message;
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[api]', req.method, req.path, e.message);
  res.status(e instanceof SalesforceError && e.status < 500 ? 400 : 500).json({ error: sfMessage(e) });
});

api.get('/me', (req, res) => {
  const { email, name, role, ownerName } = req.user;
  res.json({ email, name, role, ownerName });
});

api.get('/meta', wrap(async (req, res) => {
  res.json(await getMeta());
}));

api.get('/requests', wrap(async (req, res) => {
  const where = [scope(req.user)];
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) {
    const like = soqlContains(q);
    where.push(/^\d+$/.test(q) ? `(CaseNumber LIKE ${like} OR request_name__c LIKE ${like})` : `request_name__c LIKE ${like}`);
  }
  const status = String(req.query.status || 'open');
  if (status === 'open') where.push("Status != 'Closed'");
  else if (status !== 'all') where.push(`Status = ${soqlString(status)}`);
  const page = Math.max(0, Math.min(39, parseInt(req.query.page, 10) || 0));
  const r = await query(
    `SELECT ${LIST_FIELDS.join(', ')} FROM Case WHERE ${where.join(' AND ')} ORDER BY LastModifiedDate DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${page * PAGE_SIZE}`,
  );
  res.json({ records: r.records.slice(0, PAGE_SIZE), page, hasMore: r.records.length > PAGE_SIZE });
}));

api.get('/requests/:id', wrap(async (req, res) => {
  const record = await loadCase(req.user, req.params.id);
  if (!record) return res.status(404).json({ error: 'הבקשה לא נמצאה' });
  res.json({ record, history: await auditFor(record.Id) });
}));

api.patch('/requests/:id', wrap(async (req, res) => {
  const meta = await getMeta();
  const before = await loadCase(req.user, req.params.id);
  if (!before) return res.status(404).json({ error: 'הבקשה לא נמצאה' });
  const { out, errors } = cleanInput(meta, req.body?.fields, 'update');
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const changes = {};
  for (const [k, v] of Object.entries(out)) {
    if ((before[k] ?? null) !== v) changes[k] = { from: before[k] ?? null, to: v };
  }
  if (!Object.keys(changes).length) return res.json({ ok: true, changed: 0 });
  const missing = Object.keys(changes).filter((k) => meta.fields[k].required && changes[k].to === null);
  if (missing.length) return res.status(400).json({ error: `שדות חובה: ${missing.map((k) => meta.fields[k].label).join(', ')}` });
  await sf(`/sobjects/Case/${before.Id}`, { method: 'PATCH', body: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])) });
  await audit({ email: req.user.email, action: 'update', case_id: before.Id, case_number: before.CaseNumber, changes });
  res.json({ ok: true, changed: Object.keys(changes).length });
}));

api.post('/requests', wrap(async (req, res) => {
  const meta = await getMeta();
  const { out, errors } = cleanInput(meta, req.body?.fields, 'create');
  const missing = Object.values(meta.fields).filter((f) => f.required && (out[f.name] ?? null) === null).map((f) => f.label);
  if (missing.length) errors.unshift(`שדות חובה: ${missing.join(', ')}`);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  let ownerId = req.user.ownerId;
  if (req.user.role === 'admin') ownerId = isId(req.body?.ownerId) ? req.body.ownerId : null;
  else if (!isId(ownerId)) return res.status(403).json({ error: 'למשתמש לא הוגדרה קליניקה' });
  const body = { ...out, RecordTypeId: meta.recordTypeId, ...(ownerId ? { OwnerId: ownerId } : {}) };
  const created = await sf('/sobjects/Case', { method: 'POST', body });
  const r = await query(`SELECT CaseNumber FROM Case WHERE Id = '${created.id}'`);
  const caseNumber = r.records[0]?.CaseNumber;
  await audit({ email: req.user.email, action: 'create', case_id: created.id, case_number: caseNumber, changes: body });
  res.status(201).json({ id: created.id, caseNumber });
}));

// Search for Contacts / Accounts to fill lookup fields.
api.get('/lookup/:object', wrap(async (req, res) => {
  const object = req.params.object;
  if (!['Contact', 'Account'].includes(object)) return res.status(400).json({ error: 'bad object' });
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ records: [] });
  const extra = object === 'Contact' ? ', Email, Account.Name' : '';
  const r = await query(`SELECT Id, Name${extra} FROM ${object} WHERE Name LIKE ${soqlContains(q)} ORDER BY Name LIMIT 20`);
  res.json({ records: r.records.map((x) => ({ id: x.Id, name: x.Name, sub: [x.Account?.Name, x.Email].filter(Boolean).join(' · ') })) });
}));

// ---- admin ----

api.get('/admin/owners', requireAdmin, wrap(async (req, res) => {
  const r = await query("SELECT Id, Name, Email FROM User WHERE IsActive = true AND UserType = 'Standard' AND (NOT Name LIKE '%Integration%') ORDER BY Name");
  res.json({ records: r.records.map((u) => ({ id: u.Id, name: u.Name, email: u.Email })) });
}));

api.get('/admin/users', requireAdmin, wrap(async (req, res) => {
  res.json({ users: await listUsers(), envAdmins: [...adminEmails] });
}));

api.post('/admin/users', requireAdmin, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role === 'admin' ? 'admin' : 'clinic';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'כתובת מייל לא תקינה' });
  let ownerName = null;
  const ownerId = role === 'clinic' ? req.body?.ownerId : null;
  if (role === 'clinic') {
    if (!isId(ownerId)) return res.status(400).json({ error: 'יש לבחור קליניקה' });
    const r = await query(`SELECT Name FROM User WHERE Id = '${ownerId}'`);
    if (!r.records[0]) return res.status(400).json({ error: 'המשתמש בסיילספורס לא נמצא' });
    ownerName = r.records[0].Name;
  }
  await upsertUser({ email, name: String(req.body?.name || '').slice(0, 100) || null, role, sf_owner_id: ownerId, sf_owner_name: ownerName, created_by: req.user.email });
  await audit({ email: req.user.email, action: 'user_upsert', changes: { email, role, ownerName } });
  res.json({ ok: true });
}));

api.delete('/admin/users/:email', requireAdmin, wrap(async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  await deleteUser(email);
  await audit({ email: req.user.email, action: 'user_delete', changes: { email } });
  res.json({ ok: true });
}));

api.get('/admin/audit', requireAdmin, wrap(async (req, res) => {
  res.json({ entries: await recentAudit(200) });
}));
