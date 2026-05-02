// ═══════════════════════════════════════════════════════════════════
//  ZENTY — DATA INTEGRITY CHECKS (Phase B+ — Veilleur élargi #2)
//  2026-05-02 nuit
//
//  POURQUOI : health-check.js (Phase B) vérifie que les services EXTERNES répondent.
//  Mais ne détecte pas les INCOHÉRENCES de DATA (ex : storyParentFolderId orphelin
//  qui a fait rater 12 comptes pendant 4 jours sans qu'aucun signal ne passe).
//
//  QUOI : 7 checks d'intégrité côté Firebase + Drive + APIs.
//   1. Account config integrity : champs requis présents pour comptes actifs
//   2. Drive folder map integrity : pas d'orphelins, dossiers requis présents
//   3. Posting flow : cron a tourné cette nuit + a schedulé > 0
//   4. Caption AI health : taux succès dernière 24h > 90%
//   5. Cron timers : tous les zenty-* timers actifs
//   6. Multi-agency : pas d'orphelins (configs pour comptes supprimés)
//   7. Telegram bot : dernier message envoyé < 24h
//
//  Stockage : zenty/integrity_checks/{date}/{hour}
//  AUTH : CRON_SECRET (header x-cron-secret)
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET     = process.env.CRON_SECRET       || '';
const ONEUP_KEY       = process.env.ONEUP_API_KEY     || '';

const fbAuth = '?auth=' + FIREBASE_SECRET;
async function fbGet(p) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth);
  return r.json();
}

// ── Check 1: Account config integrity ────────────────────────────────────────
// Pour chaque compte actif (paused !== true), vérifier les champs requis.
async function checkAccountConfigIntegrity() {
  const accounts = await fbGet('zenty/cron_config/accounts').catch(function() { return null; }) || {};
  const issues = [];
  let totalActive = 0;
  Object.keys(accounts).forEach(function(snid) {
    const a = accounts[snid];
    if (!a || a.paused === true) return;
    totalActive++;
    const handle = (a.username || '').replace('@', '').toLowerCase();
    if (!a.category_id) issues.push({ snid: snid, handle: handle, missing: 'category_id' });
    if ((a.stories || 0) > 0 && !a.storyParentFolderId) issues.push({ snid: snid, handle: handle, missing: 'storyParentFolderId' });
    if (!a.username) issues.push({ snid: snid, handle: '?', missing: 'username' });
    if (!a.agency) issues.push({ snid: snid, handle: handle, missing: 'agency' });
  });
  return {
    name: 'account_config_integrity',
    ok: issues.length === 0,
    totalActiveAccounts: totalActive,
    issuesCount: issues.length,
    issues: issues.slice(0, 10) // cap pour éviter blow-up
  };
}

