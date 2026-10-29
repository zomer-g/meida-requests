# meida-requests

Portal for the Movement for Freedom of Information: clinics and staff sign in with Google (xhostd SSO)
and view, create and update FOI requests (Salesforce Cases, record type `בקשה`) through the Salesforce API.

- `server/` Express API. Salesforce access is through the API-only user `meida-portal-api@octopus.org.il.integration`
  (External Client App "Meida Portal", Client Credentials). The portal never deletes records.
- `public/` the single-page UI, styled after meida.org.il.
- Groups and boards (`portal_groups`, `server/access.js`): each group has its own requests board. A clinic's board is
  the Cases owned by its Salesforce user(s); the single staff group ("עובדי התנועה") gets every Case whose owner is
  not a clinic owner. Admins add clinics at `#/admin/groups` without code changes.
- New requests are owned by the board's Salesforce user: on a clinic board the clinic's user (all clinic members
  create under it); on the staff board the creator's own Salesforce user (`portal_users.sf_user_id`, mapped per staff
  user at `#/admin`, with a suggestion by email or name). A staff user with no mapping cannot create requests.
- Roles (`portal_users.role`): `student` and `employee` see only their own group's board, enforced in every Case query,
  update, create and lookup (`scope()` / `loadCase()` in `routes.js`); `manager` and `admin` see all boards; only
  `admin` manages users, groups, imports and the log. `ADMIN_EMAILS` (env) are always admins.
- Every portal user is linked to a Salesforce Contact (matched by email, else created by the API user) so they can be
  picked as the request handler (`metapel_bakasha__c`). The handler picker offers only the request's group members;
  saving rejects a handler from another group (managers/admins may pick any portal user).
- CSV import of users into a group at `#/admin` (name, email; header row, BOM, quotes, `,` `;` or tab, upsert by email)
  with a preview first.
- Every create/update (field by field, from → to with labels), user/group change and import is written to `audit_log`;
  admins follow it at `#/admin/log` with filters and paging.
- Access log (`access_log`, `server/accesslog.js`): every API request (reads too), every new sign-in session (first
  request with a new identity token) and every denied attempt (Google account without access, admin-only page, a
  request outside the user's board), with email, time, action, case, result, IP and user agent. Written in batches
  every 2 s so it never slows or fails a request; no bodies, search text, file contents or tokens. Admins see a
  per-user summary, a filtered timeline and CSV export at `#/admin/access`. Kept `ACCESS_LOG_RETENTION_DAYS`
  (default 365) days, cleaned daily.

Env: `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `ADMIN_EMAILS`, `NODE_ENV=production`, optional `ACCESS_LOG_RETENTION_DAYS`.
Local run: `PORT=3456 DEV_USER_EMAIL=you@gmail.com ADMIN_EMAILS=you@gmail.com npm run dev`.
