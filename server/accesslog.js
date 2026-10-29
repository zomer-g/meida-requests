// Access log for supervision: every API request (reads too), every new sign-in session and every
// denied attempt, with who, when, what, result, IP and user agent. Rows are queued in memory and
// written in batches, so logging never delays or fails a request. Field-level edits stay in audit_log.
// Never logged: request bodies, search text, file contents, tokens.

import { insertAccess, pruneAccess } from './db.js';
import { query, isId } from './salesforce.js';

const FLUSH_MS = 2000;
const MAX_QUEUE = 5000;
export const RETENTION_DAYS = Math.max(1, parseInt(process.env.ACCESS_LOG_RETENTION_DAYS, 10) || 365);

let queue = [];
const seenSessions = new Set();
const caseNumbers = new Map(); // case id -> CaseNumber, filled by loadCase

export function rememberCase(id, caseNumber) {
  if (caseNumbers.size > 20000) caseNumbers.clear();
  caseNumbers.set(id, caseNumber);
}

// What a request was, from its method and path (the API's own routes).
const ACTIONS = [
  ['GET', /^\/me$/, 'app_open'],
  ['GET', /^\/(meta|boards)$/, 'app_config'],
  ['GET', /^\/requests$/, 'list_requests'],
  ['POST', /^\/requests$/, 'create_request'],
  ['GET', /^\/requests\/([^/]+)$/, 'view_request'],
  ['PATCH', /^\/requests\/([^/]+)$/, 'update_request'],
  ['GET', /^\/requests\/([^/]+)\/activity$/, 'view_activity'],
  ['POST', /^\/requests\/([^/]+)\/activity$/, 'post_activity'],
  ['GET', /^\/requests\/([^/]+)\/activity\/files\/([^/]+)$/, 'download_file'],
  ['GET', /^\/lookup\/([^/]+)$/, 'lookup'],
  ['GET', /^\/admin\/audit$/, 'admin_view_edit_log'],
  ['GET', /^\/admin\/access(\.csv)?$/, 'admin_view_access_log'],
  ['GET', /^\/admin\/access\/summary$/, 'admin_view_access_log'],
  ['POST', /^\/admin\/import(\/preview)?$/, 'admin_import'],
  [null, /^\/admin\/users/, 'admin_users'],
  [null, /^\/admin\/groups/, 'admin_groups'],
  [null, /^\/admin\//, 'admin_other'],
];

function classify(method, path) {
  for (const [m, re, action] of ACTIONS) {
    if (m && m !== method) continue;
    const match = path.match(re);
    if (!match) continue;
    const caseId = path.startsWith('/requests/') && isId(match[1]) ? match[1] : null;
    const target = action === 'download_file' ? match[2] : action === 'lookup' ? match[1] : null;
    return { action, caseId, target };
  }
  return { action: 'other', caseId: null, target: null };
}

// Route without ids or free text, plus the few query parameters worth keeping.
function routeOf(path, q) {
  const route = path.replace(/\/[a-zA-Z0-9]{15,18}(?=\/|$)/g, '/:id').replace(/\/files\/[^/]+/, '/files/:file');
  const keep = ['board', 'status', 'page', 'group'].filter((k) => q[k] !== undefined && q[k] !== '').map((k) => `${k}=${String(q[k]).slice(0, 20)}`);
  return keep.length ? `${route}?${keep.join('&')}` : route;
}

// Express middleware on /api: records the request once the response has been sent.
export function accessLog(req, res, next) {
  const started = new Date();
  const path = req.path; // relative to /api; Express restores req.url once the router is done
  const q = { ...req.query };
  res.on('finish', () => {
    try {
      const who = req.identity; // set by requireUser once the token is verified
      if (!who) return; // no valid sign-in at all (a 401 before login): nothing to attribute
      const { action, caseId, target } = classify(req.method, path);
      const status = res.statusCode;
      const base = {
        email: who.email, ip: req.ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
        session_id: who.session || null,
      };
      if (who.session && !seenSessions.has(who.session)) {
        if (seenSessions.size > 50000) seenSessions.clear();
        seenSessions.add(who.session);
        queue.push({ ...base, at: who.issuedAt || started, kind: 'session', action: 'sign_in' });
      }
      let kind = req.method === 'GET' ? 'read' : 'write';
      let reason = null;
      if (status === 401 || status === 403) { kind = 'denied'; reason = res.locals.denyReason || (status === 403 ? 'forbidden' : 'not_signed_in'); }
      else if (status >= 500) kind = 'error';
      queue.push({
        ...base, at: started, kind, action, method: req.method, route: routeOf(path, q), status, reason,
        case_id: caseId, case_number: caseId ? caseNumbers.get(caseId) || null : null, target,
      });
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    } catch (e) {
      console.error('[access] record', e.message);
    }
  });
  next();
}

// A 404 on a request id is either a wrong id or a case outside the user's board; the second is a
// denied attempt. One unscoped query per batch tells them apart and fills the CaseNumber.
async function resolveNotFound(rows) {
  const ids = [...new Set(rows.filter((r) => r.status === 404 && r.case_id).map((r) => r.case_id))];
  if (!ids.length) return;
  try {
    const r = await query(`SELECT Id, CaseNumber FROM Case WHERE Id IN (${ids.map((id) => `'${id}'`).join(', ')})`);
    const found = new Map(r.records.map((c) => [c.Id, c.CaseNumber]));
    for (const row of rows) {
      if (row.status !== 404 || !found.has(row.case_id)) continue;
      row.kind = 'denied';
      row.reason = 'outside_board';
      row.case_number = found.get(row.case_id);
    }
  } catch (e) {
    console.error('[access] resolve', e.message);
  }
}

async function flush() {
  if (!queue.length) return;
  const rows = queue;
  queue = [];
  await resolveNotFound(rows);
  try {
    for (let i = 0; i < rows.length; i += 500) await insertAccess(rows.slice(i, i + 500));
  } catch (e) {
    console.error('[access] write', e.message);
  }
}

// Starts the batch writer and the daily retention cleanup (ACCESS_LOG_RETENTION_DAYS, default 365).
export function startAccessLog() {
  setInterval(flush, FLUSH_MS).unref();
  const prune = () => pruneAccess(RETENTION_DAYS)
    .then((n) => { if (n) console.log(`[access] removed ${n} entries older than ${RETENTION_DAYS} days`); })
    .catch((e) => console.error('[access] prune', e.message));
  prune();
  setInterval(prune, 24 * 60 * 60 * 1000).unref();
}
