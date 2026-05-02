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

// ── Check 6a: Posting schedule compliance — chaque compte a posté le bon nb ──
// Détection des stories/reels MANQUANTS et DOUBLONS par compte aujourd'hui.
// Bug du 2026-05-02 : 4/5 comptes n'ont pas posté leur story 13:30 (storyParentFolderId
// orphelin) ET tous ont eu doublons à 21:00 (re-schedule checker). Aucun check ne
// détectait ça → cette fonction l'aurait alerté immédiatement.
async function checkPostingScheduleCompliance() {
  if (!ONEUP_KEY) return { name: 'posting_schedule_compliance', ok: true, note: 'no key (skipped)' };
  try {
    // 1. Lire la config de tous les comptes actifs
    const accounts = await fbGet('zenty/cron_config/accounts').catch(function() { return null; }) || {};
    const expectedByAccount = {};
    Object.keys(accounts).forEach(function(snid) {
      const a = accounts[snid];
      if (!a || a.paused === true || !a.username) return;
      const handle = (a.username || '').replace('@', '').toLowerCase();
      const reelsExpected = a.reels || 0;
      const storiesExpected = a.stories || 0;
      if (reelsExpected + storiesExpected === 0) return;
      expectedByAccount[handle] = {
        reels: reelsExpected,
        stories: storiesExpected,
        total: reelsExpected + storiesExpected
      };
    });
    // 2. Compter les posts publiés aujourd'hui par compte
    const r = await fetch('https://www.oneupapp.io/api/getpublishedposts?apiKey=' + ONEUP_KEY);
    if (!r.ok) return { name: 'posting_schedule_compliance', ok: false, error: 'HTTP ' + r.status };
    const txt = await r.text();
    if (txt.trim().startsWith('<')) return { name: 'posting_schedule_compliance', ok: false, error: 'OneUp HTML' };
    const j = JSON.parse(txt);
    const arr = Array.isArray(j) ? j : (j.data || []);
    const today = new Date().toISOString().split('T')[0];
    const publishedByAccount = {};
    arr.filter(function(p) { return (p.created_at || '').startsWith(today); }).forEach(function(p) {
      const h = (p.social_network_username || '').toLowerCase();
      if (!publishedByAccount[h]) publishedByAccount[h] = 0;
      publishedByAccount[h]++;
    });
    // 3. Tolérer "trop tôt dans la journée" (avant 22h Paris = 20h UTC, certains slots
    //    ne sont pas encore passés). Hard-check seulement après 22h Paris.
    const hourUTC = new Date().getUTCHours();
    const tooEarly = hourUTC < 20;
    // 4. Détecter MISSING (publié < attendu) et OVER (publié > attendu)
    const missing = [];
    const over = [];
    Object.keys(expectedByAccount).forEach(function(handle) {
      const exp = expectedByAccount[handle];
      const got = publishedByAccount[handle] || 0;
      if (got < exp.total && !tooEarly) {
        missing.push({ handle: handle, expected: exp.total, got: got, deficit: exp.total - got });
      }
      if (got > exp.total) {
        over.push({ handle: handle, expected: exp.total, got: got, surplus: got - exp.total });
      }
    });
    return {
      name: 'posting_schedule_compliance',
      ok: missing.length === 0 && over.length === 0,
      tooEarlyForMissingCheck: tooEarly,
      missingCount: missing.length,
      overCount: over.length,
      missing: missing.slice(0, 10),
      over: over.slice(0, 10),
      note: (missing.length > 0 ? missing.length + ' compte(s) ont posté MOINS que prévu' : '') +
            (over.length > 0 ? (missing.length > 0 ? ' · ' : '') + over.length + ' compte(s) ont posté PLUS (doublons)' : '') ||
            'tous les comptes ont posté le bon nombre'
    };
  } catch (e) {
    return { name: 'posting_schedule_compliance', ok: false, error: e.message };
  }
}

