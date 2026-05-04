// ═══════════════════════════════════════════════════════════════════
//  ZENTY — CAPTION BANK BACKEND (Phase 7+ — banque branchée dans cron VPS)
//  2026-05-04 — pendant backend de js/captions/bank.js
//
//  POURQUOI : la banque (70 captions Tina FR) tournait UNIQUEMENT côté frontend
//  quand Jordan faisait "Apply" manuel. Le cron VPS daily-trigger (1h Paris) et
//  checker (toutes 15min) ignoraient la banque et appelaient Claude Haiku en
//  direct → captions imprévisibles, coût Anthropic, hallucinations possibles.
//
//  QUOI : module CommonJS avec une seule fonction `pickFromBank(handle, modelName)`
//  qui utilise la même logique shuffle-bag que le frontend (Fisher-Yates par
//  compte, garantit qu'un compte parcourt les N captions sans répétition avant
//  de pouvoir retomber sur la même).
//
//  CONTRAT :
//   - retourne caption (string) si banque dispo
//   - retourne null si banque vide / modelKey inconnu / Firebase down
//   - le caller (daily-trigger generateCaption) fallback sur Anthropic si null
//
//  STORAGE FIREBASE (mêmes paths que le frontend, pas de duplication) :
//   - zenty/caption_bank/{modelKey}      = { captions: [string], updatedAt }
//   - zenty/caption_bag/{handleSafe}     = { permutation, cursor, model, shuffledAt }
//
//  RÈGLE R17 : modelName arrive de Firebase acc.modelName ou dérivé via acc.agency
//  ('FR' → 'Tina FR' → modelKey 'tina_fr').
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fetch = require('node-fetch');

const FIREBASE_URL    = (process.env.FIREBASE_URL || 'https://dashboard-a76d2-default-rtdb.firebaseio.com').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const fbAuth = '?auth=' + FIREBASE_SECRET;

async function fbGet(path) {
  const r = await fetch(FIREBASE_URL + '/' + path + '.json' + fbAuth);
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

// ── Normalize modelKey (mêmes règles que js/captions/bank.js captionBankModelKey)
function modelKeyOf(modelName) {
  if (!modelName) return '';
  return String(modelName).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

// ── Sanitize handle pour Firebase (cf feedback_dotted_keys_firebase)
function safeHandleOf(handle) {
  if (!handle) return '';
  return String(handle).replace(/^@/, '').replace(/\./g, '_').toLowerCase().trim();
}

// ── Fisher-Yates shuffle (identique frontend)
function shuffleN(n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(i);
  for (let j = arr.length - 1; j > 0; j--) {
    const k = Math.floor(Math.random() * (j + 1));
    const tmp = arr[j]; arr[j] = arr[k]; arr[k] = tmp;
  }
  return arr;
}

// ── Cache mémoire (re-fetch banque toutes les 60s)
const _bankCache = {};   // { modelKey: { captions, fetchedAt } }
const _BANK_TTL = 60 * 1000;

async function loadBank(modelKey) {
  if (!modelKey) return null;
  const cached = _bankCache[modelKey];
  if (cached && (Date.now() - cached.fetchedAt) < _BANK_TTL) return cached;
  const data = await fbGet('zenty/caption_bank/' + modelKey).catch(function() { return null; });
  if (!data || !Array.isArray(data.captions) || data.captions.length === 0) return null;
  const entry = { captions: data.captions, fetchedAt: Date.now() };
  _bankCache[modelKey] = entry;
  return entry;
}

// ── Pick : pioche la prochaine caption pour un compte ─────────────
//
// Returns Promise<string|null>. null = pas de banque dispo → caller fallback IA.
//
// Logique shuffle-bag :
//   - Lit/crée bag {permutation, cursor, model, shuffledAt}
//   - Si bag corrompu (model mismatch, taille != banque, cursor out of range) → reshuffle
//   - Renvoie caption[permutation[cursor]], puis cursor++
//   - Quand cursor >= N, reshuffle pour le prochain tour
//
// Identique au frontend captionBankPickForAccount.
async function pickFromBank(handle, modelName) {
  if (!handle || !modelName) return null;
  const modelKey = modelKeyOf(modelName);
  if (!modelKey) return null;
  const bank = await loadBank(modelKey);
  if (!bank) return null;
  const handleSafe = safeHandleOf(handle);
  if (!handleSafe) return null;
  const n = bank.captions.length;

  let bag = await fbGet('zenty/caption_bag/' + handleSafe).catch(function() { return null; });
  if (!bag || bag.model !== modelKey
      || !Array.isArray(bag.permutation)
      || bag.permutation.length !== n
      || typeof bag.cursor !== 'number'
      || bag.cursor < 0 || bag.cursor >= n) {
    bag = { permutation: shuffleN(n), cursor: 0, model: modelKey, shuffledAt: Date.now() };
  }
  const caption = bank.captions[bag.permutation[bag.cursor]] || '';
  bag.cursor += 1;
  if (bag.cursor >= n) {
    bag.permutation = shuffleN(n);
    bag.cursor = 0;
    bag.shuffledAt = Date.now();
  }
  // Persist new bag (best-effort, on n'attend pas la promesse pour la latence)
  fbPut('zenty/caption_bag/' + handleSafe, bag).catch(function() {});
  return caption || null;
}

// ── Dérivation modelName depuis le record account Firebase ────────
// Pattern aligné sur health-integrity.js : acc.modelName si présent, sinon
// acc.agency ('FR' → 'Tina FR', 'US' → 'Tina US'). Sinon null.
function deriveModelName(acc) {
  if (!acc) return null;
  if (acc.modelName) return String(acc.modelName);
  if (acc.agency === 'FR') return 'Tina FR';
  if (acc.agency === 'US') return 'Tina US';
  return null;
}

module.exports = {
  pickFromBank: pickFromBank,
  deriveModelName: deriveModelName,
  modelKeyOf: modelKeyOf,
  safeHandleOf: safeHandleOf
};
