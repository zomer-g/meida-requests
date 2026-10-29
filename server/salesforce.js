// Salesforce REST client: Client Credentials token, shared in-flight token request,
// hourly revoke so permission changes take effect, one retry on 401.

const LOGIN_URL = (process.env.SF_LOGIN_URL || '').replace(/\/$/, '');
const API_VERSION = process.env.SF_API_VERSION || '65.0';
const TOKEN_MAX_AGE_MS = 60 * 60 * 1000;

let token = null; // { access, instance, issuedAt }
let pending = null;

async function requestToken() {
  if (token && Date.now() - token.issuedAt > TOKEN_MAX_AGE_MS) {
    // Client Credentials returns the existing session, which keeps the permissions it was opened with.
    await fetch(`${LOGIN_URL}/services/oauth2/revoke`, {
      method: 'POST',
      body: new URLSearchParams({ token: token.access }),
    }).catch(() => {});
    token = null;
  }
  if (token) return token;
  if (!pending) {
    pending = (async () => {
      const res = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.SF_CLIENT_ID || '',
          client_secret: process.env.SF_CLIENT_SECRET || '',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.access_token) throw new Error(`Salesforce token failed: ${body.error || res.status} ${body.error_description || ''}`);
      token = { access: body.access_token, instance: body.instance_url, issuedAt: Date.now() };
      return token;
    })().finally(() => { pending = null; });
  }
  return pending;
}

export class SalesforceError extends Error {
  constructor(status, errors) {
    const first = Array.isArray(errors) ? errors[0] : errors;
    super(first?.message || `Salesforce error ${status}`);
    this.status = status;
    this.errors = errors;
  }
}

export async function sf(path, { method = 'GET', body } = {}, retried = false) {
  const t = await requestToken();
  const url = path.startsWith('/services/') ? `${t.instance}${path}` : `${t.instance}/services/data/v${API_VERSION}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${t.access}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    token = null;
    return sf(path, { method, body }, true);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new SalesforceError(res.status, data);
  return data;
}

// Authenticated request returning the raw Response, for binary downloads (activity feed files).
export async function sfFetch(path, retried = false) {
  const t = await requestToken();
  const res = await fetch(`${t.instance}/services/data/v${API_VERSION}${path}`, { headers: { Authorization: `Bearer ${t.access}` } });
  if (res.status === 401 && !retried) {
    token = null;
    return sfFetch(path, true);
  }
  return res;
}

export const query = (soql) => sf(`/query?q=${encodeURIComponent(soql)}`);

// Salesforce Ids are 15 or 18 alphanumeric characters; validate before putting one in SOQL.
export const isId = (v) => typeof v === 'string' && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(v);

// Escape a user string for a SOQL string literal.
export const soqlString = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// A LIKE pattern matching `v` anywhere, with the user's own % and _ taken literally.
export const soqlContains = (v) =>
  `'%${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/_/g, '\\_')}%'`;
