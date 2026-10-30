// Portal users, groups and the audit log live in the channel's Postgres (DATABASE_URL, injected by xhostd).
// Without DATABASE_URL (local dev) an in-memory store is used instead.

import pg from 'pg';

const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 5 }) : null;
// An idle client's error (database restart, failover) must not take the process down.
pool?.on('error', (e) => console.error('[db] idle client error:', e.message));

export const ROLES = ['student', 'employee', 'manager', 'admin'];
export const GROUP_KINDS = ['clinic', 'staff'];

// The groups the portal starts with; more clinics are added from the admin UI.
const SEED_GROUPS = [
  { name: 'עובדי התנועה', kind: 'staff', sf_owner_ids: [], sort: 0 },
  { name: 'המרכז הבינתחומי', kind: 'clinic', sf_owner_ids: ['0051n000004X6q1AAC'], default_owner_id: '0051n000004X6q1AAC', default_owner_name: 'המרכז הבינתחומי', sort: 1 },
  { name: 'המכללה למנהל', kind: 'clinic', sf_owner_ids: ['0051n000004X6pwAAC'], default_owner_id: '0051n000004X6pwAAC', default_owner_name: 'המכללה למנהל', sort: 2 },
];

const mem = {
  users: new Map(),
  audit: [],
  groups: SEED_GROUPS.map((g, i) => ({ id: i + 1, default_owner_id: null, default_owner_name: null, ...g, created_at: new Date() })),
  auditSeq: 0,
};

