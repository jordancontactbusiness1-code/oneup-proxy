// ═══════════════════════════════════════════════════════════════════
//  ZENTY — TELEGRAM FORMATTERS (cs-senior-engineer 2026-05-02)
//
//  Tous les messages Telegram envoyés depuis le VPS passent par ce module.
//  Garantit langage métier (pas dev), esthétique cohérente, brevity.
//
//  Règles de style :
//   - Français, court, direct
//   - 1 emoji par section maximum (✅ ❌ ⚠️ 🚨 🌙 ☀️ 🧹 ⏸ 📦)
//   - Pas de jargon (pas de post_id, oneup_failed, timeout_2h, verified=N)
//   - Listes à puces pour scan rapide
//   - Action concrète à la fin si besoin ("→ ...")
//
//  Pour appel : require('./_telegram-format.js').<fnName>(data)
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');

const TG_TOKEN = process.env.TG_TOKEN || '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const TG_CHAT  = process.env.TG_CHAT  || '6646462254';

// ── Send helper (silent fail, jamais bloquant) ────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text, parse_mode: 'Markdown', disable_web_page_preview: true })
    });
    const d = await r.json();
    return !!(d && d.ok);
  } catch (e) { return false; }
}

// ── Formatters de date ────────────────────────────────────────────────────────
const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avril', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function fmtDate(yyyymmdd) {
  // "2026-05-02" → "2 mai"
  const p = (yyyymmdd || '').split('-');
  if (p.length !== 3) return yyyymmdd;
  const day   = parseInt(p[2], 10);
  const month = MONTHS_FR[parseInt(p[1], 10) - 1] || '';
  return day + ' ' + month;
}

function fmtType(t) {
  if (t === 'reels')    return 'reel';
  if (t === 'stories')  return 'story';
  if (t === 'carousel') return 'carrousel';
  return t || 'post';
}

