import express from 'express';
import { sf, query, isId, soqlString, soqlContains, SalesforceError } from './salesforce.js';
import { getMeta } from './meta.js';
import { EDITABLE_FIELDS, REQUEST_RECORD_TYPE, LOOKUPS, HANDLER_FIELD } from './fields.js';
import { requireUser, requireAdmin, sameOrigin, adminEmails } from './auth.js';
import {
  audit, auditFor, searchAudit, listUsers, findUser, upsertUser, deleteUser, usersByContact,
  listGroups, saveGroup, ROLES,
} from './db.js';
import { canSeeAll, caseFilter, visibleGroups, groupOfOwner, ensureContacts, sfUserByEmail } from './access.js';
import { parsePeople, isEmail } from './csv.js';

export const api = express.Router();
api.use(express.json({ limit: '2mb' }));
api.use(sameOrigin);
api.use(requireUser);

const PAGE_SIZE = 50;
const LIST_FIELDS = [
  'Id', 'CaseNumber', 'request_name__c', 'Status', 'request_date__c', 'LastModifiedDate',
  'request_org_name__r.Name', 'metapel_bakasha__r.Name', 'OwnerId', 'Owner.Name',
];
const relName = (f) => f.replace(/__c$/, '__r');
const LOOKUP_NAMES = Object.keys(LOOKUPS).map((f) => `${relName(f)}.Name`);
const ROLE_LABELS = { student: 'סטודנט', employee: 'עובד', manager: 'מנהל', admin: 'אדמין' };

// Every query on Case goes through this: request record type, plus the boards the user may see
// (optionally narrowed to one board).
async function scope(user, boardId = null) {
  const parts = [`RecordType.DeveloperName = '${REQUEST_RECORD_TYPE}'`];
  const filter = await caseFilter(user, boardId);
  if (filter) parts.push(filter);
  return parts.join(' AND ');
}

// The Case if this user may access it, else null. Also used by the activity feed (activity.js).
export async function loadCase(user, id) {
  if (!isId(id)) return null;
  const fields = ['Id', 'CaseNumber', 'OwnerId', 'Owner.Name', 'CreatedDate', 'LastModifiedDate', 'ClosedDate', ...EDITABLE_FIELDS, ...LOOKUP_NAMES];
  const r = await query(`SELECT ${[...new Set(fields)].join(', ')} FROM Case WHERE Id = '${id}' AND ${await scope(user)} LIMIT 1`);
  return r.records[0] || null;
}

const groupInfo = (g) => (g ? { id: g.id, name: g.name, kind: g.kind } : null);

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

// The handler must be a portal user with a Contact; students and employees may only pick
// members of the request's group, managers and admins any portal user.
async function checkHandler(user, contactId, group) {
  if (!contactId) return null;
  const [member] = await usersByContact([contactId]);
  if (!member) return 'המטפל/ת בבקשה חייב/ת להיות משתמש/ת רשום/ה בפורטל';
  if (!canSeeAll(user) && member.group_id !== group?.id) return 'המטפל/ת בבקשה חייב/ת להיות מהקבוצה של הבקשה';
  return null;
}

// Adds labels and readable values to { field: { from, to } } for the log.
async function describeChanges(meta, changes, before = {}) {
  const refIds = Object.entries(changes).filter(([k, c]) => meta.fields[k]?.type === 'reference' && c.to).map(([, c]) => c.to);
  const names = new Map();
  for (const object of ['Contact', 'Account']) {
    const ids = refIds.filter((id) => id.startsWith(object === 'Contact' ? '003' : '001'));
    if (!ids.length) continue;
    const r = await query(`SELECT Id, Name FROM ${object} WHERE Id IN (${ids.map((id) => `'${id}'`).join(', ')})`);
    for (const x of r.records) names.set(x.Id, x.Name);
  }
  const text = (f, v) => {
    if (v === null || v === undefined) return null;
    if (f.options) return String(v).split(';').map((x) => f.options.find((o) => o.value === x)?.label || x).join('; ');
    if (f.type === 'boolean') return v ? 'כן' : 'לא';
    return null;
  };
  const out = {};
  for (const [k, c] of Object.entries(changes)) {
    const f = meta.fields[k] || { label: k };
    const entry = { label: f.label, from: c.from ?? null, to: c.to ?? null };
    if (f.type === 'reference') {
      if (c.from) entry.fromText = before[relName(k)]?.Name || c.from;
      if (c.to) entry.toText = names.get(c.to) || c.to;
    } else {
      const ft = text(f, c.from); const tt = text(f, c.to);
      if (ft !== null) entry.fromText = ft;
      if (tt !== null) entry.toText = tt;
    }
    out[k] = entry;
  }
  return out;
}