export async function migrate() {
  if (!pool) return console.log('[db] no DATABASE_URL, using in-memory store');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portal_users (
      email          text PRIMARY KEY,
      name           text,
      role           text NOT NULL,
      sf_owner_id    text,
      sf_owner_name  text,
      created_by     text,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id          bigserial PRIMARY KEY,
      at          timestamptz NOT NULL DEFAULT now(),
      email       text NOT NULL,
      action      text NOT NULL,
      case_id     text,
      case_number text,
      changes     jsonb
    );
    CREATE INDEX IF NOT EXISTS audit_log_case_idx ON audit_log (case_id, at DESC);

    -- Groups: each has its own requests board. A clinic's cases are those owned by its Salesforce
    -- users; the single staff group's cases are those owned by anyone who is not a clinic owner.
    CREATE TABLE IF NOT EXISTS portal_groups (
      id                 serial PRIMARY KEY,
      name               text NOT NULL UNIQUE,
      kind               text NOT NULL CHECK (kind IN ('clinic', 'staff')),
      sf_owner_ids       text[] NOT NULL DEFAULT '{}',
      default_owner_id   text,
      default_owner_name text,
      sort               int NOT NULL DEFAULT 0,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS portal_groups_one_staff ON portal_groups (kind) WHERE kind = 'staff';

    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target text;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS group_name text;
    CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
    CREATE INDEX IF NOT EXISTS audit_log_number_idx ON audit_log (case_number);

    -- Access log: one row per API request and per new sign-in session (see accesslog.js).
    -- No request bodies, file contents or tokens; session_id is a hash prefix of the identity token.
    CREATE TABLE IF NOT EXISTS access_log (
      id          bigserial PRIMARY KEY,
      at          timestamptz NOT NULL DEFAULT now(),
      email       text,
      kind        text NOT NULL,
      action      text NOT NULL,
      method      text,
      route       text,
      status      int,
      reason      text,
      case_id     text,
      case_number text,
      target      text,
      ip          text,
      user_agent  text,
      session_id  text
    );
    CREATE INDEX IF NOT EXISTS access_log_email_at_idx ON access_log (email, at DESC);
    CREATE INDEX IF NOT EXISTS access_log_at_idx ON access_log (at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS access_log_session_idx ON access_log (session_id) WHERE kind = 'session';
  `);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT count(*)::int AS n FROM portal_groups');
    if (!rows[0].n) {
      for (const g of SEED_GROUPS) {
        await client.query(
          'INSERT INTO portal_groups (name, kind, sf_owner_ids, default_owner_id, default_owner_name, sort) VALUES ($1, $2, $3, $4, $5, $6)',
          [g.name, g.kind, g.sf_owner_ids, g.default_owner_id || null, g.default_owner_name || null, g.sort],
        );
      }
    }
    // One-time move from the old model (role admin/clinic + sf_owner_id) to group + role. It runs
    // only while group_id does not exist yet, so a second run, or role changes made later, are
    // never touched. No row or column is dropped; sf_owner_id / sf_owner_name stay as they were.
    //   clinic, owner is a clinic's Salesforce user -> student in that clinic
    //   clinic, owner is anyone else (a staff member) -> employee in the staff group, mapped to that Salesforce user
    //   admin -> manager in the staff group (ADMIN_EMAILS stay admins regardless of the row)
    await client.query(`
      ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS sf_user_id text;
      ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS sf_user_name text;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'portal_users' AND column_name = 'group_id') THEN
          ALTER TABLE portal_users ADD COLUMN group_id int REFERENCES portal_groups(id);
          ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
          UPDATE portal_users u SET group_id = g.id, role = 'student' FROM portal_groups g
            WHERE u.role = 'clinic' AND g.kind = 'clinic' AND u.sf_owner_id = ANY (g.sf_owner_ids);
          UPDATE portal_users SET group_id = (SELECT id FROM portal_groups WHERE kind = 'staff'), role = 'employee',
            sf_user_id = sf_owner_id, sf_user_name = sf_owner_name
            WHERE role = 'clinic';
          UPDATE portal_users SET group_id = (SELECT id FROM portal_groups WHERE kind = 'staff'), role = 'manager'
            WHERE role = 'admin';
        END IF;
      END $$;
      ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS sf_contact_id text;
      ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS contact_error text;
      ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS updated_at timestamptz;
      ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
      ALTER TABLE portal_users ADD CONSTRAINT portal_users_role_check CHECK (role IN ('student', 'employee', 'manager', 'admin'));
      CREATE INDEX IF NOT EXISTS portal_users_group_idx ON portal_users (group_id);
      CREATE INDEX IF NOT EXISTS portal_users_contact_idx ON portal_users (sf_contact_id);
    `);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log('[migrate] done');
}

// ---- groups ----

export async function listGroups() {
  if (!pool) return [...mem.groups].sort((a, b) => a.sort - b.sort || a.id - b.id);
  const { rows } = await pool.query('SELECT * FROM portal_groups ORDER BY sort, id');
  return rows;
}

export async function saveGroup(g) {
  if (!pool) {
    if (g.id) {
      const cur = mem.groups.find((x) => x.id === g.id);
      Object.assign(cur, g);
      return cur;
    }
    if (mem.groups.some((x) => x.name === g.name)) throw Object.assign(new Error('duplicate'), { code: '23505' });
    const row = { ...g, id: Math.max(0, ...mem.groups.map((x) => x.id)) + 1, created_at: new Date() };
    mem.groups.push(row);
    return row;
  }
  const values = [g.name, g.sf_owner_ids, g.default_owner_id, g.default_owner_name, g.sort ?? 0];
  if (g.id) {
    const { rows } = await pool.query(
      `UPDATE portal_groups SET name = $1, sf_owner_ids = $2, default_owner_id = $3, default_owner_name = $4, sort = $5
       WHERE id = $6 RETURNING *`,
      [...values, g.id],
    );
    return rows[0];
  }
  const { rows } = await pool.query(
    `INSERT INTO portal_groups (name, sf_owner_ids, default_owner_id, default_owner_name, sort, kind)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [...values, g.kind],
  );
  return rows[0];
}

// ---- users ----

export async function findUser(email) {
  if (!pool) return mem.users.get(email) || null;
  const { rows } = await pool.query('SELECT * FROM portal_users WHERE email = $1', [email]);
  return rows[0] || null;
}

export async function listUsers() {
  if (!pool) return [...mem.users.values()];
  const { rows } = await pool.query('SELECT * FROM portal_users ORDER BY created_at');
  return rows;
}

export async function usersByContact(contactIds) {
  if (!contactIds.length) return [];
  if (!pool) return [...mem.users.values()].filter((u) => contactIds.includes(u.sf_contact_id));
  const { rows } = await pool.query('SELECT * FROM portal_users WHERE sf_contact_id = ANY ($1)', [contactIds]);
  return rows;
}

