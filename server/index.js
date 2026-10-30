import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';
import { activity } from './activity.js'; // activity feed (posts + files) on each request
import { migrate } from './db.js';
import { accessLog, startAccessLog } from './accesslog.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // one hop: the xhostd edge. `true` would let clients forge req.ip via X-Forwarded-For

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  });
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', accessLog); // records every API request after it is answered (accesslog.js)
app.use('/api', activity); // before `api`: it parses its own multipart bodies
app.use('/api', api);
app.use(express.static(root, { index: 'index.html', maxAge: '5m', extensions: ['html'] })); // also serves /privacy, /accessibility (public, no sign-in)
app.get(/^\/(?!api|xhost-auth).*/, (req, res) => res.sendFile(path.join(root, 'index.html')));

// Malformed JSON, oversized bodies and anything else that reaches Express: short JSON, never a stack trace.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[server]', req.method, req.path, err.message);
  if (!res.headersSent) res.status(status).json({ error: status === 413 ? 'הבקשה גדולה מדי' : status === 500 ? 'שגיאה פנימית' : 'בקשה לא תקינה' });
});

// Last line of defence: log instead of letting one bad promise end the process.
process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e?.message || e));

const port = Number(process.env.XHOSTD_HTTP_PORT || process.env.XHOST_HTTP_PORT || process.env.PORT || 3000);
await migrate();
startAccessLog();
app.listen(port, '0.0.0.0', () => console.log(`[server] listening on ${port}`));