// ── Check 6b: Posting rate limit — détecter rafale (posts trop rapprochés) ──
// Lit OneUp getpublishedposts today et calcule l'intervalle entre posts pour chaque compte.
// Alerte si un compte a 2+ posts publiés en < 30 min (rafale anormale).
// Bug détecté 2026-05-02 : 10 doublons publiés en rafale à cause d'un fetchAllScheduledPosts
// qui retournait [] silencieusement quand OneUp répondait du HTML.
async function checkPostingRateLimit() {
  if (!ONEUP_KEY) return { name: 'posting_rate_limit', ok: true, note: 'no key (skipped)' };
  try {
    const r = await fetch('https://www.oneupapp.io/api/getpublishedposts?apiKey=' + ONEUP_KEY);
    if (!r.ok) return { name: 'posting_rate_limit', ok: false, error: 'HTTP ' + r.status };
    const txt = await r.text();
    if (txt.trim().startsWith('<')) return { name: 'posting_rate_limit', ok: false, error: 'OneUp returned HTML' };
    const j = JSON.parse(txt);
    const arr = Array.isArray(j) ? j : (j.data || []);
    const today = new Date().toISOString().split('T')[0];
    const todayPosts = arr.filter(function(p) { return (p.created_at || '').startsWith(today); });
    // Group by account
    const byAcc = {};
    todayPosts.forEach(function(p) {
      const u = p.social_network_username || '?';
      if (!byAcc[u]) byAcc[u] = [];
      byAcc[u].push(p.created_at);
    });
    // Detect violations : 2+ posts < 30 min apart on same account
    const violations = [];
    Object.keys(byAcc).forEach(function(u) {
      const times = byAcc[u].sort();
      for (let i = 1; i < times.length; i++) {
        const t1 = new Date(times[i - 1].replace(' ', 'T')).getTime();
        const t2 = new Date(times[i].replace(' ', 'T')).getTime();
        const diffMin = Math.round((t2 - t1) / 60000);
        if (diffMin < 30) {
          violations.push({ account: u, t1: times[i - 1], t2: times[i], diffMin: diffMin });
        }
      }
    });
    return {
      name: 'posting_rate_limit',
      ok: violations.length === 0,
      todayPostsTotal: todayPosts.length,
      violationsCount: violations.length,
      violations: violations.slice(0, 10),
      note: violations.length > 0 ? 'RAFALE détectée — ' + violations.length + ' intervalle(s) < 30 min' : null
    };
  } catch (e) {
    return { name: 'posting_rate_limit', ok: false, error: e.message };
  }
}

// ── Check 6c: Browser errors rate (capturés par js/core/error-beacon.js) ──
// Lit zenty/browser_errors_count/{date} : si > 20 errors aujourd'hui = anomalie.
// Couvre les vrais users (Jordan + VAs), complémentaire au smoke test (factice).
async function checkBrowserErrorsRate() {
  const today = new Date().toISOString().split('T')[0];
  const countRaw = await fbGet('zenty/browser_errors_count/' + today).catch(function() { return 0; });
  const count = (typeof countRaw === 'number') ? countRaw : 0;
  // Threshold : 20 errors/jour (avec dedup 10min côté browser, signal vrai cassé)
  return {
    name: 'browser_errors_rate',
    ok: count < 20,
    count: count,
    threshold: 20,
    note: count >= 20 ? '⚠️ ' + count + ' erreurs JS browser aujourd\'hui (seuil 20)' :
          (count > 0 ? count + ' erreurs (sous seuil)' : 'aucune erreur browser')
  };
}

