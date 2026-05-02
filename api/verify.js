// ═══════════════════════════════════════════════════════════════════
//  ZENTY — VERIFY VPS (F1 fix — cs-senior-engineer)
//  2026-05-02 — Migration postVerifyRun browser → service systemd VPS
//
//  POURQUOI : avant ce fix, postVerifyRun tournait UNIQUEMENT dans le browser.
//  Si Jordan ne charge pas le dashboard 2h+, aucun rollback automatique des
//  posts ratés. À 100 comptes × 5 posts/jour = 500 posts en attente vérif.
//
//  QUOI : ce handler est appelé toutes les 30 min par systemd zenty-verify.timer.
//   1. Fetch Firebase zenty/post_verify_queue (push par browser au scheduling)
//   2. Fetch OneUp getpublishedposts + getfailedposts (live truth)
//   3. Pour chaque item après 30min :
//      - match published → ✅ verified, remove queue
//      - match failed OR >2h timeout → rollback Drive via SA, Telegram alert
//   4. Update Firebase zenty/post_verify_results/{date} (lu par browser pour UI)
//
//  IDEMPOTENT : run twice = même résultat. Items supprimés de queue après process.
//  AUTH : CRON_SECRET dans header x-cron-secret ou ?secret=
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch  = require('node-fetch');
const fs     = require('fs');
const crypto = require('crypto');
const tg     = require('./_telegram-format.js');

// ── Env / constantes ──────────────────────────────────────────────────────────
const ONEUP_KEY    = process.env.ONEUP_API_KEY     || '';
const ONEUP_BASE   = 'https://www.oneupapp.io';
const FIREBASE_URL = (process.env.FIREBASE_URL     || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SEC = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET  = process.env.CRON_SECRET       || '';
const TG_TOKEN     = process.env.TG_TOKEN          || '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const TG_CHAT      = process.env.TG_CHAT           || '6646462254';
const SA_PATH      = process.env.GDRIVE_SA_PATH    || '/opt/zenty-cron/drive-sa.json';

const VERIFY_BUFFER_MS = 30 * 60 * 1000;     // 30 min après slot avant vérif
const TIMEOUT_MS       = 2 * 60 * 60 * 1000; // 2h sans trace = considéré failed

// ── Firebase REST helpers ─────────────────────────────────────────────────────
const fbAuth = '?auth=' + FIREBASE_SEC;
async function fbGet(path) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth);
  return r.json();
}
async function fbPatch(path, value) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}
async function fbDelete(path) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth, { method: 'DELETE' });
  return r.json();
}

// ── Telegram helper (délégué à _telegram-format.js) ───────────────────────────
const sendTelegram = tg.sendTelegram;

// ── Service Account JWT (Drive auth, no expiration) ──────────────────────────
let _saCached = null;
function _b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function _getDriveAccessToken() {
  if (!_saCached && fs.existsSync(SA_PATH)) _saCached = JSON.parse(fs.readFileSync(SA_PATH, 'utf-8'));
  if (!_saCached) throw new Error('drive-sa.json not found at ' + SA_PATH);
  const now = Math.floor(Date.now() / 1000);
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = _b64url(JSON.stringify({
    iss:   _saCached.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600, iat: now
  }));
  const sig = _b64url(crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claim), _saCached.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claim + '.' + sig }).toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SA JWT auth failed: ' + JSON.stringify(d));
  return d.access_token;
}

// ── Drive move : posted/ → source folder (rollback fichier orphelin) ──────────
async function driveMoveBack(fileId, fromFolderId, toFolderId) {
  const tok = await _getDriveAccessToken();
  const r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?addParents=' + toFolderId + '&removeParents=' + fromFolderId, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const d = await r.json();
  if (d.error) throw new Error('Drive move back failed: ' + (d.error.message || JSON.stringify(d)));
  return d;
}

