// Sign-in through xhostd: the platform runs Google login at /xhost-auth/* and sets the
// __Host-xhost_id cookie, an RS256 JWT we verify against xhostd's JWKS. Who may use the
// portal, and which requests they see, is decided here from the portal_users table.

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

async function identity(req) {
  if (DEV_USER) return { sub: `dev:${DEV_USER}`, email: DEV_USER, name: DEV_USER };
  const token = readCookie(req, '__Host-xhost_id');
  if (!token) return null;
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (!allowedHosts.has(host)) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: host, algorithms: ['RS256'] });
    return { sub: payload.sub, email: String(payload.email || '').toLowerCase(), name: payload.name || payload.email };
  } catch {
    return null;
  }
}

// Resolves req.user = { email, name, role, ownerId, ownerName } or answers 401/403.
export async function requireUser(req, res, next) {
  const who = await identity(req);
  if (!who) return res.status(401).json({ error: 'not_signed_in', login_url: '/xhost-auth/login?return_to=/' });
  if (adminEmails.has(who.email)) {
    req.user = { ...who, role: 'admin', ownerId: null, ownerName: null };
    return next();
  }
  const row = await findUser(who.email);
  if (!row) return res.status(403).json({ error: 'no_access', email: who.email });
  req.user = { ...who, role: row.role, ownerId: row.sf_owner_id, ownerName: row.sf_owner_name };
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
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