// ── Check 7a: Smoke tests UI — dernier run sans erreur JS ────────────────────
// Lit zenty/smoke_results/{date}. Si dernier run a allOk=false → fail le check.
// Si pas de run aujourd'hui (smoke tourne 1×/jour 6h UTC) : tolère si avant 8h UTC.
async function checkSmokeTests() {
  const today = new Date().toISOString().split('T')[0];
  const yest  = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const [resToday, resYest] = await Promise.all([
    fbGet('zenty/smoke_results/' + today).catch(function() { return null; }),
    fbGet('zenty/smoke_results/' + yest).catch(function() { return null; })
  ]);
  // Run today existe
  if (resToday && resToday.timestamp) {
    return {
      name: 'smoke_tests',
      ok: !!resToday.allOk,
      runAt: resToday.timestamp,
      totalJsErrors: resToday.totalJsErrors || 0,
      pagesFailedCount: (resToday.pages || []).filter(function(p) { return !p.ok; }).length
    };
  }
  // Pas de run aujourd'hui : check celui d'hier (fallback)
  const hourUTC = new Date().getUTCHours();
  if (hourUTC < 8 && resYest) {
    return {
      name: 'smoke_tests', ok: !!resYest.allOk, runAt: resYest.timestamp,
      note: 'using yesterday run (today not yet)',
      totalJsErrors: resYest.totalJsErrors || 0
    };
  }
  return { name: 'smoke_tests', ok: true, note: 'no smoke run today (smoke runs 1x/day at 06h UTC)' };
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

// ── Check 6d: Anomaly detection (Vague 4C — baseline 7j vs courant) ─────────
// Compare métriques aujourd'hui vs moyenne+stddev des 7 derniers jours.
// Alerte si écart > 3× stddev (= pattern anormal). Évite les faux positifs en
// ne calculant que sur métriques avec sample >= 4 jours et stddev > 0.
async function checkAnomalyDetection() {
  try {
    // Récupérer les 8 derniers jours (7 baseline + aujourd'hui)
    const dates = [];
    for (let i = 0; i <= 7; i++) {
      dates.push(new Date(Date.now() - i * 86400000).toISOString().split('T')[0]);
    }
    const today = dates[0];

    // Lire post_verify_results et browser_errors_count en parallèle (2 metrics testables)
    const [verifyData, browserData] = await Promise.all([
      Promise.all(dates.map(function(d) { return fbGet('zenty/post_verify_results/' + d).catch(function() { return null; }); })),
      Promise.all(dates.map(function(d) { return fbGet('zenty/browser_errors_count/' + d).catch(function() { return null; }); }))
    ]);

    function describe(samples) {
      const valid = samples.filter(function(v) { return typeof v === 'number'; });
      if (valid.length < 4) return null; // pas assez d'historique
      const mean = valid.reduce(function(s, v) { return s + v; }, 0) / valid.length;
      const variance = valid.reduce(function(s, v) { return s + Math.pow(v - mean, 2); }, 0) / valid.length;
      const stddev = Math.sqrt(variance);
      return { mean: Math.round(mean * 10) / 10, stddev: Math.round(stddev * 10) / 10, n: valid.length };
    }

    function isAnomaly(current, stats) {
      if (!stats || stats.stddev === 0) return false;
      const deviation = Math.abs(current - stats.mean) / stats.stddev;
      return deviation > 3;
    }

    // Metric 1 : posts publiés/jour (verified count)
    const verifiedCounts = verifyData.map(function(r) {
      return (r && Array.isArray(r.verified)) ? r.verified.length : null;
    });
    const baselineVerified = describe(verifiedCounts.slice(1));  // exclut today
    const todayVerified = verifiedCounts[0] || 0;

    // Metric 2 : posts ratés/jour (failed count)
    const failedCounts = verifyData.map(function(r) {
      return (r && Array.isArray(r.failed)) ? r.failed.length : null;
    });
    const baselineFailed = describe(failedCounts.slice(1));
    const todayFailed = failedCounts[0] || 0;

    // Metric 3 : errors browser/jour
    const errCounts = browserData.map(function(v) { return typeof v === 'number' ? v : null; });
    const baselineErrors = describe(errCounts.slice(1));
    const todayErrors = errCounts[0] || 0;

    const anomalies = [];
    if (baselineVerified && isAnomaly(todayVerified, baselineVerified)) {
      anomalies.push({ metric: 'posts_publiés', today: todayVerified, baseline: baselineVerified });
    }
    if (baselineFailed && isAnomaly(todayFailed, baselineFailed)) {
      anomalies.push({ metric: 'posts_ratés', today: todayFailed, baseline: baselineFailed });
    }
    if (baselineErrors && isAnomaly(todayErrors, baselineErrors)) {
      anomalies.push({ metric: 'errors_browser', today: todayErrors, baseline: baselineErrors });
    }

    return {
      name: 'anomaly_detection',
      ok: anomalies.length === 0,
      anomaliesCount: anomalies.length,
      anomalies: anomalies,
      baselines: {
        posts_publiés: baselineVerified,
        posts_ratés: baselineFailed,
        errors_browser: baselineErrors
      },
      note: anomalies.length === 0 ?
        (baselineVerified ? 'patterns normaux (baseline ' + baselineVerified.n + 'j)' : 'pas assez d\'historique pour baseline') :
        anomalies.length + ' métrique(s) hors norme'
    };
  } catch (e) {
    return { name: 'anomaly_detection', ok: false, error: e.message };
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
    checkPostingScheduleCompliance(),
    checkPostingRateLimit(),
    checkAnomalyDetection(),
    checkCaptionAIHealth(),
    checkCronTimers(),
    checkMultiAgencyOrphans(),
    checkTelegramHeartbeat(),
    checkBrowserErrorsRate(),
    checkSmokeTests(),
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
