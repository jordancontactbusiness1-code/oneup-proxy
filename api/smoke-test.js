// ═══════════════════════════════════════════════════════════════════
//  ZENTY — SMOKE TESTS UI (Vague 2 — Veilleur élargi #3)
//  2026-05-02 nuit
//
//  POURQUOI : la Vague 1 (data integrity Firebase) ne détecte pas les régressions
//  UI (page blanche après deploy, modal cassé, JS error fatale, CSS qui plante).
//  Bug du soir (drawer Programmés/Publiés tout à dash) aurait pu être catché ici
//  via comparaison "% de cellules vides".
//
//  QUOI : appelé 1×/jour par zenty-smoke.timer (avant digest matin).
//   1. Lance Chromium headless via Playwright
//   2. Inject sessionStorage.zenty_session pour bypass login
//   3. Visite 4 pages clés : Dashboard, OneUp, Comptes, Settings
//   4. Pour chaque : capture JS errors, screenshot, mesure load time, DOM checks
//   5. Détecte signaux suspects (% cellules avec '—', éléments manquants)
//   6. Stocke résultats Firebase zenty/smoke_results/{date}
//   7. Intégrité : si fail → check oneup_data_contract / health-integrity remonte alerte
//
//  AUTH : CRON_SECRET (header x-cron-secret)
//  COÛT : 0 token Anthropic. ~30s CPU/run + ~2 MB stockage Firebase/jour.
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET     = process.env.CRON_SECRET       || '';

const DASHBOARD_URL   = 'https://dashboard.jscaledashboard.online';
const SCREENSHOT_DIR  = '/opt/zenty-smoke/screenshots';

// User factice injecté en sessionStorage pour bypass login
const SMOKE_USER = {
  id: 'smokebot',
  username: 'smokebot',
  displayName: 'Smoke Bot',
  role: 'directeur',
  permissions: { editAcc: true, syncIG: true, settings: true },
  agency: 'FR'
};

// Pages à tester : nav id → label + selector clé (un id stable par page)
// Selectors validés sur le code js/templates/page-*.js réel (2026-05-02 nuit)
const PAGES_TO_TEST = [
  { navId: 'nav-dashboard', label: 'Dashboard',  keySelector: '#app-body',                            timeout: 8000 },
  { navId: 'nav-oneup',     label: 'OneUp',      keySelector: '#ou-kpi-accounts, #ou-search',         timeout: 8000 },
  { navId: 'nav-comptes',   label: 'Comptes',    keySelector: 'table, #app-body',                     timeout: 8000 },
  { navId: 'nav-settings',  label: 'Settings',   keySelector: '#app-body input, #app-body button',    timeout: 8000 }
];

// ── Firebase helper ──────────────────────────────────────────────────────────
async function fbPut(p, value) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json?auth=' + FIREBASE_SECRET, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}

