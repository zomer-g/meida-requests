import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';
import { activity } from './activity.js'; // activity feed (posts + files) on each request
import { migrate } from './db.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; frame-ancestors 'none'",
  });
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', activity); // before `api`: it parses its own multipart bodies
app.use('/api', api);
app.use(express.static(root, { index: 'index.html', maxAge: '5m', extensions: ['html'] })); // also serves /privacy, /accessibility (public, no sign-in)
app.get(/^\/(?!api|xhost-auth).*/, (req, res) => res.sendFile(path.join(root, 'index.html')));

const port = Number(process.env.XHOSTD_HTTP_PORT || process.env.XHOST_HTTP_PORT || process.env.PORT || 3000);
await migrate();
app.listen(port, '0.0.0.0', () => console.log(`[server] listening on ${port}`));
