// ═══════════════════════════════════════════════════════════════════
//  ZENTY — ARCHIVISTE (Phase E — Robot 4 du système 4 robots)
//  2026-05-02 nuit
//
//  POURQUOI : sans mémoire, le système re-diagnostique les mêmes incidents
//  jour après jour → gaspillage tokens + Jordan revoit les mêmes alertes.
//  L'Archiviste transforme les incidents récurrents en LEÇONS définitives.
//
//  QUOI : tourne 1×/jour à 23h Paris.
//   1. Lit zenty/incidents (tous les statuts, dernier 7 jours)
//   2. Groupe par signature
//   3. Si même signature × 3+ fois en 7 jours → PATTERN RÉCURRENT → leçon
//   4. Stocke dans zenty/lessons/{slug} :
//      - description courte
//      - signatureMatch (pour future dédup intelligente du Détective)
//      - cause confirmée
//      - fix recommandé (manuel ou auto)
//      - count + dernière occurrence
//   5. Marque les incidents matchés comme 'archived'
//   6. Optionnel : append au digest soir (1 ligne par leçon nouvelle)
//
//  V2 future : sync vers ~/.claude/projects/.../memory/ via GitHub
//
//  AUTH : CRON_SECRET (header x-cron-secret)
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');

// ── Config ────────────────────────────────────────────────────────────────────
const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET     = process.env.CRON_SECRET       || '';

const PATTERN_THRESHOLD = 3;                         // 3+ occurrences = pattern récurrent
const LOOKBACK_MS       = 7 * 24 * 60 * 60 * 1000;   // 7 jours
const ARCHIVE_OLDER_MS  = 30 * 24 * 60 * 60 * 1000;  // 30 jours d'archives max

// ── Firebase helpers ─────────────────────────────────────────────────────────
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
async function fbDelete(p) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, { method: 'DELETE' });
  return r.json();
}

// ── Slugify (signature → slug lisible) ───────────────────────────────────────
function slugify(text) {
  return (text || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const startTime = Date.now();
  console.log('[archive] start');

  try {
    // 1. Lire tous les incidents
    const incidentsRaw = await fbGet('zenty/incidents').catch(function() { return null; });
    if (!incidentsRaw || typeof incidentsRaw !== 'object') {
      res.status(200).json({ ok: true, message: 'no incidents to archive', processed: 0 });
      return;
    }

    const cutoff = Date.now() - LOOKBACK_MS;
    const archiveCutoff = Date.now() - ARCHIVE_OLDER_MS;

    // 2. Grouper par signature
    const bySignature = {};
    const tooOld = [];
    Object.keys(incidentsRaw).forEach(function(id) {
      const i = incidentsRaw[id];
      if (!i || !i.signature || !i.timestamp) return;
      const ts = new Date(i.timestamp).getTime();
      if (ts < archiveCutoff) {
        tooOld.push(id);
        return;
      }
      if (ts < cutoff) return;
      if (!bySignature[i.signature]) bySignature[i.signature] = [];
      bySignature[i.signature].push({ id: id, ...i });
    });

    // 3. Lire leçons existantes (pour mise à jour count)
    const existingLessons = await fbGet('zenty/lessons').catch(function() { return null; }) || {};

    // 4. Détecter patterns récurrents
    const newLessons = [];
    const updatedLessons = [];

    for (const sig of Object.keys(bySignature)) {
      const occurrences = bySignature[sig];
      if (occurrences.length < PATTERN_THRESHOLD) continue;

      // Référence = première occurrence (la plus ancienne du groupe)
      occurrences.sort(function(a, b) { return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(); });
      const first = occurrences[0];
      const last  = occurrences[occurrences.length - 1];

      // Construire la leçon
      const cause   = (first.diagnosis && first.diagnosis.cause) || 'Pattern non identifié';
      const fix     = (first.diagnosis && first.diagnosis.proposedFix) || {};
      const target  = (first.signal && first.signal.target) || 'unknown';
      const slug    = slugify(target + '-' + cause).slice(0, 80);

      const lessonKey = sig.slice(0, 8) + '_' + slug;
      const existing = existingLessons[lessonKey];

      const lesson = {
        signature: sig,
        slug: slug,
        cause: cause,
        target: target,
        category: (first.diagnosis && first.diagnosis.category) || 'unknown',
        recommendedFix: {
          type: fix.type,
          description: fix.description,
          steps: fix.steps || [],
          rollback: fix.rollback
        },
        count: occurrences.length + (existing ? (existing.count || 0) : 0),
        firstSeen: existing ? existing.firstSeen : first.timestamp,
        lastSeen: last.timestamp,
        riskLevel: (first.diagnosis && first.diagnosis.riskLevel) || 'medium',
        userMessage: (first.diagnosis && first.diagnosis.userMessage) || cause,
        updatedAt: new Date().toISOString()
      };

      await fbPut('zenty/lessons/' + lessonKey, lesson);

      if (existing) {
        updatedLessons.push({ slug: slug, count: lesson.count, target: target });
      } else {
        newLessons.push({ slug: slug, count: lesson.count, target: target, cause: cause });
      }

      // Marquer les incidents comme archivés
      const archivePatch = {};
      occurrences.forEach(function(o) {
        archivePatch[o.id + '/status'] = 'archived';
        archivePatch[o.id + '/lessonKey'] = lessonKey;
      });
      await fbPatch('zenty/incidents', archivePatch);
    }

    // 5. Cleanup incidents > 30 jours
    if (tooOld.length) {
      const delPatch = {};
      tooOld.forEach(function(id) { delPatch[id] = null; });
      await fbPatch('zenty/incidents', delPatch);
      console.log('[archive] purged ' + tooOld.length + ' incidents > 30j');
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log('[archive] done in ' + elapsed + 's. newLessons=' + newLessons.length + ' updated=' + updatedLessons.length + ' purged=' + tooOld.length);

    res.status(200).json({
      ok: true,
      newLessons: newLessons,
      updatedLessons: updatedLessons,
      purgedOldIncidents: tooOld.length,
      elapsed_s: elapsed
    });
  } catch (e) {
    console.error('[archive] FATAL:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
};