export async function upsertUser(u) {
  if (!pool) {
    const cur = mem.users.get(u.email);
    return mem.users.set(u.email, { created_at: new Date(), ...cur, ...u, updated_at: cur ? new Date() : null });
  }
  await pool.query(
    `INSERT INTO portal_users (email, name, role, group_id, sf_contact_id, contact_error, sf_user_id, sf_user_name, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (email) DO UPDATE SET name = $2, role = $3, group_id = $4, sf_contact_id = $5, contact_error = $6,
       sf_user_id = $7, sf_user_name = $8, updated_at = now()`,
    [u.email, u.name, u.role, u.group_id, u.sf_contact_id || null, u.contact_error || null, u.sf_user_id || null, u.sf_user_name || null, u.created_by],
  );
}

export async function deleteUser(email) {
  if (!pool) return mem.users.delete(email);
  await pool.query('DELETE FROM portal_users WHERE email = $1', [email]);
}

// ---- audit log ----

// entry: { email, action, case_id?, case_number?, changes?, target?, group_name? }.
// For case edits `changes` is { field: { label, from, to, fromText?, toText? } }.
export async function audit(entry) {
  if (!pool) return mem.audit.unshift({ id: ++mem.auditSeq, ...entry, at: new Date() });
  await pool.query(
    'INSERT INTO audit_log (email, action, case_id, case_number, changes, target, group_name) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [entry.email, entry.action, entry.case_id || null, entry.case_number || null, JSON.stringify(entry.changes || {}), entry.target || null, entry.group_name || null],
  );
}

export async function auditFor(caseId) {
  if (!pool) return mem.audit.filter((a) => a.case_id === caseId).slice(0, 50);
  const { rows } = await pool.query('SELECT * FROM audit_log WHERE case_id = $1 ORDER BY at DESC LIMIT 50', [caseId]);
  return rows;
}

export async function recentAudit(limit = 200) {
  return (await searchAudit({ pageSize: limit })).entries;
}

// Filtered, paged log for the admin log page. from/to are YYYY-MM-DD (inclusive, Israel time).
export async function searchAudit({ email, caseNumber, action, from, to, page = 0, pageSize = 50 } = {}) {
  const fromAt = from ? new Date(`${from}T00:00:00+02:00`) : null;
  const toAt = to ? new Date(new Date(`${to}T00:00:00+02:00`).getTime() + 86400000) : null;
  if (!pool) {
    const all = mem.audit.filter((a) => (!email || a.email === email)
      && (!caseNumber || String(a.case_number || '').replace(/^0+/, '') === caseNumber.replace(/^0+/, ''))
      && (!action || a.action === action)
      && (!fromAt || a.at >= fromAt) && (!toAt || a.at < toAt));
    return { entries: all.slice(page * pageSize, (page + 1) * pageSize), total: all.length, actions: [...new Set(mem.audit.map((a) => a.action))], emails: [...new Set(mem.audit.map((a) => a.email))] };
  }
  const where = [];
  const args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (email) add('email = ?', email);
  // Case numbers are zero-padded (00012345), so match on the digits typed.
  if (caseNumber) add("ltrim(case_number, '0') = ltrim(?, '0')", caseNumber);
  if (action) add('action = ?', action);
  if (from) add("(at AT TIME ZONE 'Asia/Jerusalem')::date >= ?::date", from);
  if (to) add("(at AT TIME ZONE 'Asia/Jerusalem')::date <= ?::date", to);
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [list, count, facets] = await Promise.all([
    pool.query(`SELECT * FROM audit_log ${cond} ORDER BY at DESC, id DESC LIMIT ${Number(pageSize)} OFFSET ${Number(page) * Number(pageSize)}`, args),
    pool.query(`SELECT count(*)::int AS n FROM audit_log ${cond}`, args),
    pool.query('SELECT array(SELECT DISTINCT action FROM audit_log ORDER BY 1) AS actions, array(SELECT DISTINCT email FROM audit_log ORDER BY 1) AS emails'),
  ]);
  return { entries: list.rows, total: count.rows[0].n, actions: facets.rows[0].actions, emails: facets.rows[0].emails };
}

// ---- access log ----

const ACCESS_COLUMNS = ['at', 'email', 'kind', 'action', 'method', 'route', 'status', 'reason', 'case_id', 'case_number', 'target', 'ip', 'user_agent', 'session_id'];
mem.access = [];
mem.accessSeq = 0;

