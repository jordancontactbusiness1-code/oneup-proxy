// ═══════════════════════════════════════════════════════════════════
//  HIGGSFIELD — pilote du navigateur Chrome via CDP (port 9222)
//
//  Le service systemd zenty-chrome.service garde un Google Chrome ouvert
//  en permanence sur le VPS, avec --remote-debugging-port=9222.
//  Cette lib s'y connecte via puppeteer-core pour piloter l'interface
//  Higgsfield (upload images, prompt, generate, download résultat).
//
//  La 1ère fois, Jordan login manuellement via VNC (vnc.jscaledashboard.online)
//  puis active le mode unlimited 2K. La session reste ensuite persistante
//  dans /opt/zenty-higgsfield/profile/.
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');
const cfg  = require('./higgsfield-selectors.js');

const CDP_URL = process.env.HIGGSFIELD_CDP_URL || 'http://127.0.0.1:9222';

// Lazy require puppeteer-core (au cas où pas installé en local pour tests unitaires)
let _puppeteer = null;
function puppeteer() {
  if (!_puppeteer) _puppeteer = require('puppeteer-core');
  return _puppeteer;
}

// ── Connexion CDP au Chrome existant ───────────────────────────────────
async function connect() {
  const browser = await puppeteer().connect({
    browserURL:      CDP_URL,
    defaultViewport: { width: 1920, height: 1080 }
  });
  return browser;
}

// Réutilise un onglet existant ou en crée un nouveau
async function getOrCreatePage(browser, urlMatch) {
  const pages = await browser.pages();
  for (const p of pages) {
    try {
      const u = p.url();
      if (urlMatch && u && u.includes(urlMatch)) return p;
    } catch (_) {}
  }
  // Pas trouvé → ouvre un nouvel onglet
  const page = await browser.newPage();
  return page;
}

// ── Navigation studio ──────────────────────────────────────────────────
async function gotoStudio(page) {
  const u = page.url();
  if (!u || !u.includes(cfg.studioUrl.replace(/^https?:\/\//, '').split('/')[0])) {
    await page.goto(cfg.studioUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageLoad });
  }
  // Attend que la page soit interactive
  await page.waitForSelector('body', { timeout: cfg.timeouts.pageLoad });
}

// ── Upload une image (référence Tina ou frame Reel) ────────────────────
async function uploadImage(page, filepath, slotIndex) {
  if (!fs.existsSync(filepath)) throw new Error('uploadImage: fichier introuvable: ' + filepath);
  const inputs = await page.$$(cfg.selectors.fileInput);
  if (inputs.length === 0) throw new Error('uploadImage: aucun input[type=file] trouvé');
  const idx = (typeof slotIndex === 'number') ? slotIndex : 0;
  const input = inputs[Math.min(idx, inputs.length - 1)];
  await input.uploadFile(filepath);
  // Attente côté UI : laisser à Higgsfield le temps de digérer l'upload
  await sleep(2000);
}

// ── Remplir le prompt ──────────────────────────────────────────────────
async function setPrompt(page, text) {
  // Trouve le textarea le plus pertinent (visible + plus grand)
  const textarea = await page.$(cfg.selectors.promptTextarea);
  if (!textarea) throw new Error('setPrompt: textarea prompt introuvable');
  await textarea.click({ clickCount: 3 }); // sélectionne tout
  await page.keyboard.press('Backspace');
  await textarea.type(text, { delay: 8 });
}

// ── Click bouton Generate ──────────────────────────────────────────────
async function clickGenerate(page) {
  // Essaie plusieurs selectors potentiels
  const candidates = [
    'button:has-text("Generate")',
    'button:has-text("Create")',
    'button[data-testid*="generate" i]'
  ];
  for (const sel of candidates) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const isDisabled = await page.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true', btn);
        if (!isDisabled) {
          await btn.click();
          return;
        }
      }
    } catch (_) {}
  }
  throw new Error('clickGenerate: bouton Generate introuvable ou disabled');
}

// ── Attente résultat (avec détection safety filter) ────────────────────
async function waitForResult(page, signal) {
  const t0 = Date.now();
  const timeout = cfg.timeouts.generation;

  while (Date.now() - t0 < timeout) {
    if (signal && signal.aborted) throw new Error('waitForResult: aborted');

    // 1. Détection erreur safety
    const safetyErr = await page.evaluate((re) => {
      const txt = document.body && document.body.innerText || '';
      return new RegExp(re, 'i').test(txt);
    }, 'safety|content policy|moderation|refused|rejected|blocked');
    if (safetyErr) {
      const err = new Error('SAFETY_FILTER');
      err.code = 'SAFETY_FILTER';
      throw err;
    }

    // 2. Détection image résultat dispo
    const resultUrl = await page.evaluate((sel) => {
      const candidates = document.querySelectorAll(sel);
      for (const img of candidates) {
        if (img.src && img.naturalWidth > 256) return img.src;
      }
      return null;
    }, cfg.selectors.resultImage);

    if (resultUrl) return resultUrl;

    await sleep(2000);
  }
  throw new Error('waitForResult: timeout après ' + timeout + 'ms');
}

// ── Download l'image résultat dans un fichier local ────────────────────
async function downloadResult(page, resultUrl, savePath) {
  // Récupère via fetch dans le contexte page (cookies + auth user présents)
  const data = await page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    const buf = await r.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }, resultUrl);
  fs.writeFileSync(savePath, Buffer.from(data, 'base64'));
  return savePath;
}

// ── Helpers ────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

// ── API publique ───────────────────────────────────────────────────────
//
// generateOnePhoto({ refTinaPath, frameReelPath, prompt, outPath, signal })
// → résout avec { ok:true, path, resultUrl }
// → rejette avec Error('SAFETY_FILTER') si refus, ou autre Error si echec
//
async function generateOnePhoto(opts) {
  const browser = await connect();
  try {
    const page = await getOrCreatePage(browser, 'higgsfield');
    await gotoStudio(page);

    // Upload ref Tina (slot 0) puis frame Reel (slot 1)
    await uploadImage(page, opts.refTinaPath, 0);
    await uploadImage(page, opts.frameReelPath, 1);

    // Prompt swap
    await setPrompt(page, opts.prompt);

    // Click Generate
    await clickGenerate(page);
    await sleep(cfg.timeouts.generateClick);

    // Attente résultat
    const resultUrl = await waitForResult(page, opts.signal);

    // Download
    const out = opts.outPath || ('/tmp/zenty-higgsfield/' + Date.now() + '.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await downloadResult(page, resultUrl, out);

    return { ok: true, path: out, resultUrl: resultUrl };
  } finally {
    // Disconnect (ne ferme PAS Chrome — c'est le service systemd qui le possède)
    try { browser.disconnect(); } catch (_) {}
  }
}

module.exports = {
  connect:         connect,
  getOrCreatePage: getOrCreatePage,
  gotoStudio:      gotoStudio,
  uploadImage:     uploadImage,
  setPrompt:       setPrompt,
  clickGenerate:   clickGenerate,
  waitForResult:   waitForResult,
  downloadResult:  downloadResult,
  generateOnePhoto: generateOnePhoto
};