function sfMessage(e) {
  if (e.message?.startsWith('Salesforce token failed')) return 'החיבור לסיילספורס נכשל: פרטי ה-API (SF_CLIENT_ID / SF_CLIENT_SECRET) חסרים או שגויים';
  if (e.status === 400 && e.expose) return e.message;
  if (!(e instanceof SalesforceError)) return 'שגיאה פנימית';
  return (Array.isArray(e.errors) ? e.errors : [e.errors]).map((x) => x?.message).filter(Boolean).join('; ') || e.message;
}

const bad = (message) => Object.assign(new Error(message), { status: 400, expose: true });

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[api]', req.method, req.path, e.message);
  res.status((e instanceof SalesforceError || e.expose) && e.status < 500 ? 400 : 500).json({ error: sfMessage(e) });
});

api.get('/me', wrap(async (req, res) => {
  const { email, name, role, groupId } = req.user;
  const group = (await listGroups()).find((g) => g.id === groupId);
  res.json({ email, name, role, roleLabel: ROLE_LABELS[role], group: groupInfo(group), seesAll: canSeeAll(req.user) });
}));

api.get('/meta', wrap(async (req, res) => {
  res.json(await getMeta());
}));

// The boards (groups) this user may open, with who new requests on each board are assigned to.
api.get('/boards', wrap(async (req, res) => {
  const groups = await visibleGroups(req.user);
  res.json({ boards: groups.map((g) => ({ ...groupInfo(g), newOwnerName: g.default_owner_name || null })) });
}));

api.get('/requests', wrap(async (req, res) => {
  const boardId = parseInt(req.query.board, 10) || null;
  const where = [await scope(req.user, boardId)];
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
  const groups = await listGroups();
  const records = r.records.slice(0, PAGE_SIZE).map((x) => ({ ...x, board: groupOfOwner(x.OwnerId, groups)?.name || null }));
  res.json({ records, page, hasMore: r.records.length > PAGE_SIZE });
}));

api.get('/requests/:id', wrap(async (req, res) => {
  const record = await loadCase(req.user, req.params.id);
  if (!record) return res.status(404).json({ error: 'הבקשה לא נמצאה' });
  const group = groupOfOwner(record.OwnerId, await listGroups());
  res.json({ record, group: groupInfo(group), history: await auditFor(record.Id) });
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
  const group = groupOfOwner(before.OwnerId, await listGroups());
  if (changes[HANDLER_FIELD]) {
    const err = await checkHandler(req.user, changes[HANDLER_FIELD].to, group);
    if (err) return res.status(400).json({ error: err });
  }
  await sf(`/sobjects/Case/${before.Id}`, { method: 'PATCH', body: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])) });
  await audit({
    email: req.user.email, action: 'update', case_id: before.Id, case_number: before.CaseNumber,
    changes: await describeChanges(meta, changes, before), group_name: group?.name,
  });
  res.json({ ok: true, changed: Object.keys(changes).length });
}));

// Who owns a new request on this board: the clinic's Salesforce user; on the staff board the
// creator's own Salesforce user (matched by email), else the board's default owner, else the API user.
async function newCaseOwner(user, board, groups) {
  if (board.kind === 'clinic') {
    const ids = board.sf_owner_ids || [];
    const id = ids.includes(board.default_owner_id) ? board.default_owner_id : ids[0];
    if (!isId(id)) throw bad(`לא הוגדר משתמש סיילספורס ל${board.name}`);
    return id;
  }
  const clinicOwners = new Set(groups.filter((g) => g.kind === 'clinic').flatMap((g) => g.sf_owner_ids || []));
  const own = await sfUserByEmail(user.email);
  if (own && !clinicOwners.has(own.Id)) return own.Id;
  return isId(board.default_owner_id) && !clinicOwners.has(board.default_owner_id) ? board.default_owner_id : null;
}

