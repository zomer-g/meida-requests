# meida-requests

Portal for the Movement for Freedom of Information: clinics and staff sign in with Google (xhostd SSO)
and view, create and update FOI requests (Salesforce Cases, record type `בקשה`) through the Salesforce API.

- `server/` Express API. Salesforce access is through one API-only integration user
  (an External Client App with the Client Credentials flow). The portal never deletes records.
- `public/` the single-page UI, styled after meida.org.il.
- Groups and boards (`portal_groups`, `server/access.js`): each group has its own requests board. A clinic's board is
  the Cases owned by its Salesforce user(s); the single staff group ("עובדי התנועה") gets every Case whose owner is
  not a clinic owner. Admins add clinics at `#/admin/groups` without code changes.
- New requests are owned by the board's Salesforce user: on a clinic board the clinic's user (all clinic members
  create under it); on the staff board the creator's own Salesforce user (`portal_users.sf_user_id`, mapped per staff
  user at `#/admin`, with a suggestion by email or name). A staff user with no mapping cannot create requests.
- Roles (`portal_users.role`): `student` and `employee` see only their own group's board, enforced in every Case query,
  update, create and lookup (`scope()` / `loadCase()` in `routes.js`); `manager` and `admin` see all boards; a
  `manager` also manages the students of their own group at `#/team` (`/api/team/*`: add, CSV import, rename,
  remove; students only, own group only); only `admin` manages other roles, groups and the logs. `ADMIN_EMAILS` (env) are always admins.
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

- External API (`/api/v1`, `server/extapi.js`), documented at `/api-docs` (`public/api-docs.html`): other systems
  search, read, create and update requests (every portal field, lookups by Id or by name/email) with one shared
  token kept on the server in the `API_TOKEN` secret (comma-separated for rotation, 24+ characters; unset = API off).
  Callers name themselves with `X-Client-Name`; every call, refused tokens included, goes to the access log as
  `api:<name>`, and every create/update to the edit log. Acts as an admin over request Cases; never deletes.
  20 refused tokens per IP in 10 minutes → 429.

- Help pages per role at `#/help` (`public/help.js`); privacy policy at `/privacy`, accessibility statement at
  `/accessibility` (WCAG 2.1 AA / IS 5568, audit in `docs/accessibility-audit.md`).

Env: `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `ADMIN_EMAILS`, `NODE_ENV=production`, optional `ACCESS_LOG_RETENTION_DAYS`, optional `API_TOKEN` (secret).
Local run (impersonating a user, without a database; refused on xhostd or with `DATABASE_URL`):
`PORT=3456 ALLOW_DEV_USER=1 DEV_USER_EMAIL=you@gmail.com ADMIN_EMAILS=you@gmail.com npm run dev`.
