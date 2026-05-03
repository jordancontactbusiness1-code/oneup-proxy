// ═══════════════════════════════════════════════════════════════════
//  HIGGSFIELD — Queue manager 4 slots avec retry safety filter
//
//  Higgsfield n'autorise PAS plus de 4 générations en parallèle. Cette
//  queue garantit ce maximum tout en autorisant N requêtes simultanées
//  côté API : les requêtes en surplus attendent qu'un slot se libère.
//
//  En plus : retry auto si Higgsfield refuse pour safety filter
//  (décolleté/peau). Jordan a confirmé : en relançant plusieurs fois,
//  ça finit souvent par passer.
// ═══════════════════════════════════════════════════════════════════
'use strict';

const browserLib = require('./higgsfield-browser.js');
const cfg        = require('./higgsfield-selectors.js');

const MAX_PARALLEL = cfg.maxParallel;
const MAX_RETRIES  = cfg.maxRetries;
const RETRY_DELAY  = cfg.retryDelayMs;

// État de la queue (singleton process-wide)
let _activeCount = 0;
const _waiters = []; // [{ resolve, reject }]

function _acquireSlot() {
  return new Promise(function(resolve, reject) {
    if (_activeCount < MAX_PARALLEL) {
      _activeCount++;
      resolve();
    } else {
      _waiters.push({ resolve: resolve, reject: reject });
    }
  });
}

function _releaseSlot() {
  _activeCount = Math.max(0, _activeCount - 1);
  const next = _waiters.shift();
  if (next) {
    _activeCount++;
    next.resolve();
  }
}

function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

// ── API publique ───────────────────────────────────────────────────────
// runGeneration({ refTinaPath, frameReelPath, prompt, outPath, jobId, onAttempt })
// → résout avec { ok:true, path, resultUrl, attempts }
// → rejette avec Error si échec après MAX_RETRIES
//
async function runGeneration(opts) {
  await _acquireSlot();
  try {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (typeof opts.onAttempt === 'function') {
        try { opts.onAttempt(attempt, MAX_RETRIES); } catch (_) {}
      }
      try {
        const r = await browserLib.generateOnePhoto({
          refTinaPath:   opts.refTinaPath,
          frameReelPath: opts.frameReelPath,
          prompt:        opts.prompt,
          outPath:       opts.outPath,
          signal:        opts.signal
        });
        return { ok: true, path: r.path, resultUrl: r.resultUrl, attempts: attempt };
      } catch (e) {
        lastErr = e;
        const isSafety = (e && e.code === 'SAFETY_FILTER') || /safety/i.test(String(e && e.message));
        const isAborted = e && /aborted/i.test(String(e.message));
        if (isAborted) throw e;
        if (isSafety && attempt < MAX_RETRIES) {
          // Retry sur safety filter (Jordan a confirmé que ça repasse souvent)
          console.warn('[higgsfield-queue] safety filter, retry ' + attempt + '/' + MAX_RETRIES);
          await sleep(RETRY_DELAY);
          continue;
        }
        // Autre erreur → on retente quand même (max 2 retries non-safety)
        if (!isSafety && attempt >= 2) throw e;
        console.warn('[higgsfield-queue] tentative ' + attempt + ' échouée:', e.message);
        await sleep(RETRY_DELAY);
      }
    }
    const err = new Error('Échec après ' + MAX_RETRIES + ' tentatives — ' + (lastErr && lastErr.message || 'unknown'));
    err.attempts = MAX_RETRIES;
    err.lastError = lastErr;
    throw err;
  } finally {
    _releaseSlot();
  }
}

// État de la queue (debug / monitoring)
function status() {
  return {
    active:   _activeCount,
    max:      MAX_PARALLEL,
    waiting:  _waiters.length
  };
}

module.exports = {
  runGeneration: runGeneration,
  status:        status
};