// ── Check 2: Drive folder map integrity ──────────────────────────────────────
// Vérifier driveFolderMap : pas d'orphelins (comptes plus dans accounts) +
// tous les comptes actifs ont leur entry avec reels/stories/posted.
async function checkDriveFolderMapIntegrity() {
  const [accounts, dfm] = await Promise.all([
    fbGet('zenty/cron_config/accounts').catch(function() { return null; }),
    fbGet('zenty/cron_config/driveFolderMap').catch(function() { return null; })
  ]);
  const acc = accounts || {};
  const map = dfm || {};
  const orphans = [];   // entries dans map sans compte correspondant
  const missing = [];   // comptes actifs sans entry map ou entry incomplet

  // Récup tous les handles connus (paused inclus — les comptes paused sont temporairement
  // désactivés mais leur config reste légitime). Vrais orphelins = entries pour comptes
  // qui n'existent PLUS du tout dans accounts (suppression mal nettoyée).
  const knownHandlesSafe = new Set();
  Object.keys(acc).forEach(function(snid) {
    const a = acc[snid];
    if (!a || !a.username) return;
    const handle = (a.username || '').replace('@', '').toLowerCase().replace(/\./g, '_');
    if (handle) knownHandlesSafe.add(handle);
  });

  // Détecter VRAIS orphelins (entry sans compte du tout — pas même paused)
  Object.keys(map).forEach(function(handleSafe) {
    if (!knownHandlesSafe.has(handleSafe)) {
      orphans.push(handleSafe);
    }
  });

  // Détecter comptes actifs sans map ou map incomplet
  Object.keys(acc).forEach(function(snid) {
    const a = acc[snid];
    if (!a || a.paused === true) return;
    const handle = (a.username || '').replace('@', '').toLowerCase();
    const handleSafe = handle.replace(/\./g, '_');
    const entry = map[handle] || map[handleSafe];
    if (!entry) {
      missing.push({ snid: snid, handle: handle, issue: 'no_dfm_entry' });
      return;
    }
    if (!entry.reels) missing.push({ snid: snid, handle: handle, issue: 'no_reels_folder' });
    if (!entry.posted) missing.push({ snid: snid, handle: handle, issue: 'no_posted_folder' });
    if ((a.stories || 0) > 0 && !entry.stories) missing.push({ snid: snid, handle: handle, issue: 'no_stories_folder_but_freq>0' });
  });

  return {
    name: 'drive_folder_map_integrity',
    ok: orphans.length === 0 && missing.length === 0,
    orphansCount: orphans.length,
    orphans: orphans.slice(0, 10),
    missingCount: missing.length,
    missing: missing.slice(0, 10)
  };
}

// ── Check 3: Posting flow ────────────────────────────────────────────────────
// Approche fiable : vérifier dans Firebase si verify_results a des entries today
// (preuve que le posting + verify tournent). Plus robuste que parser journalctl.
async function checkPostingFlow() {
  const today = new Date().toISOString().split('T')[0];
  const results = await fbGet('zenty/post_verify_results/' + today).catch(function() { return null; });
  const verified = (results && Array.isArray(results.verified)) ? results.verified.length : 0;
  const failed   = (results && Array.isArray(results.failed))   ? results.failed.length   : 0;
  const total    = verified + failed;

  // Si > 0 posts traités today : posting flow vivant
  // Si 0 mais on est avant 13h Paris (11h UTC) : pas encore eu le temps de poster, OK
  const hourUTC = new Date().getUTCHours();
  const tooEarly = hourUTC < 11; // avant 13h Paris

  let ok, note;
  if (total > 0) {
    ok = true;
    note = total + ' posts traités aujourd\'hui (' + verified + ' OK, ' + failed + ' fails)';
  } else if (tooEarly) {
    ok = true;
    note = 'pas encore d\'activité posting (trop tôt dans la journée)';
  } else {
    ok = false;
    note = 'aucun post traité aujourd\'hui après 13h Paris — cron en panne ?';
  }

  return {
    name: 'posting_flow',
    ok: ok,
    verified: verified,
    failed: failed,
    total: total,
    note: note
  };
}

// ── Check 4: Caption AI health ───────────────────────────────────────────────
// Lit zenty/caption_logs/{date} pour calculer le ratio succès dernier 24h.
// Si pas de logs : ok=true (pas d'usage = pas d'erreur)
async function checkCaptionAIHealth() {
  const today = new Date().toISOString().split('T')[0];
  const yest  = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const [logsToday, logsYest] = await Promise.all([
    fbGet('zenty/caption_logs/' + today).catch(function() { return null; }),
    fbGet('zenty/caption_logs/' + yest).catch(function() { return null; })
  ]);
  const all = [];
  function pushFrom(obj) {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(function(k) {
      const e = obj[k];
      if (e && typeof e === 'object') all.push(e);
    });
  }
  pushFrom(logsToday);
  pushFrom(logsYest);

  if (all.length === 0) {
    return { name: 'caption_ai_health', ok: true, sample: 0, note: 'no logs (no usage)' };
  }
  const success = all.filter(function(e) { return e.ok === true || e.success === true; }).length;
  const ratio = success / all.length;
  return {
    name: 'caption_ai_health',
    ok: ratio >= 0.9,
    sample: all.length,
    successCount: success,
    ratio: Math.round(ratio * 100) / 100
  };
}

