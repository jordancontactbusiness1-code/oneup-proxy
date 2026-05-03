// ═══════════════════════════════════════════════════════════════════
//  ZENTY — DRIVE SCANNER (Phase 6 — auto sync Drive cross-user)
//  2026-05-03
//
//  POURQUOI : driveContentMap + driveFolderMap étaient stockés en localStorage
//  uniquement, et seul un user avec hasPerm('syncIG') pouvait cliquer Sync.
//  Les VAs (syncIG=false) voyaient zéro fichier sur un nouveau navigateur.
//
//  QUOI : tourne toutes les 30 min via systemd zenty-drive-scanner.timer.
//   1. Lit drive_root_fr + drive_root_us depuis zenty/config
//   2. Liste sous-dossiers (= comptes) + sous-sous-dossiers (reels/stories/...)
//   3. Liste fichiers de chaque dossier (paginé)
//   4. Écrit zenty/drive/folderMap + contentMap + lastScan en Firebase
//   5. Frontend (driveLoadMapsFromFirebase) charge ça au login → VA voit tout
//
//  AUTH : CRON_SECRET (header x-cron-secret) — pour le timer systemd
//  AUTH Drive : Service Account JWT (drive-sa.json) — déjà câblé sur VPS
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch  = require('node-fetch');
const fs     = require('fs');
const crypto = require('crypto');

const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const CRON_SECRET     = process.env.CRON_SECRET || '';
const SA_PATH         = process.env.GDRIVE_SA_PATH || '/opt/zenty-cron/drive-sa.json';

const fbAuth = '?auth=' + FIREBASE_SECRET;
async function fbGet(p) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth);
  return r.json();
}
async function fbPatch(p, value) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}

