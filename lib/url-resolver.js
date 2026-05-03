// ═══════════════════════════════════════════════════════════════════
//  URL RESOLVER — résout n'importe quelle URL en fichier local
//
//  Cas gérés :
//  - data: URL  (base64) → décode en /tmp
//  - https://drive.google.com/file/d/FILE_ID/...     → Drive download
//  - https://drive.google.com/uc?id=FILE_ID&...      → Drive download
//  - https://drive.google.com/open?id=FILE_ID        → Drive download
//  - https://*.googleusercontent.com/...             → fetch direct
//  - http(s)://...                                   → fetch direct
//
//  Drive download : utilise SA JWT token (drive-upload.getDriveToken).
//  Sortie : path local. L'appelant est responsable du cleanup.
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const fetch  = require('node-fetch');

const driveLib = require('./drive-upload.js');

const TMP_DIR = process.env.ZENTY_RESOLVED_DIR || '/tmp/zenty-resolved';

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ── Extract Drive file ID depuis n'importe quelle URL Drive ────────────
function _extractDriveId(url) {
  // /file/d/FILE_ID/...
  let m = url.match(/\/file\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  // ?id=FILE_ID
  m = url.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return null;
}

// ── Download data: URL ─────────────────────────────────────────────────
function _resolveDataUrl(dataUrl) {
  ensureTmpDir();
  const m = dataUrl.match(/^data:([^;,]+)(;base64)?,(.+)$/);
  if (!m) throw new Error('Invalid data URL');
  const mime = m[1] || 'application/octet-stream';
  const isBase64 = !!m[2];
  const payload = m[3];

  // Détermine extension à partir du mime
  let ext = 'bin';
  if (/png/i.test(mime))  ext = 'png';
  else if (/jpeg|jpg/i.test(mime)) ext = 'jpg';
  else if (/svg/i.test(mime))  ext = 'svg';
  else if (/webp/i.test(mime)) ext = 'webp';

  const id   = crypto.randomBytes(6).toString('hex');
  const out  = path.join(TMP_DIR, 'data_' + id + '.' + ext);
  const buf  = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
  fs.writeFileSync(out, buf);
  return out;
}

// ── Download Drive via SA token ────────────────────────────────────────
async function _resolveDriveUrl(url) {
  const fileId = _extractDriveId(url);
  if (!fileId) throw new Error('Drive URL sans file ID: ' + url);
  ensureTmpDir();
  const token = await driveLib.getDriveToken();

  // Récupère metadata pour avoir le name + mime
  const metaR = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=id,name,mimeType', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const meta = await metaR.json();
  if (!meta.id) throw new Error('Drive metadata fail: ' + JSON.stringify(meta));

  // Download alt=media
  const dlR = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!dlR.ok) throw new Error('Drive download HTTP ' + dlR.status);
  const buf = await dlR.buffer();

  // Détermine ext
  let ext = (meta.name || '').split('.').pop().toLowerCase();
  if (!ext || ext.length > 5) {
    if (/png/i.test(meta.mimeType))  ext = 'png';
    else if (/jpeg|jpg/i.test(meta.mimeType)) ext = 'jpg';
    else if (/mp4/i.test(meta.mimeType))      ext = 'mp4';
    else ext = 'bin';
  }
  const id  = crypto.randomBytes(6).toString('hex');
  const out = path.join(TMP_DIR, 'drive_' + id + '.' + ext);
  fs.writeFileSync(out, buf);
  return out;
}

// ── Download HTTP(S) URL ───────────────────────────────────────────────
async function _resolveHttpUrl(url) {
  ensureTmpDir();
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url);
  const buf = await r.buffer();
  const ct  = r.headers.get('content-type') || '';
  let ext = 'bin';
  if (/png/i.test(ct))  ext = 'png';
  else if (/jpeg|jpg/i.test(ct)) ext = 'jpg';
  else if (/mp4/i.test(ct))      ext = 'mp4';
  else if (/webp/i.test(ct))     ext = 'webp';
  // Fallback sur l'extension de l'URL
  if (ext === 'bin') {
    const m = url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
    if (m) ext = m[1].toLowerCase();
  }
  const id  = crypto.randomBytes(6).toString('hex');
  const out = path.join(TMP_DIR, 'http_' + id + '.' + ext);
  fs.writeFileSync(out, buf);
  return out;
}

// ── API publique ───────────────────────────────────────────────────────
async function resolveToFile(urlOrData) {
  if (!urlOrData) throw new Error('URL vide');
  const s = String(urlOrData);

  if (s.startsWith('data:')) return _resolveDataUrl(s);
  if (/drive\.google\.com/.test(s)) return await _resolveDriveUrl(s);
  if (/^https?:\/\//.test(s))       return await _resolveHttpUrl(s);

  throw new Error('URL non reconnue: ' + s.slice(0, 80));
}

module.exports = { resolveToFile };
