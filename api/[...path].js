const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');

// ── Drive Auth — Service Account JWT (no expiration, replaces refresh_token) ──
// Migration 2026-04-14 : refresh_token expirait 7j (project Testing mode).
// SA JSON path : /opt/zenty-cron/drive-sa.json (VPS) ou /tmp/... (override env)
const SA_PATH = process.env.GDRIVE_SA_PATH || '/opt/zenty-cron/drive-sa.json';
let _saCached = null;
function _b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function _getDriveAccessToken() {
  if (!_saCached && fs.existsSync(SA_PATH)) _saCached = JSON.parse(fs.readFileSync(SA_PATH, 'utf-8'));
  if (!_saCached) throw new Error('drive-sa.json not found at ' + SA_PATH);
  const now = Math.floor(Date.now() / 1000);
  const header = _b64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const claim = _b64url(JSON.stringify({
    iss: _saCached.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  }));
  const sig = _b64url(crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claim), _saCached.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claim + '.' + sig}).toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SA JWT auth failed: ' + JSON.stringify(d));
  return d.access_token;
}

const ONEUP_KEY      = process.env.ONEUP_API_KEY || '';
const ONEUP_BASE     = 'https://www.oneupapp.io';
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const APIFY_KEY      = process.env.APIFY_API_KEY || '';

// Google Drive OAuth2 credentials (pour move fichiers reels/ → posted/)
const GDRIVE_CLIENT_ID     = process.env.GDRIVE_CLIENT_ID || '';
const GDRIVE_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET || '';
const GDRIVE_REFRESH_TOKEN = process.env.GDRIVE_REFRESH_TOKEN || '';