api.post('/requests', wrap(async (req, res) => {
  const meta = await getMeta();
  const groups = await listGroups();
  const boardId = canSeeAll(req.user) ? parseInt(req.body?.boardId, 10) : req.user.groupId;
  const board = groups.find((g) => g.id === boardId);
  if (!board) return res.status(canSeeAll(req.user) ? 400 : 403).json({ error: canSeeAll(req.user) ? 'יש לבחור לוח' : 'לא הוגדרה לך קבוצה' });
  const { out, errors } = cleanInput(meta, req.body?.fields, 'create');
  const missing = Object.values(meta.fields).filter((f) => f.required && (out[f.name] ?? null) === null).map((f) => f.label);
  if (missing.length) errors.unshift(`שדות חובה: ${missing.join(', ')}`);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const handlerError = await checkHandler(req.user, out[HANDLER_FIELD], board);
  if (handlerError) return res.status(400).json({ error: handlerError });
  const ownerId = await newCaseOwner(req.user, board, groups);
  const body = { ...out, RecordTypeId: meta.recordTypeId, ...(ownerId ? { OwnerId: ownerId } : {}) };
  const created = await sf('/sobjects/Case', { method: 'POST', body });
  const r = await query(`SELECT CaseNumber, Owner.Name FROM Case WHERE Id = '${created.id}'`);
  const caseNumber = r.records[0]?.CaseNumber;
  const changes = await describeChanges(meta, Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null).map(([k, v]) => [k, { from: null, to: v }])));
  changes.OwnerId = { label: 'בעלים', from: null, to: ownerId, toText: r.records[0]?.Owner?.Name || ownerId };
  await audit({ email: req.user.email, action: 'create', case_id: created.id, case_number: caseNumber, changes, group_name: board.name });
  res.status(201).json({ id: created.id, caseNumber });
}));

// Handler options: portal users with a Contact. Students and employees get their own group only;
// managers and admins get every group, the request's own group first.
api.get('/lookup/handler', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
  const groups = await listGroups();
  const preferred = canSeeAll(req.user) ? parseInt(req.query.group, 10) || null : req.user.groupId;
  const users = (await listUsers()).filter((u) => isId(u.sf_contact_id)
    && (canSeeAll(req.user) || u.group_id === req.user.groupId)
    && (!q || `${u.name || ''} ${u.email}`.toLowerCase().includes(q)));
  users.sort((a, b) => (b.group_id === preferred) - (a.group_id === preferred) || String(a.name || a.email).localeCompare(String(b.name || b.email), 'he'));
  res.json({
    records: users.slice(0, 50).map((u) => ({
      id: u.sf_contact_id,
      name: u.name || u.email,
      sub: canSeeAll(req.user) ? groups.find((g) => g.id === u.group_id)?.name : null,
    })),
  });
}));

// Search for Contacts / Accounts to fill the other lookup fields. Contacts of portal users in
// other groups are left out for students and employees.
api.get('/lookup/:object', wrap(async (req, res) => {
  const object = req.params.object;
  if (!['Contact', 'Account'].includes(object)) return res.status(400).json({ error: 'bad object' });
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ records: [] });
  const where = [`Name LIKE ${soqlContains(q)}`];
  if (object === 'Contact' && !canSeeAll(req.user)) {
    const hidden = (await listUsers()).filter((u) => isId(u.sf_contact_id) && u.group_id !== req.user.groupId).map((u) => `'${u.sf_contact_id}'`);
    if (hidden.length) where.push(`Id NOT IN (${hidden.join(', ')})`);
  }
  const extra = object === 'Contact' ? ', Email, Account.Name' : '';
  const r = await query(`SELECT Id, Name${extra} FROM ${object} WHERE ${where.join(' AND ')} ORDER BY Name LIMIT 20`);
  res.json({ records: r.records.map((x) => ({ id: x.Id, name: x.Name, sub: [x.Account?.Name, x.Email].filter(Boolean).join(' · ') })) });
}));

