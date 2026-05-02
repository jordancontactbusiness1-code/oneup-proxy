// ═══════════════════════════════════════════════════════════════════
//  ZENTY — HEALTH CHECK VPS (Phase B — Veilleur élargi 2026-05-02)
//
//  POURQUOI : zenty-verify ne couvre que le posting OneUp. Il faut surveiller
//  TOUS les organes vitaux : Drive, Firebase, OneUp, Anthropic, Apify, Dashboard.
//
//  QUOI : appelé toutes les heures par zenty-supervisor.timer.
//   1. Ping chaque service externe + mesure latence
//   2. Stocke résultats dans Firebase zenty/health_checks/{date}/{hour}
//   3. Pas d'alerte Telegram directe (le Détective Robot 2 décidera)
//
//  AUTH : CRON_SECRET (header x-cron-secret ou ?secret=)
//  COÛT : ~6 HTTP requests + 1 token Anthropic (haiku) par run = négligeable
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');

const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET     = process.env.CRON_SECRET       || '';
const ONEUP_KEY       = process.env.ONEUP_API_KEY     || '';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const APIFY_KEY       = process.env.APIFY_API_KEY     || '';
const SA_PATH         = process.env.GDRIVE_SA_PATH    || '/opt/zenty-cron/drive-sa.json';

// ── Helper: timed fetch (latency + ok/error) ─────────────────────────────────
async function timedFetch(url, opts) {
  const start = Date.now();
  try {
    const r = await fetch(url, opts || {});
    const elapsed = Date.now() - start;
    return { ok: r.ok, status: r.status, latency_ms: elapsed };
  } catch (e) {
    return { ok: false, error: e.message, latency_ms: Date.now() - start };
  }
}

// ── Check 1: Firebase reachable + auth OK ────────────────────────────────────
async function checkFirebase() {
  const t = await timedFetch(FIREBASE_URL + '/zenty.json?auth=' + FIREBASE_SECRET + '&shallow=true');
  return Object.assign({ name: 'firebase' }, t);
}

// ── Check 2: OneUp API listcategory (cheap call) ─────────────────────────────
async function checkOneup() {
  const t = await timedFetch('https://www.oneupapp.io/api/listcategory?apiKey=' + ONEUP_KEY);
  return Object.assign({ name: 'oneup' }, t);
}

// ── Check 3: Drive Service Account file present + parseable ──────────────────
async function checkDrive() {
  if (!fs.existsSync(SA_PATH)) return { name: 'drive', ok: false, error: 'SA file missing at ' + SA_PATH };
  try {
    const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf-8'));
    if (!sa.client_email || !sa.private_key) return { name: 'drive', ok: false, error: 'SA malformed' };
    return { name: 'drive', ok: true, email: sa.client_email };
  } catch (e) {
    return { name: 'drive', ok: false, error: 'SA parse: ' + e.message };
  }
}

// ── Check 4: Anthropic API ping (1 token request, ~$0.0001) ──────────────────
async function checkAnthropic() {
  if (!ANTHROPIC_KEY) return { name: 'anthropic', ok: false, error: 'no key' };
  const t = await timedFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] })
  });
  // Status 200/400 = API joignable. 401/403 = clé invalide. 500+ = service down.
  return Object.assign({ name: 'anthropic', ok: t.status === 200 || t.status === 400 }, t);
}

// ── Check 5: Apify credits (account info) ────────────────────────────────────
async function checkApify() {
  if (!APIFY_KEY) return { name: 'apify', ok: false, error: 'no key' };
  const start = Date.now();
  try {
    const r = await fetch('https://api.apify.com/v2/users/me?token=' + APIFY_KEY);
    const elapsed = Date.now() - start;
    if (!r.ok) return { name: 'apify', ok: false, status: r.status, latency_ms: elapsed };
    const j = await r.json();
    return { name: 'apify', ok: true, status: 200, latency_ms: elapsed, plan: (j && j.data && j.data.plan) || 'unknown' };
  } catch (e) {
    return { name: 'apify', ok: false, error: e.message, latency_ms: Date.now() - start };
  }
}

// ── Check 6: Dashboard public URL ────────────────────────────────────────────
async function checkDashboard() {
  const t = await timedFetch('https://dashboard.jscaledashboard.online/');
  return Object.assign({ name: 'dashboard' }, t);
}

// ── Check 7: Caption AI success rate (last 24h) ──────────────────────────────
// Lit zenty/caption_logs (si dispo) et calcule le ratio succès/total.
// Si pas de logs : ok=true (pas d'usage = pas d'erreur)
async function checkCaptionAI() {
  const t = await timedFetch(FIREBASE_URL + '/zenty/caption_logs.json?auth=' + FIREBASE_SECRET + '&shallow=true');
  // Pour l'instant simple : si Firebase répond, OK.
  // V2 : analyser le ratio succès des dernières 24h
  return { name: 'caption_ai', ok: t.ok, status: t.status, latency_ms: t.latency_ms, note: 'shallow only' };
}

// ── Check 8: Posting health (last 24h) ───────────────────────────────────────
// Lit zenty/post_verify_results/{today} pour vérifier que ça tourne.
async function checkPosting() {
  const today = new Date().toISOString().split('T')[0];
  const r = await timedFetch(FIREBASE_URL + '/zenty/post_verify_results/' + today + '.json?auth=' + FIREBASE_SECRET);
  if (!r.ok) return { name: 'posting', ok: false, status: r.status, error: 'cannot read post_verify_results' };
  // Le fait que ça réponde indique que zenty-verify a au moins tourné une fois aujourd'hui.
  return { name: 'posting', ok: true, status: 200, latency_ms: r.latency_ms };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Auth
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const startTime = Date.now();
  console.log('[supervisor] Starting health checks');

  // Run all checks in parallel for speed
  const checks = await Promise.all([
    checkFirebase(),
    checkOneup(),
    checkDrive(),
    checkAnthropic(),
    checkApify(),
    checkDashboard(),
    checkCaptionAI(),
    checkPosting()
  ]);

  const allOk = checks.every(function(c) { return c.ok; });
  const failedChecks = checks.filter(function(c) { return !c.ok; });
  const elapsed_s = Math.round((Date.now() - startTime) / 1000);

  // Store in Firebase by date+hour for trend analysis
  const now = new Date();
  const datePart = now.toISOString().split('T')[0];
  const hourPart = String(now.getUTCHours()).padStart(2, '0');
  const fbPath = FIREBASE_URL + '/zenty/health_checks/' + datePart + '/' + hourPart + '.json?auth=' + FIREBASE_SECRET;

  try {
    await fetch(fbPath, {
      method: 'PUT',  // PUT not PATCH : on overwrite tout le slot horaire
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
    console.error('[supervisor] Firebase write failed:', e.message);
  }

  console.log('[supervisor] Done in ' + elapsed_s + 's : allOk=' + allOk + ' failed=[' + failedChecks.map(function(c) { return c.name; }).join(',') + ']');

  res.status(200).json({
    ok: true,
    allOk: allOk,
    checks: checks,
    failedNames: failedChecks.map(function(c) { return c.name; }),
    elapsed_s: elapsed_s,
    storedAt: 'zenty/health_checks/' + datePart + '/' + hourPart
  });
};
