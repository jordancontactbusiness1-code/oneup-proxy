// ═══════════════════════════════════════════════════════════════════
//  ZENTY — DÉTECTIVE IA (Phase C — Robot 2 du système 4 robots)
//  2026-05-02 nuit
//
//  POURQUOI : verify et supervisor détectent les SYMPTÔMES (post raté, service KO).
//  Mais comprendre POURQUOI demande analyse logs + code + contexte. Sans ça,
//  Jordan doit tout investiguer à la main. À 50 comptes, impossible.
//
//  QUOI : appelé toutes les 30 min par zenty-diagnose.timer.
//   1. Lit signaux récents (health_checks failed + post_verify_results.failed)
//   2. Dédup signature 24h (1 même cause = 1 diagnostic max)
//   3. Pour chaque NOUVEAU incident :
//      - Récupère logs journalctl pertinents
//      - Appel Claude haiku (cheap) avec prompt système caché → 90% économie
//      - Parse output JSON strict (cause, fix proposé, niveau de risque)
//      - Stocke dans Firebase zenty/incidents/{id}
//   4. Rate limit : max 10 diagnostics/jour (hard cap budget Anthropic)
//   5. PAS de Telegram immédiat (le digest soir agrège). Sauf critique → optionnel.
//
//  COÛT : haiku-4-5, prompt cached. Estimé ~$0.5/mois pour 10 incidents/jour.
//  AUTH : CRON_SECRET (header x-cron-secret)
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch  = require('node-fetch');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ── Config ────────────────────────────────────────────────────────────────────
const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET     = process.env.CRON_SECRET       || '';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';

const MAX_INCIDENTS_PER_DAY = 10;     // hard cap budget Anthropic (~5€/mois max)
const DEDUP_WINDOW_MS       = 24 * 60 * 60 * 1000;
const MODEL                 = 'claude-haiku-4-5-20251001';

// ── System prompt (caché — économie 90% des tokens) ──────────────────────────
const SYSTEM_PROMPT = `Tu es le Détective du dashboard Zenty — système OFM Instagram (Tina FR, 4-50 comptes auto-postés).

ARCHITECTURE :
- Frontend vanilla HTML/JS modulaire (~110 fichiers atomiques, max 300L/fichier)
- Backend Express/Postgres VPS Hostinger (port 3100, route via Caddy)
- Services systemd : zenty-{checker:15min, verify:30min, supervisor:1h, cron:01h, backup:04h30, digest-morning:09h, digest-evening:21h}
- Firebase Realtime DB miroir, Drive = vérité physique, OneUp = scheduler IG

RÈGLES ABSOLUES PROJET (ne JAMAIS contourner) :
1. Drive = vérité physique : posted/ = POSTED, autre dossier = PENDING
2. Firebase = miroir : .update({[id]: data}) ciblé, jamais .set() global
3. Soft-delete corbeille 30j obligatoire (pas de hard-delete comptes)
4. Timezone Europe/Paris explicite, jamais new Date() brut pour scheduling
5. Stories OneUp : isStory=true uniquement avec mp4 (jamais image directe — 50% partent sur grille feed)
6. Fichier max 300 lignes — au-delà, splitter
7. Backup horodaté obligatoire avant toute modif par agent (cf /opt/zenty-backups/auto/)

PIÈGES RÉCURRENTS DOCUMENTÉS :
- Apostrophes françaises dans strings JS → SyntaxError
- Drive trailing slash : toujours .replace(/\\/$/, '')
- Firebase dotted keys : sanitiser . en _ (ex tina.dolcezza → tina_dolcezza)
- DM Mono dans onclick inline : escHtml encode ' en &#39; → SyntaxError
- OneUp scheduledposts sans champ instagram → registry zenty/post_type_map obligatoire
- Cron daily-trigger 21/04 : 50 posts en 8 min car slot dans le passé (isSlotFutureFullParis)

TON RÔLE :
Diagnostiquer un incident. Output STRICTEMENT JSON, RIEN D'AUTRE (pas de markdown, pas de prose) :
{
  "cause": "phrase courte concrète (français)",
  "confidence": 0.0-1.0,
  "category": "code_bug|config|external_api|infra|data|user_action_needed",
  "affectedFiles": ["chemins relatifs si pertinent, sinon []"],
  "proposedFix": {
    "type": "auto_safe|config_change|code_patch|investigation_needed|user_action",
    "action": null,
    "description": "français concret, dit ce qu'il faut faire",
    "steps": ["étape 1", "étape 2"],
    "rollback": "comment annuler en français"
  },
  "riskLevel": "low|medium|high",
  "validationRequired": true|false,
  "userMessage": "1 ligne très courte pour Telegram à Jordan (français, pas jargon)"
}

ACTIONS WHITELISTÉES (utiliser proposedFix.action UNIQUEMENT si type="auto_safe") :
- restart_service : args=["zenty-NAME.service"]. Pour redémarrer un service systemd zenty.
- clear_firebase_flag : args=["zenty/path/sub/flag"]. Pour reset un flag idempotence (digestSent_*, diagnose_count, cache_invalidate).
- retrigger_post : args=["postId"]. Pour mettre un postId raté en file de re-essai.
- cleanup_temp_files : args=[]. Pour vider les fichiers /tmp/in_* /tmp/out_* > 1h.

Si l'action ne matche AUCUN nom whitelisté → laisse action=null et type="config_change" ou "user_action".

CONTRAINTES :
- Si tu manques de contexte : type="investigation_needed", description="J'ai besoin de [X]"
- riskLevel="high" UNIQUEMENT si risque réel pour la prod (perte data, downtime)
- userMessage doit être lisible par non-dev (pas "endpoint", "stack trace", "regression")
- Si le souci vient d'une API externe en panne (ex: OneUp 502 transient): type="auto_safe", action=null, confidence basse, description="probablement transient, monitoring continue"`;

