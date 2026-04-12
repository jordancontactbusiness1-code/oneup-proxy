// ═══════════════════════════════════════════════════════════════════
//  ZENTY — DAILY SCHEDULER v3
//  2026-04-11 — Caption IA (Claude Haiku) intégrée
//
//  QUAND    : Timer systemd 23:00 UTC = 01:00 Paris (après minuit)
//  QUOI     : Programme les posts du jour PARIS qui vient de commencer
//  MARCHE   : Fenêtres horaires FR avec randomisation
//  CAPTIONS : Claude Haiku — génération parallèle AVANT scheduling
//             Cache Firebase par fileId (évite les regénérations)
//             Fallback template si IA échoue
//  SECURITE : Firebase flag AVANT scheduling (anti-race-condition)
//             getTodayScheduledByType() comme 2e filet
//             Anti-doublon cross-compte en mémoire _usedFileIds
//             Drive listé UNE seule fois par dossier par compte
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');

// ── API keys ──────────────────────────────────────────────────────────────────
const ONEUP_KEY      = process.env.ONEUP_API_KEY        || '';
const ONEUP_BASE     = 'https://www.oneupapp.io';
const FIREBASE_URL   = (process.env.FIREBASE_URL        || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SEC   = process.env.FIREBASE_SECRET      || '';
const GDRIVE_ID      = process.env.GDRIVE_CLIENT_ID     || '';
const GDRIVE_SECRET  = process.env.GDRIVE_CLIENT_SECRET || '';
const GDRIVE_TOKEN   = process.env.GDRIVE_REFRESH_TOKEN || '';
const CRON_SECRET    = process.env.CRON_SECRET          || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY    || '';
const TG_TOKEN       = '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const TG_CHAT        = '6646462254';

// ── Fenêtres horaires FR — randomisation dans chaque plage ───────────────────
const PEAK_WINDOWS = {
  reels: [
    { start: [7,  0], end: [9,  0] },
    { start: [12, 0], end: [14, 0] },
    { start: [17, 0], end: [19, 0] },
    { start: [21, 0], end: [23, 0] }
  ],
  stories: [
    { start: [7,  30], end: [9,  30] },
    { start: [12, 30], end: [14, 30] },
    { start: [17, 30], end: [19, 30] },
    { start: [21, 30], end: [23, 30] }
  ],
  carousel: [
    { start: [12, 0], end: [14, 0] },
    { start: [19, 0], end: [21, 0] }
  ]
};

// ── Helpers utils ─────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function parisDateStr(d) {
  const p = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  return p.getFullYear() + '-' + pad(p.getMonth() + 1) + '-' + pad(p.getDate());
}

// Génère un slot horaire dans une fenêtre pour un compte donné.
// accountIdx étale les comptes uniformément dans la fenêtre (stagger).
function generateSlot(window, targetParisDateStr, accountIdx, totalAccounts) {
  const startMin = window.start[0] * 60 + window.start[1];
  const endMin   = window.end[0]   * 60 + window.end[1];
  const range    = endMin - startMin;
  const accountSpread = totalAccounts > 1
    ? Math.floor((range * accountIdx) / totalAccounts)
    : Math.floor(Math.random() * range);
  const jitter = Math.floor(Math.random() * 11) - 5; // ±5 min
  var totalMin = startMin + accountSpread + jitter;
  if (totalMin < startMin) totalMin = startMin + Math.floor(Math.random() * 5);
  if (totalMin >= endMin)  totalMin = endMin - 1 - Math.floor(Math.random() * 5);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return targetParisDateStr + ' ' + pad(h) + ':' + pad(m);
}

// ── Firebase helpers ──────────────────────────────────────────────────────────
const fbAuth = '?auth=' + FIREBASE_SEC;

async function fbGet(path) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth);
  return r.json();
}

async function fbPut(path, value) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(value)
  });
  return r.json();
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TG_CHAT, text: text, parse_mode: 'Markdown', disable_web_page_preview: true })
    });
  } catch (e) { /* silent */ }
}

