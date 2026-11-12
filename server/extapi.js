// External API (/api/v1): lets other systems read, create and update FOI requests with a shared
// token instead of a Google sign-in. Documented at /api-docs (public/api-docs.html).
//
// - The token lives only on the server, in the API_TOKEN secret (several tokens separated by commas,
//   so one can be rotated without downtime). Without API_TOKEN the external API is off (503).
// - Callers send `Authorization: Bearer <token>`, and may name themselves with `X-Client-Name`.
// - Every call, including a refused token, goes to the access log (accesslog.js) as `api:<client>`;
//   every create and update also goes to the edit log (audit_log), field by field, like the portal.
// - The API acts with the rights of an admin over request Cases (all boards), and never deletes.

import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sf, query, isId, soqlString, soqlContains, SalesforceError } from './salesforce.js';
import { getMeta } from './meta.js';
import { SECTIONS, LOOKUPS, HANDLER_FIELD, READONLY_FIELDS, REQUEST_RECORD_TYPE } from './fields.js';
import { audit, auditFor, listGroups, listUsers, findUser } from './db.js';
import { groupOfOwner, boardFilter, sfUserByEmail } from './access.js';
import { isEmail } from './csv.js';
import {
  loadCase, cleanInput, checkHandler, describeChanges, newCaseOwner, sfMessage, bad, groupInfo,
} from './routes.js';
import { rememberCase } from './accesslog.js';

export const extApi = express.Router();

// Public, for the docs page: field names, sections and which are required, from fields.js only
// (no Salesforce call, no labels or values). Labels, types and allowed values come from GET /api/v1/fields.
export const docsSchema = (req, res) => res.set('Cache-Control', 'public, max-age=300').json({
  enabled: TOKENS.length > 0,
  sections: SECTIONS.map((s) => ({ key: s.key, title: s.title, fields: s.fields.map((f) => ({ name: f.name, required: !!f.required })) })),
  lookups: { ...LOOKUPS, [HANDLER_FIELD]: 'PortalUser' },
});

const digest = (s) => createHash('sha256').update(String(s)).digest();
const TOKENS = (process.env.API_TOKEN || '').split(',').map((t) => t.trim()).filter((t) => t.length >= 24).map(digest);
export const apiEnabled = () => TOKENS.length > 0;
if ((process.env.API_TOKEN || '').trim() && !TOKENS.length) console.error('[extapi] API_TOKEN is shorter than 24 characters, the external API stays off');

// Refused tokens per IP: after 20 in 10 minutes the IP gets 429 until the window ends.
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 20;
const failures = new Map(); // ip -> { n, since }

function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > FAIL_WINDOW_MS) { failures.delete(ip); return false; }
  return f.n >= FAIL_LIMIT;
}

function noteFailure(ip) {
  if (failures.size > 10000) failures.clear();
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > FAIL_WINDOW_MS) failures.set(ip, { n: 1, since: Date.now() });
  else f.n++;
}

const tokenOk = (given) => {
  if (!given) return false;
  const d = digest(given);
  let ok = false;
  for (const t of TOKENS) ok = timingSafeEqual(d, t) || ok; // compare with every token, no early exit
  return ok;
};

const clientName = (req) => String(req.headers['x-client-name'] || '').replace(/[^\w.\-]/g, '').slice(0, 40);

// The pseudo-user the API acts as: an admin over request Cases (all boards).
const apiUser = (client) => ({ email: `api:${client || 'client'}`, name: client || 'API', role: 'admin', groupId: null, sfUserId: null });

function requireToken(req, res, next) {
  const client = clientName(req);
  // The access log attributes the request to this identity, refused ones included.
  req.identity = { email: `api:${client || 'client'}`, session: null };
  res.set('Cache-Control', 'no-store');
  if (!apiEnabled()) return res.status(503).json({ error: 'api_disabled', message: 'ה-API החיצוני לא הופעל בשרת (API_TOKEN לא הוגדר)' });
  if (tooManyFailures(req.ip)) {
    res.locals.denyReason = 'rate_limited';
    return res.status(429).json({ error: 'too_many_attempts', message: 'יותר מדי ניסיונות עם טוקן שגוי. נסו שוב בעוד כמה דקות.' });
  }
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (!tokenOk(m?.[1])) {
    noteFailure(req.ip);
    res.locals.denyReason = m ? 'bad_token' : 'no_token';
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: m ? 'bad_token' : 'no_token', message: 'נדרש טוקן תקין בכותרת Authorization: Bearer <token>' });
  }
  req.user = apiUser(client);
  next();
}