// ── Firebase helpers ─────────────────────────────────────────────────────────
const fbAuth = '?auth=' + FIREBASE_SECRET;
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
async function fbPut(path, value) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return r.json();
}

// ── Signature dedup (16 chars md5) ───────────────────────────────────────────
function signatureOf(incident) {
  const key = (incident.category || '') + '|' + (incident.target || '') + '|' + (incident.errorHint || '').slice(0, 100);
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 16);
}

// ── Logs journalctl (5 min récents pour le service) ──────────────────────────
async function getLogsForService(serviceName, lines) {
  lines = lines || 30;
  try {
    const cmd = 'journalctl -u zenty-' + serviceName + '.service --since="5 minutes ago" --no-pager 2>&1 | tail -n ' + lines;
    const r = await execAsync(cmd, { timeout: 10000 });
    return (r.stdout || '').trim() || '(no recent logs)';
  } catch (e) {
    return '(failed to fetch logs: ' + e.message + ')';
  }
}

// ── Gather incidents from current signals ────────────────────────────────────
async function gatherIncidents() {
  const incidents = [];
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // 1. Health checks (last 2 hours UTC)
  const healthChecks = await fbGet('zenty/health_checks/' + today).catch(function() { return null; });
  if (healthChecks && typeof healthChecks === 'object') {
    const hours = Object.keys(healthChecks).sort().slice(-2);
    hours.forEach(function(hour) {
      const hc = healthChecks[hour];
      if (hc && hc.allOk === false && Array.isArray(hc.checks)) {
        hc.checks.filter(function(c) { return !c.ok; }).forEach(function(failed) {
          incidents.push({
            id: 'health-' + today + '-' + hour + '-' + failed.name,
            category: 'external_api_or_infra',
            target: failed.name,
            errorHint: failed.error || ('status_' + (failed.status || 'unknown')),
            source: 'supervisor',
            timestamp: hc.timestamp || now.toISOString(),
            details: failed
          });
        });
      }
    });
  }

  // 2. Posting failures (today)
  const verifyResults = await fbGet('zenty/post_verify_results/' + today).catch(function() { return null; });
  if (verifyResults && Array.isArray(verifyResults.failed)) {
    verifyResults.failed.forEach(function(f) {
      incidents.push({
        id: 'post-' + (f.postId || '?'),
        category: 'posting',
        target: '@' + (f.account || '?') + '/' + (f.contentType || '?'),
        errorHint: f.oneupReason || f.reason || 'unknown',
        source: 'verify',
        timestamp: f.failedAt || now.toISOString(),
        details: { reason: f.reason, oneupReason: f.oneupReason, rollback: f.rollback }
      });
    });
  }

  return incidents;
}

// ── Claude API call (with prompt cache) ──────────────────────────────────────
async function diagnoseWithClaude(incident, logs) {
  const userMsg = 'INCIDENT:\n' + JSON.stringify(incident, null, 2) +
                  '\n\nLOGS RÉCENTS (5 min):\n' + (logs || '(no logs)') +
                  '\n\nDiagnostique. Output JSON strict UNIQUEMENT.';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: [{
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{ role: 'user', content: userMsg }]
    })
  });

  const data = await r.json();
  if (data.error) {
    throw new Error('Claude API: ' + (data.error.message || JSON.stringify(data.error)));
  }

  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Claude output: ' + text.slice(0, 200));

  let diagnosis;
  try { diagnosis = JSON.parse(match[0]); }
  catch (e) { throw new Error('Claude JSON parse failed: ' + e.message); }

  return {
    diagnosis: diagnosis,
    usage: data.usage || {}
  };
}