// ── Check 5: Cron timers all active ──────────────────────────────────────────
// Tous les zenty-* timers actifs (loaded + active waiting).
async function checkCronTimers() {
  try {
    const r = await execAsync('systemctl list-units --type=timer "zenty-*" --no-legend 2>&1', { timeout: 5000 });
    const lines = (r.stdout || '').trim().split('\n').filter(function(l) { return l.trim(); });
    const failedOrInactive = [];
    let total = 0;
    lines.forEach(function(line) {
      total++;
      // Format : "zenty-X.timer  loaded active waiting Description"
      // Vérifier qu'il y a "active" et "waiting" ou "running"
      if (!line.includes(' active ') || (!line.includes(' waiting') && !line.includes(' running'))) {
        const name = (line.split(/\s+/)[0] || 'unknown').replace(/●/g, '').trim();
        failedOrInactive.push(name);
      }
    });
    return {
      name: 'cron_timers',
      ok: failedOrInactive.length === 0 && total >= 8, // on attend au moins 8 timers (10 après Phase D+E)
      total: total,
      failedOrInactive: failedOrInactive
    };
  } catch (e) {
    return { name: 'cron_timers', ok: false, error: e.message };
  }
}

// ── Check 6: Multi-agency orphans ────────────────────────────────────────────
// Plusieurs nodes Firebase peuvent avoir des entries pour comptes supprimés.
async function checkMultiAgencyOrphans() {
  const [accounts, igAccounts, ouAuto] = await Promise.all([
    fbGet('zenty/cron_config/accounts').catch(function() { return null; }),
    fbGet('zenty/igAccounts').catch(function() { return null; }),
    fbGet('zenty/ouAccountAutomation').catch(function() { return null; })
  ]);
  const cronSnids = Object.keys(accounts || {});
  const igAcc = igAccounts || {};
  const ouAcc = ouAuto || {};

  const igOrphans = [];
  const ouOrphans = [];

  // igAccounts indexé par id (pas snid). Cherche par socialNetworkId.
  Object.keys(igAcc).forEach(function(id) {
    const a = igAcc[id];
    if (!a) return;
    if (a.socialNetworkId && cronSnids.indexOf(a.socialNetworkId) === -1) {
      // Ce compte est dans igAccounts mais pas dans cron_config → orphelin
      igOrphans.push(id);
    }
  });

  // ouAccountAutomation indexé par snid
  Object.keys(ouAcc).forEach(function(snid) {
    if (cronSnids.indexOf(snid) === -1) ouOrphans.push(snid);
  });

  return {
    name: 'multi_agency_orphans',
    ok: igOrphans.length === 0 && ouOrphans.length === 0,
    cronAccounts: cronSnids.length,
    igOrphans: igOrphans.slice(0, 5),
    ouOrphans: ouOrphans.slice(0, 5)
  };
}