// ── Google Drive OAuth ────────────────────────────────────────────────────────
async function getOAuthToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     GDRIVE_ID,
      client_secret: GDRIVE_SECRET,
      refresh_token: GDRIVE_TOKEN,
      grant_type:    'refresh_token'
    }).toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('OAuth refresh failed: ' + JSON.stringify(d));
  return d.access_token;
}

async function listDriveFolder(token, folderId) {
  const url = 'https://www.googleapis.com/drive/v3/files'
    + '?q=' + encodeURIComponent("'" + folderId + "' in parents and trashed=false")
    + '&fields=files(id,name,mimeType)&pageSize=100&orderBy=name';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  return (d.files || []);
}

async function moveFileToDrive(token, fileId, fromId, toId) {
  const r = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + fileId + '?addParents=' + toId + '&removeParents=' + fromId,
    { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' }
  );
  if (!r.ok) { console.error('[drive] Move FAILED for ' + fileId + ': HTTP ' + r.status); return false; }
  return true;
}

// ── Anti-doublon OneUp ────────────────────────────────────────────────────────
// Récupère TOUS les posts schedulés via pagination (OneUp retourne ~50 par page).
// Appelé UNE SEULE FOIS au démarrage du cron, résultat partagé entre tous les comptes.
async function fetchAllScheduledPosts() {
  var allPosts = [];
  var start    = 0;
  var maxPages = 20; // sécurité anti-boucle infinie (20 × 50 = 1000 posts max)
  while (maxPages-- > 0) {
    try {
      const r = await fetch(ONEUP_BASE + '/api/getscheduledposts?start=' + start + '&apiKey=' + ONEUP_KEY);
      const d = await r.json();
      const page = Array.isArray(d) ? d : (d.data || []);
      allPosts = allPosts.concat(page);
      if (page.length < 50) break; // plus de pages
      start += 50;
    } catch (e) {
      console.error('[oneup] fetchAllScheduledPosts error at start=' + start + ':', e.message);
      break;
    }
  }
  console.log('[oneup] ' + allPosts.length + ' post(s) schedulés trouvés (toutes pages)');
  return allPosts;
}

// Filtre en mémoire — pas d'appel API (allPosts déjà chargé)
function countScheduledByType(allPosts, username, targetDateStr) {
  const todayPosts = allPosts.filter(function(p) {
    const dt = p.date_time || p.scheduled_date_time || '';
    const un = (p.social_network_username || p.social_network_name || '').replace('@', '').toLowerCase();
    return dt.startsWith(targetDateStr) && un === username.toLowerCase();
  });
  const counts = { reels: 0, stories: 0, carousel: 0 };
  todayPosts.forEach(function(p) {
    const hasVideo = p.video_url && p.video_url !== 'NA';
    const hasImg   = p.content_image && p.content_image !== 'NA';
    const hasImgs  = p.image_urls && Array.isArray(p.image_urls) && p.image_urls.length > 1;
    const ig = (function() { try { return JSON.parse(p.instagram_settings || '{}'); } catch (e) { return {}; } })();
    if (ig.isStory || ig.shareToStory) counts.stories++;
    else if (hasImgs)              counts.carousel++;
    else if (hasVideo)             counts.reels++;
    else if (hasImg && !ig.isReel) counts.stories++;
    else                           counts.reels++;
  });
  return counts;
}

// ── Caption IA — Claude Haiku ─────────────────────────────────────────────────
//
// Logique :
//   stories  → template uniquement (texte peu visible sur les stories)
//   IA OFF   → template pour tous
//   IA ON    → cache Firebase → Anthropic → fallback template
//
// Cache : zenty/captions_cache/{fileId_sanitized}
// Modèle : claude-haiku-4-5-20251001 (rapide, économique, ~1-2s)
// ─────────────────────────────────────────────────────────────────────────────

