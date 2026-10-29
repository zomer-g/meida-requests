# meida-requests

Portal for the Movement for Freedom of Information: clinics and staff sign in with Google (xhostd SSO)
and view, create and update FOI requests (Salesforce Cases, record type `בקשה`) through the Salesforce API.

- `server/` Express API. Salesforce access is through the API-only user `meida-portal-api@octopus.org.il.integration`
  (External Client App "Meida Portal", Client Credentials). The portal never deletes records.
- `public/` the single-page UI, styled after meida.org.il.
- Access: `ADMIN_EMAILS` (env) see everything and manage users at `#/admin`; other users are added there and
  are scoped to requests whose Salesforce owner is their clinic. Every create/update is written to `audit_log`.

Env: `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `ADMIN_EMAILS`, `NODE_ENV=production`.
Local run: `PORT=3456 DEV_USER_EMAIL=you@gmail.com ADMIN_EMAILS=you@gmail.com npm run dev`.