extApi.use(requireToken); // before the body parser, so a refused call never has its body read
extApi.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[extapi]', req.method, req.path, e.message);
  const status = (e instanceof SalesforceError || e.expose) && e.status < 500 ? (e.status === 404 ? 404 : 400) : 500;
  res.status(status).json({ error: status === 500 ? 'server_error' : 'bad_request', message: sfMessage(e) });
});

const fail = (res, status, error, message, extra = {}) => res.status(status).json({ error, message, ...extra });

// A request is addressed by its Salesforce Id or by its case number (digits, leading zeros optional).
async function findCase(user, key, res) {
  let id = null;
  if (isId(key)) id = key;
  else if (/^\d{1,10}$/.test(key)) {
    const r = await query(`SELECT Id FROM Case WHERE CaseNumber = ${soqlString(key.padStart(8, '0'))} AND RecordType.DeveloperName = '${REQUEST_RECORD_TYPE}' LIMIT 1`);
    id = r.records[0]?.Id || null;
  }
  const record = id ? await loadCase(user, id) : null;
  if (record) res.locals.logCase = { id: record.Id, number: record.CaseNumber }; // for the access log
  return record;
}

// Board by id or by exact name.
function findBoard(groups, value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return groups.find((g) => (Number.isInteger(n) && g.id === n) || g.name === String(value).trim()) || null;
}

// Lookup fields accept a Salesforce Id, or an object that names the record:
//   request_org_name__c  { "name": "<exact Account name>" }
//   request_initiator__c { "email": "<Contact email>" }
//   metapel_bakasha__c   { "email": "<portal user email>" }
async function resolveLookups(meta, fields) {
  const out = { ...fields };
  const errors = [];
  for (const [name, v] of Object.entries(fields)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    delete out[name]; // set again below once found, so a miss is reported once
    const label = meta.fields[name]?.label || name;
    const object = name === HANDLER_FIELD ? 'handler' : LOOKUPS[name];
    if (!object) { errors.push(`${label}: ערך לא תקין`); continue; }
    if (object === 'handler') {
      const email = String(v.email || '').trim().toLowerCase();
      const u = isEmail(email) ? await findUser(email) : null;
      if (!u) errors.push(`${label}: לא נמצא משתמש פורטל עם המייל ${email}`);
      else if (!isId(u.sf_contact_id)) errors.push(`${label}: למשתמש ${email} אין כרטיס איש קשר בסיילספורס`);
      else out[name] = u.sf_contact_id;
    } else if (object === 'Contact') {
      const email = String(v.email || '').trim();
      if (!isEmail(email.toLowerCase())) { errors.push(`${label}: יש לתת email`); continue; }
      const r = await query(`SELECT Id FROM Contact WHERE Email = ${soqlString(email)} ORDER BY CreatedDate LIMIT 1`);
      if (!r.records[0]) errors.push(`${label}: לא נמצא איש קשר עם המייל ${email}`);
      else out[name] = r.records[0].Id;
    } else {
      const nm = String(v.name || '').trim();
      if (!nm) { errors.push(`${label}: יש לתת name`); continue; }
      const r = await query(`SELECT Id FROM ${object} WHERE Name = ${soqlString(nm)} LIMIT 2`);
      if (!r.records.length) errors.push(`${label}: לא נמצא "${nm}"`);
      else if (r.records.length > 1) errors.push(`${label}: יש יותר מרשומה אחת בשם "${nm}", יש לשלוח Id`);
      else out[name] = r.records[0].Id;
    }
  }
  return { out, errors };
}

// Unknown or read-only field names are an error here (the portal form silently ignores them).
function unknownFields(meta, fields, mode) {
  return Object.keys(fields).filter((k) => {
    const f = meta.fields[k];
    return !f || !(mode === 'create' ? f.createable : f.updateable);
  });
}

function readFields(body) {
  const f = body?.fields;
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('גוף הבקשה חייב לכלול אובייקט fields');
  return f;
}

