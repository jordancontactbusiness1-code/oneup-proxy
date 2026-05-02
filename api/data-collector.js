// ═══════════════════════════════════════════════════════════════════
//  ZENTY — DATA COLLECTOR (Phase 5 — Business Analytics)
//  2026-05-02 nuit
//
//  POURQUOI : la vision business analytics nécessite un historique daily PERSISTANT
//  des followers/posts/engagement. Aujourd'hui : ouAccountStats localStorage (30j
//  rolling) côté browser, dépendant de Jordan qui clique "Sync". Insuffisant pour
//  identifier les winners/losers à scale 50 comptes.
//
//  QUOI : tourne 1×/jour à 06h UTC (avant smoke + digest matin).
//   1. Lit la liste des comptes actifs (Firebase zenty/cron_config/accounts)
//   2. UN SEUL appel Apify batch (instagram-profile-scraper) pour tous
//   3. Pour chaque compte : write zenty/account_history/{handle_safe}/{YYYY-MM-DD}
//      - followers, following, postsCount, engagementAvg
//      - posts_today_count + posts_today_failed (depuis post_verify_results)
//      - timestamp + source (apify_batch)
//   4. Skip si data Apify partielle (followersCount undefined) — pas de fake data
//
//  COÛT APIFY : ~$0.001 par profil scraped. 12 comptes × 30j = ~$0.36/mois.
//  Largement sous le plafond 5$/mois fixé par Jordan.
//
//  AUTH : CRON_SECRET (header x-cron-secret)
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');

const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET     = process.env.CRON_SECRET       || '';
const APIFY_KEY       = process.env.APIFY_API_KEY     || '';

const fbAuth = '?auth=' + FIREBASE_SECRET;
async function fbGet(p) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth);
  return r.json();
}
async function fbPut(p, value) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}
async function fbPatch(p, value) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}

// ── Sanitize handle Firebase (point → underscore) ────────────────────────────
function sanitize(handle) { return (handle || '').replace(/\./g, '_'); }

// ── Apify call BATCH (1 seul appel pour tous les handles) ────────────────────
async function fetchApifyBatch(usernames) {
  if (!APIFY_KEY) throw new Error('APIFY_API_KEY not configured');
  const url = 'https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items?token=' + APIFY_KEY + '&timeout=180';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: usernames })
  });
  if (!r.ok) throw new Error('Apify HTTP ' + r.status);
  const txt = await r.text();
  if (txt.trim().startsWith('<')) throw new Error('Apify returned HTML (rate limit or down)');
  const data = JSON.parse(txt);
  if (!Array.isArray(data)) throw new Error('Apify response not array');
  return data;
}

// ── Calcul engagement moyen depuis latestPosts (Apify) ──────────────────────
function computeEngagementAvg(profile) {
  const posts = profile && profile.latestPosts;
  if (!Array.isArray(posts) || !posts.length) return null;
  const followers = profile.followersCount || 0;
  if (followers === 0) return null;
  // Engagement = (likes + comments) / followers — moyenne sur dernières 12 posts dispo
  const sample = posts.slice(0, 12).filter(function(p) { return p && (p.likesCount != null || p.commentsCount != null); });
  if (!sample.length) return null;
  let totalEng = 0;
  sample.forEach(function(p) {
    totalEng += (p.likesCount || 0) + (p.commentsCount || 0);
  });
  const avg = totalEng / sample.length / followers;
  return Math.round(avg * 100000) / 100000; // 5 decimals (en pourcent c'est ratio × 100)
}

