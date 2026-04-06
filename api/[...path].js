const fetch = require('node-fetch');

const ONEUP_KEY      = process.env.ONEUP_API_KEY || '';
const ONEUP_BASE     = 'https://www.oneupapp.io';
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY || '';

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

  // ── Route spéciale : /api/drive-move → Déplace un fichier Drive vers posted/ ──
  // Body: { fileId, fromFolderId, toFolderId }
  // Utilise OAuth2 refresh token de zentyagency@gmail.com
  if (apiPath === '/api/drive-move') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'POST only' }); return; }
    if (!GDRIVE_CLIENT_ID || !GDRIVE_REFRESH_TOKEN) {
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

      // Get fresh access token from refresh token
      var tokenBody = new URLSearchParams({
        client_id: GDRIVE_CLIENT_ID,
        client_secret: GDRIVE_CLIENT_SECRET,
        refresh_token: GDRIVE_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      }).toString();
      var tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody
      });
      var tokenData = await tokenRes.json();
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

  // ── Route spéciale : /api/transcribe → AssemblyAI (pas OneUp) ──────
  if (apiPath === '/api/transcribe') {
    if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'Method not allowed' }); return; }
    if (!ASSEMBLYAI_KEY) { res.status(500).json({ error: true, message: 'ASSEMBLYAI_API_KEY not configured' }); return; }
    try {
      var payload = req.body || {};
      var action  = payload.action || 'submit';
      if (action === 'submit') {
        if (!payload.audio_url) { res.status(400).json({ error: true, message: 'audio_url required' }); return; }
        var submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
          method: 'POST',
          headers: { 'Authorization': ASSEMBLYAI_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio_url: payload.audio_url,
            language_detection: true,
            speech_models: ['universal-2']  // API 2026 : field renommé en array
          })
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