// The request as the API returns it: every portal field, the read-only header fields and lookup names.
function present(meta, record, groups) {
  const fields = {};
  for (const name of Object.keys(meta.fields)) fields[name] = record[name] ?? null;
  const names = {};
  for (const name of [...Object.keys(LOOKUPS), HANDLER_FIELD]) {
    const rel = record[name.replace(/__c$/, '__r')];
    if (rel?.Name) names[name] = rel.Name;
  }
  const head = Object.fromEntries(READONLY_FIELDS.map((k) => [k, record[k] ?? null]));
  return {
    id: record.Id,
    caseNumber: record.CaseNumber,
    ownerName: record.Owner?.Name || null,
    board: groupInfo(groupOfOwner(record.OwnerId, groups)),
    lastModified: record.LastModifiedDate,
    ...head,
    fields,
    lookupNames: names,
  };
}

// ---- endpoints ----

extApi.get('/ping', (req, res) => res.json({ ok: true, client: req.user.email }));

// Every field: name, label, type, required, length, help and the allowed values of picklists.
extApi.get('/fields', wrap(async (req, res) => {
  const meta = await getMeta();
  res.json({
    sections: meta.sections.map((s) => ({
      key: s.key,
      title: s.title,
      fields: s.fields.map((f) => ({
        name: f.name, label: f.label, type: f.type, required: f.required, length: f.length || null, help: f.help,
        createable: f.createable, updateable: f.updateable,
        lookup: f.lookup === 'handler' ? 'PortalUser' : f.lookup,
        options: f.options,
      })),
    })),
  });
}));

extApi.get('/boards', wrap(async (req, res) => {
  const groups = await listGroups();
  res.json({
    boards: groups.map((g) => ({
      ...groupInfo(g),
      owner: g.kind === 'clinic' ? { id: g.default_owner_id || g.sf_owner_ids?.[0] || null, name: g.default_owner_name || null } : null,
      ownerRequired: g.kind === 'staff',
    })),
  });
}));

// Values for lookup fields: Account / Contact by name, or the portal users that may handle requests.
extApi.get('/lookup/:object', wrap(async (req, res) => {
  const object = req.params.object;
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (object === 'handler') {
    const groups = await listGroups();
    const users = (await listUsers()).filter((u) => isId(u.sf_contact_id)
      && (!q || `${u.name || ''} ${u.email}`.toLowerCase().includes(q.toLowerCase())));
    return res.json({
      records: users.slice(0, 200).map((u) => ({ id: u.sf_contact_id, name: u.name || u.email, email: u.email, group: groups.find((g) => g.id === u.group_id)?.name || null })),
    });
  }
  if (!['Contact', 'Account'].includes(object)) return fail(res, 400, 'bad_object', 'object חייב להיות Account, Contact או handler');
  if (q.length < 2) return fail(res, 400, 'short_query', 'יש לתת q באורך 2 תווים לפחות');
  const extra = object === 'Contact' ? ', Email, Account.Name' : '';
  const r = await query(`SELECT Id, Name${extra} FROM ${object} WHERE Name LIKE ${soqlContains(q)} ORDER BY Name LIMIT 50`);
  res.json({ records: r.records.map((x) => ({ id: x.Id, name: x.Name, ...(object === 'Contact' ? { email: x.Email || null, account: x.Account?.Name || null } : {}) })) });
}));

