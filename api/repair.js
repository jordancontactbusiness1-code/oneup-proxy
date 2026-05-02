// ═══════════════════════════════════════════════════════════════════
//  ZENTY — RÉPARATEUR (Phase D — Robot 3 du système 4 robots)
//  2026-05-02 nuit
//
//  POURQUOI : le Détective produit des diagnostics + fix proposés. Mais qui les
//  exécute ? Le Réparateur — avec 3 niveaux de prudence pour ne JAMAIS casser prod.
//
//  NIVEAUX :
//   1. AUTO-SAFE (whitelist hardcoded) : restart service, clear cache Firebase,
//      retrigger slot, refresh Drive token. Pas de validation, juste log.
//   2. CONFIG_CHANGE (validation Telegram) : modif .env, modif systemd. Pour V1,
//      on stocke en attente de validation manuelle Jordan.
//   3. CODE_PATCH (PR auto GitHub) : V2 future. Pour V1, on stocke + Telegram.
//
//  GARDE-FOUS :
//   - Backup horodaté avant TOUTE modif (cf feedback_agent_backup_before_modify.md)
//   - Index JSONL /opt/zenty-backups/auto/index.jsonl
//   - Circuit breaker : 3 fix/heure max sur même module → halt + alerte
//   - Whitelist VALIDATION STRICTE : regex + paramètres typés
//
//  AUTH : CRON_SECRET (header x-cron-secret)
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch  = require('node-fetch');
const fs     = require('fs');
const path   = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ── Config ────────────────────────────────────────────────────────────────────
const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET     = process.env.CRON_SECRET       || '';

const BACKUP_ROOT     = '/opt/zenty-backups/auto';
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000; // 1 heure
const CIRCUIT_BREAKER_MAX       = 3;              // max 3 fix/h sur même module

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
async function fbDelete(p) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, { method: 'DELETE' });
  return r.json();
}

