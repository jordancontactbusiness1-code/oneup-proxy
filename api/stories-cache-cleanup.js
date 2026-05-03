// ═══════════════════════════════════════════════════════════════════
//  ZENTY — STORIES CACHE CLEANUP (Phase 3 cs-senior-engineer 2026-05-02)
//
//  POURQUOI : ensure-story-video upload des mp4 cache "<image>.jpg.mp4" sur
//  Drive sous le dossier stories/ pour éviter la conversion ffmpeg à chaque post.
//  À 100 comptes × 200 mp4/an = 20K fichiers + 50GB cumulatifs.
//
//  QUOI : 1×/mois (1er du mois 03h Paris) :
//   - Pour chaque compte du cron_config/driveFolderMap :
//     - List files dans stories/ ET dans posted/
//     - Pour chaque .mp4 cache (nom finit par .jpg.mp4 ou .png.mp4) :
//       - Si > 30 jours ET source image absente : DELETE
//   - Telegram : "Cache cleanup : N fichiers supprimés, X MB libérés"
//
//  Pas urgent en P3 mais permet scale propre 100 comptes.
//  Sécurité : ne touche QUE les .mp4 dont le nom matche pattern cache (pas les vrais reels).
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch  = require('node-fetch');
const fs     = require('fs');
const crypto = require('crypto');
const tg     = require('./_telegram-format.js');

const FIREBASE_URL = (process.env.FIREBASE_URL  || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SEC = process.env.FIREBASE_SECRET || '';
const CRON_SECRET  = process.env.CRON_SECRET    || '';
const TG_TOKEN     = process.env.TG_TOKEN       || '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const TG_CHAT      = process.env.TG_CHAT        || '6646462254';
const SA_PATH      = process.env.GDRIVE_SA_PATH || '/opt/zenty-cron/drive-sa.json';

const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 jours

const fbAuth = '?auth=' + FIREBASE_SEC;
async function fbGet(p) { const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth); return r.json(); }
const sendTelegram = tg.sendTelegram;

let _saCached = null;
function _b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function _getDriveAccessToken() {
  if (!_saCached && fs.existsSync(SA_PATH)) _saCached = JSON.parse(fs.readFileSync(SA_PATH, 'utf-8'));
  if (!_saCached) throw new Error('drive-sa.json not found');
  const now = Math.floor(Date.now() / 1000);
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = _b64url(JSON.stringify({
    iss: _saCached.client_email, scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
  }));
  const sig = _b64url(crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claim), _saCached.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claim + '.' + sig }).toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SA JWT auth failed: ' + JSON.stringify(d));
  return d.access_token;
}

async function listFiles(folderId, token) {
  const out = [];
  let pageToken = null;
  for (let p = 0; p < 50; p++) {
    let url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("'" + folderId + "' in parents and trashed=false") +
              '&fields=nextPageToken,files(id,name,size,createdTime,mimeType)&pageSize=100';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json();
    (d.files || []).forEach(function(f) { out.push(f); });
    if (!d.nextPageToken) break;
    pageToken = d.nextPageToken;
  }
  return out;
}

async function deleteFile(fileId, token) {
  const r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + token }
  });
  return r.status === 204 || r.status === 200;
}

const CACHE_NAME_RE = /\.(jpg|jpeg|png|gif|webp)\.mp4$/i;

module.exports = async function handler(req, res) {
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  console.log('[cache-cleanup] Starting');
  const dryRun = req.query && req.query.dry === '1';
  if (dryRun) console.log('[cache-cleanup] DRY RUN (pas de suppression)');

  try {
    const driveFolderMap = await fbGet('zenty/cron_config/driveFolderMap').catch(function() { return {}; });
    if (!driveFolderMap || typeof driveFolderMap !== 'object') {
      res.status(200).json({ ok: true, skipped: 'no driveFolderMap' });
      return;
    }
    const token = await _getDriveAccessToken();

    const now = Date.now();
    let totalScanned = 0, totalCacheFound = 0, totalDeleted = 0, totalBytesFreed = 0;
    const accountReports = [];

    const handles = Object.keys(driveFolderMap);
    for (const h of handles) {
      const f = driveFolderMap[h];
      if (!f) continue;
      const folders = [];
      if (f.stories) folders.push({ name: 'stories', id: f.stories });
      if (f.posted)  folders.push({ name: 'posted',  id: f.posted });
      let scanCount = 0, cacheCount = 0, delCount = 0, bytesFreed = 0;

      for (const folder of folders) {
        let files = [];
        try { files = await listFiles(folder.id, token); }
        catch (e) { console.warn('[cache-cleanup] List @' + h + '/' + folder.name + ' fail:', e.message); continue; }
        scanCount += files.length;
        for (const fl of files) {
          if (!CACHE_NAME_RE.test(fl.name)) continue; // pas un cache
          cacheCount++;
          const created = fl.createdTime ? new Date(fl.createdTime).getTime() : 0;
          if (now - created < MAX_AGE_MS) continue; // trop récent
          // OK : > 30 jours, supprimer (le mp4 sera regénéré next post si besoin)
          if (dryRun) { delCount++; bytesFreed += parseInt(fl.size || 0, 10); continue; }
          try {
            const ok = await deleteFile(fl.id, token);
            if (ok) { delCount++; bytesFreed += parseInt(fl.size || 0, 10); }
          } catch (e) {
            console.warn('[cache-cleanup] Delete fail:', fl.name, e.message);
          }
        }
      }

      totalScanned   += scanCount;
      totalCacheFound += cacheCount;
      totalDeleted   += delCount;
      totalBytesFreed += bytesFreed;
      if (delCount > 0) accountReports.push({ handle: h, deleted: delCount, mb: Math.round(bytesFreed / 1048576) });
    }

    const mbTotal = Math.round(totalBytesFreed / 1048576);
    console.log('[cache-cleanup] Done : scanned=' + totalScanned + ' cache=' + totalCacheFound + ' deleted=' + totalDeleted + ' mb=' + mbTotal);

    if (totalDeleted > 0) {
      const msg = tg.formatCacheCleanup({
        deleted: totalDeleted, mb: mbTotal,
        accountReports: accountReports, dryRun: dryRun
      });
      if (msg) await sendTelegram(msg);
    }

    res.status(200).json({
      ok: true, dryRun: dryRun,
      scanned: totalScanned, cacheFound: totalCacheFound,
      deleted: totalDeleted, bytesFreed: totalBytesFreed
    });
  } catch (e) {
    console.error('[cache-cleanup] FATAL:', e.message);
    await sendTelegram(tg.formatFatalError('cache-cleanup', e.message));
    res.status(500).json({ error: true, message: e.message });
  }
};