// ---- admin ----

api.get('/admin/owners', requireAdmin, wrap(async (req, res) => {
  const r = await query("SELECT Id, Name, Email FROM User WHERE IsActive = true AND UserType = 'Standard' AND (NOT Name LIKE '%Integration%') ORDER BY Name");
  res.json({ records: r.records.map((u) => ({ id: u.Id, name: u.Name, email: u.Email })) });
}));

// ---- admin: groups ----

api.get('/admin/groups', requireAdmin, wrap(async (req, res) => {
  const [groups, users] = await Promise.all([listGroups(), listUsers()]);
  res.json({ groups: groups.map((g) => ({ ...g, members: users.filter((u) => u.group_id === g.id).length })) });
}));

async function sfUserNames(ids) {
  if (!ids.length) return new Map();
  const r = await query(`SELECT Id, Name FROM User WHERE Id IN (${ids.map((id) => `'${id}'`).join(', ')})`);
  return new Map(r.records.map((u) => [u.Id, u.Name]));
}

async function writeGroup(req, res, current) {
  const groups = await listGroups();
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) throw bad('יש לתת שם לקבוצה');
  if (groups.some((g) => g.name === name && g.id !== current?.id)) throw bad('כבר יש קבוצה בשם הזה');
  const kind = current?.kind || 'clinic';
  const ownerIds = kind === 'clinic' ? [...new Set((req.body?.sf_owner_ids || []).filter(isId))] : [];
  const defaultOwnerId = isId(req.body?.default_owner_id) ? req.body.default_owner_id : null;
  if (kind === 'clinic' && !ownerIds.length) throw bad('יש לבחור לפחות משתמש סיילספורס אחד שהבקשות שלו שייכות לקליניקה');
  const otherClinicOwners = new Set(groups.filter((g) => g.kind === 'clinic' && g.id !== current?.id).flatMap((g) => g.sf_owner_ids || []));
  if (ownerIds.some((id) => otherClinicOwners.has(id))) throw bad('משתמש סיילספורס יכול להשתייך לקליניקה אחת בלבד');
  if (kind === 'staff' && defaultOwnerId && groups.some((g) => g.kind === 'clinic' && g.sf_owner_ids.includes(defaultOwnerId))) throw bad('בעלים ברירת מחדל של לוח העובדים לא יכול להיות משתמש של קליניקה');
  const effectiveDefault = kind === 'clinic' ? (ownerIds.includes(defaultOwnerId) ? defaultOwnerId : ownerIds[0]) : defaultOwnerId;
  const names = await sfUserNames([...new Set([...ownerIds, effectiveDefault].filter(Boolean))]);
  const missing = [...ownerIds, effectiveDefault].filter((id) => id && !names.has(id));
  if (missing.length) throw bad('משתמש סיילספורס לא נמצא');
  const sort = Number.isFinite(Number(req.body?.sort)) ? Number(req.body.sort) : current?.sort ?? groups.length;
  const saved = await saveGroup({
    id: current?.id, name, kind, sf_owner_ids: ownerIds, sort,
    default_owner_id: effectiveDefault, default_owner_name: effectiveDefault ? names.get(effectiveDefault) : null,
  });
  const ownersText = (ids) => (ids || []).map((id) => names.get(id) || id).join(', ') || null;
  const changes = {};
  const diff = (key, label, from, to) => { if (String(from ?? '') !== String(to ?? '')) changes[key] = { label, from: from ?? null, to: to ?? null }; };
  diff('name', 'שם', current?.name, saved.name);
  diff('sf_owner_ids', 'משתמשי סיילספורס', ownersText(current?.sf_owner_ids), ownersText(saved.sf_owner_ids));
  diff('default_owner', 'בעלים לבקשות חדשות', current?.default_owner_name, saved.default_owner_name);
  diff('sort', 'סדר', current?.sort, saved.sort);
  if (Object.keys(changes).length) {
    await audit({ email: req.user.email, action: current ? 'group_update' : 'group_create', target: saved.name, group_name: saved.name, changes });
  }
  res.json({ group: saved });
}

