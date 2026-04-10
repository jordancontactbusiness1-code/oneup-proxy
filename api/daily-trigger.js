// ═══════════════════════════════════════════════════════════════════
//  ZENTY — DAILY SCHEDULER (Vercel Cron)
//  Déclenché chaque matin à 7h Paris (0 5 * * * UTC)
//  Lit la config depuis Firebase, programme les posts via OneUp
//  Sans dépendance au browser — tourne même dashboard fermé
// ═══════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const ONEUP_KEY            = process.env.ONEUP_API_KEY      || '';
const ONEUP_BASE           = 'https://www.oneupapp.io';
const GDRIVE_CLIENT_ID     = process.env.GDRIVE_CLIENT_ID   || '';
const GDRIVE_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET || '';
const GDRIVE_REFRESH_TOKEN = process.env.GDRIVE_REFRESH_TOKEN || '';
const FIREBASE_URL         = process.env.FIREBASE_URL       || 'https://dashboard-a76d2-default-rtdb.firebaseio.com';
const CRON_SECRET          = process.env.CRON_SECRET        || '';
const TG_TOKEN             = '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const TG_CHAT              = '6646462254';

// Créneaux de peak FR par type (copie exacte du dashboard)
const PEAK_SLOTS = {
  reels:    ['07:30', '12:30', '18:30', '21:00'],
  stories:  ['08:00', '13:00', '19:00', '22:00'],
  carousel: ['12:00', '19:00']
};

// ── Helpers ──────────────────────────────────────────────────────────

async function sendTelegram(text) {
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text, parse_mode: 'Markdown' })
    });
  } catch(e) { /* silent */ }
}

async function getOAuthToken() {
  var r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GDRIVE_CLIENT_ID,
      client_secret: GDRIVE_CLIENT_SECRET,
      refresh_token: GDRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }).toString()
  });
  var d = await r.json();
  if (!d.access_token) throw new Error('OAuth refresh failed: ' + JSON.stringify(d));
  return d.access_token;
}

async function listDriveFolder(token, folderId) {
  var url = 'https://www.googleapis.com/drive/v3/files?q=' +
    encodeURIComponent("'" + folderId + "' in parents and trashed=false") +
    '&fields=files(id,name,mimeType)&pageSize=50';
  var r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var d = await r.json();
  return (d.files || []).filter(function(f) {
    return f.mimeType !== 'application/vnd.google-apps.folder';
  });
}

async function moveFileToDrive(token, fileId, fromId, toId) {
  var r = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + fileId +
    '?addParents=' + toId + '&removeParents=' + fromId,
    { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' }
  );
  return r.ok;
}

function getSlot(type, index, stagger) {
  var slots = PEAK_SLOTS[type] || PEAK_SLOTS.reels;
  var sg = stagger || 25;
  // Aujourd'hui en Paris
  var now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  var slotIdx = index % slots.length;
  var parts = slots[slotIdx].split(':');
  var slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    parseInt(parts[0]), parseInt(parts[1]) + (Math.floor(index / slots.length) * sg), 0);
  // Si le créneau est déjà passé aujourd'hui, décaler de 30min
  if (slot.getTime() < Date.now()) {
    slot = new Date(slot.getTime() + 30 * 60 * 1000);
  }
  // Format: "YYYY-MM-DD HH:MM"
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return slot.getFullYear() + '-' + pad(slot.getMonth() + 1) + '-' + pad(slot.getDate()) +
    ' ' + pad(slot.getHours()) + ':' + pad(slot.getMinutes());
}

async function schedulePost(snId, catId, fileId, dateStr, type, fileName) {
  var mediaUrl = 'https://drive.google.com/uc?export=download&id=' + fileId;
  var isStory = type === 'stories';
  var isCarousel = type === 'carousel';
  var isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(fileName || '');
  var endpoint = (isCarousel || (isStory && isImage)) ? '/api/scheduleimagepost' : '/api/schedulevideopost';
  var body = new URLSearchParams({
    social_network_id: JSON.stringify([snId]),
    category_id: catId || '',
    scheduled_date_time: dateStr,
    content: '',
  });
  if (isCarousel || (isStory && isImage)) {
    body.set('image_url', mediaUrl);
  } else {
    body.set('video_url', mediaUrl);
  }
  if (isStory) {
    body.set('instagram', JSON.stringify({ shareToStory: true }));
  } else if (!isCarousel) {
    body.set('instagram', JSON.stringify({ isReel: true, addToFeed: 1 }));
  }
  var r = await fetch(ONEUP_BASE + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-API-KEY': ONEUP_KEY },
    body: body.toString()
  });
  var d = await r.json();
  if (d && d.error) {
    console.log('[schedulePost] ' + type + ' FAILED:', JSON.stringify(d));
  }
  return d && !d.error;
}

