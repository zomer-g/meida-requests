// Sign-in through xhostd: the platform runs Google login at /xhost-auth/* and sets the
// __Host-xhost_id cookie, an RS256 JWT we verify against xhostd's JWKS. Who may use the
// portal, and which requests they see, is decided here from the portal_users table.

import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { findUser } from './db.js';

const ISSUER = 'https://auth.xhostd.com';
const JWKS = createRemoteJWKSet(new URL('https://auth.xhostd.com/xhost-auth/jwks'));

// Hostnames the token may be minted for: the channel hostname plus verified custom domains.
const allowedHosts = new Set(
  [process.env.XHOSTD_HOSTNAME, ...(process.env.XHOSTD_DOMAINS || '').split(',')]
    .map((h) => (h || '').trim().toLowerCase())
    .filter(Boolean),
);

export const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);

// Local impersonation for development only: needs an explicit opt-in, and is refused whenever the
// app runs on xhostd (XHOSTD_HOSTNAME) or against a real database, whatever NODE_ENV says.
const DEV_USER = process.env.ALLOW_DEV_USER === '1' && process.env.DEV_USER_EMAIL ? process.env.DEV_USER_EMAIL.toLowerCase() : null;
if (DEV_USER && (process.env.XHOSTD_HOSTNAME || process.env.DATABASE_URL || process.env.NODE_ENV === 'production')) {
  throw new Error('DEV_USER_EMAIL impersonation is only allowed locally (no XHOSTD_HOSTNAME, DATABASE_URL or NODE_ENV=production)');
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; } // a malformed cookie is no cookie
}

const DEV_SESSION = `dev-${Date.now()}`;

// session: a hash prefix of the identity token (a new token = a new sign-in), for the access log.
async function identity(req) {
  if (DEV_USER) return { sub: `dev:${DEV_USER}`, email: DEV_USER, name: DEV_USER, session: DEV_SESSION, issuedAt: null };
  const token = readCookie(req, '__Host-xhost_id');
  if (!token) return null;
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (!allowedHosts.has(host)) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: host, algorithms: ['RS256'] });
    return {
      sub: payload.sub,
      email: String(payload.email || '').toLowerCase(),
      name: payload.name || payload.email,
      session: createHash('sha256').update(token).digest('hex').slice(0, 24),
      issuedAt: payload.iat ? new Date(payload.iat * 1000) : null,
    };
  } catch {
    return null;
  }
}

// Resolves req.user = { email, name, role, groupId, contactId, sfUserId, sfUserName } or answers 401/403.
// ADMIN_EMAILS are always admins; their portal_users row (if any) only adds a group and Contact.
export async function requireUser(req, res, next) {
  try {
    const who = await identity(req);
    if (!who) return res.status(401).json({ error: 'not_signed_in', login_url: '/xhost-auth/login?return_to=/' });
    req.identity = who; // lets the access log attribute denied requests too
    const row = await findUser(who.email);
    const isEnvAdmin = adminEmails.has(who.email);
    if (!row && !isEnvAdmin) {
      res.locals.denyReason = 'no_access'; // signed in with Google but not a portal user
      return res.status(403).json({ error: 'no_access', email: who.email });
    }
    req.user = {
      ...who,
      name: row?.name || who.name,
      role: isEnvAdmin ? 'admin' : row.role,
      groupId: row?.group_id ?? null,
      contactId: row?.sf_contact_id ?? null,
      sfUserId: row?.sf_user_id ?? null, // owner of the staff-board requests this user creates
      sfUserName: row?.sf_user_name ?? null,
    };
    next();
  } catch (e) {
    console.error('[auth]', e.message);
    res.status(500).json({ error: 'שגיאה פנימית' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    res.locals.denyReason = 'admin_only';
    return res.status(403).json({ error: 'admin_only' });
  }
  next();
}

// Managers manage the students of their own group (see /team in routes.js); admins any group.
export function requireManager(req, res, next) {
  if (!['manager', 'admin'].includes(req.user?.role)) {
    res.locals.denyReason = 'managers_only';
    return res.status(403).json({ error: 'managers_only' });
  }
  next();
}

// The identity cookie travels on any same-site request, so writes must come from our own pages.
export function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  const host = req.headers.host;
  let ok = false;
  try { ok = !!origin && new URL(origin).host === host; } catch { ok = false; } // e.g. "Origin: null"
  if (!ok) return res.status(403).json({ error: 'bad_origin' });
  next();
}