api.post('/admin/groups', requireAdmin, wrap(async (req, res) => writeGroup(req, res, null)));

api.patch('/admin/groups/:id', requireAdmin, wrap(async (req, res) => {
  const current = (await listGroups()).find((g) => g.id === parseInt(req.params.id, 10));
  if (!current) return res.status(404).json({ error: 'הקבוצה לא נמצאה' });
  return writeGroup(req, res, current);
}));

// ---- admin: users ----

api.get('/admin/users', requireAdmin, wrap(async (req, res) => {
  res.json({ users: await listUsers(), envAdmins: [...adminEmails], roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) });
}));

const userDiff = (before, after, groups) => {
  const gname = (id) => groups.find((g) => g.id === id)?.name ?? null;
  const changes = {};
  const diff = (key, label, from, to) => { if ((from ?? null) !== (to ?? null)) changes[key] = { label, from: from ?? null, to: to ?? null }; };
  diff('name', 'שם', before?.name, after.name);
  diff('role', 'תפקיד', ROLE_LABELS[before?.role], ROLE_LABELS[after.role]);
  diff('group', 'קבוצה', gname(before?.group_id), gname(after.group_id));
  diff('sf_contact_id', 'איש קשר בסיילספורס', before?.sf_contact_id, after.sf_contact_id);
  return changes;
};

// Saves users and links each to a Salesforce Contact (found by email or created) if not linked yet.
async function saveUsers(actor, people, groups) {
  const current = new Map((await listUsers()).map((u) => [u.email, u]));
  const needContact = people.filter((p) => !isId(p.sf_contact_id ?? current.get(p.email)?.sf_contact_id));
  let contacts = new Map();
  if (needContact.length) {
    try {
      contacts = await ensureContacts(needContact.map((p) => ({ email: p.email, name: p.name })));
    } catch (e) {
      const error = sfMessage(e);
      contacts = new Map(needContact.map((p) => [p.email, { error }]));
    }
  }
  const results = [];
  for (const p of people) {
    const before = current.get(p.email) || null;
    const c = contacts.get(p.email);
    const row = {
      email: p.email,
      name: p.name ?? before?.name ?? null,
      role: p.role ?? before?.role,
      group_id: p.group_id ?? before?.group_id ?? null,
      sf_contact_id: c?.id || before?.sf_contact_id || null,
      contact_error: c?.error || (c?.id || before?.sf_contact_id ? null : before?.contact_error) || null,
      created_by: before?.created_by || actor,
    };
    await upsertUser(row);
    results.push({ before, after: row, changes: userDiff(before, row, groups), contact: c || null });
  }
  return results;
}

api.post('/admin/users', requireAdmin, wrap(async (req, res) => {
  const groups = await listGroups();
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw bad('כתובת מייל לא תקינה');
  const before = await findUser(email);
  const role = req.body?.role ?? before?.role;
  if (!ROLES.includes(role)) throw bad('יש לבחור תפקיד');
  const groupId = parseInt(req.body?.groupId, 10);
  if (!groups.some((g) => g.id === groupId)) throw bad('יש לבחור קבוצה');
  const name = req.body?.name === undefined ? before?.name : String(req.body.name).replace(/\s+/g, ' ').trim().slice(0, 100) || null;
  const [r] = await saveUsers(req.user.email, [{ email, name, role, group_id: groupId }], groups);
  if (Object.keys(r.changes).length) {
    await audit({ email: req.user.email, action: before ? 'user_update' : 'user_create', target: email, group_name: groups.find((g) => g.id === groupId)?.name, changes: r.changes });
  }
  res.json({ ok: true, user: r.after, contactError: r.after.contact_error });
}));

// Retries finding / creating the Contact for a user whose first attempt failed.
api.post('/admin/users/:email/contact', requireAdmin, wrap(async (req, res) => {
  const user = await findUser(String(req.params.email).toLowerCase());
  if (!user) return res.status(404).json({ error: 'המשתמש לא נמצא' });
  const [r] = await saveUsers(req.user.email, [{ email: user.email }], await listGroups());
  if (Object.keys(r.changes).length) await audit({ email: req.user.email, action: 'user_update', target: user.email, changes: r.changes });
  res.json({ ok: !r.after.contact_error, user: r.after, contactError: r.after.contact_error });
}));