// ── Test une page : retourne { ok, jsErrors, screenshot, dashRatio, loadMs, ... }
async function testPage(page, pageDef) {
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', function(msg) {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', function(e) {
    pageErrors.push((e.message || String(e)).slice(0, 200));
  });

  const startMs = Date.now();
  try {
    // Click sur le nav button correspondant
    const navSel = '#' + pageDef.navId + ', [data-nav="' + pageDef.navId + '"]';
    const navEl = await page.$(navSel);
    if (navEl) {
      await navEl.click();
    } else {
      // Fallback : injection directe via fonction globale si exposée
      await page.evaluate(function(navId) {
        if (typeof switchPage === 'function') switchPage(navId.replace('nav-', ''));
        else if (typeof renderPage === 'function') renderPage(navId.replace('nav-', ''));
      }, pageDef.navId);
    }
    // Attendre que le selector clé apparaisse
    let keyVisible = false;
    try {
      await page.waitForSelector(pageDef.keySelector, { timeout: pageDef.timeout, state: 'attached' });
      keyVisible = true;
    } catch(e) { keyVisible = false; }
    const loadMs = Date.now() - startMs;

    // Compter les cellules vides "—" ou contenu vide (signal de bug du genre side-panel.js)
    const dashStats = await page.evaluate(function() {
      const all = document.querySelectorAll('*');
      let totalText = 0, dashCount = 0;
      all.forEach(function(el) {
        if (el.children.length > 0) return; // leaf only
        const t = (el.textContent || '').trim();
        if (!t) return;
        totalText++;
        if (t === '—' || t === '-') dashCount++;
      });
      return { total: totalText, dashes: dashCount };
    });
    const dashRatio = dashStats.total > 0 ? dashStats.dashes / dashStats.total : 0;

    // Screenshot
    const safeName = pageDef.label.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const screenshotPath = SCREENSHOT_DIR + '/latest_' + safeName + '.png';
    try {
      await page.screenshot({ path: screenshotPath, type: 'png', fullPage: false });
    } catch(e) {}

    return {
      page: pageDef.label,
      ok: keyVisible && pageErrors.length === 0,
      keyVisible: keyVisible,
      jsErrors: pageErrors.length,
      jsErrorMessages: pageErrors.slice(0, 3),
      consoleErrors: consoleErrors.length,
      consoleErrorMessages: consoleErrors.slice(0, 3),
      loadMs: loadMs,
      dashCount: dashStats.dashes,
      dashTotal: dashStats.total,
      dashRatio: Math.round(dashRatio * 1000) / 1000,
      screenshot: screenshotPath
    };
  } catch (e) {
    return {
      page: pageDef.label,
      ok: false,
      error: e.message.slice(0, 200),
      loadMs: Date.now() - startMs
    };
  }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // Lazy require Playwright (gros module, on charge seulement à l'appel)
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (e) { res.status(500).json({ error: 'Playwright not installed: ' + e.message }); return; }

  // Setup screenshot dir
  try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch(e) {}

  const startTime = Date.now();
  console.log('[smoke] Starting Playwright browser');

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: false
    });
    const page = await context.newPage();

    // 1. Charger l'index pour avoir le sessionStorage du bon domaine
    let initialLoadOk = false;
    let initialError = null;
    try {
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
      initialLoadOk = true;
    } catch(e) {
      initialError = e.message.slice(0, 200);
    }

    if (!initialLoadOk) {
      await browser.close();
      res.status(200).json({
        ok: false,
        allOk: false,
        initialLoad: { ok: false, error: initialError },
        elapsed_s: Math.round((Date.now() - startTime) / 1000)
      });
      return;
    }

    // 2. Inject sessionStorage user factice (bypass login)
    await page.evaluate(function(user) {
      sessionStorage.setItem('zenty_session', JSON.stringify(user));
    }, SMOKE_USER);

    // 3. Reload pour que checkAuth() lise la session et appelle showApp()
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });

    // 4. Attendre que app-body soit visible (showApp() effectif)
    let loggedIn = false;
    try {
      await page.waitForFunction(function() {
        const ab = document.getElementById('app-body');
        return ab && ab.style.display !== 'none' && document.getElementById('login-screen').classList.contains('hidden');
      }, { timeout: 15000 });
      loggedIn = true;
    } catch(e) { loggedIn = false; }

    if (!loggedIn) {
      try { await page.screenshot({ path: SCREENSHOT_DIR + '/latest_login-fail.png' }); } catch(e) {}
      await browser.close();
      res.status(200).json({
        ok: false,
        allOk: false,
        loginBypass: { ok: false, screenshot: SCREENSHOT_DIR + '/latest_login-fail.png' },
        elapsed_s: Math.round((Date.now() - startTime) / 1000)
      });
      return;
    }

    // 5. Tester chaque page séquentiellement (Playwright browser unique)
    const pageResults = [];
    for (let i = 0; i < PAGES_TO_TEST.length; i++) {
      const r = await testPage(page, PAGES_TO_TEST[i]);
      pageResults.push(r);
    }

    await browser.close();

    const allOk = pageResults.every(function(r) { return r.ok; });
    const totalJsErrors = pageResults.reduce(function(s, r) { return s + (r.jsErrors || 0); }, 0);
    const elapsed_s = Math.round((Date.now() - startTime) / 1000);

    // 6. Stocker dans Firebase
    const now = new Date();
    const datePart = now.toISOString().split('T')[0];
    await fbPut('zenty/smoke_results/' + datePart, {
      timestamp: now.toISOString(),
      allOk: allOk,
      pages: pageResults,
      totalJsErrors: totalJsErrors,
      elapsed_s: elapsed_s
    });

    console.log('[smoke] Done in ' + elapsed_s + 's. allOk=' + allOk + ' jsErrors=' + totalJsErrors);

    res.status(200).json({
      ok: true,
      allOk: allOk,
      pages: pageResults,
      totalJsErrors: totalJsErrors,
      elapsed_s: elapsed_s
    });
  } catch (e) {
    console.error('[smoke] FATAL:', e.message);
    if (browser) { try { await browser.close(); } catch(e2) {} }
    res.status(500).json({ error: true, message: e.message });
  }
};
