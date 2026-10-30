// Activity feed on a request: free-text updates with optional files, newest first.
// Case feed tracking (Chatter) is off in the org, so each post is a completed Task on the Case
// (staff see it in the Case's activity timeline) and each file a ContentVersion published to the
// Case (its Files list) and linked to the post's Task. Salesforce shows the API user as the
// creator, so the real author is the first line of the Task description.

import express from 'express';
import { Readable } from 'node:stream';
import { sf, sfFetch, isId, soqlString, SalesforceError } from './salesforce.js';
import { requireUser, sameOrigin } from './auth.js';
import { loadCase } from './routes.js';
import { audit } from './db.js';

export const activity = express.Router();

const SUBJECT = 'עדכון מהפורטל';
const MAX_TEXT = 10000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
const EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'csv', 'txt', 'zip',
]);
const HEADER = /^נכתב ע״י (.*) <([^<>\s]*)> דרך הפורטל\r?\n(?:\r?\n)?/;

const oneLine = (v) => String(v || '').replace(/[\r\n<>]+/g, ' ').trim().slice(0, 100);

// Keeps the base name only, drops control and reserved characters, and caps the length.
export function cleanFilename(name) {
  let n = String(name || '').split(/[\\/]/).pop().normalize('NFC');
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

// Archived (closed and older than a year) Tasks are only returned by queryAll, which also returns deleted rows.
const queryAll = (soql) => sf(`/queryAll?q=${encodeURIComponent(soql)}`);

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[activity]', req.method, req.path, e.message);
  const msg = e instanceof SalesforceError
    ? (Array.isArray(e.errors) ? e.errors : [e.errors]).map((x) => x?.message).filter(Boolean).join('; ') || e.message
    : 'שגיאה פנימית';
  res.status(e instanceof SalesforceError && e.status < 500 ? 400 : 500).json({ error: msg });
});

async function caseFor(req, res) {
  const record = await loadCase(req.user, req.params.id);
  if (!record) res.status(404).json({ error: 'הבקשה לא נמצאה' });
  return record;
}

activity.get('/requests/:id/activity', requireUser, wrap(async (req, res) => {
  const record = await caseFor(req, res);
  if (!record) return;
  const r = await queryAll(
    `SELECT Id, Description, CreatedDate, CreatedBy.Name,
       (SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.ContentSize FROM ContentDocumentLinks)
     FROM Task WHERE WhatId = '${record.Id}' AND IsDeleted = false AND Subject LIKE ${soqlString(`${SUBJECT}%`)}
     ORDER BY CreatedDate DESC LIMIT 200`,
  );
  const posts = r.records.map((t) => {
    const desc = t.Description || '';
    const m = desc.match(HEADER);
    return {
      id: t.Id,
      at: t.CreatedDate,
      author: m ? { name: m[1], email: m[2] } : { name: t.CreatedBy?.Name || '', email: '' },
      text: m ? desc.slice(m[0].length) : desc,
      files: (t.ContentDocumentLinks?.records || []).map((l) => ({
        id: l.ContentDocumentId,
        name: [l.ContentDocument?.Title, l.ContentDocument?.FileExtension].filter(Boolean).join('.'),
        size: l.ContentDocument?.ContentSize ?? null,
      })),
    };
  });
  res.json({ posts });
}));

const multipart = express.raw({ type: 'multipart/form-data', limit: MAX_FILES * MAX_FILE_BYTES + 200 * 1024 });

// Each upload holds its files in memory a few times over, so allow one at a time per user and a
// few overall; the rest are asked to retry instead of growing memory.
const MAX_UPLOADS = 3;
const uploading = new Set();
function uploadSlot(req, res, next) {
  const key = req.user?.email;
  if (!key) return next();
  if (uploading.has(key)) return res.status(429).json({ error: 'העלאה קודמת שלך עדיין בתהליך; נסו שוב בעוד רגע' });
  if (uploading.size >= MAX_UPLOADS) return res.status(429).json({ error: 'השרת מעלה כרגע קבצים אחרים; נסו שוב בעוד רגע' });
  uploading.add(key);
  res.on('close', () => uploading.delete(key));
  next();
}