// Retourne { reels, stories, carousel } : posts DEJA programmes aujourd'hui pour ce username
// Matching par username car l'API OneUp getscheduledposts ne retourne PAS social_network_id
async function getTodayScheduledByType(username) {
  var empty = { reels: 0, stories: 0, carousel: 0 };
  try {
    var r = await fetch(ONEUP_BASE + '/api/getscheduledposts?start=0', {
      headers: { 'X-API-KEY': ONEUP_KEY }
    });
    var d = await r.json();
    var posts = Array.isArray(d) ? d : (d.data || []);
    var today = new Date().toISOString().substring(0, 10);
    var uname = String(username || '').toLowerCase().replace('@','');
    var counts = { reels: 0, stories: 0, carousel: 0 };
    posts.forEach(function(p) {
      var dt = (p.date_time || p.scheduled_date_time || '').substring(0, 10);
      if (dt !== today) return;
      var pname = String(p.social_network_username || p.social_network_name || '').toLowerCase().replace('@','');
      if (pname !== uname) return;
      // Heuristique type : content_image contient drive.google.com + pas de caption = story image
      //                     image_urls array = carousel
      //                     sinon = reel (video_url)
      var hasImg = p.content_image && p.content_image !== 'NA';
      var hasVid = p.video_url && p.video_url !== 'NA';
      if (p.image_urls && Array.isArray(p.image_urls) && p.image_urls.length > 1) counts.carousel++;
      else if (hasImg && !p.content) counts.stories++;
      else if (hasVid) counts.reels++;
      else if (hasImg) counts.carousel++;
    });
    return counts;
  } catch(e) { return empty; }
}