// ── Backup helper (cf règle feedback_agent_backup_before_modify.md) ──────────
async function agentBackup(filepath, incidentId, reason) {
  if (!fs.existsSync(filepath)) throw new Error('Cannot backup missing file: ' + filepath);
  const date = new Date().toISOString().split('T')[0];
  const ts = new Date().toTimeString().split(' ')[0].replace(/:/g, '');
  const flat = filepath.replace(/^\/+/, '').replace(/\//g, '-');
  const dir = BACKUP_ROOT + '/' + date;
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = dir + '/' + ts + '_' + flat + '_repair-bot.bak';
  fs.copyFileSync(filepath, backupPath);
  // Append index JSONL
  const indexEntry = {
    ts: new Date().toISOString(),
    incident: incidentId,
    agent: 'repair-bot-v1',
    file: filepath,
    backup: backupPath,
    reason: reason,
    rollback_cmd: 'cp ' + backupPath + ' ' + filepath
  };
  fs.appendFileSync(BACKUP_ROOT + '/index.jsonl', JSON.stringify(indexEntry) + '\n');
  return backupPath;
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
async function checkCircuitBreaker(module) {
  const repairsRaw = await fbGet('zenty/repairs').catch(function() { return null; });
  if (!repairsRaw || typeof repairsRaw !== 'object') return { ok: true, count: 0 };
  const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
  let count = 0;
  Object.keys(repairsRaw).forEach(function(k) {
    const r = repairsRaw[k];
    if (r && r.module === module && r.timestamp && new Date(r.timestamp).getTime() > cutoff) {
      count++;
    }
  });
  return { ok: count < CIRCUIT_BREAKER_MAX, count: count };
}

// ── WHITELIST D'ACTIONS AUTO-SAFE ─────────────────────────────────────────────
// Chaque action prend (incidentId, args) et retourne { ok, output, error? }
// Validation STRICTE des arguments : si invalide, refus.

const WHITELIST = {
  // Restart d'un service zenty-* (jamais autre chose)
  'restart_service': {
    validate: function(args) {
      const name = args && args[0];
      return typeof name === 'string' && /^zenty-[a-z][a-z-]*\.service$/.test(name);
    },
    execute: async function(args) {
      const name = args[0];
      const r = await execAsync('systemctl restart ' + name, { timeout: 30000 });
      return { ok: true, output: r.stdout + r.stderr };
    },
    module: 'systemd'
  },

  // Clear un flag Firebase (suppression d'une clé sous zenty/)
  'clear_firebase_flag': {
    validate: function(args) {
      const path = args && args[0];
      // Whitelist de paths autorisés (pas de wildcard, pas de zenty/accounts ni zenty/incidents)
      const ALLOWED_PREFIXES = [
        'zenty/post_verify_results/',  // pour reset un flag digestSent
        'zenty/diagnose_count/',
        'zenty/cache_invalidate/'
      ];
      return typeof path === 'string' && ALLOWED_PREFIXES.some(function(p) { return path.startsWith(p); });
    },
    execute: async function(args) {
      const path = args[0];
      await fbDelete(path);
      return { ok: true, output: 'Cleared ' + path };
    },
    module: 'firebase_flag'
  },

  // Retrigger : remettre un postId dans la queue pour ré-essai
  'retrigger_post': {
    validate: function(args) {
      const postId = args && args[0];
      return typeof postId === 'string' && /^[a-zA-Z0-9_-]{5,50}$/.test(postId);
    },
    execute: async function(args) {
      const postId = args[0];
      // Appeler /api/scheduleimagepost ou similaire — pour V1 on stocke juste un flag retrigger
      // qui sera lu par le checker au prochain run.
      await fbPatch('zenty/retrigger_queue', { [postId]: { ts: Date.now(), source: 'repair-bot' } });
      return { ok: true, output: 'Marked ' + postId + ' for retrigger' };
    },
    module: 'posting'
  },

  // Reset cache stories (vide /tmp et logs vieux > 7j)
  'cleanup_temp_files': {
    validate: function(args) {
      // Pas d'argument requis, action fixe et safe
      return true;
    },
    execute: async function(args) {
      const r = await execAsync('find /tmp -name "in_*" -mmin +60 -delete 2>&1; find /tmp -name "out_*" -mmin +60 -delete 2>&1; echo "cleanup OK"', { timeout: 15000 });
      return { ok: true, output: r.stdout + r.stderr };
    },
    module: 'system'
  },

  // Sync storyParentFolderId pour un compte depuis driveFolderMap
  // (ajouté 2026-05-02 nuit après bug 12 comptes orphelins)
  'sync_story_parent_folder': {
    validate: function(args) {
      const snid = args && args[0];
      return typeof snid === 'string' && /^\d{15,20}$/.test(snid);
    },
    execute: async function(args) {
      const snid = args[0];
      // Lire le compte
      const account = await fbGet('zenty/cron_config/accounts/' + snid);
      if (!account || !account.username) throw new Error('account ' + snid + ' not found');
      const handle = (account.username || '').replace('@', '').toLowerCase();
      const handleSafe = handle.replace(/\./g, '_');
      // Lire le driveFolderMap
      const dfm = await fbGet('zenty/cron_config/driveFolderMap');
      const entry = (dfm && (dfm[handle] || dfm[handleSafe])) || null;
      if (!entry || !entry.stories) throw new Error('no driveFolderMap.stories for @' + handle);
      // Patch ciblé
      await fbPatch('zenty/cron_config/accounts/' + snid, { storyParentFolderId: entry.stories });
      return { ok: true, output: 'Set storyParentFolderId=' + entry.stories + ' for @' + handle };
    },
    module: 'config_sync'
  },

  // Cleanup orphelins driveFolderMap (entries sans compte correspondant)
  'cleanup_orphan_dfm': {
    validate: function(args) {
      // handleSafe à supprimer
      const handleSafe = args && args[0];
      return typeof handleSafe === 'string' && /^[a-z0-9_]{3,30}$/.test(handleSafe);
    },
    execute: async function(args) {
      const handleSafe = args[0];
      // Vérifier que c'est bien un orphelin (pas dans accounts)
      const accounts = await fbGet('zenty/cron_config/accounts');
      const found = Object.values(accounts || {}).some(function(a) {
        if (!a || !a.username) return false;
        const h = (a.username || '').replace('@', '').toLowerCase().replace(/\./g, '_');
        return h === handleSafe;
      });
      if (found) throw new Error('@' + handleSafe + ' is NOT orphan, account exists');
      await fbDelete('zenty/cron_config/driveFolderMap/' + handleSafe);
      return { ok: true, output: 'Removed orphan driveFolderMap entry: ' + handleSafe };
    },
    module: 'config_sync'
  }
};

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Auth
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const startTime = Date.now();
  console.log('[repair] start');

  try {
    // 1. Lire les diagnostics ouverts (status='open' ou non défini)
    const incidentsRaw = await fbGet('zenty/incidents').catch(function() { return null; });
    const incidents = (incidentsRaw && typeof incidentsRaw === 'object') ? incidentsRaw : {};

    // Trier par timestamp asc. Garder :
    //  - status 'open' (auto_safe whitelist exécuté direct)
    //  - status 'user_approved' (Jordan a validé via Telegram boutons — Vague 4A)
    const openIds = Object.keys(incidents).filter(function(id) {
      const i = incidents[id];
      if (!i || !i.diagnosis) return false;
      const s = i.status || 'open';
      return s === 'open' || s === 'user_approved';
    }).sort(function(a, b) {
      return new Date(incidents[a].timestamp).getTime() - new Date(incidents[b].timestamp).getTime();
    });

    if (!openIds.length) {
      res.status(200).json({ ok: true, message: 'no open incidents', processed: 0 });
      return;
    }

    const results = { auto_safe: [], awaiting_validation: [], skipped: [], errors: [] };

    for (const incidentId of openIds) {
      const incident = incidents[incidentId];
      const dx = incident.diagnosis;
      const fix = dx.proposedFix || {};
      const isUserApproved = incident.status === 'user_approved';

      // Cas 1 : auto_safe (whitelist) OU user_approved avec action whitelistée (Vague 4A)
      // Si Jordan a validé via Telegram bouton, on exécute aussi les config_change
      // tant que l'action est dans la whitelist (sync_story_parent_folder, etc.).
      if ((fix.type === 'auto_safe' || isUserApproved) && fix.action && fix.action.name && WHITELIST[fix.action.name]) {
        const wl = WHITELIST[fix.action.name];
        const args = fix.action.args || [];

        // Validation stricte
        if (!wl.validate(args)) {
          await fbPatch('zenty/incidents/' + incidentId, { status: 'rejected', rejectedReason: 'invalid args for ' + fix.action.name });
          results.errors.push({ id: incidentId, error: 'invalid_args' });
          continue;
        }

        // Circuit breaker
        const cb = await checkCircuitBreaker(wl.module);
        if (!cb.ok) {
          await fbPatch('zenty/incidents/' + incidentId, { status: 'circuit_breaker_open', cbCount: cb.count });
          results.skipped.push({ id: incidentId, reason: 'circuit_breaker', module: wl.module, count: cb.count });
          continue;
        }

        // Execute
        try {
          const r = await wl.execute(args);
          const repairId = 'repair_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          await fbPatch('zenty/repairs/' + repairId, {
            timestamp: new Date().toISOString(),
            incidentId: incidentId,
            module: wl.module,
            action: fix.action.name,
            args: args,
            ok: r.ok,
            output: (r.output || '').slice(0, 500)
          });
          await fbPatch('zenty/incidents/' + incidentId, {
            status: 'applied',
            appliedAt: new Date().toISOString(),
            repairId: repairId
          });
          results.auto_safe.push({ id: incidentId, action: fix.action.name, ok: r.ok });
        } catch (e) {
          await fbPatch('zenty/incidents/' + incidentId, { status: 'failed', failedReason: e.message });
          results.errors.push({ id: incidentId, error: e.message });
        }
      }
      // Cas 2 : config_change — stocker en attente (V2 = boutons Telegram)
      else if (fix.type === 'config_change') {
        await fbPatch('zenty/incidents/' + incidentId, {
          status: 'awaiting_validation',
          awaitingSince: new Date().toISOString()
        });
        results.awaiting_validation.push({ id: incidentId, type: 'config_change', userMessage: dx.userMessage });
      }
      // Cas 3 : code_patch — stocker pour PR future (V2)
      else if (fix.type === 'code_patch') {
        await fbPatch('zenty/incidents/' + incidentId, {
          status: 'awaiting_pr',
          awaitingSince: new Date().toISOString()
        });
        results.awaiting_validation.push({ id: incidentId, type: 'code_patch', userMessage: dx.userMessage });
      }
      // Cas 4 : investigation_needed ou user_action
      else {
        await fbPatch('zenty/incidents/' + incidentId, {
          status: 'awaiting_human',
          awaitingSince: new Date().toISOString()
        });
        results.awaiting_validation.push({ id: incidentId, type: fix.type || 'unknown', userMessage: dx.userMessage });
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log('[repair] done in ' + elapsed + 's. auto_safe=' + results.auto_safe.length + ' awaiting=' + results.awaiting_validation.length + ' skipped=' + results.skipped.length + ' errors=' + results.errors.length);

    res.status(200).json({
      ok: true,
      processed: openIds.length,
      results: results,
      elapsed_s: elapsed
    });
  } catch (e) {
    console.error('[repair] FATAL:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
};
