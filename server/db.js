// Portal users and the audit log live in the channel's Postgres (DATABASE_URL, injected by xhostd).
// Without DATABASE_URL (local dev) an in-memory store is used instead.

import pg from 'pg';

const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 5 }) : null;
const mem = { users: new Map(), audit: [] };

export async function migrate() {
  if (!pool) return console.log('[db] no DATABASE_URL, using in-memory store');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portal_users (
      email          text PRIMARY KEY,
      name           text,
      role           text NOT NULL CHECK (role IN ('admin', 'clinic')),
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
  `);
  console.log('[migrate] done');
}

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

export async function upsertUser(u) {
  if (!pool) return mem.users.set(u.email, { ...u, created_at: new Date() });
  await pool.query(
    `INSERT INTO portal_users (email, name, role, sf_owner_id, sf_owner_name, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email) DO UPDATE SET name = $2, role = $3, sf_owner_id = $4, sf_owner_name = $5`,
    [u.email, u.name, u.role, u.sf_owner_id, u.sf_owner_name, u.created_by],
  );
}

export async function deleteUser(email) {
  if (!pool) return mem.users.delete(email);
  await pool.query('DELETE FROM portal_users WHERE email = $1', [email]);
}

export async function audit(entry) {
  if (!pool) return mem.audit.unshift({ ...entry, at: new Date() });
  await pool.query(
    'INSERT INTO audit_log (email, action, case_id, case_number, changes) VALUES ($1, $2, $3, $4, $5)',
    [entry.email, entry.action, entry.case_id, entry.case_number, JSON.stringify(entry.changes || {})],
  );
}

export async function auditFor(caseId) {
  if (!pool) return mem.audit.filter((a) => a.case_id === caseId).slice(0, 50);
  const { rows } = await pool.query('SELECT * FROM audit_log WHERE case_id = $1 ORDER BY at DESC LIMIT 50', [caseId]);
  return rows;
}

export async function recentAudit(limit = 200) {
  if (!pool) return mem.audit.slice(0, limit);
  const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY at DESC LIMIT $1', [limit]);
  return rows;
}
