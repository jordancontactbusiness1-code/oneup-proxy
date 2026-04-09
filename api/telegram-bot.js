// ═══════════════════════════════════════════════════════════════════
//  ZENTY — BOT WARM-UP (Vercel Serverless)
//  Webhook endpoint : /api/telegram-bot
//  Bot DÉDIÉ warm-up — séparé du bot deploy/alertes (@OFM_Deploy_Bot)
//
//  Le VA tape le NUMÉRO du compte (#1, #2...) affiché dans le dashboard.
//  /ban remplace les credentials par un spare (le compte garde sa position,
//  son VA, sa progression warm-up — seuls login/pwd/2fa changent).
//
//  Commandes :
//    /ban N raison       → swap credentials du compte #N avec un spare
//    /problem N raison   → signale un problème sur le compte #N
//    /status             → état warm-up avec numéros
//    /help               → liste des commandes
//
//  BOTS TELEGRAM ZENTY :
//    @OFM_Deploy_Bot     → alertes système, audit, deploy
//    @Zenty_Warmupbot    → commandes VA warm-up (ce fichier)
// ═══════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const TG_TOKEN         = process.env.TG_WARMUP_BOT_TOKEN || '';
const DEPLOY_BOT_TOKEN = process.env.TG_TOKEN || '8731205281:AAEDHGji6_Oe3Cue30LBZ6x_8-CTN2F9DcQ';
const JORDAN_CHAT      = process.env.TG_JORDAN_CHAT || '6646462254';
const FIREBASE_URL     = process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com';
const FIREBASE_SECRET  = process.env.FIREBASE_SECRET || '';

// ── Helpers ──────────────────────────────────────────────────────

async function sendTG(chatId, text) {
  if (!TG_TOKEN) { console.error('[WarmupBot] TG_WARMUP_BOT_TOKEN non configuré'); return; }
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
  }).catch(function() {});
}

async function notifyJordan(text) {
  await fetch('https://api.telegram.org/bot' + DEPLOY_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: JORDAN_CHAT, text: text, parse_mode: 'Markdown' })
  }).catch(function() {});
}

function fbPath(p) { return FIREBASE_URL + '/' + p + '.json?auth=' + FIREBASE_SECRET; }
async function fbGet(p) { var r = await fetch(fbPath(p)); return r.json(); }
async function fbPatch(p, d) { await fetch(fbPath(p), { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(d) }); }
async function fbDelete(p) { await fetch(fbPath(p), { method: 'DELETE' }); }

function clean(h) { return (h || '').replace(/^@/, '').toLowerCase().trim(); }

// ── Load accounts + number map from Firebase ────────────────────

async function getAllAccounts() {
  var data = await fbGet('zenty/accounts');
  if (!data) return [];
  return Object.keys(data).map(function(id) {
    var a = data[id]; a._fbId = id; return a;
  });
}

// Numérotation calculée par le bot (pas de dépendance au dashboard)
// Les comptes non-spare sont numérotés dans l'ordre de Firebase
function numberAccounts(accounts) {
  var nonSpare = accounts.filter(function(a) { return a.status !== 'spare'; });
  nonSpare.forEach(function(a, i) { a._num = i + 1; });
  return nonSpare;
}

function findByNumber(accounts, num) {
  var numbered = numberAccounts(accounts);
  return numbered.filter(function(a) { return a._num === num; })[0] || null;
}

function findSpare(accounts) {
  return accounts.filter(function(a) { return a.status === 'spare'; })[0] || null;
}

// ── /ban N raison — Credential swap ─────────────────────────────
// Le compte #N GARDE sa position, VA, warm-up day.
// Seuls login/password/2fa sont remplacés par ceux du spare.
// Le spare est SUPPRIMÉ de la banque (usage unique).

