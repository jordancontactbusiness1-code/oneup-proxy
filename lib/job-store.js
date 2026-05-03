// ═══════════════════════════════════════════════════════════════════
//  JOB STORE — map jobId → fichiers locaux temporaires (in-memory + TTL)
//
//  Permet de garder le path local de la frame extraite et de la photo
//  générée entre 2 requêtes HTTP (extract → generate → save-validated)
//  sans repasser tout le contenu en base64 dans le body chaque fois.
//
//  TTL automatique : un job est purgé du store + fichiers supprimés
//  au bout de 30 min sans activité.
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');

const TTL_MS = 30 * 60 * 1000;  // 30 min
const _store = new Map();        // jobId → { framePath, mp4Path, photoPath, lastTouch }

function _now() { return Date.now(); }

function _purge() {
  const cutoff = _now() - TTL_MS;
  for (const [id, rec] of _store.entries()) {
    if (rec.lastTouch < cutoff) {
      cleanup(id);
    }
  }
}

// Purge périodique (toutes les 5 min)
setInterval(_purge, 5 * 60 * 1000).unref?.();

// ── API ──────────────────────────────────────────────────────────────
function set(jobId, fields) {
  if (!jobId) return;
  const cur = _store.get(jobId) || {};
  const next = Object.assign({}, cur, fields, { lastTouch: _now() });
  _store.set(jobId, next);
}

function get(jobId) {
  if (!jobId) return null;
  const rec = _store.get(jobId);
  if (rec) rec.lastTouch = _now();
  return rec || null;
}

function has(jobId) {
  return _store.has(jobId);
}

function cleanup(jobId) {
  const rec = _store.get(jobId);
  if (!rec) return;
  for (const k of ['framePath', 'mp4Path', 'photoPath', 'refPath']) {
    const p = rec[k];
    if (p) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
  _store.delete(jobId);
}

function size() { return _store.size; }

module.exports = { set, get, has, cleanup, size };
