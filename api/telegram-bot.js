// ═══════════════════════════════════════════════════════════════════
//  ZENTY — BOT WARM-UP (Vercel Serverless)
//  Webhook endpoint : /api/telegram-bot
//  Bot DÉDIÉ warm-up — séparé du bot deploy/alertes (@OFM_Deploy_Bot)
//  Le VA (et Jordan) communiquent les problèmes warm-up ici
//  Le bot met à jour Firebase directement (source de vérité dashboard)
//
//  Commandes :
//    /ban @handle raison      → marque banned + pioche un spare + notifie Jordan
//    /problem @handle raison  → signale un problème (shadow, restrict...)
//    /replace @old @new       → swap manuel de deux comptes
//    /status                  → état warm-up de tous les comptes
//    /help                    → liste des commandes
//
//  BOTS TELEGRAM ZENTY :
//    @OFM_Deploy_Bot   → alertes système, audit, deploy (TG_TOKEN dans daily-trigger)
//    @zenty_warmup_bot → commandes VA warm-up (TG_WARMUP_BOT_TOKEN ici)
// ═══════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

// Token du bot WARM-UP (pas le même que le bot deploy)
const TG_TOKEN    = process.env.TG_WARMUP_BOT_TOKEN || '';
// Notifications Jordan via le bot DEPLOY (alertes système séparées)
const DEPLOY_BOT_TOKEN = process.env.TG_TOKEN || '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const JORDAN_CHAT = process.env.TG_JORDAN_CHAT || '6646462254';
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com';

// ── Helpers ──────────────────────────────────────────────────────

// Répondre au VA (ou Jordan) via le bot warm-up
async function sendTG(chatId, text) {
  if (!TG_TOKEN) { console.error('[WarmupBot] TG_WARMUP_BOT_TOKEN non configuré'); return; }
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
  }).catch(function() {});
}

// Notifier Jordan via le bot deploy (canal séparé)
async function notifyJordan(text) {
  await fetch('https://api.telegram.org/bot' + DEPLOY_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: JORDAN_CHAT, text: text, parse_mode: 'Markdown' })
  }).catch(function() {});
}

async function fbGet(path) {
  var r = await fetch(FIREBASE_URL + '/' + path + '.json');
  return r.json();
}