async function callAnthropic(uname, template) {
  // Exemples fixes OFM style (anchor le modele sur le bon registre)
  const examples = [
    'dans mes pensees \uD83C\uDF19',
    'juste moi, aujourd\'hui \u2728',
    'quelque chose de doux \uD83E\uDD0D',
    'un peu de moi pour toi \uD83E\uDEF6',
    'douce comme toujours \uD83C\uDF38',
    'la vie est belle quand on sait ou regarder \u2728\uD83C\uDF3F'
  ];
  const styleBlock = template
    ? 'Exemples de captions validees :\n- ' + template + '\n- ' + examples.slice(0, 3).join('\n- ')
    : 'Exemples de captions validees :\n- ' + examples.join('\n- ');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json'
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role:    'user',
        content: 'Tu geres le compte Instagram OFM @' + uname + ' (crearice de contenu francophone, niche girl-next-door, audience masculine FR).\n' + styleBlock + '\n\nGenere UNE nouvelle caption dans ce meme style :\n- 1 a 3 lignes max\n- 2-3 emojis\n- Ton intime, personnel, leger, authentique\n- SANS hashtags, SANS questions generiques, SANS references aux reseaux sociaux\n- Unique — ne pas copier les exemples\n\nReponds UNIQUEMENT avec la caption, rien d\'autre.'
      }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return ((d.content && d.content[0] && d.content[0].text) || '').trim();
}

async function generateCaption(fileId, type, uname, captionCfg) {
  const template = (captionCfg && captionCfg.template) || '';

  // Stories : template uniquement (pas d'IA)
  if (type === 'stories') return template;

  // IA désactivée ou pas de clé
  if (!captionCfg || !captionCfg.enabled || !ANTHROPIC_KEY) return template;

  // Cache Firebase — évite les regénérations pour le même fichier
  const cacheKey = 'zenty/captions_cache/' + fileId.replace(/[^a-zA-Z0-9]/g, '_');
  try {
    const cached = await fbGet(cacheKey);
    if (cached && cached.text) {
      console.log('[caption] Cache hit — ' + fileId.substring(0, 12) + '... @' + uname);
      return cached.text;
    }
  } catch (e) { /* ignore erreur cache */ }

  // Appel Anthropic
  try {
    const caption = await callAnthropic(uname, template);
    // Écriture cache en arrière-plan (silencieux si échec)
    fbPut(cacheKey, { text: caption, generatedAt: Date.now(), account: uname }).catch(function() {});
    console.log('[caption] Generated @' + uname + ': "' + caption.substring(0, 50) + '"');
    return caption;
  } catch (e) {
    console.error('[caption] Anthropic error @' + uname + ':', e.message);
    return template; // fallback garanti
  }
}