// ── OneUp fetch (paginated) ───────────────────────────────────────────────────
async function fetchOneupList(endpoint) {
  const all = [];
  let start = 0;
  for (let page = 0; page < 20; page++) {
    const r = await fetch(ONEUP_BASE + endpoint + '?start=' + start + '&apiKey=' + ONEUP_KEY);
    const d = await r.json();
    const arr = Array.isArray(d) ? d : (d.data || []);
    if (!arr.length) break;
    arr.forEach(function(p) { all.push(p); });
    if (arr.length < 50) break;
    start += 50;
  }
  return all;
}

// ── Date helpers (Paris timezone) ─────────────────────────────────────────────
function parisDateStr(d) {
  const p = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  function pad(n) { return String(n).padStart(2, '0'); }
  return p.getFullYear() + '-' + pad(p.getMonth() + 1) + '-' + pad(p.getDate());
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Auth
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const startTime = Date.now();
  const todayStr  = parisDateStr(new Date());
  console.log('[verify ' + todayStr + '] Starting');

  try {
    // 1. Fetch queue Firebase + OneUp lists en parallèle (+ scheduled pour backfill)
    const [queueRaw, published, failed, scheduled, driveFolderMapRaw, postTypeMapRaw] = await Promise.all([
      fbGet('zenty/post_verify_queue').catch(function() { return null; }),
      fetchOneupList('/api/getpublishedposts').catch(function() { return []; }),
      fetchOneupList('/api/getfailedposts').catch(function() { return []; }),
      fetchOneupList('/api/getscheduledposts').catch(function() { return []; }),
      fbGet('zenty/cron_config/driveFolderMap').catch(function() { return {}; }),
      fbGet('zenty/post_type_map').catch(function() { return {}; })
    ]);

    const queue          = (queueRaw && typeof queueRaw === 'object') ? queueRaw : {};
    const driveFolderMap = driveFolderMapRaw || {};
    const postTypeMap    = postTypeMapRaw || {};

    // 1.b BACKFILL : tout post OneUp (scheduled OU published OU failed) absent de la queue
    // est ajouté automatiquement. Filet de sécurité contre tab fermé entre Apply et push Firebase.
    // Source du fileId : registry post_type_map (clé fileid_<driveFileId>) ou inférence URL.
    const allOneup = [].concat(scheduled, published, failed);
    let backfilled = 0;
    for (const p of allOneup) {
      const pid = p.post_id || p.id;
      if (!pid || queue[pid]) continue; // Déjà tracké ou pas de post_id
      const dt = p.date_time || p.scheduled_date_time || p.created_at || '';
      // Considère seulement les posts du jour (filtre date Paris)
      if (!dt.startsWith(todayStr)) continue;
      const uname = (p.social_network_username || p.social_network_name || '').replace('@', '').toLowerCase();
      // Récup type + fileId via registry post_type_map (SOURCE DE VÉRITÉ interne)
      let type = 'reels', fileId = null, typeFromRegistry = false;
      if (postTypeMap[pid]) {
        type = postTypeMap[pid].type || 'reels';
        fileId = postTypeMap[pid].fileId || null;
        typeFromRegistry = true;
      }
      // Sinon inférence URL (pattern fileId Drive dans video_url)
      if (!fileId) {
        const url = (p.video_url || '') + ' ' + (p.content_image || '');
        const m = url.match(/fileId=([a-zA-Z0-9_-]{20,})/);
        if (m) fileId = m[1];
      }
      // Inférence type UNIQUEMENT si pas dans registry — sinon registry prime (évite mismatch
      // ex : story qui rate sans média se retrouvait classée 'carousel' à cause du fallback)
      if (!typeFromRegistry) {
        try {
          const ig = typeof p.instagram === 'string' ? JSON.parse(p.instagram) : (p.instagram || {});
          if (ig.isStory) type = 'stories';
          else if (ig.isReel) type = 'reels';
          else if ((p.content_image || p.image_url) && !p.video_url) type = 'carousel';
        } catch(e) {}
      }
      // Ajouter à la queue (sera processed dans la même run)
      queue[pid] = {
        postId: pid, fileId: fileId, account: uname,
        contentType: type, scheduledAt: dt.substring(0, 16),
        queuedAt: new Date().toISOString(),
        backfilled: true
      };
      backfilled++;
    }
    if (backfilled > 0) {
      console.log('[verify] BACKFILL: +' + backfilled + ' posts OneUp absents de la queue (browser n\'a pas pushé)');
      // Persister dans Firebase pour cohérence (next run verra ces items)
      const patchBatch = {};
      Object.keys(queue).forEach(function(k) { if (queue[k].backfilled) patchBatch[k] = queue[k]; });
      if (Object.keys(patchBatch).length) {
        await fbPatch('zenty/post_verify_queue', patchBatch);
      }
    }

    // Si queue vide même après backfill, exit
    if (Object.keys(queue).length === 0) {
      console.log('[verify] queue empty (no OneUp posts today either), exit');
      res.status(200).json({ ok: true, processed: 0, message: 'queue empty' });
      return;
    }

    // Indexer published/failed par post_id
    const publishedById = {};
    published.forEach(function(p) { if (p.post_id) publishedById[p.post_id] = p; });
    const failedById = {};
    failed.forEach(function(p) { if (p.post_id) failedById[p.post_id] = p; });

    console.log('[verify] queue=' + Object.keys(queue).length + ' published=' + published.length + ' failed=' + failed.length);

    // 2. Fetch results existants du jour pour append
    const existingResults = await fbGet('zenty/post_verify_results/' + todayStr).catch(function() { return null; });
    const dayResults = existingResults && typeof existingResults === 'object'
      ? existingResults
      : { date: todayStr, verified: [], failed: [], updatedAt: 0 };
    if (!Array.isArray(dayResults.verified)) dayResults.verified = [];
    if (!Array.isArray(dayResults.failed))   dayResults.failed   = [];

    // 3. Process queue items
    const now = Date.now();
    const processed = { verified: 0, failed: 0, kept: 0, errors: 0 };
    const queueDeletes = []; // postIds à supprimer après process
    const newFailedAlerts = [];

    for (const postId of Object.keys(queue)) {
      const item = queue[postId];
      if (!item || !item.scheduledAt) {
        // Item corrompu — drop
        queueDeletes.push(postId);
        processed.errors++;
        continue;
      }

      // Parser scheduledAt format "YYYY-MM-DD HH:MM" en heure Paris
      const schedTime = new Date((item.scheduledAt || '').replace(' ', 'T') + ':00').getTime();
      if (isNaN(schedTime)) {
        queueDeletes.push(postId);
        processed.errors++;
        continue;
      }

      // Pas encore le moment de vérifier
      if (now < schedTime + VERIFY_BUFFER_MS) {
        processed.kept++;
        continue;
      }

      // ✅ Match published
      if (publishedById[postId]) {
        // DEDUP : skip si déjà processed aujourd'hui (évite append dupliqué dans Firebase)
        if (dayResults.verified.some(function(f) { return f.postId === postId; })) {
          queueDeletes.push(postId);
          processed.verified++;
          continue;
        }
        dayResults.verified.push({
          postId: postId, fileId: item.fileId, account: item.account,
          contentType: item.contentType, scheduledAt: item.scheduledAt,
          verifiedAt: new Date().toISOString()
        });
        queueDeletes.push(postId);
        processed.verified++;
        continue;
      }

      // ❌ Match failed OneUp OU timeout 2h
      const isOneupFailed = !!failedById[postId];
      const isTimeout     = now > schedTime + TIMEOUT_MS;
      if (isOneupFailed || isTimeout) {
        // DEDUP : skip si déjà processed (rollback Drive déjà fait, alerte déjà partie au digest)
        if (dayResults.failed.some(function(f) { return f.postId === postId; })) {
          queueDeletes.push(postId);
          processed.failed++;
          continue;
        }
        // Rollback Drive : posted/ → source folder
        const accName = (item.account || '').replace('@', '').toLowerCase();
        // Lookup driveFolderMap : sanitize . → _ (cohérent registry browser)
        const safeName = accName.replace(/\./g, '_');
        const folderInfo = driveFolderMap[accName] || driveFolderMap[safeName] || null;
        let rollbackOk = false, rollbackMsg = '';
        if (folderInfo && folderInfo.posted && item.fileId) {
          const sourceFolderId = folderInfo[item.contentType] || folderInfo.reels;
          if (sourceFolderId) {
            try {
              await driveMoveBack(item.fileId, folderInfo.posted, sourceFolderId);
              rollbackOk = true;
              rollbackMsg = 'Drive moved back to ' + item.contentType + '/';
            } catch (e) {
              rollbackMsg = 'Drive move back error: ' + e.message;
              processed.errors++;
            }
          } else {
            rollbackMsg = 'No source folder for type=' + item.contentType;
          }
        } else {
          rollbackMsg = 'No driveFolderMap entry for @' + accName;
        }

        // Enrichir avec la raison OneUp si disponible. La VRAIE clé OneUp est `fail_reason`
        // (les autres sont des hypothèses qui ne sont pas dans la réponse réelle de OneUp API).
        let oneupReason = '';
        if (isOneupFailed && failedById[postId]) {
          const f = failedById[postId];
          oneupReason = f.fail_reason || f.error_message || f.message || f.failure_reason || f.status_message || f.error || '';
          if (typeof oneupReason !== 'string') { try { oneupReason = JSON.stringify(oneupReason); } catch(e) { oneupReason = ''; } }
          // Si content_image=NA et source_url=NA → poste arrivé sans média (cause profonde, à logger)
          if ((f.content_image === 'NA' || !f.content_image) && (f.source_url === 'NA' || !f.source_url)) {
            oneupReason = (oneupReason || 'ERROR') + ' | aucun média uploadé (NA)';
          }
        }

        const failedEntry = {
          postId: postId, fileId: item.fileId, account: accName,
          contentType: item.contentType, scheduledAt: item.scheduledAt,
          failedAt: new Date().toISOString(),
          reason: isOneupFailed ? 'oneup_failed' : 'timeout_2h',
          oneupReason: oneupReason,
          rollback: { ok: rollbackOk, msg: rollbackMsg }
        };
        dayResults.failed.push(failedEntry);
        newFailedAlerts.push(failedEntry);
        queueDeletes.push(postId);
        processed.failed++;
        continue;
      }

      // Encore en attente (pas published, pas failed, pas timeout)
      processed.kept++;
    }

    // 4. Update Firebase results
    dayResults.updatedAt = now;
    await fbPatch('zenty/post_verify_results/' + todayStr, dayResults);

    // 5. Delete queue items processed (PATCH avec valeurs null = delete cible Firebase REST)
    if (queueDeletes.length) {
      const delBody = {};
      queueDeletes.forEach(function(pid) { delBody[pid] = null; });
      await fbPatch('zenty/post_verify_queue', delBody);
    }

    // 6. Telegram alert UNIQUEMENT si rafale critique (>= 10 fails dans 1 run de 30 min).
    //    Sinon SILENCE : les fails sont stockés Firebase et envoyés dans le digest matin/soir.
    //    Cf. budget Telegram 3-4/jour MAX (memory/feedback_telegram_budget_3_4_par_jour.md).
    const RAFALE_THRESHOLD = 10;
    if (newFailedAlerts.length >= RAFALE_THRESHOLD) {
      const msg = tg.formatFailAlert(newFailedAlerts);
      if (msg) await sendTelegram(msg);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log('[verify] Done in ' + elapsed + 's : verified=' + processed.verified + ' failed=' + processed.failed + ' kept=' + processed.kept + ' errors=' + processed.errors);

    res.status(200).json({
      ok: true,
      todayStr: todayStr,
      processed: processed,
      elapsed_s: elapsed,
      results_total: { verified: dayResults.verified.length, failed: dayResults.failed.length }
    });
  } catch (e) {
    console.error('[verify] FATAL:', e.message);
    console.error(e.stack);
    await sendTelegram(tg.formatFatalError('verify', e.message));
    res.status(500).json({ error: true, message: e.message });
  }
};