// Search: by case number, the authority's reference, free text, board, status and modification time.
extApi.get('/requests', wrap(async (req, res) => {
  const where = [`RecordType.DeveloperName = '${REQUEST_RECORD_TYPE}'`];
  const groups = await listGroups();
  const { caseNumber, asmahta, q, status, board, modifiedSince } = req.query;
  if (caseNumber) {
    if (!/^\d{1,10}$/.test(caseNumber)) return fail(res, 400, 'bad_case_number', 'caseNumber חייב להיות מספר');
    where.push(`CaseNumber = ${soqlString(String(caseNumber).padStart(8, '0'))}`);
  }
  if (asmahta) where.push(`asmahta_gov_number__c = ${soqlString(String(asmahta).slice(0, 255))}`);
  if (q) {
    const like = soqlContains(String(q).trim().slice(0, 80));
    where.push(`(request_name__c LIKE ${like} OR asmahta_gov_number__c LIKE ${like} OR request_org_name__r.Name LIKE ${like})`);
  }
  if (status) where.push(`Status = ${soqlString(String(status).slice(0, 255))}`);
  if (board) {
    const g = findBoard(groups, board);
    if (!g) return fail(res, 400, 'bad_board', 'לוח לא נמצא');
    const f = boardFilter(g, groups);
    if (f) where.push(f);
  }
  if (modifiedSince) {
    const t = Date.parse(modifiedSince);
    if (Number.isNaN(t)) return fail(res, 400, 'bad_date', 'modifiedSince חייב להיות תאריך ISO 8601');
    where.push(`LastModifiedDate >= ${new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  }
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, Math.min(2000, parseInt(req.query.offset, 10) || 0));
  const r = await query(`SELECT Id, CaseNumber, request_name__c, Status, request_date__c, asmahta_gov_number__c, OwnerId, Owner.Name, request_org_name__r.Name, LastModifiedDate
    FROM Case WHERE ${where.join(' AND ')} ORDER BY LastModifiedDate DESC, Id DESC LIMIT ${limit + 1} OFFSET ${offset}`);
  res.json({
    records: r.records.slice(0, limit).map((x) => ({
      id: x.Id, caseNumber: x.CaseNumber, name: x.request_name__c, status: x.Status, requestDate: x.request_date__c,
      asmahta: x.asmahta_gov_number__c, org: x.request_org_name__r?.Name || null, ownerName: x.Owner?.Name || null,
      board: groupOfOwner(x.OwnerId, groups)?.name || null, lastModified: x.LastModifiedDate,
    })),
    limit, offset, hasMore: r.records.length > limit,
  });
}));

extApi.get('/requests/:key', wrap(async (req, res) => {
  const meta = await getMeta();
  const record = await findCase(req.user, req.params.key, res);
  if (!record) return fail(res, 404, 'not_found', 'הבקשה לא נמצאה');
  const result = present(meta, record, await listGroups());
  if (req.query.history === '1') result.history = await auditFor(record.Id);
  res.json(result);
}));

extApi.post('/requests', wrap(async (req, res) => {
  const meta = await getMeta();
  const groups = await listGroups();
  const board = findBoard(groups, req.body?.board);
  if (!board) return fail(res, 400, 'bad_board', 'יש לתת board: מזהה או שם של לוח (ראו GET /api/v1/boards)');
  const raw = readFields(req.body);
  const unknown = unknownFields(meta, raw, 'create');
  if (unknown.length) return fail(res, 400, 'unknown_fields', `שדות לא מוכרים או שאי אפשר למלא: ${unknown.join(', ')}`, { fields: unknown });
  const resolved = await resolveLookups(meta, raw);
  const { out, errors } = cleanInput(meta, resolved.out, 'create');
  errors.unshift(...resolved.errors);
  const missing = Object.values(meta.fields).filter((f) => f.required && (out[f.name] ?? null) === null).map((f) => f.name);
  if (missing.length) errors.unshift(`שדות חובה חסרים: ${missing.join(', ')}`);
  if (errors.length) return fail(res, 400, 'invalid', errors.join('; '), { errors, ...(missing.length ? { missing } : {}) });

  // Staff board: the request is owned by the Salesforce user of owner_email (as a staff member
  // opening it in the portal would own it). Clinic board: the clinic's user, as in the portal.
  let ownerUser = req.user;
  if (board.kind === 'staff') {
    const email = String(req.body?.owner_email || '').trim().toLowerCase();
    if (!isEmail(email)) return fail(res, 400, 'owner_required', 'בלוח עובדי התנועה יש לתת owner_email: המייל של עובד/ת התנועה שהבקשה תשויך אליו/ה');
    const portal = await findUser(email);
    const sfUser = isId(portal?.sf_user_id) ? { Id: portal.sf_user_id } : await sfUserByEmail(email);
    if (!sfUser) return fail(res, 400, 'owner_not_found', `לא נמצא משתמש סיילספורס פעיל עבור ${email}`);
    ownerUser = { ...req.user, sfUserId: sfUser.Id };
  }
  const ownerId = newCaseOwner(ownerUser, board, groups);
  const handlerError = await checkHandler(req.user, out[HANDLER_FIELD], board);
  if (handlerError) return fail(res, 400, 'bad_handler', handlerError);

  const created = await sf('/sobjects/Case', { method: 'POST', body: { ...out, RecordTypeId: meta.recordTypeId, OwnerId: ownerId } });
  const r = await query(`SELECT CaseNumber, Owner.Name, LastModifiedDate FROM Case WHERE Id = '${created.id}'`);
  const caseNumber = r.records[0]?.CaseNumber;
  rememberCase(created.id, caseNumber);
  res.locals.logCase = { id: created.id, number: caseNumber };
  const changes = await describeChanges(meta, Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null).map(([k, v]) => [k, { from: null, to: v }])));
  changes.OwnerId = { label: 'בעלים', from: null, to: ownerId, toText: r.records[0]?.Owner?.Name || ownerId };
  await audit({ email: req.user.email, action: 'create', case_id: created.id, case_number: caseNumber, changes, group_name: board.name });
  res.status(201).json({ id: created.id, caseNumber, board: groupInfo(board), ownerName: r.records[0]?.Owner?.Name || null, lastModified: r.records[0]?.LastModifiedDate || null });
}));

extApi.patch('/requests/:key', wrap(async (req, res) => {
  const meta = await getMeta();
  const before = await findCase(req.user, req.params.key, res);
  if (!before) return fail(res, 404, 'not_found', 'הבקשה לא נמצאה');
  const seen = req.body?.lastModified;
  if (seen && Date.parse(seen) !== Date.parse(before.LastModifiedDate)) {
    return fail(res, 409, 'conflict', 'הבקשה עודכנה מאז lastModified שנשלח', { lastModified: before.LastModifiedDate });
  }
  const raw = readFields(req.body);
  const unknown = unknownFields(meta, raw, 'update');
  if (unknown.length) return fail(res, 400, 'unknown_fields', `שדות לא מוכרים או שאי אפשר לעדכן: ${unknown.join(', ')}`, { fields: unknown });
  const resolved = await resolveLookups(meta, raw);
  const { out, errors } = cleanInput(meta, resolved.out, 'update');
  errors.unshift(...resolved.errors);
  if (errors.length) return fail(res, 400, 'invalid', errors.join('; '), { errors });
  const changes = {};
  for (const [k, v] of Object.entries(out)) {
    if ((before[k] ?? null) !== v) changes[k] = { from: before[k] ?? null, to: v };
  }
  if (!Object.keys(changes).length) return res.json({ ok: true, id: before.Id, caseNumber: before.CaseNumber, changed: [], lastModified: before.LastModifiedDate });
  const missing = Object.keys(changes).filter((k) => meta.fields[k].required && changes[k].to === null);
  if (missing.length) return fail(res, 400, 'invalid', `אי אפשר לרוקן שדות חובה: ${missing.join(', ')}`, { missing });
  const group = groupOfOwner(before.OwnerId, await listGroups());
  if (changes[HANDLER_FIELD]) {
    const err = await checkHandler(req.user, changes[HANDLER_FIELD].to, group);
    if (err) return fail(res, 400, 'bad_handler', err);
  }
  await sf(`/sobjects/Case/${before.Id}`, { method: 'PATCH', body: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])) });
  await audit({
    email: req.user.email, action: 'update', case_id: before.Id, case_number: before.CaseNumber,
    changes: await describeChanges(meta, changes, before), group_name: group?.name,
  });
  const after = await query(`SELECT LastModifiedDate FROM Case WHERE Id = '${before.Id}'`);
  res.json({ ok: true, id: before.Id, caseNumber: before.CaseNumber, changed: Object.keys(changes), lastModified: after.records[0]?.LastModifiedDate || null });
}));

extApi.use((req, res) => fail(res, 404, 'no_such_endpoint', 'אין נקודת קצה כזו. התיעוד: /api-docs'));
// Malformed JSON or an oversized body, after the token was accepted.
extApi.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status === 413 ? 413 : 400;
  res.status(status).json({ error: status === 413 ? 'too_large' : 'bad_json', message: status === 413 ? 'גוף הבקשה גדול מ-1MB' : 'גוף הבקשה אינו JSON תקין' });
});