// Inserts a batch in one statement; a session row whose session_id is already logged is skipped.
export async function insertAccess(rows) {
  if (!rows.length) return;
  if (!pool) {
    for (const r of rows) {
      if (r.kind === 'session' && mem.access.some((a) => a.kind === 'session' && a.session_id === r.session_id)) continue;
      mem.access.unshift({ id: ++mem.accessSeq, ...r });
    }
    mem.access.length = Math.min(mem.access.length, 20000);
    return;
  }
  const args = [];
  const tuples = rows.map((r) => `(${ACCESS_COLUMNS.map((c) => { args.push(r[c] ?? null); return `$${args.length}`; }).join(', ')})`);
  await pool.query(
    `INSERT INTO access_log (${ACCESS_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
     ON CONFLICT (session_id) WHERE kind = 'session' DO NOTHING`,
    args,
  );
}

export async function pruneAccess(days) {
  if (!pool) {
    const cut = Date.now() - days * 86400000;
    mem.access = mem.access.filter((a) => +a.at >= cut);
    return 0;
  }
  const r = await pool.query('DELETE FROM access_log WHERE at < now() - make_interval(days => $1)', [days]);
  return r.rowCount;
}

// Shared filter for the timeline, the CSV export and the per-user summary.
// f: { email, kind, caseNumber, from, to (YYYY-MM-DD, Israel time), denied }
function accessWhere(f) {
  const where = [];
  const args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replaceAll('?', `$${args.length}`)); };
  if (f.email) add('email = ?', f.email);
  if (f.kind) add('kind = ?', f.kind);
  if (f.denied) where.push("kind = 'denied'");
  if (f.caseNumber) add("ltrim(case_number, '0') = ltrim(?, '0')", f.caseNumber);
  if (f.from) add("(at AT TIME ZONE 'Asia/Jerusalem')::date >= ?::date", f.from);
  if (f.to) add("(at AT TIME ZONE 'Asia/Jerusalem')::date <= ?::date", f.to);
  return { cond: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

function memAccess(f) {
  const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  return mem.access.filter((a) => (!f.email || a.email === f.email) && (!f.kind || a.kind === f.kind) && (!f.denied || a.kind === 'denied')
    && (!f.caseNumber || String(a.case_number || '').replace(/^0+/, '') === f.caseNumber.replace(/^0+/, ''))
    && (!f.from || day(a.at) >= f.from) && (!f.to || day(a.at) <= f.to));
}

export async function searchAccess(f, { page = 0, pageSize = 50 } = {}) {
  if (!pool) {
    const all = memAccess(f);
    return { entries: all.slice(page * pageSize, (page + 1) * pageSize), total: all.length };
  }
  const { cond, args } = accessWhere(f);
  const [list, count] = await Promise.all([
    pool.query(`SELECT * FROM access_log ${cond} ORDER BY at DESC, id DESC LIMIT ${Number(pageSize)} OFFSET ${Number(page) * Number(pageSize)}`, args),
    pool.query(`SELECT count(*)::int AS n FROM access_log ${cond}`, args),
  ]);
  return { entries: list.rows, total: count.rows[0].n };
}

// Per-user counts over the filtered events (email, kind filters are ignored here on purpose
// except the date range, so the summary always lists everyone).
export async function accessSummary(f) {
  const range = { from: f.from, to: f.to };
  if (!pool) {
    const by = new Map();
    for (const a of memAccess(range)) {
      const s = by.get(a.email) || { email: a.email, last_seen: a.at, sessions: 0, actions: 0, denied: 0 };
      if (+a.at > +s.last_seen) s.last_seen = a.at;
      if (a.kind === 'session') s.sessions++; else if (a.kind === 'denied') s.denied++; else s.actions++;
      by.set(a.email, s);
    }
    return [...by.values()];
  }
  const { cond, args } = accessWhere(range);
  const { rows } = await pool.query(
    `SELECT email, max(at) AS last_seen,
       count(*) FILTER (WHERE kind = 'session')::int AS sessions,
       count(*) FILTER (WHERE kind NOT IN ('session', 'denied'))::int AS actions,
       count(*) FILTER (WHERE kind = 'denied')::int AS denied
     FROM access_log ${cond} GROUP BY email ORDER BY max(at) DESC`,
    args,
  );
  return rows;
}