function fmtTime(scheduledAt) {
  // "2026-05-02 12:30" → "12h30"
  if (!scheduledAt) return '';
  const m = String(scheduledAt).match(/(\d{2}):(\d{2})/);
  return m ? (m[1] + 'h' + m[2]) : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ALERTE POSTS RATÉS — appelé par verify.js après chaque run si nouveaux fails
// ─────────────────────────────────────────────────────────────────────────────
function formatFailAlert(failedItems) {
  if (!failedItems || !failedItems.length) return null;
  const byAcc = {};
  failedItems.forEach(function(f) {
    const acc = f.account || '?';
    if (!byAcc[acc]) byAcc[acc] = [];
    byAcc[acc].push({
      type:        fmtType(f.contentType),
      time:        fmtTime(f.scheduledAt),
      oneupReason: f.oneupReason || ''  // Refonte 2026-05-02 : afficher cause OneUp si dispo
    });
  });
  const lines = [];
  lines.push('⚠️ *' + failedItems.length + ' post' + (failedItems.length > 1 ? 's' : '') + ' raté' + (failedItems.length > 1 ? 's' : '') + '*');
  lines.push('');
  Object.keys(byAcc).slice(0, 10).forEach(function(acc) {
    const items = byAcc[acc].map(function(i) {
      const base = i.type + (i.time ? ' ' + i.time : '');
      // Si OneUp donne une raison (ex: "Authentication failed", "Aspect ratio invalid"), l'inclure tronquée
      if (i.oneupReason) {
        const reason = i.oneupReason.length > 50 ? i.oneupReason.slice(0, 47) + '…' : i.oneupReason;
        return base + ' — ' + reason;
      }
      return base;
    });
    lines.push('• @' + acc + ' — ' + items.join(' · '));
  });
  if (Object.keys(byAcc).length > 10) lines.push('… +' + (Object.keys(byAcc).length - 10) + ' autres');
  // Rollback Drive : on ne mentionne que si problème (sinon Jordan pas besoin de savoir)
  const rollbackKo = failedItems.filter(function(f) { return f.rollback && f.rollback.ok === false; }).length;
  lines.push('');
  if (rollbackKo > 0) {
    lines.push('⚠️ ' + rollbackKo + ' fichier' + (rollbackKo > 1 ? 's' : '') + ' Drive coincé' + (rollbackKo > 1 ? 's' : '') + ' dans posted/ — vérif manuelle');
  } else {
    lines.push('Fichiers Drive remis automatiquement.');
  }
  lines.push('');
  lines.push('→ Détails dans le dashboard · cloche');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DIGEST MATIN — bilan veille (J-1)
// ─────────────────────────────────────────────────────────────────────────────
function formatDigestMorning(targetDate, summary) {
  // summary = { verified: [], failed: [], lowDrive: [{handle, count}] }
  const v = summary.verified || [];
  const f = summary.failed   || [];
  const lowDrive = summary.lowDrive || [];
  const total = v.length + f.length;

  const lines = [];
  lines.push('☀️ *Bilan d\'hier · ' + fmtDate(targetDate) + '*');
  lines.push('');

  if (total === 0) {
    lines.push('Aucun post programmé hier.');
  } else {
    const successPct = total > 0 ? Math.round(v.length / total * 100) : 0;
    const vTxt = '*' + v.length + ' publié' + (v.length > 1 ? 's' : '') + '*';
    const fTxt = f.length ? f.length + ' raté' + (f.length > 1 ? 's' : '') + ' · ' : '';
    lines.push(vTxt + ' · ' + fTxt + successPct + '% succès');
    lines.push('');
    // Détail par compte (top 8)
    const byAcc = {};
    v.forEach(function(x) { byAcc[x.account] = byAcc[x.account] || { ok: 0, ko: 0 }; byAcc[x.account].ok++; });
    f.forEach(function(x) { byAcc[x.account] = byAcc[x.account] || { ok: 0, ko: 0 }; byAcc[x.account].ko++; });
    const handles = Object.keys(byAcc).sort(function(a, b) { return (byAcc[b].ok + byAcc[b].ko) - (byAcc[a].ok + byAcc[a].ko); });
    handles.slice(0, 8).forEach(function(h) {
      const c = byAcc[h];
      const tag = c.ko > 0 ? ' (' + c.ko + ' raté' + (c.ko > 1 ? 's' : '') + ')' : '';
      lines.push('• @' + h + ' — ' + c.ok + ' publié' + (c.ok > 1 ? 's' : '') + tag);
    });
    if (handles.length > 8) lines.push('  … +' + (handles.length - 8) + ' comptes');
  }

  // Drive vide : message critique pour Jordan
  if (lowDrive.length > 0) {
    lines.push('');
    lines.push('🚨 *' + lowDrive.length + ' compte' + (lowDrive.length > 1 ? 's ont' : ' a') + ' besoin de contenu*');
    lowDrive.slice(0, 8).forEach(function(d) {
      // Schéma : { handle, reels, stories, freqR, freqS } depuis fetchLowDrive
      const r = (d.reels !== undefined) ? d.reels : (d.count !== undefined ? d.count : null);
      let what;
      if (r === 0) what = 'Drive vide';
      else if (r !== null) what = r + ' reel' + (r > 1 ? 's' : '') + ' restant' + (r > 1 ? 's' : '');
      else what = 'à vérifier';
      lines.push('• @' + d.handle + ' — ' + what);
    });
    if (lowDrive.length > 8) lines.push('  … +' + (lowDrive.length - 8) + ' comptes');
    lines.push('');
    lines.push('→ Recharge avant ce soir');
  } else if (total > 0) {
    lines.push('');
    lines.push('Tous les Drive sont OK ✅');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. DIGEST SOIR — bilan jour
// ─────────────────────────────────────────────────────────────────────────────
function formatDigestEvening(targetDate, summary) {
  const v = summary.verified || [];
  const f = summary.failed   || [];
  const total = v.length + f.length;

  const lines = [];
  lines.push('🌙 *Bilan du jour · ' + fmtDate(targetDate) + '*');
  lines.push('');

  if (total === 0) {
    lines.push('Aucun post vérifié aujourd\'hui.');
    lines.push('Le verify peut encore en traiter quelques-uns cette nuit.');
  } else {
    const successPct = total > 0 ? Math.round(v.length / total * 100) : 0;
    const vTxt = '*' + v.length + ' publié' + (v.length > 1 ? 's' : '') + '*';
    const fTxt = f.length ? f.length + ' raté' + (f.length > 1 ? 's' : '') + ' · ' : '';
    lines.push(vTxt + ' · ' + fTxt + successPct + '% succès');
    if (f.length > 0) {
      lines.push('');
      lines.push('Comptes avec ratés :');
      const koByAcc = {};
      f.forEach(function(x) { koByAcc[x.account] = (koByAcc[x.account] || 0) + 1; });
      Object.keys(koByAcc).slice(0, 6).forEach(function(h) {
        lines.push('• @' + h + ' — ' + koByAcc[h]);
      });
    }
  }

  // ─── Section Diagnostics (Phase C — Détective IA) ───
  // Les incidents du jour avec cause identifiée + fix proposé.
  // On limite à 3 max pour respecter budget Telegram (lisible mobile).
  const dx = (summary.diagnostics || []).slice(0, 3);
  if (dx.length > 0) {
    lines.push('');
    lines.push('🕵️ *Causes identifiées* (' + dx.length + (summary.diagnosticsTotal && summary.diagnosticsTotal > dx.length ? '/' + summary.diagnosticsTotal : '') + ') :');
    dx.forEach(function(d) {
      const userMsg = (d.userMessage || d.cause || 'incident sans détail').replace(/\n/g, ' ').slice(0, 120);
      const risk = d.riskLevel === 'high' ? ' 🔴' : (d.riskLevel === 'medium' ? ' 🟠' : '');
      lines.push('• ' + userMsg + risk);
    });
  }

  if (f.length > 0 || dx.length > 0) {
    lines.push('');
    lines.push('→ Détails dashboard · cloche notifications');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ALERTE DRIVE VIDE IMMÉDIATE — appelé par daily-trigger.js si compte actif a 0 contenu
// ─────────────────────────────────────────────────────────────────────────────
function formatLowDriveAlert(lowDriveItems) {
  // lowDriveItems = [{ handle, reels, stories, freqR, freqS }]
  if (!lowDriveItems || !lowDriveItems.length) return null;
  const empty = lowDriveItems.filter(function(d) { return (d.reels === 0 && d.freqR > 0) || (d.stories === 0 && d.freqS > 0); });
  const low   = lowDriveItems.filter(function(d) { return empty.indexOf(d) === -1; });

  const lines = [];
  if (empty.length > 0) {
    lines.push('🚨 *Drive vide — ' + empty.length + ' compte' + (empty.length > 1 ? 's' : '') + '*');
    lines.push('');
    empty.slice(0, 10).forEach(function(d) {
      const parts = [];
      if (d.freqR > 0 && d.reels === 0) parts.push('reels');
      if (d.freqS > 0 && d.stories === 0) parts.push('stories');
      lines.push('• @' + d.handle + ' — ' + parts.join(' + ') + ' à 0');
    });
    if (low.length > 0) {
      lines.push('');
      lines.push('Bas niveau (≤ 3 reels) :');
      low.slice(0, 5).forEach(function(d) { lines.push('• @' + d.handle + ' — ' + d.reels + ' restants'); });
    }
  } else if (low.length > 0) {
    lines.push('⚠️ *' + low.length + ' Drive bas* (≤ 3 reels)');
    lines.push('');
    low.slice(0, 10).forEach(function(d) { lines.push('• @' + d.handle + ' — ' + d.reels + ' restants'); });
  }
  if (!lines.length) return null;
  lines.push('');
  lines.push('→ Recharge dans les dossiers Drive');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RAFALE — alerte critique daily-trigger si slots passés détectés
// ─────────────────────────────────────────────────────────────────────────────
function formatRafaleAlert(skippedSlots, accountsAffected) {
  const lines = [];
  lines.push('🚨 *Rafale évitée*');
  lines.push('');
  lines.push(skippedSlots + ' slots passés détectés sur ' + accountsAffected + ' compte' + (accountsAffected > 1 ? 's' : ''));
  lines.push('');
  lines.push('→ Le cron 01h n\'a pas tourné cette nuit, le rattrapage 15min a sauté ces slots pour éviter de poster en rafale (Instagram aurait flag les comptes).');
  lines.push('');
  lines.push('À vérifier : `journalctl -u zenty-cron`');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. HEALTHCHECK E2E — résultat quotidien
// ─────────────────────────────────────────────────────────────────────────────
function formatE2EResult(checks, schedOk, sandboxAccount, slotStr) {
  const allOk = checks.yesterdayPublished && checks.yesterdayVerified !== false && schedOk;
  const lines = [];
  if (allOk) {
    lines.push('✅ *Système opérationnel*');
    lines.push('');
    lines.push('Le compte test @' + sandboxAccount + ' a publié hier et a un nouveau post programmé pour ' + fmtTime(slotStr) + '.');
    lines.push('');
    lines.push('Le posting fonctionne normalement.');
  } else {
    lines.push('🚨 *Problème détecté*');
    lines.push('');
    if (!checks.yesterdayPublished) lines.push('• Le post test d\'hier n\'a pas été publié sur Instagram');
    if (checks.yesterdayVerified === false) lines.push('• Le verify n\'a pas reconnu le post test d\'hier');
    if (!schedOk) lines.push('• Impossible de programmer un nouveau post test aujourd\'hui');
    lines.push('');
    lines.push('→ Vérifier le dashboard et les logs VPS');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. CACHE CLEANUP — bilan mensuel
// ─────────────────────────────────────────────────────────────────────────────
function formatCacheCleanup(stats) {
  // stats = { deleted, mb, accountReports, dryRun }
  if (!stats.deleted) return null;
  const lines = [];
  lines.push('🧹 *Nettoyage Drive' + (stats.dryRun ? ' [simulé]' : '') + '*');
  lines.push('');
  lines.push(stats.deleted + ' fichiers cache supprimés · ' + stats.mb + ' Mo libérés');
  if (stats.accountReports && stats.accountReports.length > 0) {
    lines.push('');
    stats.accountReports.slice(0, 5).forEach(function(r) {
      lines.push('• @' + r.handle + ' — ' + r.deleted + ' fichiers');
    });
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. ERREUR FATALE — un service VPS crash
// ─────────────────────────────────────────────────────────────────────────────
function formatFatalError(serviceName, errorMsg) {
  const lines = [
    '🚨 *' + serviceName + ' en panne*',
    '',
    'Erreur : ' + (errorMsg || 'inconnue').substring(0, 200),
    '',
    '→ Vérifier `systemctl status zenty-' + serviceName + '`'
  ];
  return lines.join('\n');
}

module.exports = {
  sendTelegram: sendTelegram,
  // Formatters
  formatFailAlert:      formatFailAlert,
  formatDigestMorning:  formatDigestMorning,
  formatDigestEvening:  formatDigestEvening,
  formatLowDriveAlert:  formatLowDriveAlert,
  formatRafaleAlert:    formatRafaleAlert,
  formatE2EResult:      formatE2EResult,
  formatCacheCleanup:   formatCacheCleanup,
  formatFatalError:     formatFatalError,
  // Helpers exposés pour tests
  fmtDate: fmtDate, fmtType: fmtType, fmtTime: fmtTime
};