// ── Drive Auth — Service Account JWT (no expiration) ────────────────────────
let _saCached = null;
function _b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function getDriveToken() {
  if (!_saCached && fs.existsSync(SA_PATH)) _saCached = JSON.parse(fs.readFileSync(SA_PATH, 'utf-8'));
  if (!_saCached) throw new Error('drive-sa.json not found at ' + SA_PATH);
  const now    = Math.floor(Date.now() / 1000);
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = _b64url(JSON.stringify({
    iss: _saCached.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
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

// ── Drive helpers ────────────────────────────────────────────────────────────
async function listSubfolders(parentId, token) {
  const q = encodeURIComponent("'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)&pageSize=200';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  if (d.error) throw new Error('listSubfolders: ' + d.error.message);
  return d.files || [];
}

async function listFiles(folderId, token) {
  // Paginé. Stocke uniquement les champs utiles pour le frontend (id,name,mimeType,thumbnailLink,hasThumbnail).
  const q = encodeURIComponent("'" + folderId + "' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'");
  const baseUrl = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=nextPageToken,files(id,name,mimeType,thumbnailLink,hasThumbnail)&pageSize=200';
  let all = [];
  let pageToken = null;
  do {
    const url = pageToken ? (baseUrl + '&pageToken=' + encodeURIComponent(pageToken)) : baseUrl;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json();
    if (d.error) throw new Error('listFiles: ' + d.error.message);
    all = all.concat(d.files || []);
    pageToken = d.nextPageToken || null;
  } while (pageToken);
  // Filtrer les .mp4 cache générés depuis images (workaround story image → mp4) — invisibles dashboard
  return all.filter(function(f) { return !/\.(jpg|jpeg|png|gif|webp)\.mp4$/i.test(f.name || ''); });
}

function findSub(folders, names) {
  for (let i = 0; i < names.length; i++) {
    const f = folders.filter(function(x) { return (x.name || '').toLowerCase().replace(/\/$/, '') === names[i]; })[0];
    if (f) return f;
  }
  return null;
}

// ── Scan d'un compte (account folder) ───────────────────────────────────────
async function scanAccount(accFolder, token) {
  const subs = await listSubfolders(accFolder.id, token);
  const rfolder = findSub(subs, ['reels']);
  const sfolder = findSub(subs, ['stories']);
  const cfolder = findSub(subs, ['carousel', 'feed']);
  const pfolder = findSub(subs, ['posted']);

  const folderInfo = {
    folder:   accFolder.id,
    reels:    rfolder ? rfolder.id : null,
    stories:  sfolder ? sfolder.id : null,
    carousel: cfolder ? cfolder.id : null,
    posted:   pfolder ? pfolder.id : null
  };

  const [reels, stories, carousel, posted] = await Promise.all([
    rfolder ? listFiles(rfolder.id, token) : Promise.resolve([]),
    sfolder ? listFiles(sfolder.id, token) : Promise.resolve([]),
    cfolder ? listFiles(cfolder.id, token) : Promise.resolve([]),
    pfolder ? listFiles(pfolder.id, token) : Promise.resolve([])
  ]);

  return { folderInfo: folderInfo, content: { reels: reels, stories: stories, carousel: carousel, posted: posted } };
}

// ── Scan d'un agency root (FR ou US) ─────────────────────────────────────────
async function scanAgencyRoot(rootId, agency, token, folderMap, contentMap) {
  const accounts = await listSubfolders(rootId, token);
  let fileCount = 0;
  let accountCount = 0;

  // Batch de 5 comptes en parallèle (ne pas saturer Drive API)
  const batchSize = 5;
  for (let i = 0; i < accounts.length; i += batchSize) {
    const batch = accounts.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(function(accFolder) {
      return scanAccount(accFolder, token).then(function(r) {
        return { name: accFolder.name, ...r };
      }).catch(function(e) {
        console.warn('[drive-scanner] scanAccount fail @' + accFolder.name + ':', e.message);
        return null;
      });
    }));
    results.forEach(function(r) {
      if (!r) return;
      const handle = (r.name || '').toLowerCase().replace(/\/$/, '').trim();
      if (!handle) return;
      // Préfixer l'agence pour éviter conflit FR/US si même handle (rare mais possible)
      folderMap[handle] = Object.assign({ agency: agency }, r.folderInfo);
      contentMap[handle] = r.content;
      accountCount++;
      fileCount += r.content.reels.length + r.content.stories.length + r.content.carousel.length + r.content.posted.length;
    });
  }
  return { accountCount: accountCount, fileCount: fileCount };
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const startTime = Date.now();
  console.log('[drive-scanner] Starting scan');

  try {
    // 1. Charger les Drive roots depuis Firebase (source vérité)
    const config = await fbGet('zenty/config').catch(function() { return null; });
    const rootFR = (config && config.drive_root_fr) || '';
    const rootUS = (config && config.drive_root_us) || '';
    if (!rootFR && !rootUS) {
      res.status(500).json({ error: 'no drive root configured in zenty/config' });
      return;
    }

    // 2. Auth Drive
    const token = await getDriveToken();

    // 3. Scan FR + US (si configuré)
    const folderMap = {};
    const contentMap = {};
    const summary = { FR: { accountCount: 0, fileCount: 0 }, US: { accountCount: 0, fileCount: 0 } };

    if (rootFR) {
      try {
        summary.FR = await scanAgencyRoot(rootFR, 'FR', token, folderMap, contentMap);
      } catch (e) {
        console.error('[drive-scanner] FR root scan fail:', e.message);
        summary.FR.error = e.message;
      }
    }
    if (rootUS) {
      try {
        summary.US = await scanAgencyRoot(rootUS, 'US', token, folderMap, contentMap);
      } catch (e) {
        console.error('[drive-scanner] US root scan fail:', e.message);
        summary.US.error = e.message;
      }
    }

    const totalAccounts = summary.FR.accountCount + summary.US.accountCount;
    const totalFiles    = summary.FR.fileCount + summary.US.fileCount;
    const elapsed       = Date.now() - startTime;

    // 4. Écrire en Firebase (PATCH ciblé sous zenty/drive/, ne wipe pas les autres clés)
    // Firebase REST n'aime pas les clés avec '.' → on sanitize les handles (point → underscore).
    const folderMapSafe = {};
    const contentMapSafe = {};
    Object.keys(folderMap).forEach(function(h) {
      const safe = h.replace(/\./g, '_');
      folderMapSafe[safe] = folderMap[h];
      contentMapSafe[safe] = contentMap[h];
    });

    const lastScan = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      durationMs: elapsed,
      totalAccounts: totalAccounts,
      totalFiles: totalFiles,
      summary: summary
    };

    // PUT explicit pour folderMap + contentMap (remplace entièrement → dossiers supprimés disparaissent)
    await fetch(FIREBASE_URL + '/zenty/drive/folderMap.json' + fbAuth, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(folderMapSafe)
    });
    await fetch(FIREBASE_URL + '/zenty/drive/contentMap.json' + fbAuth, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contentMapSafe)
    });
    await fetch(FIREBASE_URL + '/zenty/drive/lastScan.json' + fbAuth, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastScan)
    });

    console.log('[drive-scanner] Done in ' + Math.round(elapsed/1000) + 's. accounts=' + totalAccounts + ' files=' + totalFiles);

    res.status(200).json({
      ok: true,
      elapsed_s: Math.round(elapsed / 1000),
      totalAccounts: totalAccounts,
      totalFiles: totalFiles,
      summary: summary
    });
  } catch (e) {
    console.error('[drive-scanner] FATAL:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
};