activity.post('/requests/:id/activity', sameOrigin, requireUser, uploadSlot, multipart, wrap(async (req, res) => {
  const record = await caseFor(req, res);
  if (!record) return;
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'יש לשלוח טופס עם קבצים (multipart/form-data)' });
  let form;
  try {
    form = await new Response(req.body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
  } catch {
    return res.status(400).json({ error: 'הטופס לא תקין' });
  }
  const text = String(form.get('text') || '').replace(/\r\n/g, '\n').trim();
  const files = form.getAll('files').filter((f) => typeof f === 'object' && f.size > 0);
  if (!text && !files.length) return res.status(400).json({ error: 'יש לכתוב עדכון או לצרף קובץ' });
  if (text.length > MAX_TEXT) return res.status(400).json({ error: `העדכון ארוך מדי (עד ${MAX_TEXT} תווים)` });
  if (files.length > MAX_FILES) return res.status(400).json({ error: `אפשר לצרף עד ${MAX_FILES} קבצים` });
  const uploads = [];
  for (const f of files) {
    const name = cleanFilename(f.name);
    if (!name || !EXTENSIONS.has(extOf(name))) return res.status(400).json({ error: `סוג הקובץ לא נתמך: ${oneLine(f.name) || '(ללא שם)'}` });
    if (f.size > MAX_FILE_BYTES) return res.status(400).json({ error: `הקובץ ${name} גדול מ-10MB` });
    uploads.push({ name, file: f });
  }

  const name = oneLine(req.user.name) || req.user.email;
  const email = oneLine(req.user.email).replace(/\s/g, '');
  const description = `נכתב ע״י ${name} <${email}> דרך הפורטל\n\n${text}`;
  const firstLine = text.split('\n')[0].slice(0, 80) || uploads.map((u) => u.name).join(', ').slice(0, 80);
  const task = await sf('/sobjects/Task', {
    method: 'POST',
    body: {
      WhatId: record.Id,
      Subject: `${SUBJECT}: ${firstLine}`.slice(0, 255),
      Description: description,
      Status: 'Completed',
      TaskSubtype: 'Task',
      ActivityDate: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }),
    },
  });

  // Files go up one by one after the post exists; a failed file is reported, the post stays.
  const saved = [];
  const failed = [];
  for (const u of uploads) {
    try {
      const data = Buffer.from(await u.file.arrayBuffer()).toString('base64');
      const cv = await sf('/sobjects/ContentVersion', {
        method: 'POST',
        body: {
          Title: u.name.replace(/\.[^.]+$/, ''),
          PathOnClient: u.name,
          VersionData: data,
          FirstPublishLocationId: record.Id,
          Description: `הועלה ע״י ${name} <${email}> דרך הפורטל`,
        },
      });
      const doc = await sf(`/sobjects/ContentVersion/${cv.id}?fields=ContentDocumentId`);
      await sf('/sobjects/ContentDocumentLink', { method: 'POST', body: { LinkedEntityId: task.id, ContentDocumentId: doc.ContentDocumentId, ShareType: 'V' } });
      saved.push(u.name);
    } catch (e) {
      console.error('[activity] file upload failed', u.name, e.message);
      failed.push(u.name);
    }
  }

  await audit({
    email: req.user.email, action: 'post', case_id: record.Id, case_number: record.CaseNumber,
    changes: { task_id: task.id, text_length: text.length, files: saved, ...(failed.length ? { failed_files: failed } : {}) },
  });
  res.status(201).json({ id: task.id, files: saved, failed });
}));

// Streams a file of the request through the server; Salesforce URLs never reach the browser.
activity.get('/requests/:id/activity/files/:docId', requireUser, wrap(async (req, res) => {
  const record = await caseFor(req, res);
  if (!record) return;
  const docId = req.params.docId;
  if (!isId(docId)) return res.status(404).json({ error: 'הקובץ לא נמצא' });
  const link = await sf(`/query?q=${encodeURIComponent(
    `SELECT ContentDocumentId FROM ContentDocumentLink WHERE ContentDocumentId = '${docId}' AND LinkedEntityId = '${record.Id}' LIMIT 1`,
  )}`);
  if (!link.records.length) return res.status(404).json({ error: 'הקובץ לא נמצא' });
  const v = await sf(`/query?q=${encodeURIComponent(
    `SELECT Id, Title, FileExtension, ContentSize FROM ContentVersion WHERE ContentDocumentId = '${docId}' AND IsLatest = true LIMIT 1`,
  )}`);
  const version = v.records[0];
  if (!version) return res.status(404).json({ error: 'הקובץ לא נמצא' });
  const sfRes = await sfFetch(`/sobjects/ContentVersion/${version.Id}/VersionData`);
  if (!sfRes.ok || !sfRes.body) return res.status(502).json({ error: 'הורדת הקובץ מסיילספורס נכשלה' });
  const filename = cleanFilename([version.Title, version.FileExtension].filter(Boolean).join('.')) || 'file';
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store',
    // fetch() decompresses a gzip body, so the upstream length only holds for an uncompressed one.
    ...(sfRes.headers.get('content-length') && !sfRes.headers.get('content-encoding') ? { 'Content-Length': sfRes.headers.get('content-length') } : {}),
  });
  Readable.fromWeb(sfRes.body).on('error', () => res.destroy()).pipe(res);
}));