// ── Compte les posts publiés/failed du jour pour un compte ───────────────────
function countPostsToday(verifyResults, handle) {
  const verified = (verifyResults && Array.isArray(verifyResults.verified)) ? verifyResults.verified : [];
  const failed   = (verifyResults && Array.isArray(verifyResults.failed))   ? verifyResults.failed   : [];
  const handleLow = (handle || '').toLowerCase();
  const v = verified.filter(function(p) { return (p.account || '').toLowerCase() === handleLow; }).length;
  const f = failed.filter(function(p) { return (p.account || '').toLowerCase() === handleLow; }).length;
  return { published: v, failed: f };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!APIFY_KEY) {
    res.status(500).json({ error: 'APIFY_API_KEY not configured' });
    return;
  }

  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  console.log('[collector] Starting daily snapshot for ' + today);

  try {
    // 1. Lire les comptes actifs depuis cron_config (source vérité du cron)
    const accountsRaw = await fbGet('zenty/cron_config/accounts').catch(function() { return null; });
    if (!accountsRaw || typeof accountsRaw !== 'object') {
      res.status(500).json({ error: 'no accounts in cron_config' });
      return;
    }
    const handles = [];
    Object.keys(accountsRaw).forEach(function(snid) {
      const a = accountsRaw[snid];
      if (!a || !a.username) return;
      // On collecte AUSSI les comptes paused (pour suivre s'ils stagnent ou non avant decision suppression)
      const handle = (a.username || '').replace('@', '').toLowerCase();
      if (handle) handles.push(handle);
    });
    if (!handles.length) {
      res.status(200).json({ ok: true, message: 'no accounts to collect' });
      return;
    }
    console.log('[collector] ' + handles.length + ' handles to scrape (1 batch Apify call)');

    // 2. UN SEUL appel Apify batch
    let apifyData = [];
    try {
      apifyData = await fetchApifyBatch(handles);
    } catch (e) {
      console.error('[collector] Apify batch fail:', e.message);
      res.status(503).json({ ok: false, error: 'apify_batch_failed', detail: e.message });
      return;
    }
    console.log('[collector] Apify returned ' + apifyData.length + ' profiles');

    // 3. Lire post_verify_results today pour compter posts publiés/failed par compte
    const verifyResults = await fbGet('zenty/post_verify_results/' + today).catch(function() { return null; });

    // 4. Pour chaque compte Apify, snapshot Firebase
    const snapshotsWritten = [];
    const snapshotsSkipped = [];
    const writes = {};
    apifyData.forEach(function(profile) {
      const handle = (profile.username || '').toLowerCase();
      if (!handle) return;
      // Détecter scraping partiel : Apify a trouvé le compte mais ne renvoie pas les stats
      // (compte trop récent ou restriction IG). On NE STOCKE PAS de données partielles
      // pour respecter "données réelles uniquement" (Jordan 2026-05-02).
      const statsOk = profile.followersCount !== undefined ||
                      profile.followers      !== undefined ||
                      profile.postsCount     !== undefined;
      if (!statsOk) {
        snapshotsSkipped.push({ handle: handle, reason: 'apify_partial' });
        return;
      }
      const followers = (profile.followersCount !== undefined) ? profile.followersCount : (profile.followers || 0);
      const following = profile.followsCount || profile.following || 0;
      const postsCount = profile.postsCount || 0;
      const engagementAvg = computeEngagementAvg(profile);
      const todayPosts = countPostsToday(verifyResults, handle);
      const handleSafe = sanitize(handle);
      const snapshot = {
        handle: handle,
        followers: followers,
        following: following,
        postsCount: postsCount,
        engagementAvg: engagementAvg, // ratio (likes+comments) / followers / posts moyen sur 12 derniers
        postsToday: todayPosts.published,
        postsTodayFailed: todayPosts.failed,
        biography: (profile.biography || '').slice(0, 200),
        profilePic: profile.profilePicUrlHD || profile.profilePicUrl || profile.profilePic || '',
        isVerified: !!profile.verified,
        scrapedAt: new Date().toISOString(),
        source: 'apify_batch'
      };
      writes['zenty/account_history/' + handleSafe + '/' + today] = snapshot;
      snapshotsWritten.push({ handle: handle, followers: followers, eng: engagementAvg });
    });

    // 5. Batch write Firebase (1 PATCH global sur la racine = 1 round-trip)
    if (Object.keys(writes).length > 0) {
      await fbPatch('', writes);
    }

    // 6. Tracker l'usage Apify mensuel pour monitoring coût
    const monthKey = today.slice(0, 7); // YYYY-MM
    const apifyMonthCount = await fbGet('zenty/apify_calls/' + monthKey).catch(function() { return 0; });
    const newMonthCount = (typeof apifyMonthCount === 'number' ? apifyMonthCount : 0) + 1;
    const monthPatch = {};
    monthPatch[monthKey] = newMonthCount;
    await fbPatch('zenty/apify_calls', monthPatch);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log('[collector] Done in ' + elapsed + 's. written=' + snapshotsWritten.length + ' skipped=' + snapshotsSkipped.length);

    res.status(200).json({
      ok: true,
      date: today,
      requested: handles.length,
      written: snapshotsWritten.length,
      skipped: snapshotsSkipped.length,
      skippedDetail: snapshotsSkipped,
      apifyCallsThisMonth: newMonthCount,
      estimatedMonthCostUsd: (newMonthCount * 0.0012 * handles.length).toFixed(3), // ~$0.0012/profile estimate
      elapsed_s: elapsed
    });
  } catch (e) {
    console.error('[collector] FATAL:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
};
