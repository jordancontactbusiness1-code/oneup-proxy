// ═══════════════════════════════════════════════════════
// CONTENT STUDIO — Generate Photo (POST /api/content-generate-photo)
// ═══════════════════════════════════════════════════════
// V2 : pilote Higgsfield via puppeteer-core sur le Chrome VPS (CDP 9222).
// Body : { jobId, frame_url, ref_url, prompt, model, resolution }
// Res  : { photo_url: string (data URL base64 du PNG généré),
//          photo_id: string (= jobId, pour save-validated) }
'use strict';

var fs       = require('fs');
var path     = require('path');
var queue    = require('../lib/higgsfield-queue.js');
var jobStore = require('../lib/job-store.js');
var resolver = require('../lib/url-resolver.js');

module.exports = async function(req, res) {
  var body     = req.body || {};
  var frameUrl = body.frame_url || '';
  var refUrl   = body.ref_url   || '';
  var prompt   = body.prompt    || '';
  var jobId    = body.jobId     || '';

  if (!jobId)   return res.status(400).json({ error: 'jobId manquant' });
  if (!frameUrl) return res.status(400).json({ error: 'frame_url manquante' });
  if (!refUrl)   return res.status(400).json({ error: 'ref_url manquante (configure photo référence dans Settings)' });
  if (!prompt)   return res.status(400).json({ error: 'prompt manquant (configure dans Settings → Studio Reels)' });

  try {
    // 1. Récupère le path local de la frame (extract-frame l'a stocké en jobStore)
    var rec = jobStore.get(jobId);
    var framePath = rec && rec.framePath;
    if (!framePath || !fs.existsSync(framePath)) {
      // Fallback : décode frame_url (data URL ou URL) en local file
      framePath = await resolver.resolveToFile(frameUrl);
      jobStore.set(jobId, { framePath: framePath });
    }

    // 2. Résout ref_url en local file (Drive ou data URL)
    var refPath = rec && rec.refPath;
    if (!refPath || !fs.existsSync(refPath)) {
      refPath = await resolver.resolveToFile(refUrl);
      jobStore.set(jobId, { refPath: refPath });
    }

    // 3. Output path
    var outDir  = '/tmp/zenty-higgsfield';
    fs.mkdirSync(outDir, { recursive: true });
    var outPath = path.join(outDir, jobId + '.png');

    // 4. Lance la génération via la queue (4 slots max + retry safety)
    var result = await queue.runGeneration({
      refTinaPath:   refPath,
      frameReelPath: framePath,
      prompt:        prompt,
      outPath:       outPath,
      jobId:         jobId,
      onAttempt: function(n, max) {
        console.log('[content-generate-photo] ' + jobId + ' tentative ' + n + '/' + max);
      }
    });

    // 5. Stocke le path de la photo générée pour save-validated
    jobStore.set(jobId, { photoPath: result.path });

    // 6. Retourne en data URL (frontend l'affiche directement)
    var buf = fs.readFileSync(result.path);
    var dataUrl = 'data:image/png;base64,' + buf.toString('base64');

    res.json({
      photo_url: dataUrl,
      photo_id:  jobId,
      attempts:  result.attempts
    });
  } catch (e) {
    console.error('[content-generate-photo]', e);
    var msg = String(e && e.message || e);
    var code = (e && e.code === 'SAFETY_FILTER') ? 422 : 500;
    res.status(code).json({ error: 'Génération échouée: ' + msg });
  }
};