// ── Programmer un post sur OneUp ──────────────────────────────────────────────
// content : caption IA ou template fallback
async function schedulePost(snId, catId, fileId, dateStr, type, fileName, content) {
  const mediaUrl   = 'https://dashboard.jscaledashboard.online/api/drive-serve?fileId=' + fileId;
  const isStory    = type === 'stories';
  const isCarousel = type === 'carousel';
  const isImage    = /\.(jpg|jpeg|png|gif|webp)$/i.test(fileName || '');
  const endpoint   = (isCarousel || (isStory && isImage))
    ? '/api/scheduleimagepost'
    : '/api/schedulevideopost';

  const body = new URLSearchParams({
    apiKey:              ONEUP_KEY,
    social_network_id:   JSON.stringify([snId]),
    category_id:         catId || '',
    scheduled_date_time: dateStr,
    content:             content || ''
  });

  if (isCarousel || (isStory && isImage)) {
    body.set('image_url', mediaUrl);
  } else {
    body.set('video_url', mediaUrl);
  }

  if (isStory) {
    body.set('instagram', JSON.stringify({ isStory: true }));
  } else if (!isCarousel) {
    body.set('instagram', JSON.stringify({ isReel: true, addToFeed: 1 }));
  }

  try {
    const r = await fetch(ONEUP_BASE + endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString()
    });
    const d = await r.json();
    if (d && d.error) return { ok: false, postId: null, error: d.message || JSON.stringify(d) };
    const postId = d && (d.post_id || d.id || (d.data && d.data.id) || null);
    return { ok: true, postId: String(postId || ''), error: null };
  } catch (e) {
    return { ok: false, postId: null, error: e.message };
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Auth
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const startTime     = Date.now();
  const targetDateStr = parisDateStr(new Date());
  console.log('[cron v3] Starting for Paris date: ' + targetDateStr);

  try {
    // 1. Config Firebase
    const cronConfig = await fbGet('zenty/cron_config');
    if (!cronConfig || !cronConfig.accounts) {
      await sendTelegram('⚠️ *Zenty Cron* — Aucune config dans Firebase.\nLancer Apply Automation depuis le dashboard.');
      res.status(200).json({ ok: false, message: 'no config' });
      return;
    }

    const accounts       = cronConfig.accounts       || {};
    const driveFolderMap = cronConfig.driveFolderMap || {};
    const captionCfg     = cronConfig.captionConfig  || { enabled: false, template: '' };

    console.log('[cron v3] Caption mode: ' + (captionCfg.enabled ? 'IA Claude Haiku' : 'Template "' + (captionCfg.template || 'vide') + '"'));

    // 2. OAuth Drive + prefetch OneUp en parallèle (une seule fois pour tout le run)
    var oauthToken     = null;
    var allOneupPosts  = [];
    const [oauthResult, oneupResult] = await Promise.allSettled([
      Object.keys(driveFolderMap).length > 0 ? getOAuthToken() : Promise.resolve(null),
      fetchAllScheduledPosts()
    ]);
    if (oauthResult.status === 'fulfilled')  oauthToken    = oauthResult.value;
    else console.error('[drive] OAuth failed:', oauthResult.reason && oauthResult.reason.message);
    if (oneupResult.status === 'fulfilled')  allOneupPosts = oneupResult.value;
    else console.error('[oneup] fetchAll failed:', oneupResult.reason && oneupResult.reason.message);

    const _usedFileIds  = new Set();
    const accountList   = Object.keys(accounts);
    const totalAccounts = accountList.length;

    // ── PHASE 1 : Construire le plan de scheduling ────────────────────────────
    // Pour chaque compte : vérifier skip, lister Drive UNE fois par dossier,
    // sélectionner fichiers (anti-doublon cross-compte), ajouter au plan.
    // Aucun appel OneUp ici — uniquement la préparation.
    // ─────────────────────────────────────────────────────────────────────────
    const plan    = [];
    var skippedCount   = 0;
    var skippedReasons = [];
    var accountResults = {};

    for (var accountIdx = 0; accountIdx < accountList.length; accountIdx++) {
      const snId = accountList[accountIdx];
      const acc  = accounts[snId];
      if (!acc || !acc.username) continue;
      const uname = acc.username.replace('@', '').toLowerCase();

      // Déjà schedulé aujourd'hui (flag Firebase)
      if (acc.lastScheduledDate === targetDateStr) {
        skippedCount++;
        skippedReasons.push('⏭ @' + uname + ' — déjà schedulé');
        continue;
      }

      // Double-check OneUp (filet anti-race-condition) — filtre en mémoire, 0 appel API
      const existing    = countScheduledByType(allOneupPosts, uname, targetDateStr);
      const needReels   = Math.max(0, (acc.reels   || 0) - existing.reels);
      const needStories = Math.max(0, (acc.stories || 0) - existing.stories);
      const needFeed    = Math.max(0, (acc.feed    || 0) - existing.carousel);

      if (needReels + needStories + needFeed === 0) {
        skippedCount++;
        await fbPut('zenty/cron_config/accounts/' + snId + '/lastScheduledDate', targetDateStr);
        skippedReasons.push('⏭ @' + uname + ' — quota atteint (' + existing.reels + 'R/' + existing.stories + 'S)');
        continue;
      }

      // Marquer Firebase EN COURS avant tout scheduling (anti-race-condition)
      await fbPut('zenty/cron_config/accounts/' + snId + '/lastScheduledDate', targetDateStr);
      accountResults[snId] = { uname: uname, scheduled: 0, errors: [] };

      const folders   = driveFolderMap[uname] || {};
      const carFolder = folders.carousel || folders.feed || null;

      // Lister tous les dossiers Drive UNE seule fois en parallèle
      const [allReelFiles, allStoryFiles, allCarouselFiles] = await Promise.all([
        (folders.reels   && oauthToken) ? listDriveFolder(oauthToken, folders.reels)   : Promise.resolve([]),
        (folders.stories && oauthToken) ? listDriveFolder(oauthToken, folders.stories) : Promise.resolve([]),
        (carFolder       && oauthToken) ? listDriveFolder(oauthToken, carFolder)       : Promise.resolve([])
      ]);

      // Sélectionner les Reels
      for (var ri = 0; ri < needReels; ri++) {
        const available = allReelFiles.filter(function(f) { return !_usedFileIds.has(f.id); });
        if (!available.length) { accountResults[snId].errors.push('reels: Drive vide ou tous utilisés'); break; }
        const file = available[Math.floor(Math.random() * available.length)];
        _usedFileIds.add(file.id);
        plan.push({
          snId: snId, acc: acc, uname: uname, file: file, type: 'reels',
          window: PEAK_WINDOWS.reels[ri] || PEAK_WINDOWS.reels[PEAK_WINDOWS.reels.length - 1],
          accountIdx: accountIdx, fromFolder: folders.reels, toFolder: folders.posted,
          caption: null, slot: null
        });
      }

      // Sélectionner les Stories
      for (var si = 0; si < needStories; si++) {
        const available = allStoryFiles.filter(function(f) { return !_usedFileIds.has(f.id); });
        if (!available.length) { accountResults[snId].errors.push('stories: Drive vide ou tous utilisés'); break; }
        const file = available[Math.floor(Math.random() * available.length)];
        _usedFileIds.add(file.id);
        plan.push({
          snId: snId, acc: acc, uname: uname, file: file, type: 'stories',
          window: PEAK_WINDOWS.stories[si] || PEAK_WINDOWS.stories[PEAK_WINDOWS.stories.length - 1],
          accountIdx: accountIdx, fromFolder: folders.stories, toFolder: folders.posted,
          caption: null, slot: null
        });
      }

      // Sélectionner les Carousels
      for (var ci = 0; ci < needFeed; ci++) {
        const available = allCarouselFiles.filter(function(f) { return !_usedFileIds.has(f.id); });
        if (!available.length) break;
        const file = available[Math.floor(Math.random() * available.length)];
        _usedFileIds.add(file.id);
        plan.push({
          snId: snId, acc: acc, uname: uname, file: file, type: 'carousel',
          window: PEAK_WINDOWS.carousel[ci] || PEAK_WINDOWS.carousel[PEAK_WINDOWS.carousel.length - 1],
          accountIdx: accountIdx, fromFolder: carFolder, toFolder: folders.posted,
          caption: null, slot: null
        });
      }
    }

    console.log('[cron v3] Phase 1 — plan: ' + plan.length + ' post(s) pour ' + totalAccounts + ' compte(s)');

    // ── PHASE 2 : Générer TOUTES les captions en batches parallèles ─────────────
    // Batches de 15 pour respecter les rate limits Anthropic (50 RPM Haiku).
    // Stories → template. Reels/Carousel → IA si enabled.
    // Cache Firebase évite les regénérations pour les mêmes fichiers.
    // ─────────────────────────────────────────────────────────────────────────
    const CAPTION_BATCH = 15; // max appels Anthropic simultanés
    if (plan.length > 0) {
      if (captionCfg.enabled && ANTHROPIC_KEY) {
        const aiCount = plan.filter(function(i) { return i.type !== 'stories'; }).length;
        console.log('[caption] Génération de ' + aiCount + ' caption(s) IA — batches de ' + CAPTION_BATCH + '...');
        for (var ci2 = 0; ci2 < plan.length; ci2 += CAPTION_BATCH) {
          const batch = plan.slice(ci2, ci2 + CAPTION_BATCH);
          await Promise.all(
            batch.map(function(item) {
              return generateCaption(item.file.id, item.type, item.uname, captionCfg)
                .then(function(cap) { item.caption = cap; });
            })
          );
        }
        console.log('[caption] Toutes les captions prêtes.');
      } else {
        plan.forEach(function(item) { item.caption = captionCfg.template || ''; });
        if (captionCfg.template) console.log('[caption] Mode template — "' + captionCfg.template + '"');
      }

      // Générer les slots horaires
      plan.forEach(function(item) {
        item.slot = generateSlot(item.window, targetDateStr, item.accountIdx, totalAccounts);
      });
    }

    // ── PHASE 3 : Scheduler sur OneUp + déplacer les fichiers Drive ──────────
    // Batches de 10 en parallèle — 10× plus rapide que séquentiel.
    // 50 comptes × 6 posts = 300 posts → ~30s au lieu de ~300s.
    // ─────────────────────────────────────────────────────────────────────────
    const SCHEDULE_BATCH = 10;
    var   scheduledTotal = 0;
    var   failedTotal    = 0;

    for (var pi = 0; pi < plan.length; pi += SCHEDULE_BATCH) {
      const batch = plan.slice(pi, pi + SCHEDULE_BATCH);
      await Promise.all(
        batch.map(async function(item) {
          const result = await schedulePost(
            item.snId, item.acc.category_id, item.file.id,
            item.slot, item.type, item.file.name, item.caption
          );
          if (result.ok) {
            scheduledTotal++;
            accountResults[item.snId].scheduled++;
            if (item.toFolder && item.fromFolder && oauthToken) {
              const moved = await moveFileToDrive(oauthToken, item.file.id, item.fromFolder, item.toFolder);
              if (!moved) console.warn('[drive] Move failed: ' + item.file.name + ' @' + item.uname);
            }
          } else {
            failedTotal++;
            accountResults[item.snId].errors.push(item.type + ': ' + result.error);
          }
        })
      );
    }

    console.log('[cron v3] Phase 3 — ' + scheduledTotal + ' schedulés, ' + failedTotal + ' échoués');

    // ── Rapport Telegram ──────────────────────────────────────────────────────
    const results = [];
    Object.keys(accountResults).forEach(function(snId) {
      const r = accountResults[snId];
      if (r.errors.length > 0) {
        results.push('⚠️ @' + r.uname + ' — ' + r.scheduled + ' ok / ' + r.errors.length + ' erreur(s): ' + r.errors.join(' | '));
      } else if (r.scheduled > 0) {
        results.push('✅ @' + r.uname + ' — ' + r.scheduled + ' post(s) programmé(s)');
      } else {
        results.push('⚠️ @' + r.uname + ' — 0 post (Drive vide ?)');
      }
    });
    skippedReasons.forEach(function(r) { results.push(r); });

    const dur         = ((Date.now() - startTime) / 1000).toFixed(1);
    const emoji       = failedTotal > 0 ? '⚠️' : '⚡';
    const captionMode = captionCfg.enabled ? '✨ Claude IA' : '📝 Template';
    const lines       = [
      emoji + ' *Zenty Daily Scheduler v3* — ' + targetDateStr,
      '',
      '📊 ' + totalAccounts + ' comptes | ' + scheduledTotal + ' programmés | ' + skippedCount + ' déjà OK | ' + failedTotal + ' erreur(s)',
      '🖊️ Captions: ' + captionMode
    ];
    if (results.length) lines.push('', results.join('\n'));
    lines.push('\n⏱ ' + dur + 's');
    await sendTelegram(lines.join('\n'));

    res.status(200).json({
      ok:          true,
      scheduled:   scheduledTotal,
      skipped:     skippedCount,
      failed:      failedTotal,
      date:        targetDateStr,
      accounts:    totalAccounts,
      captionMode: captionMode
    });

  } catch (e) {
    console.error('[cron v3] FATAL:', e);
    await sendTelegram('🚨 *Zenty Cron ERREUR* — ' + e.message);
    res.status(500).json({ error: e.message });
  }
};