async function fbSet(path, data) {
  await fetch(FIREBASE_URL + '/' + path + '.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function fbPatch(path, data) {
  await fetch(FIREBASE_URL + '/' + path + '.json', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

function clean(handle) {
  return (handle || '').replace(/^@/, '').toLowerCase().trim();
}

// ── Load all accounts from Firebase ─────────────────────────────

async function getAllAccounts() {
  var data = await fbGet('zenty/accounts');
  if (!data) return [];
  return Object.keys(data).map(function(id) {
    var a = data[id];
    a._fbId = id;
    return a;
  });
}

function findAccount(accounts, handle) {
  var h = clean(handle);
  return accounts.filter(function(a) {
    return clean(a.handle) === h;
  })[0] || null;
}

function findSpare(accounts) {
  return accounts.filter(function(a) {
    return a.status === 'spare';
  })[0] || null;
}

// ── Commands ────────────────────────────────────────────────────

async function cmdBan(chatId, args) {
  if (!args.length) return sendTG(chatId, '❌ Usage : `/ban @handle raison`');
  var handle = clean(args[0]);
  var reason = args.slice(1).join(' ') || 'ban Instagram';
  if (!handle) return sendTG(chatId, '❌ Handle manquant');

  var accounts = await getAllAccounts();
  var acc = findAccount(accounts, handle);
  if (!acc) return sendTG(chatId, '❌ Compte @' + handle + ' introuvable dans le dashboard');
  if (acc.status === 'banned') return sendTG(chatId, '⚠️ @' + handle + ' est déjà marqué comme banni');

  // Sauvegarder les infos warm-up du compte banni
  var oldVa = acc.va || 'non-assigné';
  var oldDay = 1;
  if (acc.warmupStartedAt) {
    oldDay = Math.floor((Date.now() - acc.warmupStartedAt) / 86400000) + 1;
  }

  // Marquer comme banni
  await fbPatch('zenty/accounts/' + acc._fbId, {
    status: 'banned',
    bannedAt: new Date().toISOString(),
    bannedReason: reason,
    warmupStartedAt: null
  });

  // Chercher un spare
  var spare = findSpare(accounts);
  if (!spare) {
    await sendTG(chatId, '⚠️ @' + handle + ' marqué *banni* mais *AUCUN spare disponible* !\nAjouter des comptes spare dans le dashboard.');
    await notifyJordan( '🚨 *ALERTE WARM-UP*\n\n@' + handle + ' banni (' + reason + ')\n⚠️ *Pool spare VIDE* — pas de remplacement\nVA : ' + oldVa + ' (était à D' + oldDay + ')');
    return;
  }

  // Activer le spare : reprend le VA, repart à D1
  await fbPatch('zenty/accounts/' + spare._fbId, {
    status: 'warmup',
    va: oldVa,
    warmupStartedAt: Date.now(),
    replacedAccount: handle,
    replacedReason: reason,
    activatedAt: new Date().toISOString()
  });

  var spareHandle = clean(spare.handle);
  var remainingSpares = accounts.filter(function(a) {
    return a.status === 'spare' && a._fbId !== spare._fbId;
  }).length;

  await sendTG(chatId, '✅ *Remplacement effectué*\n\n' +
    '❌ @' + handle + ' → banni (' + reason + ')\n' +
    '✅ @' + spareHandle + ' → warm-up D1, assigné à ' + oldVa + '\n' +
    '📦 Spares restants : ' + remainingSpares);

  // Notifier Jordan
  await notifyJordan( '🔄 *ROTATION WARM-UP*\n\n' +
    '❌ @' + handle + ' banni (' + reason + ')\n' +
    '✅ Remplacé par @' + spareHandle + ' → D1\n' +
    'VA : ' + oldVa + ' (était à D' + oldDay + ')\n' +
    '📦 Spares restants : ' + remainingSpares +
    (remainingSpares <= 2 ? '\n⚠️ _Stock spare bas !_' : ''));
}

async function cmdProblem(chatId, args) {
  if (!args.length) return sendTG(chatId, '❌ Usage : `/problem @handle raison`');
  var handle = clean(args[0]);
  var reason = args.slice(1).join(' ') || 'problème signalé';
  if (!handle) return sendTG(chatId, '❌ Handle manquant');

  var accounts = await getAllAccounts();
  var acc = findAccount(accounts, handle);
  if (!acc) return sendTG(chatId, '❌ Compte @' + handle + ' introuvable');

  // Ajouter une note au compte sans changer le statut
  var notes = (acc.notes || '') + '\n[' + new Date().toISOString().substring(0, 10) + '] ' + reason;
  await fbPatch('zenty/accounts/' + acc._fbId, {
    notes: notes.trim(),
    lastIssue: reason,
    lastIssueAt: new Date().toISOString()
  });

  await sendTG(chatId, '📝 Problème noté pour @' + handle + ' : ' + reason);

  // Notifier Jordan
  await notifyJordan( '⚠️ *PROBLÈME WARM-UP*\n\n@' + handle + ' : ' + reason + '\nStatut : ' + (acc.status || '?') + '\nVA : ' + (acc.va || '?'));
}

async function cmdReplace(chatId, args) {
  if (args.length < 2) return sendTG(chatId, '❌ Usage : `/replace @ancien @nouveau`');
  var oldHandle = clean(args[0]);
  var newHandle = clean(args[1]);

  var accounts = await getAllAccounts();
  var oldAcc = findAccount(accounts, oldHandle);
  var newAcc = findAccount(accounts, newHandle);

  if (!oldAcc) return sendTG(chatId, '❌ @' + oldHandle + ' introuvable');
  if (!newAcc) return sendTG(chatId, '❌ @' + newHandle + ' introuvable');
  if (newAcc.status !== 'spare') return sendTG(chatId, '⚠️ @' + newHandle + ' n\'est pas un spare (statut: ' + newAcc.status + ')');

  var oldVa = oldAcc.va || 'non-assigné';

  // Bannir l'ancien
  await fbPatch('zenty/accounts/' + oldAcc._fbId, {
    status: 'banned',
    bannedAt: new Date().toISOString(),
    bannedReason: 'remplacé manuellement'
  });

  // Activer le nouveau
  await fbPatch('zenty/accounts/' + newAcc._fbId, {
    status: 'warmup',
    va: oldVa,
    warmupStartedAt: Date.now(),
    replacedAccount: oldHandle,
    activatedAt: new Date().toISOString()
  });

  await sendTG(chatId, '✅ @' + oldHandle + ' → banni\n✅ @' + newHandle + ' → warm-up D1, VA: ' + oldVa);
  await notifyJordan( '🔄 *SWAP MANUEL*\n@' + oldHandle + ' → @' + newHandle + '\nVA : ' + oldVa);
}

async function cmdStatus(chatId) {
  var accounts = await getAllAccounts();
  var warmup = accounts.filter(function(a) { return a.status === 'warmup'; });
  var spares = accounts.filter(function(a) { return a.status === 'spare'; });
  var banned = accounts.filter(function(a) { return a.status === 'banned'; });
  var automated = accounts.filter(function(a) { return a.status === 'automated'; });

  var lines = ['📊 *ÉTAT COMPTES ZENTY*\n'];

  if (warmup.length) {
    lines.push('🟡 *Warm-up (' + warmup.length + ')* :');
    warmup.forEach(function(a) {
      var day = a.warmupStartedAt ? Math.floor((Date.now() - a.warmupStartedAt) / 86400000) + 1 : '?';
      var va = a.va || '-';
      var issue = a.lastIssue ? ' ⚠️' : '';
      lines.push('  • @' + clean(a.handle) + ' — D' + day + ' — VA: ' + va + issue);
    });
  }

  if (automated.length) {
    lines.push('\n🟢 *Actifs (' + automated.length + ')* :');
    automated.forEach(function(a) {
      lines.push('  • @' + clean(a.handle));
    });
  }

  if (spares.length) {
    lines.push('\n⚪ *Spare (' + spares.length + ')* :');
    spares.forEach(function(a) {
      lines.push('  • @' + clean(a.handle));
    });
  } else {
    lines.push('\n⚪ *Spare : AUCUN* ⚠️');
  }

  if (banned.length) {
    lines.push('\n🔴 *Bannis (' + banned.length + ')* :');
    banned.slice(-5).forEach(function(a) {
      var reason = a.bannedReason || '';
      lines.push('  • @' + clean(a.handle) + (reason ? ' (' + reason + ')' : ''));
    });
  }

  await sendTG(chatId, lines.join('\n'));
}

function cmdHelp(chatId) {
  return sendTG(chatId, '*🤖 Bot Zenty Warm-up*\n\n' +
    '`/ban @handle raison` — bannir + remplacement auto par spare\n' +
    '`/problem @handle raison` — signaler un problème\n' +
    '`/replace @ancien @nouveau` — swap manuel\n' +
    '`/status` — voir tous les comptes\n' +
    '`/help` — cette aide');
}

// ── Webhook Handler ─────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (!TG_TOKEN) {
    res.status(200).json({ ok: false, message: 'TG_WARMUP_BOT_TOKEN not configured in Vercel env vars' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, message: 'Zenty Warm-up Bot active' });
    return;
  }

  try {
    var update = req.body;
    if (!update || !update.message || !update.message.text) {
      res.status(200).json({ ok: true });
      return;
    }

    var msg = update.message;
    var chatId = msg.chat.id;
    var text = (msg.text || '').trim();

    // Parse command
    var parts = text.split(/\s+/);
    var cmd = (parts[0] || '').toLowerCase().replace(/@\w+$/, ''); // strip @botname
    var args = parts.slice(1);

    switch (cmd) {
      case '/ban':
        await cmdBan(chatId, args);
        break;
      case '/problem':
        await cmdProblem(chatId, args);
        break;
      case '/replace':
        await cmdReplace(chatId, args);
        break;
      case '/status':
        await cmdStatus(chatId);
        break;
      case '/help':
      case '/start':
        await cmdHelp(chatId);
        break;
      default:
        // Ignorer les messages non-commande
        break;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[TG Bot Error]', e);
    res.status(200).json({ ok: true }); // Toujours 200 pour Telegram
  }
};
