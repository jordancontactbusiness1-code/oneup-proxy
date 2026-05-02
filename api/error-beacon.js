// ═══════════════════════════════════════════════════════════════════
//  ZENTY — ERROR BEACON RECEIVER (Vague 3)
//  2026-05-02 nuit
//
//  POURQUOI : js/core/error-beacon.js (browser) capture les errors JS et POST
//  ici. On stocke en Firebase pour analyse + intégrité (alerte si > N errors/h).
//
//  QUOI :
//   - Reçoit JSON { signature, type, message, stack, url, user, timestamp }
//   - Validation light (cap sur tailles, type allowlist)
//   - Rate limit : max 200 errors/jour total Firebase (anti-DOS)
//   - Stockage : zenty/browser_errors/{date}/{signature_timestamp}
//
//  PAS D'AUTH : public POST. Les errors peuvent arriver avant login. La
//  validation + rate limit côté serveur évitent l'abus.
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');

const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';

const MAX_ERRORS_PER_DAY = 200;
const ALLOWED_TYPES      = ['error', 'unhandledrejection'];

const fbAuth = '?auth=' + FIREBASE_SECRET;

async function fbGet(p) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth);
  return r.json();
}
async function fbPatch(p, value) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}
async function fbPut(p, value) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}

function clamp(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

module.exports = async function handler(req, res) {
  // CORS open (le beacon vient du browser)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const body = req.body || {};
    if (!body.message || !body.signature) {
      res.status(400).json({ error: 'message + signature required' });
      return;
    }
    const type = ALLOWED_TYPES.indexOf(body.type) > -1 ? body.type : 'error';

    // Rate limit jour
    const today = new Date().toISOString().split('T')[0];
    const counterRaw = await fbGet('zenty/browser_errors_count/' + today).catch(function() { return 0; });
    const counter = (typeof counterRaw === 'number') ? counterRaw : 0;
    if (counter >= MAX_ERRORS_PER_DAY) {
      // Silently drop (pas une vraie erreur côté client)
      res.status(200).json({ ok: true, dropped: true, reason: 'daily_quota_reached' });
      return;
    }

    // Stockage Firebase (clé = signature_timestamp pour déduplication side-collision)
    const sig = clamp(body.signature, 30);
    const ts = Date.now();
    const key = sig + '_' + ts;
    const entry = {
      timestamp: body.timestamp || new Date().toISOString(),
      type: type,
      signature: sig,
      message: clamp(body.message, 300),
      source: clamp(body.source || '', 200),
      line: parseInt(body.line || 0, 10),
      col: parseInt(body.col || 0, 10),
      stack: clamp(body.stack || '', 800),
      url: clamp(body.url || '', 200),
      userAgent: clamp(body.userAgent || '', 200),
      user: body.user && typeof body.user === 'object' ? {
        username: clamp(body.user.username || '?', 50),
        role: clamp(body.user.role || '?', 30),
        agency: clamp(body.user.agency || '?', 10)
      } : null,
      receivedAt: new Date().toISOString()
    };

    await fbPut('zenty/browser_errors/' + today + '/' + key, entry);
    const counterPatch = {};
    counterPatch[today] = counter + 1;
    await fbPatch('zenty/browser_errors_count', counterPatch);

    res.status(200).json({ ok: true, stored: key });
  } catch (e) {
    console.error('[error-beacon] error:', e.message);
    // Silent : 200 pour pas que le browser logue une 2nd erreur
    res.status(200).json({ ok: false, internal: true });
  }
};