async function cmdBan(chatId, args) {
  if (!args.length) return sendTG(chatId, '❌ Usage : `/ban N raison`\nExemple : `/ban 3 shadow ban`');
  var num = parseInt(args[0], 10);
  var reason = args.slice(1).join(' ') || 'ban Instagram';

  if (!num || num < 1) return sendTG(chatId, '❌ Numéro invalide. Tape `/status` pour voir les numéros.');

  var accounts = await getAllAccounts();
  var acc = findByNumber(accounts, num);
  if (!acc) return sendTG(chatId, '❌ Compte #' + num + ' introuvable. Tape `/status` pour voir la liste.');

  var handle = clean(acc.handle);
  var spare = findSpare(accounts);

  if (!spare) {
    // Pas de spare — on note le problème mais on ne change rien
    await sendTG(chatId, '⚠️ Compte #' + num + ' (@' + handle + ') a un problème mais *AUCUN spare disponible* !\nDemande à Jordan d\'ajouter des spares.');
    await notifyJordan('🚨 *ALERTE WARM-UP*\n\n#' + num + ' @' + handle + ' — ' + reason + '\n⚠️ *Pool spare VIDE*\nVA : ' + (acc.va || '?'));
    return;
  }

  // Sauvegarder les anciennes credentials pour le log
  var oldLogin = acc.originalUsername || acc.handle || '?';
  var spareLogin = spare.originalUsername || spare.handle || '?';

  // Swap COMPLET : credentials + reset stats (nouveau compte = table rase)
  // Seuls VA, position (#N), modelName sont conservés
  await fbPatch('zenty/accounts/' + acc._fbId, {
    // Credentials du spare (remplacement complet — zero reste de l'ancien)
    handle: spareLogin,
    originalUsername: spareLogin,
    password: spare.password || '',
    secret2fa: spare.secret2fa || '',
    // Reset warm-up a D1
    warmupStartedAt: Date.now(),
    status: 'warmup',
    // Reset stats (nouveau compte vierge)
    bio: '',
    followers: 0,
    posts: 0,
    following: 0,
    lastPostDate: '',
    lastIssue: null,
    lastIssueAt: null,
    // Log du remplacement
    bannedCredentials: oldLogin + ' (' + reason + ', ' + new Date().toISOString().substring(0, 10) + ')',
    notes: '[' + new Date().toISOString().substring(0, 10) + '] Remplace ' + oldLogin + ' -> ' + spareLogin + ' (' + reason + ')'
  });

  // Supprimer le spare de la banque (usage unique)
  await fbDelete('zenty/accounts/' + spare._fbId);

  var remainingSpares = accounts.filter(function(a) {
    return a.status === 'spare' && a._fbId !== spare._fbId;
  }).length;

  await sendTG(chatId,
    '✅ *Compte #' + num + ' — remplacé*\n\n' +
    '❌ Ancien : `' + oldLogin + '` (' + reason + ')\n\n' +
    '🔑 *Nouveaux credentials :*\n' +
    '  Login : `' + spareLogin + '`\n' +
    '  Password : `' + (spare.password || '-') + '`\n' +
    '  2FA : `' + (spare.secret2fa || '-') + '`\n\n' +
    '👤 VA : ' + (acc.va || '-') + ' — warm-up D1\n' +
    '📦 Spares restants : ' + remainingSpares);

  await notifyJordan(
    '🔄 *SWAP CREDENTIALS #' + num + '*\n\n' +
    'Ancien : `' + oldLogin + '` (' + reason + ')\n' +
    'Nouveau : `' + spareLogin + '`\n' +
    'VA : ' + (acc.va || '?') + '\n' +
    '📦 Spares restants : ' + remainingSpares +
    (remainingSpares <= 2 ? '\n⚠️ _Stock spare bas !_' : ''));
}

// ── /problem N raison ───────────────────────────────────────────

