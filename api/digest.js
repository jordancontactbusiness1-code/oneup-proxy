// ═══════════════════════════════════════════════════════════════════
//  ZENTY — TELEGRAM DIGEST (Phase 5 cs-senior-engineer 2026-05-02)
//
//  POURQUOI : à 100 comptes, alertes éparses = spam Telegram. Solution :
//  2 messages/jour groupés (09h matin = bilan veille, 21h soir = bilan jour).
//  Les alertes immédiates de verify.js restent (uniquement nouveaux fails).
//
//  QUOI :
//   - GET /api/digest-run?slot=morning : bilan veille (J-1, complet)
//   - GET /api/digest-run?slot=evening : bilan aujourd'hui (jusqu'à 21h)
//   - Idempotent : flag debriefSent dans results pour ne pas re-envoyer
//
//  Source : Firebase zenty/post_verify_results/{date} + cron_config (compteurs)
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');
const tg    = require('./_telegram-format.js');

const FIREBASE_URL = (process.env.FIREBASE_URL  || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SEC = process.env.FIREBASE_SECRET || '';
const CRON_SECRET  = process.env.CRON_SECRET    || '';
const TG_TOKEN     = process.env.TG_TOKEN       || '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const TG_CHAT      = process.env.TG_CHAT        || '6646462254';
const ONEUP_KEY    = process.env.ONEUP_API_KEY  || '';
const ONEUP_BASE   = 'https://www.oneupapp.io';

const fbAuth = '?auth=' + FIREBASE_SEC;
async function fbGet(path) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth);
  return r.json();
}
async function fbPatch(path, value) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}
const sendTelegram = tg.sendTelegram;

function pad(n) { return String(n).padStart(2, '0'); }
function parisDateStr(d) {
  const p = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  return p.getFullYear() + '-' + pad(p.getMonth() + 1) + '-' + pad(p.getDate());
}
function dateMinusOne(s) {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// ── Détection Drive vide pour comptes actifs (digest matin) ──────────────────
// Lit zenty/cron_config/accounts (config) + driveContentMap si présent en cache
// Firebase. À défaut, retourne [] (le badge dashboard suffira).
async function fetchLowDrive() {
  try {
    const accounts = await fbGet('zenty/cron_config/accounts').catch(function() { return null; });
    const driveContentMap = await fbGet('zenty/driveContentMap').catch(function() { return null; });
    if (!accounts || typeof accounts !== 'object') return [];
    const out = [];
    Object.keys(accounts).forEach(function(snid) {
      const a = accounts[snid];
      if (!a || a.paused === true) return;
      const freqR = (a.reels   || 0);
      const freqS = (a.stories || 0);
      if (freqR + freqS === 0) return;
      const handle = (a.username || '').replace('@', '').toLowerCase();
      const content = (driveContentMap && driveContentMap[handle]) || {};
      const reelsCount   = Array.isArray(content.reels)   ? content.reels.length   : null;
      const storiesCount = Array.isArray(content.stories) ? content.stories.length : null;
      // On alerte si reels=0 OU reels<=3 (bas)
      const isEmpty = (reelsCount === 0 && freqR > 0) || (storiesCount === 0 && freqS > 0);
      const isLow   = !isEmpty && reelsCount !== null && reelsCount <= 3 && freqR > 0;
      if (isEmpty || isLow) {
        out.push({ handle: handle, reels: reelsCount, stories: storiesCount, freqR: freqR, freqS: freqS });
      }
    });
    return out;
  } catch (e) {
    console.warn('[digest] fetchLowDrive fail:', e.message);
    return [];
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Auth
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const slot = (req.query && req.query.slot) || 'evening';
  const todayStr = parisDateStr(new Date());
  // Bilan matin = veille; bilan soir = aujourd'hui
  const targetDate = (slot === 'morning') ? dateMinusOne(todayStr) : todayStr;

  console.log('[digest ' + slot + '] target=' + targetDate);

  try {
    const results = await fbGet('zenty/post_verify_results/' + targetDate).catch(function() { return null; });
    const flagPath = 'zenty/post_verify_results/' + targetDate + '/digestSent_' + slot;
    const alreadySent = await fbGet(flagPath).catch(function() { return null; });
    if (alreadySent === true) {
      console.log('[digest] already sent for ' + slot + ' / ' + targetDate);
      res.status(200).json({ ok: true, skipped: true, reason: 'already sent' });
      return;
    }

    const verified = (results && Array.isArray(results.verified)) ? results.verified : [];
    const failed   = (results && Array.isArray(results.failed))   ? results.failed   : [];
    const isMorning = slot === 'morning';

    // Drive vide : check uniquement le matin (digest soir = bilan post-publish)
    const lowDrive = isMorning ? await fetchLowDrive() : [];

    // Diagnostics récents (Phase C — Détective IA). Lit zenty/incidents (24h).
    // On filtre sur la targetDate pour cohérence avec le digest.
    let diagnostics = [];
    let diagnosticsTotal = 0;
    try {
      const incidents = await fbGet('zenty/incidents');
      if (incidents && typeof incidents === 'object') {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const recent = Object.keys(incidents)
          .map(function(k) { return incidents[k]; })
          .filter(function(d) {
            if (!d || !d.timestamp) return false;
            return new Date(d.timestamp).getTime() > cutoff;
          });
        diagnosticsTotal = recent.length;
        // Tri par risque (high d'abord) puis timestamp récent
        recent.sort(function(a, b) {
          const ra = a.diagnosis && a.diagnosis.riskLevel === 'high' ? 0 : (a.diagnosis && a.diagnosis.riskLevel === 'medium' ? 1 : 2);
          const rb = b.diagnosis && b.diagnosis.riskLevel === 'high' ? 0 : (b.diagnosis && b.diagnosis.riskLevel === 'medium' ? 1 : 2);
          if (ra !== rb) return ra - rb;
          return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });
        diagnostics = recent.map(function(d) {
          return {
            cause: d.diagnosis && d.diagnosis.cause,
            userMessage: d.diagnosis && d.diagnosis.userMessage,
            riskLevel: d.diagnosis && d.diagnosis.riskLevel,
            target: d.signal && d.signal.target
          };
        });
      }
    } catch (e) {
      console.warn('[digest] fetch incidents fail:', e.message);
    }

    const summary = {
      verified: verified, failed: failed, lowDrive: lowDrive,
      diagnostics: diagnostics, diagnosticsTotal: diagnosticsTotal
    };
    const msg = isMorning
      ? tg.formatDigestMorning(targetDate, summary)
      : tg.formatDigestEvening(targetDate, summary);

    const sent = await sendTelegram(msg);
    if (sent) {
      // Mark flag (idempotent)
      const patch = {};
      patch['digestSent_' + slot] = true;
      patch['digestSent_' + slot + '_at'] = Date.now();
      await fbPatch('zenty/post_verify_results/' + targetDate, patch);
    }

    res.status(200).json({
      ok: true, slot: slot, date: targetDate, sent: sent,
      summary: { verified: verified.length, failed: failed.length, lowDrive: lowDrive.length }
    });
  } catch (e) {
    console.error('[digest] FATAL:', e.message);
    await sendTelegram(tg.formatFatalError('digest', e.message));
    res.status(500).json({ error: true, message: e.message });
  }
};
