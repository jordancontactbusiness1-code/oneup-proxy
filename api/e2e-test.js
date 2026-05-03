// ═══════════════════════════════════════════════════════════════════
//  ZENTY — E2E HEALTHCHECK (Phase 4 cs-senior-engineer 2026-05-02)
//
//  POURQUOI : aucun test bout-en-bout n'existe — on découvre les bugs en prod.
//  Solution : 1×/jour à 14h Paris, on vérifie que le pipeline complet marche.
//
//  QUOI :
//   1. Lit zenty/e2e_config Firebase : { sandboxAccount, sandboxFileId, sandboxCategoryId }
//   2. Vérifie que le post sandbox du jour précédent (programmé à J-1 14h+1h)
//      apparaît dans OneUp published. Si oui → ✅ pipeline OK.
//   3. Vérifie aussi que verify.js a bien marqué le post comme verified dans
//      zenty/post_verify_results/{J-1}.
//   4. Programme un nouveau post sandbox pour aujourd'hui +1h via OneUp API.
//   5. Telegram report OK/KO.
//
//  CONFIGURATION (à faire 1× manuellement par Jordan) :
//   - Choisir 1 compte IG sandbox dédié (ex: créer @zenty_e2e_test).
//   - Mettre 1 fichier mp4 de test dans son dossier reels/.
//   - Écrire dans Firebase :
//     {
//       sandboxAccount: 'zenty_e2e_test',
//       sandboxFileId: 'drive_file_id_du_test_mp4',
//       sandboxSocialNetworkId: '123456',
//       sandboxCategoryId: 'oneup_cat_id'
//     }
//   - Le compte sandbox NE DOIT PAS être dans cron_config/accounts (sinon double-schedule)
//
//  Si zenty/e2e_config absent : le script skip silencieux (pas d'alerte).
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');
const tg    = require('./_telegram-format.js');

const ONEUP_KEY    = process.env.ONEUP_API_KEY     || '';
const ONEUP_BASE   = 'https://www.oneupapp.io';
const FIREBASE_URL = (process.env.FIREBASE_URL     || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SEC = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET  = process.env.CRON_SECRET       || '';
const TG_TOKEN     = process.env.TG_TOKEN          || '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const TG_CHAT      = process.env.TG_CHAT           || '6646462254';

const fbAuth = '?auth=' + FIREBASE_SEC;
async function fbGet(p) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth);
  return r.json();
}
async function fbPatch(p, v) {
  return fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(v)
  }).then(function(r){ return r.json(); });
}
const sendTelegram = tg.sendTelegram;

function pad(n) { return String(n).padStart(2, '0'); }
function parisDateStr(d) {
  const p = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  return p.getFullYear() + '-' + pad(p.getMonth() + 1) + '-' + pad(p.getDate());
}
function parisDateTimeStr(d) {
  const p = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  return p.getFullYear() + '-' + pad(p.getMonth() + 1) + '-' + pad(p.getDate()) + ' ' + pad(p.getHours()) + ':' + pad(p.getMinutes());
}

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

module.exports = async function handler(req, res) {
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  console.log('[e2e] Starting');
  try {
    const cfg = await fbGet('zenty/e2e_config').catch(function() { return null; });
    if (!cfg || !cfg.sandboxAccount || !cfg.sandboxFileId || !cfg.sandboxSocialNetworkId) {
      console.log('[e2e] config missing, skip silent');
      res.status(200).json({ ok: true, skipped: 'no e2e_config' });
      return;
    }

    const todayStr = parisDateStr(new Date());
    const yStr     = (function() { const d = new Date(todayStr + 'T00:00:00'); d.setDate(d.getDate() - 1); return parisDateStr(d); })();

    // 1. Vérifier que le post sandbox programmé hier a été publié + verified
    const checks = { yesterdayPublished: null, yesterdayVerified: null };
    const published = await fetchOneupList('/api/getpublishedposts').catch(function() { return []; });
    const ystart = new Date(yStr + 'T00:00:00').getTime();
    const yend   = ystart + 24 * 3600 * 1000;
    const yesterdayPubMatch = published.filter(function(p) {
      const uname = (p.social_network_username || p.social_network_name || '').replace('@', '').toLowerCase();
      if (uname !== cfg.sandboxAccount.toLowerCase()) return false;
      const dt = (p.date_time || p.scheduled_date_time || p.created_at || '');
      const t = new Date(dt.replace(' ', 'T')).getTime();
      return t >= ystart && t < yend;
    });
    checks.yesterdayPublished = yesterdayPubMatch.length > 0;

    const yResults = await fbGet('zenty/post_verify_results/' + yStr).catch(function() { return null; });
    if (yResults && Array.isArray(yResults.verified)) {
      checks.yesterdayVerified = yResults.verified.some(function(v) {
        return (v.account || '').toLowerCase() === cfg.sandboxAccount.toLowerCase();
      });
    }

    // 2. Programmer un nouveau post sandbox pour aujourd'hui +1h
    const slotDate = new Date(Date.now() + 60 * 60 * 1000);
    const slotStr  = parisDateTimeStr(slotDate);
    const driveUrl = 'https://dashboard.jscaledashboard.online/api/drive-serve?fileId=' + cfg.sandboxFileId;
    const body = new URLSearchParams({
      apiKey:              ONEUP_KEY,
      social_network_id:   JSON.stringify([cfg.sandboxSocialNetworkId]),
      category_id:         cfg.sandboxCategoryId || '',
      scheduled_date_time: slotStr,
      content:             '[E2E test ' + todayStr + ']',
      video_url:           driveUrl,
      instagram:           JSON.stringify({ isReel: true, addToFeed: 1 })
    });
    const schedRes = await fetch(ONEUP_BASE + '/api/schedulevideopost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const schedData = await schedRes.json();
    const newPostId = (schedData && (schedData.post_id || (schedData.data && schedData.data.post_id))) || null;
    const schedOk = !!newPostId;

    // 3. Push verify queue Firebase pour que zenty-verify le traite
    if (schedOk) {
      await fbPatch('zenty/post_verify_queue/' + newPostId, {
        postId: newPostId,
        fileId: cfg.sandboxFileId,
        account: cfg.sandboxAccount,
        contentType: 'reels',
        scheduledAt: slotStr,
        queuedAt: new Date().toISOString(),
        e2eTest: true
      });
    }

    // 4. Telegram report (langage Jordan, pas dev)
    const overallOk = checks.yesterdayPublished && checks.yesterdayVerified !== false && schedOk;
    // On envoie SEULEMENT si KO (pas de spam quotidien quand tout va bien)
    if (!overallOk) {
      await sendTelegram(tg.formatE2EResult(checks, schedOk, cfg.sandboxAccount, slotStr));
    } else {
      console.log('[e2e] all OK, no Telegram (silent success)');
    }

    res.status(200).json({
      ok: true,
      checks: checks,
      newPostId: newPostId,
      slotStr: slotStr,
      overallOk: overallOk
    });
  } catch (e) {
    console.error('[e2e] FATAL:', e.message);
    await sendTelegram(tg.formatFatalError('e2e', e.message));
    res.status(500).json({ error: true, message: e.message });
  }
};
