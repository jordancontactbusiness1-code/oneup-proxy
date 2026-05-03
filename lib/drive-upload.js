// ═══════════════════════════════════════════════════════════════════
//  DRIVE UPLOAD — Service Account JWT (raw, pas googleapis)
//
//  Reprend le pattern de drive-scanner.js : JWT signé localement,
//  échangé contre access_token, puis Drive API REST direct via fetch.
//  Pas besoin de googleapis (~80 MB) — on garde le proxy léger.
//
//  Le SA est dans /opt/zenty-cron/drive-sa.json (var env GDRIVE_SA_PATH).
//  Il a les scopes 'drive' (read+write) déjà délégués à Jordan.
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const fetch  = require('node-fetch');

const SA_PATH = process.env.GDRIVE_SA_PATH || '/opt/zenty-cron/drive-sa.json';

let _saCached = null;

function _b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ── Auth Drive : SA JWT → access_token ─────────────────────────────────
// Note : scope = 'drive' (read+write) pour l'upload (vs 'drive.readonly' du scanner)
async function getDriveToken() {
  if (!_saCached && fs.existsSync(SA_PATH)) {
    _saCached = JSON.parse(fs.readFileSync(SA_PATH, 'utf-8'));
  }
  if (!_saCached) throw new Error('drive-sa.json introuvable: ' + SA_PATH);

  const now    = Math.floor(Date.now() / 1000);
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = _b64url(JSON.stringify({
    iss:   _saCached.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now
  }));
  const sig = _b64url(crypto.sign(
    'RSA-SHA256',
    Buffer.from(header + '.' + claim),
    _saCached.private_key
  ));

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  header + '.' + claim + '.' + sig
    }).toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SA JWT auth failed: ' + JSON.stringify(d));
  return d.access_token;
}

// ── Lookup folder ID par handle compte ─────────────────────────────────
// Lit zenty/drive/folderMap[handle] dans Firebase pour trouver le folderId.
// (rempli par drive-scanner.js toutes les 30 min)
async function findAccountFolder(handle, sub) {
  const FB_URL    = (process.env.FIREBASE_URL    || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
  const FB_SECRET = process.env.FIREBASE_SECRET  || '';
  const auth      = '?auth=' + FB_SECRET;

  const cleanHandle = (handle || '').toLowerCase().replace(/^@/, '').replace(/\/$/, '').trim();
  const fbHandle    = cleanHandle.replace(/\./g, '_');  // dotted keys → underscore

  // Essai par handle sanitized puis original
  const candidates = [fbHandle, cleanHandle];
  let info = null;
  for (const k of candidates) {
    const url = FB_URL + '/zenty/drive/folderMap/' + encodeURIComponent(k) + '.json' + auth;
    const r = await fetch(url);
    const d = await r.json();
    if (d && (d.folder || d.reels)) { info = d; break; }
  }
  if (!info) throw new Error('folderMap[' + cleanHandle + '] vide — drive-scanner pas encore passé ?');

  if (sub === 'reels')    return info.reels    || info.folder;
  if (sub === 'stories')  return info.stories  || info.folder;
  if (sub === 'carousel') return info.carousel || info.folder;
  if (sub === 'pending') {
    // Cherche/crée le sous-dossier _pending_video sous le folder principal
    return await ensureSubfolder(info.folder, '_pending_video');
  }
  return info.folder;
}

// ── Crée un sous-dossier s'il n'existe pas ─────────────────────────────
async function ensureSubfolder(parentId, name) {
  const token = await getDriveToken();
  const q = encodeURIComponent("'" + parentId + "' in parents and name='" + name + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const list = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const d = await list.json();
  if (d.files && d.files.length) return d.files[0].id;

  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  const c = await create.json();
  if (!c.id) throw new Error('ensureSubfolder: ' + JSON.stringify(c));
  return c.id;
}

// ── Upload un fichier dans un folder Drive ─────────────────────────────
// filepath = chemin local sur VPS, folderId = ID Drive parent, displayName = nom voulu
async function uploadFile(filepath, folderId, displayName, mimeType) {
  if (!fs.existsSync(filepath)) throw new Error('uploadFile: fichier absent: ' + filepath);
  const token = await getDriveToken();
  const buf   = fs.readFileSync(filepath);
  const mime  = mimeType || 'image/png';
  const name  = displayName || path.basename(filepath);

  // Multipart upload (metadata + content)
  const meta = JSON.stringify({ name: name, parents: [folderId] });
  const boundary = '-------zentyboundary' + Date.now();
  const closeDelim = '\r\n--' + boundary + '--';
  const body = Buffer.concat([
    Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      meta + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mime + '\r\n\r\n'
    ),
    buf,
    Buffer.from(closeDelim)
  ]);

  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'multipart/related; boundary=' + boundary,
      'Content-Length': String(body.length)
    },
    body: body
  });
  const d = await r.json();
  if (!d.id) throw new Error('uploadFile: ' + JSON.stringify(d));
  return d;  // { id, name, webViewLink }
}

// ── API publique haut niveau ───────────────────────────────────────────
//
// uploadValidatedPhoto({ photoPath, handle, sub='pending', filename })
// → { drive_file_id, drive_url, folder_id }
async function uploadValidatedPhoto(opts) {
  if (!opts.photoPath) throw new Error('photoPath manquant');
  if (!opts.handle)    throw new Error('handle manquant');
  const sub = opts.sub || 'pending';
  const folderId = await findAccountFolder(opts.handle, sub);
  const fname = opts.filename || ('tina_studio_' + Date.now() + '.png');
  const r = await uploadFile(opts.photoPath, folderId, fname, opts.mimeType || 'image/png');
  return {
    drive_file_id: r.id,
    drive_url:     r.webViewLink || ('https://drive.google.com/file/d/' + r.id),
    folder_id:     folderId
  };
}

module.exports = {
  uploadValidatedPhoto: uploadValidatedPhoto,
  uploadFile:           uploadFile,
  findAccountFolder:    findAccountFolder,
  ensureSubfolder:      ensureSubfolder,
  getDriveToken:        getDriveToken
};