async function cmdProblem(chatId, args) {
  if (!args.length) return sendTG(chatId, '❌ Usage : `/problem N raison`\nExemple : `/problem 5 restrict actions`');
  var num = parseInt(args[0], 10);
  var reason = args.slice(1).join(' ') || 'problème signalé';

  if (!num || num < 1) return sendTG(chatId, '❌ Numéro invalide. Tape `/status` pour voir les numéros.');

  var accounts = await getAllAccounts();
  var acc = findByNumber(accounts, num);
  if (!acc) return sendTG(chatId, '❌ Compte #' + num + ' introuvable.');

  var handle = clean(acc.handle);
  var notes = ((acc.notes || '') + '\n[' + new Date().toISOString().substring(0, 10) + '] ' + reason).trim();
  await fbPatch('zenty/accounts/' + acc._fbId, {
    notes: notes,
    lastIssue: reason,
    lastIssueAt: new Date().toISOString()
  });

  await sendTG(chatId, '📝 Problème noté pour #' + num + ' (@' + handle + ') : ' + reason);
  await notifyJordan('⚠️ *PROBLÈME #' + num + '* @' + handle + ' : ' + reason + '\nVA : ' + (acc.va || '?'));
}

// ── /status ─────────────────────────────────────────────────────

async function cmdStatus(chatId) {
  var accounts = await getAllAccounts();
  // Numéroter les comptes non-spare (même logique que le dashboard)
  numberAccounts(accounts);

  var warmup = accounts.filter(function(a) { return a.status === 'warmup'; });
  var spares = accounts.filter(function(a) { return a.status === 'spare'; });
  var banned = accounts.filter(function(a) { return a.status === 'banned'; });
  var automated = accounts.filter(function(a) { return a.status === 'automated'; });

  var lines = ['📊 *ÉTAT COMPTES ZENTY*\n'];

  if (warmup.length) {
    lines.push('🟡 *Warm-up (' + warmup.length + ')* :');
    warmup.forEach(function(a) {
      var day = a.warmupStartedAt ? Math.floor((Date.now() - a.warmupStartedAt) / 86400000) + 1 : '?';
      var issue = a.lastIssue ? ' ⚠️' : '';
      lines.push('  #' + (a._num || '?') + ' @' + clean(a.handle) + ' — D' + day + ' — VA: ' + (a.va || '-') + issue);
    });
  }

  if (automated.length) {
    lines.push('\n🟢 *Actifs (' + automated.length + ')* :');
    automated.forEach(function(a) {
      lines.push('  #' + (a._num || '?') + ' @' + clean(a.handle));
    });
  }

  lines.push('\n📦 *Spares dispo : ' + spares.length + '*' + (spares.length <= 2 ? ' ⚠️' : ''));

  if (banned.length) {
    lines.push('\n🔴 *Bannis récents (' + banned.length + ')* :');
    banned.slice(-3).forEach(function(a) {
      lines.push('  @' + clean(a.handle) + (a.bannedReason ? ' (' + a.bannedReason + ')' : ''));
    });
  }

  await sendTG(chatId, lines.join('\n'));
}

// ── /help ───────────────────────────────────────────────────────

function cmdHelp(chatId) {
  return sendTG(chatId,
    '*🤖 Bot Zenty Warm-up*\n\n' +
    '`/ban N raison` — remplacer les credentials du compte #N par un spare\n' +
    '`/problem N raison` — signaler un problème\n' +
    '`/status` — voir tous les comptes avec leurs numéros\n' +
    '`/help` — cette aide\n\n' +
    '_N = numéro du compte affiché dans le dashboard_');
}

// ── Webhook Handler ─────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (!TG_TOKEN) {
    res.status(200).json({ ok: false, message: 'TG_WARMUP_BOT_TOKEN not configured' });
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

    var chatId = update.message.chat.id;
    var text = (update.message.text || '').trim();
    var parts = text.split(/\s+/);
    var cmd = (parts[0] || '').toLowerCase().replace(/@\w+$/, '');
    var args = parts.slice(1);

    switch (cmd) {
      case '/ban':     await cmdBan(chatId, args); break;
      case '/problem': await cmdProblem(chatId, args); break;
      case '/status':  await cmdStatus(chatId); break;
      case '/help':
      case '/start':   await cmdHelp(chatId); break;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[TG Bot Error]', e);
    res.status(200).json({ ok: true });
  }
};
