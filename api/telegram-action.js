// ═══════════════════════════════════════════════════════════════════
//  ZENTY — TELEGRAM CALLBACK HANDLER (Vague 4A — interactif)
//  2026-05-02 nuit
//
//  POURQUOI : le système détecte des bugs et propose des fix, mais Jordan doit
//  ouvrir le dashboard ou SSH pour valider. Vague 4A = boutons inline keyboard
//  Telegram → 1 clic depuis le mobile pour Apply / Reject / View.
//
//  QUOI : reçoit POST webhook Telegram (update.callback_query) :
//   1. Vérifie auth (chat_id == JORDAN_CHAT)
//   2. Parse data : "action:incidentId" (action ∈ apply/reject/view)
//   3. Action :
//      - apply  → marque incident.status='user_approved', trigger repair-run
//      - reject → marque incident.status='rejected_by_user'
//      - view   → envoie détail complet (cause + fix + rollback)
//   4. answerCallbackQuery + send confirmation
//
//  SETUP : doit setWebhook https://dashboard.../telegram-webhook (handler dans server.js).
//  Cf. setup commande dans /opt/zenty-cron/setup-telegram-webhook.sh
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');

const TG_TOKEN        = process.env.TG_TOKEN          || '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const JORDAN_CHAT     = process.env.TG_CHAT           || '6646462254';
const FIREBASE_URL    = (process.env.FIREBASE_URL     || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET   || '';
const CRON_SECRET     = process.env.CRON_SECRET       || '';

// ── Firebase + Telegram helpers ──────────────────────────────────────────────
const fbAuth = '?auth=' + FIREBASE_SECRET;
async function fbGet(p) {
  const r = await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth);
  return r.json();
}
async function fbPatch(p, value) {
  await fetch(FIREBASE_URL + '/' + p + '.json' + fbAuth, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}

async function answerCallback(callbackId, text) {
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/answerCallbackQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: text, show_alert: false })
  }).catch(function() {});
}

async function sendMessage(text, replyMarkup) {
  const body = { chat_id: JORDAN_CHAT, text: text, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(function() {});
}

async function editMessageText(chatId, messageId, text) {
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/editMessageText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, parse_mode: 'Markdown' })
  }).catch(function() {});
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Telegram envoie POST sans auth header — on répond 200 toujours pour ne pas
  // que Telegram retry sur erreur (sinon spam de webhook).
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const update = req.body || {};
    const cb = update.callback_query;

    // Pas un callback : on ignore (les /commands texte sont gérées ailleurs)
    if (!cb) {
      res.status(200).json({ ok: true, ignored: 'no_callback_query' });
      return;
    }

    // Auth strict : seul Jordan peut valider les fix
    const fromId = cb.from && cb.from.id ? String(cb.from.id) : '';
    if (fromId !== JORDAN_CHAT) {
      await answerCallback(cb.id, '⛔ Action non autorisée');
      res.status(200).json({ ok: true, blocked: true });
      return;
    }

    // Parse data : "action:incidentId"
    const data = String(cb.data || '');
    const sep = data.indexOf(':');
    const action = sep > 0 ? data.slice(0, sep) : data;
    const incidentId = sep > 0 ? data.slice(sep + 1) : '';

    if (!incidentId || ['apply', 'reject', 'view'].indexOf(action) === -1) {
      await answerCallback(cb.id, '❓ Action inconnue : ' + action);
      res.status(200).json({ ok: true });
      return;
    }

    // Lire l'incident
    const incident = await fbGet('zenty/incidents/' + incidentId);
    if (!incident || !incident.diagnosis) {
      await answerCallback(cb.id, '⚠️ Incident introuvable ou expiré');
      res.status(200).json({ ok: true });
      return;
    }

    const diag = incident.diagnosis;
    const fix = diag.proposedFix || {};

    // ─── ACTION : view (détail complet) ───
    if (action === 'view') {
      await answerCallback(cb.id, '');
      const detail = '🔍 *Détail incident*\n\n' +
        '*Cause :* ' + (diag.cause || '?') + '\n' +
        '*Confiance :* ' + (Math.round((diag.confidence || 0) * 100)) + '%\n' +
        '*Risque :* ' + (diag.riskLevel || '?') + '\n' +
        '*Catégorie :* ' + (diag.category || '?') + '\n\n' +
        '*Fix proposé :* ' + (fix.description || '?') + '\n' +
        '*Steps :*\n' + ((fix.steps || []).map(function(s) { return '  • ' + s; }).join('\n') || '  —') + '\n\n' +
        '*Rollback :* ' + (fix.rollback || '?');
      await sendMessage(detail);
      res.status(200).json({ ok: true });
      return;
    }

    // ─── ACTION : reject ───
    if (action === 'reject') {
      await fbPatch('zenty/incidents/' + incidentId, {
        status: 'rejected_by_user',
        rejectedAt: new Date().toISOString(),
        rejectedBy: 'jordan_telegram'
      });
      await answerCallback(cb.id, '❌ Rejeté');
      // Edit le message d'origine pour montrer le résultat
      if (cb.message && cb.message.chat) {
        await editMessageText(cb.message.chat.id, cb.message.message_id,
          (cb.message.text || '') + '\n\n❌ *Rejeté par Jordan* — pas d\'action prise.');
      }
      res.status(200).json({ ok: true, action: 'rejected' });
      return;
    }

    // ─── ACTION : apply ───
    if (action === 'apply') {
      await fbPatch('zenty/incidents/' + incidentId, {
        status: 'user_approved',
        approvedAt: new Date().toISOString(),
        approvedBy: 'jordan_telegram'
      });
      await answerCallback(cb.id, '⏳ Application en cours...');
      // Trigger repair-run immédiat (le Réparateur traite les user_approved)
      const repairRes = await fetch('http://127.0.0.1:3100/api/repair-run', {
        method: 'POST',
        headers: { 'x-cron-secret': CRON_SECRET, 'Content-Type': 'application/json' }
      }).catch(function(e) { return null; });
      let repairOk = false, repairDetail = '';
      if (repairRes) {
        try {
          const j = await repairRes.json();
          repairOk = !!j.ok;
          // Vérifier si l'incident est maintenant 'applied'
          const updated = await fbGet('zenty/incidents/' + incidentId);
          if (updated && updated.status === 'applied') {
            repairDetail = '✅ Fix appliqué avec succès';
          } else if (updated && updated.status === 'user_approved') {
            repairDetail = '⏳ Action whitelistée pas dispo, attente humaine';
          } else {
            repairDetail = '⚠️ Status: ' + (updated && updated.status);
          }
        } catch(e) { repairDetail = 'erreur parse réponse'; }
      }
      // Edit le message d'origine
      if (cb.message && cb.message.chat) {
        await editMessageText(cb.message.chat.id, cb.message.message_id,
          (cb.message.text || '') + '\n\n✅ *Approuvé par Jordan*\n' + repairDetail);
      }
      res.status(200).json({ ok: true, action: 'applied', detail: repairDetail });
      return;
    }
  } catch (e) {
    console.error('[telegram-action] error:', e.message);
    // Tjs 200 pour éviter retry Telegram
    res.status(200).json({ ok: false, internal: true });
  }
};
