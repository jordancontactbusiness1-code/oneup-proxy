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

// Check si un slot HH:MM est encore dans le futur (Paris time, +5min buffer)
function isSlotFutureParis(slotTime) {
  if (!/^\d{1,2}:\d{2}$/.test(slotTime)) return false;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const nowMin = now.getHours() * 60 + now.getMinutes() + 5;
  const p = slotTime.split(':');
  return (parseInt(p[0]) * 60 + parseInt(p[1])) >= nowMin;
}

// Check si un slot complet "YYYY-MM-DD HH:MM" est encore dans le futur Paris (+5min buffer).
// Règle absolue anti-rafale : on ne schedule JAMAIS dans le passé, OneUp publierait immédiatement.
function isSlotFutureFullParis(slotDateTime) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(slotDateTime || '')) return false;
  const nowParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const todayStr = nowParis.getFullYear() + '-' + pad(nowParis.getMonth() + 1) + '-' + pad(nowParis.getDate());
  const p = slotDateTime.split(' ');
  const slotDate = p[0];
  if (slotDate > todayStr) return true;
  if (slotDate < todayStr) return false;
  const hm = p[1].split(':');
  const slotMin = parseInt(hm[0]) * 60 + parseInt(hm[1]);
  const nowMin  = nowParis.getHours() * 60 + nowParis.getMinutes() + 5;
  return slotMin >= nowMin;
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

// ── Google Drive Auth — Service Account JWT (no expiration) ──────────────────
// Migration 2026-04-14 : refresh_token expirait toutes les 7j (project en mode Testing).
// Service account n'expire pas et accède aux dossiers Drive partagés avec son email.
const SA_PATH = process.env.GDRIVE_SA_PATH || '/opt/zenty-cron/drive-sa.json';
let _saCache = null;
function _loadSA() {
  if (!_saCache) _saCache = JSON.parse(require('fs').readFileSync(SA_PATH, 'utf-8'));
  return _saCache;
}
function _b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function getOAuthToken() {
  // Fallback refresh_token si SA manquant (backward compat)
  if (!require('fs').existsSync(SA_PATH)) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({client_id: GDRIVE_ID, client_secret: GDRIVE_SECRET, refresh_token: GDRIVE_TOKEN, grant_type: 'refresh_token'}).toString()
    });
    const d = await r.json();
    if (!d.access_token) throw new Error('OAuth refresh failed: ' + JSON.stringify(d));
    return d.access_token;
  }
  const sa = _loadSA();
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = _b64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const claim = _b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const sig = _b64url(crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claim), sa.private_key));
  const jwt = header + '.' + claim + '.' + sig;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt}).toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SA JWT auth failed: ' + JSON.stringify(d));
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