api.delete('/admin/users/:email', requireAdmin, wrap(async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const before = await findUser(email);
  if (!before) return res.status(404).json({ error: 'המשתמש לא נמצא' });
  await deleteUser(email);
  const group = (await listGroups()).find((g) => g.id === before.group_id);
  await audit({ email: req.user.email, action: 'user_delete', target: email, group_name: group?.name, changes: { email, name: before.name, role: ROLE_LABELS[before.role] } });
  res.json({ ok: true });
}));

// ---- admin: CSV import ----

async function importPlan(req) {
  const groups = await listGroups();
  const group = groups.find((g) => g.id === parseInt(req.body?.groupId, 10));
  if (!group) throw bad('יש לבחור קבוצה');
  const role = ['student', 'employee'].includes(req.body?.role) ? req.body.role : 'student';
  const { rows, header } = parsePeople(req.body?.text);
  if (!rows.length) throw bad('הקובץ ריק');
  if (rows.length > 2000) throw bad('אפשר לייבא עד 2,000 שורות בכל פעם');
  const current = new Map((await listUsers()).map((u) => [u.email, u]));
  const gname = (id) => groups.find((g) => g.id === id)?.name || '—';
  for (const r of rows) {
    if (r.error) { r.status = 'invalid'; continue; }
    const u = current.get(r.email);
    if (!u) { r.status = 'new'; continue; }
    const notes = [];
    if (u.group_id !== group.id) notes.push(`מעבר מ${gname(u.group_id)}`);
    if (u.name !== r.name) notes.push(`שם: ${u.name || '—'} ← ${r.name}`);
    r.status = notes.length ? 'update' : 'same';
    r.note = notes.join(' · ') || 'קיים, ללא שינוי';
    r.role = ROLE_LABELS[u.role];
  }
  return { groups, group, role, rows, header };
}

api.post('/admin/import/preview', requireAdmin, wrap(async (req, res) => {
  const { group, role, rows, header } = await importPlan(req);
  const count = (s) => rows.filter((r) => r.status === s).length;
  res.json({ group: groupInfo(group), role, header, rows, counts: { new: count('new'), update: count('update'), same: count('same'), invalid: count('invalid') } });
}));

api.post('/admin/import', requireAdmin, wrap(async (req, res) => {
  const { groups, group, role, rows } = await importPlan(req);
  const todo = rows.filter((r) => r.status === 'new' || r.status === 'update');
  const results = await saveUsers(req.user.email, todo.map((r) => ({
    email: r.email, name: r.name, group_id: group.id, ...(r.status === 'new' ? { role } : {}),
  })), groups);
  const contactErrors = results.filter((r) => r.after.contact_error).map((r) => ({ email: r.after.email, error: r.after.contact_error }));
  const summary = {
    added: results.filter((r) => !r.before).map((r) => r.after.email),
    updated: results.filter((r) => r.before).map((r) => r.after.email),
    invalid: rows.filter((r) => r.status === 'invalid').map((r) => ({ line: r.line, email: r.email, error: r.error })),
    contactErrors,
    role: ROLE_LABELS[role],
  };
  await audit({ email: req.user.email, action: 'import', target: `${summary.added.length + summary.updated.length} משתמשים`, group_name: group.name, changes: summary });
  res.json({ ok: true, added: summary.added.length, updated: summary.updated.length, invalid: summary.invalid.length, contactErrors });
}));

// ---- admin: log ----

api.get('/admin/audit', requireAdmin, wrap(async (req, res) => {
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const result = await searchAudit({
    email: String(req.query.email || '').trim().toLowerCase() || null,
    caseNumber: /^\d{1,12}$/.test(req.query.case || '') ? req.query.case : null,
    action: String(req.query.action || '').slice(0, 40) || null,
    from: date(req.query.from),
    to: date(req.query.to),
    page,
    pageSize: 50,
  });
  res.json({ ...result, page, pageSize: 50 });
}));
