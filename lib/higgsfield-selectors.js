// ═══════════════════════════════════════════════════════════════════
//  HIGGSFIELD — sélecteurs CSS calibrables
//  À ajuster après que Jordan a fait le login + ouvert Studio Nano Banana Pro 2K.
//  Lancer le script de calibration scripts/vps/calibrate-higgsfield.js
//  pour identifier les vrais sélecteurs en interactif.
// ═══════════════════════════════════════════════════════════════════
'use strict';

module.exports = {
  // URL du studio Nano Banana Pro 2K avec mode unlimited.
  // À confirmer / corriger après le 1er login Jordan.
  studioUrl: 'https://higgsfield.ai/image',

  // Sélecteurs interface (probables — à valider via calibrate)
  selectors: {
    // Inputs file pour les références (Higgsfield permet d'uploader 2 images : ref + frame)
    fileInput:           'input[type="file"]',

    // Textarea du prompt
    promptTextarea:      'textarea[placeholder*="prompt" i], textarea[placeholder*="describe" i], textarea',

    // Bouton "Generate" / "Create"
    generateButton:      'button:has-text("Generate"), button:has-text("Create"), button[data-testid*="generate" i]',

    // Sélecteur du modèle (Nano Banana Pro)
    modelSelector:       '[data-testid*="model"], [aria-label*="model" i]',
    modelOptionNanoBanana: 'text=/nano banana pro/i',

    // Toggle "Unlimited" mode
    unlimitedToggle:     'button:has-text("Unlimited"), [aria-label*="unlimited" i]',

    // Indicateur de génération en cours
    generatingIndicator: '[class*="loading" i], [class*="generating" i], [data-status="generating"]',

    // Image résultat (après génération)
    resultImage:         'img[src*="generation"], img[src*="result"], [data-testid*="result"] img',

    // Bouton download de l'image résultat
    downloadButton:      'button[aria-label*="download" i], a[download], button:has-text("Download")',

    // Erreur de safety filter (décolleté/peau refusé)
    safetyError:         'text=/safety|content policy|moderation|refused|rejected|blocked/i'
  },

  // Comportement
  timeouts: {
    pageLoad:        15000,  // 15s pour charger la page Studio
    uploadImage:     20000,  // 20s pour upload une image (peut être lent)
    generateClick:    5000,  // 5s après click Generate avant que le job démarre
    generation:     180000,  // 3 min max pour une génération Nano Banana 2K
    download:        15000   // 15s pour download l'image résultat
  },

  // Limites
  maxParallel: 4,            // Higgsfield = max 4 générations parallèles
  maxRetries:  5,            // Si safety filter, on retry jusqu'à 5x
  retryDelayMs: 3000         // Délai entre 2 retry
};