const ALLOWED = [
  'https://ofm-dashboard.onrender.com',
  'http://localhost',
  'http://127.0.0.1'
];

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  var ok = ALLOWED.some(function(o) { return origin.startsWith(o); });
  res.setHeader('Access-Control-Allow-Origin', ok ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Extract path from URL: /api/listcategory → /api/listcategory on OneUp
  var rawUrl   = req.url || '';
  var urlPath  = rawUrl.split('?')[0]; // e.g. /api/listcategory
  // Remove the Vercel function prefix if present (Vercel may strip it already)
  var apiPath  = urlPath.startsWith('/api/') ? urlPath : '/api/' + urlPath.replace(/^\/+/, '');
  // Fallback: use query param path if URL path is just /api
  if (apiPath === '/api/' || apiPath === '/api') {
    var qPath = req.query.path;
    if (qPath) {
      apiPath = '/api/' + (Array.isArray(qPath) ? qPath.join('/') : qPath);
    }
  }

  // ── Route spéciale : /api/drive-thumbnail → Miniature legere d'un fichier Drive ──
  // GET /api/drive-thumbnail?fileId=xxx → sert la miniature (~20-50KB au lieu de 1MB+)
  if (apiPath === '/api/drive-thumbnail') {
    var fileId = req.query.fileId || '';
    if (!fileId) { res.status(400).json({ error: true, message: 'fileId required' }); return; }
    if (!fs.existsSync(SA_PATH)) {
      res.status(500).json({ error: true, message: 'GDRIVE credentials not configured' }); return;
    }
    try {
      var tokenData;
      try { tokenData = { access_token: await _getDriveAccessToken() }; } catch(e) { res.status(500).json({ error: true, message: 'Drive auth failed' }); return; }
      // 1. Get thumbnailLink from file metadata
      var metaRes = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=thumbnailLink,mimeType', {
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
      });
      var meta = await metaRes.json();
      if (meta.error) { res.status(404).json({ error: true, message: meta.error.message || 'File not found' }); return; }
      if (!meta.thumbnailLink) {
        // Fallback : servir le fichier complet si pas de thumbnail (images petites)
        var driveRes2 = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
          headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
        });
        var ct2 = driveRes2.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', ct2);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        driveRes2.body.pipe(res);
        return;
      }
      // 2. Fetch the thumbnail (signed URL, ~20-50KB)
      var thumbUrl = meta.thumbnailLink.replace(/=s\d+$/, '=s300');
      var thumbRes = await fetch(thumbUrl);
      if (!thumbRes.ok) { res.status(thumbRes.status).json({ error: true, message: 'Thumbnail fetch failed' }); return; }
      var ct = thumbRes.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      thumbRes.body.pipe(res);
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Thumbnail error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/drive-serve → Sert un fichier Drive via OAuth (URL directe pour OneUp) ──
  // GET /api/drive-serve?fileId=xxx → stream le fichier avec le bon Content-Type
  if (apiPath === '/api/drive-serve') {
    var fileId = req.query.fileId || (req.body && req.body.fileId) || '';
    if (!fileId) { res.status(400).json({ error: true, message: 'fileId required' }); return; }
    if (!fs.existsSync(SA_PATH)) {
      res.status(500).json({ error: true, message: 'GDRIVE credentials not configured' }); return;
    }
    try {
      // SA JWT auth (no expiration)
      var tokenData;
      try { tokenData = { access_token: await _getDriveAccessToken() }; } catch(e) { res.status(500).json({ error: true, message: 'Drive auth failed: ' + e.message }); return; }
      var driveRes = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
      });
      if (!driveRes.ok) { res.status(driveRes.status).json({ error: true, message: 'Drive fetch failed: ' + driveRes.statusText }); return; }
      var ct = driveRes.headers.get('content-type') || 'application/octet-stream';
      var cl = driveRes.headers.get('content-length');
      res.setHeader('Content-Type', ct);
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      driveRes.body.pipe(res);
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Drive serve error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/drive-move → Déplace un fichier Drive vers posted/ ──
  // Body: { fileId, fromFolderId, toFolderId }
  // Utilise OAuth2 refresh token de zentyagency@gmail.com
  if (apiPath === '/api/drive-move') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!fs.existsSync(SA_PATH)) {
      res.status(500).json({ error: true, message: 'GDRIVE credentials not configured on Vercel' }); return;
    }
    try {
      var payload = req.body || {};
      var fileId = payload.fileId;
      var fromFolderId = payload.fromFolderId;
      var toFolderId = payload.toFolderId;
      if (!fileId || !fromFolderId || !toFolderId) {
        res.status(400).json({ error: true, message: 'fileId, fromFolderId, toFolderId required' }); return;
      }

      // SA JWT auth (no expiration)
      var tokenData;
      try { tokenData = { access_token: await _getDriveAccessToken() }; } catch(e) { tokenData = {}; }
      if (!tokenData.access_token) {
        res.status(500).json({ error: true, message: 'OAuth token refresh failed', detail: tokenData }); return;
      }

      // Move file: remove from old parent, add to new parent
      var moveRes = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?addParents=' + toFolderId + '&removeParents=' + fromFolderId, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      var moveData = await moveRes.json();
      if (moveData.error) {
        res.status(moveRes.status || 500).json({ error: true, message: moveData.error.message || 'Move failed' }); return;
      }
      res.status(200).json({ ok: true, fileId: fileId, newParents: moveData.parents });
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Drive move error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/drive-rename → Renomme un dossier Drive ──
  // Body: { folderId, newName }
  if (apiPath === '/api/drive-rename') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!fs.existsSync(SA_PATH)) {
      res.status(500).json({ error: true, message: 'GDRIVE credentials not configured on Vercel' }); return;
    }
    try {
      var payload = req.body || {};
      var folderId = payload.folderId;
      var newName = payload.newName;
      if (!folderId || !newName) {
        res.status(400).json({ error: true, message: 'folderId and newName required' }); return;
      }

      // SA JWT auth (no expiration)
      var tokenData;
      try { tokenData = { access_token: await _getDriveAccessToken() }; } catch(e) { tokenData = {}; }
      if (!tokenData.access_token) {
        res.status(500).json({ error: true, message: 'OAuth token refresh failed', detail: tokenData }); return;
      }

      // Rename folder
      var renameRes = await fetch('https://www.googleapis.com/drive/v3/files/' + folderId, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      var renameData = await renameRes.json();
      if (renameData.error) {
        res.status(renameRes.status || 500).json({ error: true, message: renameData.error.message || 'Rename failed' }); return;
      }
      res.status(200).json({ ok: true, folderId: folderId, newName: renameData.name });
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Drive rename error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/drive-list → Liste les sous-dossiers d'un dossier Drive ──
  // Body: { parentId }
  if (apiPath === '/api/drive-list') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!fs.existsSync(SA_PATH)) {
      res.status(500).json({ error: true, message: 'GDRIVE credentials not configured on Vercel' }); return;
    }
    try {
      var payload = req.body || {};
      var parentId = payload.parentId;
      if (!parentId) {
        res.status(400).json({ error: true, message: 'parentId required' }); return;
      }

      // SA JWT auth (no expiration)
      var tokenData;
      try { tokenData = { access_token: await _getDriveAccessToken() }; } catch(e) { tokenData = {}; }
      if (!tokenData.access_token) {
        res.status(500).json({ error: true, message: 'OAuth token refresh failed', detail: tokenData }); return;
      }

      // List subfolders
      var q = encodeURIComponent("'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
      var listRes = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,parents)', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
      });
      var listData = await listRes.json();
      if (listData.error) {
        res.status(listRes.status || 500).json({ error: true, message: listData.error.message || 'List failed' }); return;
      }
      res.status(200).json({ ok: true, folders: listData.files || [] });
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Drive list error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/drive-files → Liste les FICHIERS (pas dossiers) d'un dossier Drive ──
  // Body: { folderId, pageToken? }
  // Retourne les fichiers media (video + images) via OAuth2 de zentyagency@gmail.com
  if (apiPath === '/api/drive-files') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!fs.existsSync(SA_PATH)) {
      res.status(500).json({ error: true, message: 'GDRIVE credentials not configured on Vercel' }); return;
    }
    try {
      var payload = req.body || {};
      var folderId = payload.folderId;
      if (!folderId) { res.status(400).json({ error: true, message: 'folderId required' }); return; }

      // SA JWT auth (no expiration)
      var tokenData;
      try { tokenData = { access_token: await _getDriveAccessToken() }; } catch(e) { tokenData = {}; }
      if (!tokenData.access_token) {
        res.status(500).json({ error: true, message: 'OAuth token refresh failed' }); return;
      }

      // List files (video + images, not folders)
      var q = encodeURIComponent("'" + folderId + "' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'");
      var url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=nextPageToken,files(id,name,mimeType,size,thumbnailLink,hasThumbnail,imageMediaMetadata(width,height),videoMediaMetadata(width,height))&pageSize=100';
      if (payload.pageToken) url += '&pageToken=' + encodeURIComponent(payload.pageToken);
      var listRes = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
      });
      var listData = await listRes.json();
      if (listData.error) {
        res.status(listRes.status || 500).json({ error: true, message: listData.error.message || 'List failed' }); return;
      }
      res.status(200).json({ ok: true, files: listData.files || [], nextPageToken: listData.nextPageToken || null });
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Drive files error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/drive-create-folder → Crée un dossier dans Drive ──
  // Body: { parentId, name }
  if (apiPath === '/api/drive-create-folder') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!fs.existsSync(SA_PATH)) {
      res.status(500).json({ error: true, message: 'GDRIVE credentials not configured on Vercel' }); return;
    }
    try {
      var payload = req.body || {};
      var parentId = payload.parentId;
      var folderName = payload.name;
      if (!parentId || !folderName) {
        res.status(400).json({ error: true, message: 'parentId and name required' }); return;
      }

      // SA JWT auth (no expiration)
      var tokenData;
      try { tokenData = { access_token: await _getDriveAccessToken() }; } catch(e) { tokenData = {}; }
      if (!tokenData.access_token) {
        res.status(500).json({ error: true, message: 'OAuth token refresh failed', detail: tokenData }); return;
      }

      // Create folder
      var createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId]
        })
      });
      var createData = await createRes.json();
      if (createData.error) {
        res.status(createRes.status || 500).json({ error: true, message: createData.error.message || 'Create failed' }); return;
      }
      res.status(200).json({ ok: true, folderId: createData.id, name: createData.name });
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Drive create folder error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/ensure-story-video → image .jpg/.png → mp4 1s pour Story IG ──
  // Body: { fileId, parentFolderId }
  // Si fileId est déjà une vidéo → return tel quel
  // Si image : check cache (même nom + .mp4 dans parentFolderId), sinon convertit via ffmpeg + upload
  // Retourne : { videoFileId, cached: bool, converted: bool }
  if (apiPath === '/api/ensure-story-video') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!fs.existsSync(SA_PATH)) {
      res.status(500).json({ error: true, message: 'GDRIVE credentials not configured' }); return;
    }
    try {
      var p = req.body || {};
      if (!p.fileId || !p.parentFolderId) { res.status(400).json({ error: true, message: 'fileId and parentFolderId required' }); return; }

      // SA JWT auth (no expiration)
      var tok;
      try { tok = { access_token: await _getDriveAccessToken() }; } catch(e) { res.status(500).json({ error: true, message: 'Drive auth failed: ' + e.message }); return; }

      // Get file metadata
      var metaRes = await fetch('https://www.googleapis.com/drive/v3/files/' + p.fileId + '?fields=id,name,mimeType', { headers: { Authorization: 'Bearer ' + tok.access_token } });
      var meta = await metaRes.json();
      if (meta.error) { res.status(404).json({ error: true, message: 'File not found' }); return; }

      // If video, return as-is
      if ((meta.mimeType || '').startsWith('video/')) {
        res.status(200).json({ videoFileId: meta.id, cached: false, converted: false }); return;
      }
      if (!(meta.mimeType || '').startsWith('image/')) {
        res.status(400).json({ error: true, message: 'Not an image: ' + meta.mimeType }); return;
      }

      // Check cache : same name + ".mp4" in parent folder
      var cacheName = meta.name + '.mp4';
      var qCache = encodeURIComponent("'" + p.parentFolderId + "' in parents and name='" + cacheName.replace(/'/g, "\\'") + "' and trashed=false");
      var cacheRes = await fetch('https://www.googleapis.com/drive/v3/files?q=' + qCache + '&fields=files(id,name)', { headers: { Authorization: 'Bearer ' + tok.access_token } });
      var cacheData = await cacheRes.json();
      if (cacheData.files && cacheData.files.length) {
        res.status(200).json({ videoFileId: cacheData.files[0].id, cached: true, converted: false }); return;
      }

      // Download image, convert with ffmpeg, upload (fs déjà requis au top)
      var path = require('path');
      var os = require('os');
      var { spawn } = require('child_process');
      var tmpDir = os.tmpdir();
      var inPath = path.join(tmpDir, 'in_' + meta.id + '_' + Date.now());
      var outPath = inPath + '.mp4';

      var dlRes = await fetch('https://www.googleapis.com/drive/v3/files/' + p.fileId + '?alt=media', { headers: { Authorization: 'Bearer ' + tok.access_token } });
      if (!dlRes.ok) { res.status(500).json({ error: true, message: 'Image download failed: ' + dlRes.status }); return; }
      var buf = Buffer.from(await dlRes.arrayBuffer());
      fs.writeFileSync(inPath, buf);

      // ffmpeg : image fixe → mp4 H.264 5 secondes (min Instagram Story), 30fps, faststart
      // 5s pour eviter le rejet de IG (min 3s requis pour Stories)
      await new Promise(function(resolve, reject) {
        var ff = spawn('ffmpeg', ['-y', '-loop', '1', '-i', inPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1', '-r', '30', '-t', '5', '-movflags', '+faststart', '-an', outPath]);
        var err = '';
        ff.stderr.on('data', function(d){ err += d.toString(); });
        ff.on('close', function(code){ if (code === 0) resolve(); else reject(new Error('ffmpeg exit ' + code + ': ' + err.slice(-500))); });
      });

      var mp4Buf = fs.readFileSync(outPath);
      try { fs.unlinkSync(inPath); fs.unlinkSync(outPath); } catch(e) {}

      // Upload mp4 to Drive (multipart)
      var boundary = '-------OneUpStoryUpload' + Date.now();
      var meta2 = JSON.stringify({ name: cacheName, parents: [p.parentFolderId] });
      var body = Buffer.concat([
        Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta2 + '\r\n--' + boundary + '\r\nContent-Type: video/mp4\r\n\r\n'),
        mp4Buf,
        Buffer.from('\r\n--' + boundary + '--')
      ]);
      var upRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'multipart/related; boundary=' + boundary, 'Content-Length': body.length },
        body: body
      });
      var upData = await upRes.json();
      if (upData.error) { res.status(500).json({ error: true, message: 'Upload failed: ' + upData.error.message }); return; }

      res.status(200).json({ videoFileId: upData.id, cached: false, converted: true });
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'ensure-story-video error: ' + e.message });
      return;
    }
  }

  // ── Route spéciale : /api/anthropic → Proxy Anthropic Claude API ──────
  // Body: { model, max_tokens, messages, system? }
  if (apiPath === '/api/anthropic') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!ANTHROPIC_KEY) { res.status(500).json({ error: true, message: 'ANTHROPIC_API_KEY not configured on Vercel' }); return; }
    try {
      var payload = req.body || {};
      if (!payload.model || !payload.messages) {
        res.status(400).json({ error: true, message: 'model and messages required' }); return;
      }
      var anthropicBody = {
        model: payload.model,
        max_tokens: payload.max_tokens || 1024,
        messages: payload.messages
      };
      if (payload.system) anthropicBody.system = payload.system;
      var anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify(anthropicBody)
      });
      var anthropicData = await anthropicRes.json();
      res.status(anthropicRes.status || 200).json(anthropicData);
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Anthropic proxy error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/apify → Proxy Apify Instagram scraper ──────
  // Body: { usernames: ["username1", ...], timeout? }
  if (apiPath === '/api/apify') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!APIFY_KEY) { res.status(500).json({ error: true, message: 'APIFY_API_KEY not configured on Vercel' }); return; }
    try {
      var payload = req.body || {};
      var usernames = payload.usernames || [];
      var timeout = payload.timeout || 120;
      if (!usernames.length) {
        res.status(400).json({ error: true, message: 'usernames array required' }); return;
      }
      var apifyUrl = 'https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items?token=' + APIFY_KEY + '&timeout=' + timeout;
      var apifyRes = await fetch(apifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: usernames })
      });
      var apifyData = await apifyRes.json();
      res.status(apifyRes.status || 200).json(apifyData);
      return;
    } catch (e) {
      res.status(500).json({ error: true, message: 'Apify proxy error: ' + e.message }); return;
    }
  }

  // ── Route spéciale : /api/transcribe → AssemblyAI (pas OneUp) ──────
  if (apiPath === '/api/transcribe') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'Method not allowed' }); return; }
    if (!ASSEMBLYAI_KEY) { res.status(500).json({ error: true, message: 'ASSEMBLYAI_API_KEY not configured' }); return; }
    try {
      var payload = req.body || {};
      var action  = payload.action || 'submit';
      if (action === 'submit') {
        if (!payload.audio_url) { res.status(400).json({ error: true, message: 'audio_url required' }); return; }
        // Utiliser la cle du client si fournie, sinon env var
        var aaiKey = payload.assemblyai_key || ASSEMBLYAI_KEY;
        var submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
          method: 'POST',
          headers: { 'Authorization': aaiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({audio_url: payload.audio_url, language_detection: true, speech_models: ["universal-2"]})
        });
        var submitData = await submitRes.json();
        res.status(200).json(submitData);
        return;
      } else if (action === 'poll') {
        if (!payload.transcript_id) { res.status(400).json({ error: true, message: 'transcript_id required' }); return; }
        var pollRes = await fetch('https://api.assemblyai.com/v2/transcript/' + payload.transcript_id, {
          method: 'GET',
          headers: { 'Authorization': ASSEMBLYAI_KEY }
        });
        var pollData = await pollRes.json();
        res.status(200).json(pollData);
        return;
      } else {
        res.status(400).json({ error: true, message: 'Invalid action (submit|poll)' });
        return;
      }
    } catch (e) {
      res.status(500).json({ error: true, message: 'AssemblyAI error: ' + e.message });
      return;
    }
  }

  try {
    if (req.method === 'GET') {
      var params = new URLSearchParams();
      params.set('apiKey', ONEUP_KEY);
      Object.keys(req.query).forEach(function(k) {
        if (k !== 'path') params.set(k, req.query[k]);
      });
      var r    = await fetch(ONEUP_BASE + apiPath + '?' + params.toString());
      var text = await r.text();
      try { res.json(JSON.parse(text)); } catch(e) { res.status(502).json({ error: 'OneUp returned non-JSON', body: text.slice(0, 200) }); }

    } else if (req.method === 'POST') {
      var body = new URLSearchParams();
      body.set('apiKey', ONEUP_KEY);
      var payload = req.body || {};
      Object.keys(payload).forEach(function(k) { body.set(k, payload[k]); });
      var r    = await fetch(ONEUP_BASE + apiPath, {
        method:  'POST',
        body:    body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      var text = await r.text();
      try { res.json(JSON.parse(text)); } catch(e) { res.status(502).json({ error: 'OneUp returned non-JSON', body: text.slice(0, 200) }); }
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