// ── Cost estimate (haiku-4-5 pricing) ────────────────────────────────────────
function estimateCost(usage) {
  // haiku-4-5 prices : $1.00 / M input, $5.00 / M output, $0.10 / M cached read
  const inputUncached = (usage.input_tokens || 0) - (usage.cache_read_input_tokens || 0);
  const cached        = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const output        = usage.output_tokens || 0;
  const cost = (inputUncached * 1.00 + cached * 0.10 + cacheCreation * 1.25 + output * 5.00) / 1000000;
  return cost;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Auth
  const secret = (req.headers && (req.headers['x-cron-secret'] || req.headers['authorization'])) || (req.query && req.query.secret) || '';
  if (CRON_SECRET && secret !== CRON_SECRET && secret !== 'Bearer ' + CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!ANTHROPIC_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY missing on backend' });
    return;
  }

  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  console.log('[diagnose] start ' + today);

  try {
    // 1. Rate limit check
    const counterRaw = await fbGet('zenty/diagnose_count/' + today).catch(function() { return 0; });
    const counter = (typeof counterRaw === 'number') ? counterRaw : 0;
    if (counter >= MAX_INCIDENTS_PER_DAY) {
      console.log('[diagnose] rate limit ' + counter + '/' + MAX_INCIDENTS_PER_DAY + ' for ' + today);
      res.status(200).json({ ok: true, skipped: true, reason: 'rate_limit', counter: counter });
      return;
    }

    // 2. Gather signals
    const incidents = await gatherIncidents();
    if (!incidents.length) {
      res.status(200).json({ ok: true, processed: 0, message: 'no incidents' });
      return;
    }

    // 3. Dedup against existing diagnoses (24h window)
    const existingDiagnoses = await fbGet('zenty/incidents').catch(function() { return null; }) || {};
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    const existingSigs = new Set();
    Object.keys(existingDiagnoses).forEach(function(k) {
      const d = existingDiagnoses[k];
      if (d && d.timestamp && new Date(d.timestamp).getTime() > cutoff) {
        existingSigs.add(d.signature);
      }
    });

    const newIncidents = incidents.filter(function(i) { return !existingSigs.has(signatureOf(i)); });
    if (!newIncidents.length) {
      console.log('[diagnose] all ' + incidents.length + ' already diagnosed in last 24h');
      res.status(200).json({ ok: true, processed: 0, message: 'all already diagnosed', total: incidents.length });
      return;
    }

    // 4. Process up to remaining quota
    const remaining = MAX_INCIDENTS_PER_DAY - counter;
    const toProcess = newIncidents.slice(0, remaining);
    console.log('[diagnose] processing ' + toProcess.length + ' / ' + newIncidents.length + ' new (remaining quota: ' + remaining + ')');

    const results = [];
    let totalCost = 0;
    const totalUsage = { input: 0, output: 0, cached: 0, cache_creation: 0 };

    for (let i = 0; i < toProcess.length; i++) {
      const incident = toProcess[i];
      try {
        // Get logs from the source service
        const serviceName = incident.source === 'supervisor' ? 'supervisor' : (incident.source === 'verify' ? 'verify' : 'backend');
        const logs = await getLogsForService(serviceName, 25);

        // Claude call
        const { diagnosis, usage } = await diagnoseWithClaude(incident, logs);

        // Compute signature + persistent ID
        const sig = signatureOf(incident);
        const incidentId = sig + '_' + Date.now();

        // Store in Firebase
        const stored = {
          signature: sig,
          timestamp: new Date().toISOString(),
          signal: incident,
          diagnosis: diagnosis,
          usage: usage,
          status: 'open',
          model: MODEL
        };
        await fbPut('zenty/incidents/' + incidentId, stored);

        const cost = estimateCost(usage);
        totalCost += cost;
        totalUsage.input += usage.input_tokens || 0;
        totalUsage.output += usage.output_tokens || 0;
        totalUsage.cached += usage.cache_read_input_tokens || 0;
        totalUsage.cache_creation += usage.cache_creation_input_tokens || 0;

        results.push({
          id: incidentId,
          target: incident.target,
          cause: diagnosis.cause,
          riskLevel: diagnosis.riskLevel,
          fixType: diagnosis.proposedFix && diagnosis.proposedFix.type,
          costUsd: cost.toFixed(5)
        });
      } catch (e) {
        console.error('[diagnose] error on incident ' + incident.id + ':', e.message);
        results.push({ id: incident.id, error: e.message });
      }
    }

    // 5. Update counter
    const counterPatch = {};
    counterPatch[today] = counter + results.filter(function(r) { return !r.error; }).length;
    await fbPatch('zenty/diagnose_count', counterPatch);

    // 6. Track monthly cost (for budget monitoring)
    const monthKey = today.slice(0, 7); // YYYY-MM
    const monthCost = await fbGet('zenty/diagnose_cost/' + monthKey).catch(function() { return 0; });
    const newMonthCost = (typeof monthCost === 'number' ? monthCost : 0) + totalCost;
    const monthPatch = {};
    monthPatch[monthKey] = Math.round(newMonthCost * 100000) / 100000; // 5 decimals
    await fbPatch('zenty/diagnose_cost', monthPatch);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log('[diagnose] done in ' + elapsed + 's. Processed=' + results.length + '. Cost=$' + totalCost.toFixed(4) + '. Month total=$' + newMonthCost.toFixed(4));

    res.status(200).json({
      ok: true,
      processed: results.length,
      skipped: newIncidents.length - results.length,
      results: results,
      usage: totalUsage,
      costUsd: totalCost.toFixed(5),
      monthCostUsd: newMonthCost.toFixed(5),
      elapsed_s: elapsed,
      remaining_quota_today: MAX_INCIDENTS_PER_DAY - (counter + results.filter(function(r) { return !r.error; }).length)
    });
  } catch (e) {
    console.error('[diagnose] FATAL:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
};