// ── Check 7b: OneUp data contract — schémas attendus respectés ───────────────
// Bug détecté 2026-05-02 : side-panel.js lisait `scheduledAt`, `caption`, `type` qui
// n'existent PAS dans la réponse OneUp API (vraies clés : date_time, content, instagram).
// Tous les posts s'affichaient avec heure '—' et caption vide → "données menteuses" sur UI.
// Ce check détecte si l'API OneUp change de format ou si on a un drift de schéma.
async function checkOneupDataContract() {
  if (!ONEUP_KEY) return { name: 'oneup_data_contract', ok: true, note: 'no key (skipped)' };
  try {
    const r = await fetch('https://www.oneupapp.io/api/getscheduledposts?apiKey=' + ONEUP_KEY);
    if (!r.ok) return { name: 'oneup_data_contract', ok: false, error: 'HTTP ' + r.status };
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.data || []);
    if (!arr.length) return { name: 'oneup_data_contract', ok: true, note: 'no scheduled posts to validate' };
    // Vérifier les champs ATTENDUS sur le 1er post
    const p = arr[0];
    const expected = ['post_id', 'social_network_username', 'date_time', 'content'];
    const missing = expected.filter(function(k) { return !(k in p); });
    // Vérifier que date_time est parseable
    let dateValid = false;
    if (p.date_time) {
      const d = new Date(String(p.date_time).replace(' ', 'T'));
      dateValid = !isNaN(d.getTime());
    }
    // Vérifier qu'aucun post n'a un date_time invalide (échantillon 5)
    const invalidDates = [];
    arr.slice(0, 5).forEach(function(pp) {
      const dt = pp.date_time || pp.scheduled_date_time;
      if (!dt) { invalidDates.push(pp.post_id || '?'); return; }
      const d = new Date(String(dt).replace(' ', 'T'));
      if (isNaN(d.getTime())) invalidDates.push(pp.post_id || '?');
    });
    return {
      name: 'oneup_data_contract',
      ok: missing.length === 0 && dateValid && invalidDates.length === 0,
      sample: arr.length,
      missingFields: missing,
      dateValid: dateValid,
      invalidDatesCount: invalidDates.length,
      sampleKeys: Object.keys(p).slice(0, 12)
    };
  } catch (e) {
    return { name: 'oneup_data_contract', ok: false, error: e.message };
  }
}

// ── Check 7: Telegram heartbeat ──────────────────────────────────────────────
// Lit zenty/telegram_last_sent (timestamp). Si > 24h, alerte.
// (Pour V1, on ne sett pas encore ce field, donc check passe par défaut.)
async function checkTelegramHeartbeat() {
  const last = await fbGet('zenty/telegram_last_sent').catch(function() { return null; });
  if (!last || typeof last !== 'number') {
    return { name: 'telegram_heartbeat', ok: true, note: 'no heartbeat tracked yet (V2)' };
  }
  const ageHours = (Date.now() - last) / 3600000;
  return {
    name: 'telegram_heartbeat',
    ok: ageHours < 24,
    lastSent: new Date(last).toISOString(),
    ageHours: Math.round(ageHours * 10) / 10
  };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const startTime = Date.now();
  console.log('[integrity] Starting data integrity checks');

  const checks = await Promise.all([
    checkAccountConfigIntegrity(),
    checkDriveFolderMapIntegrity(),
    checkPostingFlow(),
    checkCaptionAIHealth(),
    checkCronTimers(),
    checkMultiAgencyOrphans(),
    checkTelegramHeartbeat(),
    checkOneupDataContract()
  ]);

  const allOk = checks.every(function(c) { return c.ok; });
  const failedChecks = checks.filter(function(c) { return !c.ok; });
  const elapsed_s = Math.round((Date.now() - startTime) / 1000);

  // Store in Firebase by date+hour
  const now = new Date();
  const datePart = now.toISOString().split('T')[0];
  const hourPart = String(now.getUTCHours()).padStart(2, '0');
  const fbPath = FIREBASE_URL + '/zenty/integrity_checks/' + datePart + '/' + hourPart + '.json' + fbAuth;

  try {
    await fetch(fbPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: now.toISOString(),
        allOk: allOk,
        checks: checks,
        failedNames: failedChecks.map(function(c) { return c.name; }),
        elapsed_s: elapsed_s
      })
    });
  } catch (e) {
    console.error('[integrity] Firebase write fail:', e.message);
  }

  console.log('[integrity] Done in ' + elapsed_s + 's : allOk=' + allOk + ' failed=[' + failedChecks.map(function(c) { return c.name; }).join(',') + ']');

  res.status(200).json({
    ok: true,
    allOk: allOk,
    checks: checks,
    failedNames: failedChecks.map(function(c) { return c.name; }),
    elapsed_s: elapsed_s,
    storedAt: 'zenty/integrity_checks/' + datePart + '/' + hourPart
  });
};
