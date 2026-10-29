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

const DEV_USER = process.env.NODE_ENV !== 'production' ? process.env.DEV_USER_EMAIL : null;

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
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
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    res.locals.denyReason = 'admin_only';
    return res.status(403).json({ error: 'admin_only' });
  }
  next();
}

// The identity cookie travels on any same-site request, so writes must come from our own pages.
export function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || new URL(origin).host !== host) return res.status(403).json({ error: 'bad_origin' });
  next();
}