// Extrait le Drive fileId d'une URL video_url/content_image OneUp.
// Formats attendus :
//   drive-serve?fileId=XXX  (cron VPS — reels, carousel, stories image fallback)
//   temp-video?id=story_XX  (stories VPS temp — pas de fileId Drive exposé)
function extractFileId(url) {
  if (!url || url === 'NA') return null;
  const m = String(url).match(/fileId=([^&"\s]+)/);
  return m ? m[1] : null;
}

// Filtre en mémoire — pas d'appel API (allPosts déjà chargé).
// typeMap supporte 2 types de cles :
//   - post_id (ancien) : ne marche plus car OneUp retourne data:[] depuis 2026-04-21
//   - 'fileid_' + fileId Drive (nouveau) : clé stable, derivable de video_url OneUp
// URL pattern /api/temp-video?id=story_ = detection directe story (dashboard + cron VPS)
function countScheduledByType(allPosts, username, targetDateStr, typeMap) {
  typeMap = typeMap || {};
  const todayPosts = allPosts.filter(function(p) {
    const dt = p.date_time || p.scheduled_date_time || p.created_at || '';
    const un = (p.social_network_username || p.social_network_name || '').replace('@', '').toLowerCase();
    return dt.startsWith(targetDateStr) && un === username.toLowerCase();
  });
  const counts = { reels: 0, stories: 0, carousel: 0 };
  todayPosts.forEach(function(p) {
    // 1. URL pattern temp-video = story certaine (pas besoin de registry)
    const vurl = p.video_url || '';
    if (/\/api\/temp-video\?id=story_/.test(vurl)) { counts.stories++; return; }
    // 2. Registry par fileId Drive (source de verite pour reels/carousel/stories cron)
    const fileId = extractFileId(vurl) || extractFileId(p.content_image);
    let entry = null;
    if (fileId && typeMap['fileid_' + fileId]) entry = typeMap['fileid_' + fileId];
    else if (p.post_id && typeMap[p.post_id]) entry = typeMap[p.post_id]; // fallback old registry
    if (entry && entry.type) {
      if (entry.type === 'stories') counts.stories++;
      else if (entry.type === 'carousel') counts.carousel++;
      else counts.reels++;
      return;
    }
    // 3. Heuristique fallback (jamais scheduled via nous → rare)
    const hasVideo = vurl && vurl !== 'NA';
    const hasImgs  = p.image_urls && Array.isArray(p.image_urls) && p.image_urls.length > 1;
    const hasImg   = p.content_image && p.content_image !== 'NA';
    if (hasImgs) counts.carousel++;
    else if (hasVideo) counts.reels++;
    else if (hasImg) counts.carousel++;
    else counts.reels++;
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

async function callAnthropic(uname, template, fileName) {
  // Extraire contexte du nom de fichier
  var fileCtx = '';
  if (fileName) {
    var clean = fileName.replace(/\.(mp4|mov|jpg|jpeg|png|gif|webp)$/i, '')
      .replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^(video|img|image|reel|story|dsc|mov)\s*\d*$/i.test(clean)) fileCtx = clean;
  }

  var contextLine = fileCtx
    ? 'Ce Reel a pour theme : "' + fileCtx + '".\n'
    : '';

  const examples = [
    'Tu me crois ou je dois prouver ? \uD83D\uDE44',
    'Alors t\'as quel age ? \uD83D\uDE44',
    'T\'aurais pense le contraire ? \uD83D\uDE44',
    'C\'est si difficile que ca a comprendre ? \uD83D\uDC49\uD83D\uDC48',
    'Tu me laisserais entrer ? \uD83D\uDE44',
    'C\'est si bien que ca ? \uD83D\uDE44'
  ];
  const styleBlock = 'CAPTIONS REELLES top performers :\n- ' + examples.join('\n- ');

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
        content: 'Tu geres le compte Instagram OFM @' + uname + ' (creatrice de contenu francophone, niche girl-next-door, audience masculine FR).\n' + contextLine + styleBlock + '\n\nGenere UNE nouvelle caption :\n- La caption DOIT etre en lien avec le contexte du Reel\n- TOUJOURS une question avec tutoiement\n- 5 a 10 mots, 1 seule ligne\n- Emoji \uD83D\uDE44 en priorite, sinon \uD83D\uDC40 ou \uD83D\uDE0C\n- Ton : provocant, taquin, defiant — PAS doux ni murmure\n- Francais oral/familier : "t\'as", "ca", "t\'aurais"\n- SANS hashtags\n- NE COPIE PAS les exemples\n- Sois CREATIF et VARIE\n\nReponds UNIQUEMENT avec la caption, rien d\'autre.'
      }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return ((d.content && d.content[0] && d.content[0].text) || '').trim();
}

async function generateCaption(fileId, type, uname, captionCfg, fileName) {
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
    const caption = await callAnthropic(uname, template, fileName);
    // Écriture cache en arrière-plan (silencieux si échec)
    fbPut(cacheKey, { text: caption, generatedAt: Date.now(), account: uname }).catch(function() {});
    console.log('[caption] Generated @' + uname + ': "' + caption.substring(0, 50) + '"');
    return caption;
  } catch (e) {
    console.error('[caption] Anthropic error @' + uname + ':', e.message);
    return template; // fallback garanti
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES — REGLE ABSOLUE (ne JAMAIS contourner)
// ═══════════════════════════════════════════════════════════════════════════════
// Bug OneUp confirmé 2026-04-13 : scheduleimagepost + isStory:true poste
// ~50% des images sur la GRILLE FEED au lieu de Story 24h (4/4 comptes affectes).
// Workaround OBLIGATOIRE : conversion image -> mp4 5s via ensureStoryVideo()
// (endpoint /api/ensure-story-video, ffmpeg) puis schedulevideopost + isStory:true.
// Test validé sur @lapetitetinaa 2026-04-13 12:12 Paris (Story 24h confirmée).
//
// SI TU MODIFIES schedulePost() ou ensureStoryVideo() :
// - Toute story image DOIT passer par ensureStoryVideo AVANT scheduling
// - JAMAIS appeler scheduleimagepost avec isStory:true direct
// - Voir lecon : ZentyBrain/CERVEAU-MERE/08-LEARNINGS/lecon-oneup-image-story-mp4-conversion.md
// ═══════════════════════════════════════════════════════════════════════════════
//
// ── Convertit une image story en mp4 5s via le proxy ──────────────────────────
// Retourne { fileId, url }. Deux modes :
//   - fileId set : mp4 cache sur Drive (ancien mode)
//   - url set   : URL VPS temp-video (mode SA no quota — fix 2026-04-18)
async function ensureStoryVideo(fileId, parentFolderId) {
  try {
    const r = await fetch('https://dashboard.jscaledashboard.online/api/ensure-story-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: fileId, parentFolderId: parentFolderId })
    });
    const d = await r.json();
    if (d && d.videoFileId) return { fileId: d.videoFileId, url: null };
    if (d && d.videoUrl)    return { fileId: null, url: d.videoUrl };
    console.warn('[ensureStoryVideo] No videoFileId/videoUrl returned:', JSON.stringify(d));
    return null;
  } catch (e) {
    console.error('[ensureStoryVideo] Error:', e.message);
    return null;
  }
}

// ── Programmer un post sur OneUp ──────────────────────────────────────────────
// content : caption IA ou template fallback
// storyParentFolderId : dossier stories/ du compte (requis pour stories image -> mp4 cache)
async function schedulePost(snId, catId, fileId, dateStr, type, fileName, content, storyParentFolderId) {
  const isStory    = type === 'stories';
  const isCarousel = type === 'carousel';
  let   isImage    = /\.(jpg|jpeg|png|gif|webp)$/i.test(fileName || '');
  let   actualFileId = fileId;
  let   directUrl    = null; // URL VPS temp-video (SA no quota)

  // Story image -> convertir en mp4 (workaround bug OneUp feed grid)
  // JAMAIS fallback scheduleimagepost + isStory:true — toujours aborter si conversion fail
  if (isStory && isImage && storyParentFolderId) {
    const conv = await ensureStoryVideo(fileId, storyParentFolderId);
    if (conv && conv.fileId) {
      actualFileId = conv.fileId;
      isImage = false;
      console.log('[story] Converted via Drive mp4: ' + fileId.substring(0,12) + ' -> ' + conv.fileId.substring(0,12));
    } else if (conv && conv.url) {
      directUrl = conv.url;
      isImage = false;
      console.log('[story] Converted via VPS temp: ' + fileName);
    } else {
      console.warn('[story] Conversion FAILED ' + fileName + ' -> abort (no feed grid fallback)');
      return { ok: false, postId: null, error: 'story conversion failed', convertedFileId: null };
    }
  }

  const mediaUrl   = directUrl || ('https://dashboard.jscaledashboard.online/api/drive-serve?fileId=' + actualFileId);
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
    if (d && d.error) return { ok: false, postId: null, error: d.message || JSON.stringify(d), convertedFileId: null };
    // OneUp schedule endpoints renvoient typiquement {data: {post_id: N}}. On cherche
    // TOUS les chemins possibles — si postId null malgre le succes, log la reponse brute
    // pour debug (sans registry le checker re-schedulera en boucle).
    const postId = d && (
      d.post_id || d.id ||
      (d.data && (d.data.post_id || d.data.id)) ||
      (Array.isArray(d.data) && d.data[0] && (d.data[0].post_id || d.data[0].id)) ||
      null
    );
    if (!postId) {
      console.warn('[schedulePost] postId not found in response:', JSON.stringify(d).substring(0, 300));
    }
    // convertedFileId = mp4 généré depuis image (différent de fileId original) → à déplacer aussi vers posted
    return { ok: true, postId: postId ? String(postId) : null, error: null, convertedFileId: actualFileId !== fileId ? actualFileId : null };
  } catch (e) {
    return { ok: false, postId: null, error: e.message, convertedFileId: null };
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
  const mode          = (req.query && req.query.mode) || 'daily'; // 'daily' (1h Paris full run) | 'checker' (toutes 30min, corrige les trous)
  const isChecker     = mode === 'checker';
  console.log('[cron v3 ' + mode + '] Starting for Paris date: ' + targetDateStr);

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

    // 2. OAuth Drive + prefetch OneUp + registry typeMap en parallèle (une seule fois pour tout le run)
    // En mode CHECKER : aussi fetch published pour exclure ce qui a déjà été publié
    // typeMap = registry Firebase post_id -> type (source de verite anti-sur-scheduling)
    var oauthToken     = null;
    var allOneupPosts  = [];
    var typeMap        = {};
    const fetchPubPromise = isChecker
      ? fetch(ONEUP_BASE + '/api/getpublishedposts?start=0&apiKey=' + ONEUP_KEY).then(function(r){ return r.json(); }).then(function(d){ return Array.isArray(d) ? d : (d.data || []); }).catch(function(){ return []; })
      : Promise.resolve([]);
    const [oauthResult, oneupResult, pubResult, typeMapResult] = await Promise.allSettled([
      Object.keys(driveFolderMap).length > 0 ? getOAuthToken() : Promise.resolve(null),
      fetchAllScheduledPosts(),
      fetchPubPromise,
      fbGet('zenty/post_type_map').catch(function(){ return {}; })
    ]);
    if (oauthResult.status === 'fulfilled')  oauthToken    = oauthResult.value;
    else console.error('[drive] OAuth failed:', oauthResult.reason && oauthResult.reason.message);
    if (oneupResult.status === 'fulfilled')  allOneupPosts = oneupResult.value;
    else console.error('[oneup] fetchAll failed:', oneupResult.reason && oneupResult.reason.message);
    if (typeMapResult.status === 'fulfilled' && typeMapResult.value && typeof typeMapResult.value === 'object') {
      typeMap = typeMapResult.value;
      console.log('[registry] Loaded ' + Object.keys(typeMap).length + ' post_type entries');
    }
    // En mode checker, concat les published pour les compter dans countScheduledByType
    if (isChecker && pubResult.status === 'fulfilled' && Array.isArray(pubResult.value)) {
      allOneupPosts = allOneupPosts.concat(pubResult.value);
      console.log('[checker] +' + pubResult.value.length + ' published posts ajoutés au calcul existing');
    }

    // BACKFILL registry : tout post OneUp sans entry est infere et ecrit.
    // Clé = 'fileid_' + fileId Drive (extrait de video_url/content_image).
    // Pour stories VPS temp (pas de fileId), clé = post_id en fallback.
    // Proteger contre classification erronee : heuristique "image_url set + pas temp-video"
    // → ambigu (pourrait etre story fallback ou carousel). On classe "reels" par defaut
    // pour les video_url drive-serve (cas le + frequent).
    const backfillBatch = {};
    allOneupPosts.forEach(function(p) {
      const vurl = p.video_url || '';
      const cimg = p.content_image || '';
      const dt = p.date_time || p.scheduled_date_time || '';
      const uname = (p.social_network_username || p.social_network_name || '').replace('@', '').toLowerCase();
      const fileId = extractFileId(vurl) || extractFileId(cimg);
      // Determiner type
      let inferred;
      if (/\/api\/temp-video\?id=story_/.test(vurl)) inferred = 'stories';
      else if (vurl && vurl !== 'NA') inferred = 'reels'; // video drive-serve = reel
      else if (p.image_urls && Array.isArray(p.image_urls) && p.image_urls.length > 1) inferred = 'carousel';
      else if (cimg && cimg !== 'NA') inferred = 'carousel'; // image seule = carousel
      else inferred = 'reels';
      // Clé registry : fileId Drive (preferee, stable) ou post_id (fallback pour stories VPS temp)
      const regKey = fileId ? ('fileid_' + fileId) : (p.post_id ? String(p.post_id) : null);
      if (!regKey || typeMap[regKey]) return;
      const entry = { type: inferred, uname: uname, date: dt.substring(0, 10), ts: Date.now(), backfilled: true };
      typeMap[regKey] = entry;
      backfillBatch[regKey] = entry;
    });
    const backfillCount = Object.keys(backfillBatch).length;
    if (backfillCount > 0) {
      try {
        await fetch(FIREBASE_URL + '/zenty/post_type_map.json' + fbAuth, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backfillBatch)
        });
        console.log('[registry] Backfilled ' + backfillCount + ' entries');
      } catch (e) {
        console.error('[registry] Backfill failed:', e.message);
      }
    }

    // Mode daily : nettoyer les entrées typeMap > 48h (evite que Firebase explose)
    if (!isChecker && Object.keys(typeMap).length > 0) {
      const expiredThreshold = Date.now() - (48 * 3600 * 1000);
      const toDelete = {};
      Object.keys(typeMap).forEach(function(pid) {
        const entry = typeMap[pid];
        if (entry && entry.ts && entry.ts < expiredThreshold) toDelete[pid] = null;
      });
      const delCount = Object.keys(toDelete).length;
      if (delCount) {
        try {
          await fetch(FIREBASE_URL + '/zenty/post_type_map.json' + fbAuth, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toDelete)
          });
          console.log('[registry] Cleaned ' + delCount + ' entries > 48h');
        } catch (e) { /* silent */ }
      }
    }

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

      // Pause manuelle (bouton Stop dashboard V2)
      if (acc.paused === true) {
        skippedCount++;
        skippedReasons.push('⏸ @' + uname + ' — pause manuelle');
        continue;
      }

      // Déjà schedulé aujourd'hui (flag Firebase) — mais checker IGNORE ce flag pour re-vérifier
      if (acc.lastScheduledDate === targetDateStr && !isChecker) {
        skippedCount++;
        skippedReasons.push('⏭ @' + uname + ' — déjà schedulé');
        continue;
      }

      // Double-check OneUp (filet anti-race-condition) — filtre en mémoire, 0 appel API
      // typeMap = registry Firebase (source de verite post_id -> type)
      const existing    = countScheduledByType(allOneupPosts, uname, targetDateStr, typeMap);
      let needReels   = Math.max(0, (acc.reels   || 0) - existing.reels);
      let needStories = Math.max(0, (acc.stories || 0) - existing.stories);
      let needFeed    = Math.max(0, (acc.feed    || 0) - existing.carousel);

      if (needReels + needStories + needFeed === 0) {
        skippedCount++;
        if (!isChecker) await fbPut('zenty/cron_config/accounts/' + snId + '/lastScheduledDate', targetDateStr);
        skippedReasons.push('⏭ @' + uname + ' — quota atteint (' + existing.reels + 'R/' + existing.stories + 'S)');
        continue;
      }

      // Marquer Firebase EN COURS avant tout scheduling (anti-race-condition)
      // Mode checker : NE PAS marquer (on veut pouvoir re-vérifier dans 30min)
      if (!isChecker) {
        await fbPut('zenty/cron_config/accounts/' + snId + '/lastScheduledDate', targetDateStr);
      }
      accountResults[snId] = { uname: uname, scheduled: 0, errors: [] };

      // Firebase REST interdit les '.' dans les keys, le dashboard ecrit avec sanitize
      // uname.replace('.', '_'). Lecture : double lookup brut puis sanitize.
      const folders   = driveFolderMap[uname] || driveFolderMap[uname.replace(/\./g, '_')] || {};
      const carFolder = folders.carousel || folders.feed || null;

      // Lister tous les dossiers Drive UNE seule fois en parallèle
      const [allReelFilesRaw, allStoryFilesRaw, allCarouselFiles] = await Promise.all([
        (folders.reels   && oauthToken) ? listDriveFolder(oauthToken, folders.reels)   : Promise.resolve([]),
        (folders.stories && oauthToken) ? listDriveFolder(oauthToken, folders.stories) : Promise.resolve([]),
        (carFolder       && oauthToken) ? listDriveFolder(oauthToken, carFolder)       : Promise.resolve([])
      ]);

      // Filtrer les fichiers cache mp4 (issus de la conversion image->story video).
      // Pattern : nom = nom_original.{jpg,jpeg,png,gif,webp}.mp4
      const isStoryCacheMp4 = function(name) { return /\.(jpg|jpeg|png|gif|webp)\.mp4$/i.test(name || ''); };
      const allReelFiles  = allReelFilesRaw.filter(function(f){ return !isStoryCacheMp4(f.name); });
      const allStoryFiles = allStoryFilesRaw.filter(function(f){ return !isStoryCacheMp4(f.name); });

      // Slots custom (Dashboard V2 → Firebase). Si présents, ils overrident PEAK_WINDOWS.
      let customReelSlots     = (acc.slots && Array.isArray(acc.slots.reels))    ? acc.slots.reels    : null;
      let customStorySlots    = (acc.slots && Array.isArray(acc.slots.stories))  ? acc.slots.stories  : null;
      let customCarouselSlots = (acc.slots && Array.isArray(acc.slots.carousel)) ? acc.slots.carousel : null;

      // Mode CHECKER : ne planifier que les slots FUTURS aujourd'hui (>now+5min Paris)
      // Si pas de slots custom en mode checker → skip (pas safe de générer slots aléatoires en cours de journée)
      if (isChecker) {
        if (!customReelSlots && !customStorySlots && !customCarouselSlots) {
          skippedCount++;
          skippedReasons.push('⏭ @' + uname + ' — checker skip (pas de slots custom)');
          continue;
        }
        customReelSlots     = customReelSlots     ? customReelSlots.filter(isSlotFutureParis)     : null;
        customStorySlots    = customStorySlots    ? customStorySlots.filter(isSlotFutureParis)    : null;
        customCarouselSlots = customCarouselSlots ? customCarouselSlots.filter(isSlotFutureParis) : null;
        // Cap les need à la longueur des slots futurs disponibles
        if (customReelSlots)     needReels   = Math.min(needReels,   customReelSlots.length);
        if (customStorySlots)    needStories = Math.min(needStories, customStorySlots.length);
        if (customCarouselSlots) needFeed    = Math.min(needFeed,    customCarouselSlots.length);
        if (needReels + needStories + needFeed === 0) {
          skippedCount++;
          skippedReasons.push('⏭ @' + uname + ' — quota OK ou slots passés');
          continue;
        }
      }

      // Sélectionner les Reels
      for (var ri = 0; ri < needReels; ri++) {
        const available = allReelFiles.filter(function(f) { return !_usedFileIds.has(f.id); });
        if (!available.length) { accountResults[snId].errors.push('reels: Drive vide ou tous utilisés'); break; }
        const file = available[Math.floor(Math.random() * available.length)];
        _usedFileIds.add(file.id);
        plan.push({
          snId: snId, acc: acc, uname: uname, file: file, type: 'reels',
          window: PEAK_WINDOWS.reels[ri] || PEAK_WINDOWS.reels[PEAK_WINDOWS.reels.length - 1],
          customTime: (customReelSlots && customReelSlots[ri]) || null,
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
          customTime: (customStorySlots && customStorySlots[si]) || null,
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
          customTime: (customCarouselSlots && customCarouselSlots[ci]) || null,
          accountIdx: accountIdx, fromFolder: carFolder, toFolder: folders.posted,
          caption: null, slot: null
        });
      }
    }

    console.log('[cron v3] Phase 1 — plan: ' + plan.length + ' post(s) pour ' + totalAccounts + ' compte(s)');

    // ── PHASE 2a : Calcul des slots EN PREMIER (avant captions) ────────────────
    // Pourquoi avant : on veut éviter de générer des captions IA (coûteuses en
    // tokens Anthropic) pour des posts qui seront skippés car slot dans le passé.
    // ─────────────────────────────────────────────────────────────────────────
    // Générer les slots horaires : custom Firebase si dispo (fourchette ±25min anti-flag IG, Jordan 2026-04-14), sinon PEAK_WINDOWS
    plan.forEach(function(item) {
      if (item.customTime && /^([01]?\d|2[0-3]):[0-5]\d$/.test(item.customTime)) {
        var parts = item.customTime.split(':');
        var jitter = Math.floor(Math.random() * 51) - 25; // -25..+25 min (fourchette ~1h anti-flag)
        var h = parseInt(parts[0]);
        var m = parseInt(parts[1]) + jitter;
        if (m < 0) { m += 60; h--; }
        if (m >= 60) { m -= 60; h++; }
        if (h < 0) h = 0;
        if (h > 23) h = 23;
        item.slot = targetDateStr + ' ' + (h<10?'0':'') + h + ':' + (m<10?'0':'') + m;
      } else {
        item.slot = generateSlot(item.window, targetDateStr, item.accountIdx, totalAccounts);
      }
    });

    // ── PHASE 2b : GARDE-FOU ANTI-RAFALE ───────────────────────────────────────
    // Règle absolue (leçon 2026-04-21) : si un slot est dans le passé, OneUp
    // publie IMMÉDIATEMENT → rafale visible sur IG (ex 50 posts en 8 min).
    // Cause typique : daily 01h Paris a raté (endpoint down, network), run
    // manuel plus tard dans la journée → slots matin/midi sont passés.
    // Comportement : on NE RATTRAPE PAS dans la journée, on laisse le contenu
    // pour le lendemain. Mieux 1 post à la bonne heure que 5 en rafale.
    plan.forEach(function(item) {
      if (!isSlotFutureFullParis(item.slot)) {
        item.skipPast = true;
        item.pastReason = '@' + item.uname + ' ' + item.type + ' ' + (item.slot || '?');
      }
    });
    var pastPlannedCount = plan.filter(function(i){ return i.skipPast; }).length;
    if (pastPlannedCount > 0) {
      var examples = plan.filter(function(i){return i.skipPast;}).slice(0,5).map(function(i){return i.pastReason;}).join(' | ');
      console.warn('[cron v3] ⚠️  ' + pastPlannedCount + '/' + plan.length + ' slot(s) dans le PASSÉ — skippés pour éviter rafale OneUp. Exemples: ' + examples);
    }

    // ── PHASE 2c : Générer les captions UNIQUEMENT pour les posts gardés ───────
    // Batches de 15 pour respecter les rate limits Anthropic (50 RPM Haiku).
    // Stories → template. Reels/Carousel → IA si enabled.
    // Cache Firebase évite les regénérations pour les mêmes fichiers.
    // ─────────────────────────────────────────────────────────────────────────
    const CAPTION_BATCH = 15; // max appels Anthropic simultanés
    const futurePlan    = plan.filter(function(i){ return !i.skipPast; });
    if (futurePlan.length > 0) {
      if (captionCfg.enabled && ANTHROPIC_KEY) {
        const aiCount = futurePlan.filter(function(i) { return i.type !== 'stories'; }).length;
        console.log('[caption] Génération de ' + aiCount + ' caption(s) IA — batches de ' + CAPTION_BATCH + '...');
        for (var ci2 = 0; ci2 < futurePlan.length; ci2 += CAPTION_BATCH) {
          const batch = futurePlan.slice(ci2, ci2 + CAPTION_BATCH);
          await Promise.all(
            batch.map(function(item) {
              return generateCaption(item.file.id, item.type, item.uname, captionCfg, item.file.name)
                .then(function(cap) { item.caption = cap; });
            })
          );
        }
        console.log('[caption] Toutes les captions prêtes.');
      } else {
        futurePlan.forEach(function(item) { item.caption = captionCfg.template || ''; });
        if (captionCfg.template) console.log('[caption] Mode template — "' + captionCfg.template + '"');
      }
    }

    // ── PHASE 3 : Scheduler sur OneUp + déplacer les fichiers Drive ──────────
    // Batches de 10 en parallèle — 10× plus rapide que séquentiel.
    // 50 comptes × 6 posts = 300 posts → ~30s au lieu de ~300s.
    // ─────────────────────────────────────────────────────────────────────────
    const SCHEDULE_BATCH = 10;
    var   scheduledTotal = 0;
    var   failedTotal    = 0;
    var   pastSkippedTotal = 0;

    for (var pi = 0; pi < plan.length; pi += SCHEDULE_BATCH) {
      const batch = plan.slice(pi, pi + SCHEDULE_BATCH);
      await Promise.all(
        batch.map(async function(item) {
          // Anti-rafale : slot passé → skip (jamais envoyé à OneUp, qui publierait immédiatement).
          if (item.skipPast) {
            pastSkippedTotal++;
            accountResults[item.snId].errors.push(item.type + ': slot passé (' + item.slot + ') — skip anti-rafale');
            return;
          }
          const result = await schedulePost(
            item.snId, item.acc.category_id, item.file.id,
            item.slot, item.type, item.file.name, item.caption,
            item.fromFolder
          );
          if (result.ok) {
            scheduledTotal++;
            accountResults[item.snId].scheduled++;
            // Registry Firebase AWAIT (pas fire-and-forget) — anti-sur-scheduling.
            // CRITIQUE : OneUp getscheduledposts ne renvoie PAS isStory. Clé principale
            // = 'fileid_' + Drive fileId (stable). Fallback post_id pour stories
            // VPS temp (pas de fileId). OneUp a change API 2026-04-21 (data:[] au
            // lieu de data.post_id) donc on ne peut plus se fier a result.postId seul.
            const entry = {
              type:  item.type,
              uname: item.uname,
              date:  targetDateStr,
              ts:    Date.now()
            };
            const regFileKey = result.convertedFileId
              ? 'fileid_' + result.convertedFileId  // mp4 cache Drive
              : (item.file && item.file.id ? 'fileid_' + item.file.id : null);
            try {
              if (regFileKey) {
                await fbPut('zenty/post_type_map/' + regFileKey, entry);
              }
              // Pour stories VPS temp (pas de fileId dans l'URL finale), ecrire aussi
              // l'original fileId Drive comme backup + post_id si fourni.
              if (item.file && item.file.id && regFileKey !== 'fileid_' + item.file.id) {
                await fbPut('zenty/post_type_map/fileid_' + item.file.id, entry);
              }
              if (result.postId) {
                await fbPut('zenty/post_type_map/' + result.postId, entry);
              }
            } catch (e) {
              console.error('[registry] fbPut failed:', e.message);
            }
            if (item.toFolder && item.fromFolder && oauthToken) {
              const moved = await moveFileToDrive(oauthToken, item.file.id, item.fromFolder, item.toFolder);
              if (!moved) console.warn('[drive] Move failed: ' + item.file.name + ' @' + item.uname);
              // Si une conversion image->mp4 a eu lieu, déplacer aussi le mp4 cache pour garder stories/ propre
              if (result.convertedFileId) {
                await moveFileToDrive(oauthToken, result.convertedFileId, item.fromFolder, item.toFolder).catch(function(){});
              }
            }
          } else {
            failedTotal++;
            accountResults[item.snId].errors.push(item.type + ': ' + result.error);
          }
        })
      );
    }

    console.log('[cron v3] Phase 3 — ' + scheduledTotal + ' schedulés, ' + failedTotal + ' échoués, ' + pastSkippedTotal + ' slots passés skippés');

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
    const emoji       = (failedTotal > 0 || pastSkippedTotal > 0) ? '⚠️' : '⚡';
    const captionMode = captionCfg.enabled ? '✨ Claude IA' : '📝 Template';
    const titlePrefix = isChecker ? '🔧 *Zenty Checker (auto-fix)*' : (emoji + ' *Zenty Daily Scheduler v3*');
    const lines       = [
      titlePrefix + ' — ' + targetDateStr,
      '',
      '📊 ' + totalAccounts + ' comptes | ' + scheduledTotal + ' programmés | ' + skippedCount + ' déjà OK | ' + failedTotal + ' erreur(s)' + (pastSkippedTotal > 0 ? ' | ' + pastSkippedTotal + ' slots passés skippés' : ''),
      '🖊️ Captions: ' + captionMode
    ];
    if (pastSkippedTotal > 0 && !isChecker) {
      lines.push('', '🚨 *ALERTE RAFALE ÉVITÉE* : ' + pastSkippedTotal + ' slot(s) dans le passé — probablement daily 01h raté. Vérifier logs /opt/zenty-cron/logs/cron.log. Posts NON rattrapés (évite publication immédiate en rafale).');
    }
    if (results.length) lines.push('', results.join('\n'));
    lines.push('\n⏱ ' + dur + 's');
    // Mode CHECKER : Telegram silent si rien à corriger (évite spam toutes les 30min)
    if (isChecker && scheduledTotal === 0 && failedTotal === 0) {
      console.log('[checker] Silent (rien à corriger).');
    } else {
      await sendTelegram(lines.join('\n'));
    }

    res.status(200).json({
      ok:             true,
      scheduled:      scheduledTotal,
      skipped:        skippedCount,
      failed:         failedTotal,
      pastSkipped:    pastSkippedTotal,
      date:           targetDateStr,
      accounts:       totalAccounts,
      captionMode:    captionMode
    });

  } catch (e) {
    console.error('[cron v3] FATAL:', e);
    await sendTelegram('🚨 *Zenty Cron ERREUR* — ' + e.message);
    res.status(500).json({ error: e.message });
  }
};