// ── Handler principal ─────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Auth : Vercel crons envoient le secret via header x-vercel-cron
  // On accepte aussi ?secret=xxx pour test manuel
  var secret = req.headers['x-cron-secret'] || req.headers['authorization'] || req.query.secret || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  var results = [];
  var startTime = Date.now();
  var todayStr = new Date().toISOString().substring(0, 10);

  try {
    // 1. Lire la config cron depuis Firebase
    var fbRes = await fetch(FIREBASE_URL + '/zenty/cron_config.json');
    var cronConfig = await fbRes.json();

    if (!cronConfig || !cronConfig.accounts) {
      await sendTelegram('⚠️ *Zenty Cron* — Aucune config automation dans Firebase.\nLancer Apply Automation depuis le dashboard pour configurer.');
      res.status(200).json({ ok: false, message: 'no config' });
      return;
    }

    var accounts = cronConfig.accounts || {};
    var driveFolderMap = cronConfig.driveFolderMap || {};
    var sched = cronConfig.scheduleSettings || { reels: '18:30', stories: '12:30', carousel: '21:00', stagger: 25 };

    // 2. OAuth token Drive
    var oauthToken = null;
    var hasDriveAccounts = Object.keys(driveFolderMap).length > 0;
    if (hasDriveAccounts) {
      try { oauthToken = await getOAuthToken(); }
      catch(e) { results.push('❌ Drive OAuth: ' + e.message); }
    }

    // 3. Pour chaque compte avec automation active
    var scheduled = 0;
    var skipped = 0;
    var failed = 0;

    for (var snId of Object.keys(accounts)) {
      var acc = accounts[snId];
      if (!acc || !acc.username) continue;
      var uname = acc.username.replace('@', '').toLowerCase();

      // Skip si déjà schedulé aujourd'hui
      if (acc.lastScheduledDate === todayStr) {
        skipped++;
        continue;
      }

      // Verifier via OneUp ce qui est DEJA scheduled par type → calculer quotas restants
      var existingByType = await getTodayScheduledByType(uname);
      var needReels   = Math.max(0, (acc.reels   || 0) - existingByType.reels);
      var needStories = Math.max(0, (acc.stories || 0) - existingByType.stories);
      var needFeed    = Math.max(0, (acc.feed    || 0) - existingByType.carousel);

      if (needReels + needStories + needFeed === 0) {
        skipped++;
        // Marquer lastScheduledDate → skip demain aussi jusqu'a reset
        await fetch(FIREBASE_URL + '/zenty/cron_config/accounts/' + snId + '/lastScheduledDate.json', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(todayStr)
        });
        results.push('⏭ @' + uname + ' — deja ' + (existingByType.reels + existingByType.stories + existingByType.carousel) + ' post(s) programmes aujourd\'hui');
        continue;
      }

      var folders = driveFolderMap[uname] || {};
      var accScheduled = 0;

      // Schedule Reels (quota restant uniquement)
      for (var ri = 0; ri < needReels; ri++) {
        if (!folders.reels || !oauthToken) break;
        try {
          var reelFiles = await listDriveFolder(oauthToken, folders.reels);
          if (!reelFiles.length) { results.push('⚠️ @' + uname + ' reels Drive vide'); break; }
          var file = reelFiles[0];
          var slot = getSlot('reels', ri, sched.stagger);
          var ok = await schedulePost(snId, acc.category_id, file.id, slot, 'reels', file.name);
          if (ok) {
            accScheduled++;
            scheduled++;
            if (folders.posted) await moveFileToDrive(oauthToken, file.id, folders.reels, folders.posted);
          } else { failed++; }
        } catch(e) { failed++; results.push('❌ @' + uname + ' reel: ' + e.message); }
      }

      // Schedule Stories (quota restant uniquement)
      for (var si = 0; si < needStories; si++) {
        if (!folders.stories || !oauthToken) break;
        try {
          var storiesFiles = await listDriveFolder(oauthToken, folders.stories);
          if (!storiesFiles.length) { results.push('⚠️ @' + uname + ' stories Drive vide'); break; }
          var sfile = storiesFiles[0];
          var sslot = getSlot('stories', si, sched.stagger);
          var sok = await schedulePost(snId, acc.category_id, sfile.id, sslot, 'stories', sfile.name);
          if (sok) {
            accScheduled++; scheduled++;
            if (folders.posted) await moveFileToDrive(oauthToken, sfile.id, folders.stories, folders.posted);
          } else { failed++; results.push('❌ @' + uname + ' story scheduling failed (OneUp rejected)'); }
        } catch(e) { failed++; results.push('❌ @' + uname + ' story: ' + e.message); }
      }

      // Schedule Carousel (quota restant uniquement)
      for (var ci = 0; ci < needFeed; ci++) {
        var carFolder = folders.carousel || folders.feed;
        if (!carFolder || !oauthToken) break;
        try {
          var carFiles = await listDriveFolder(oauthToken, carFolder);
          if (!carFiles.length) break;
          var cfile = carFiles[0];
          var cslot = getSlot('carousel', ci, sched.stagger);
          var cok = await schedulePost(snId, acc.category_id, cfile.id, cslot, 'carousel', cfile.name);
          if (cok) {
            accScheduled++; scheduled++;
            if (folders.posted) await moveFileToDrive(oauthToken, cfile.id, carFolder, folders.posted);
          } else { failed++; }
        } catch(e) { failed++; }
      }

      if (accScheduled > 0) {
        results.push('✅ @' + uname + ' — ' + accScheduled + ' post(s) programmé(s)');
        // Marquer lastScheduledDate dans Firebase
        await fetch(FIREBASE_URL + '/zenty/cron_config/accounts/' + snId + '/lastScheduledDate.json', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(todayStr)
        });
      } else if (acc.reels || acc.stories || acc.feed) {
        results.push('⚠️ @' + uname + ' — aucun fichier Drive');
      }
    }

    // 4. Rapport Telegram
    var dur = ((Date.now() - startTime) / 1000).toFixed(1);
    var totalAccounts = Object.keys(accounts).length;
    var emoji = failed > 0 ? '⚠️' : '⚡';
    var lines = [
      emoji + ' *Zenty Daily Scheduler* — ' + todayStr,
      '',
      '📊 ' + totalAccounts + ' comptes / ' + scheduled + ' posts programmés / ' + skipped + ' déjà OK',
    ];
    if (results.length) lines.push('', results.join('\n'));
    if (failed > 0) lines.push('\n❌ ' + failed + ' erreur(s)');
    lines.push('\n⏱ ' + dur + 's');

    await sendTelegram(lines.join('\n'));
    res.status(200).json({ ok: true, scheduled, skipped, failed, accounts: totalAccounts });

  } catch(e) {
    await sendTelegram('🚨 *Zenty Cron ERREUR* — ' + e.message);
    res.status(500).json({ error: e.message });
  }
};
