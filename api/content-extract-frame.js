// ═══════════════════════════════════════════════════════
// CONTENT STUDIO — Extract Frame (POST /api/content-extract-frame)
// ═══════════════════════════════════════════════════════
// V2 : yt-dlp + ffmpeg pour extraction réelle de la 1ère frame.
// Body : { url, type:'url'|'file', jobId }
// Res  : { frame_url: string (data URL base64 du PNG) }
'use strict';

var fs        = require('fs');
var extractor = require('../lib/frame-extractor.js');
var jobStore  = require('../lib/job-store.js');

module.exports = async function(req, res) {
  var body  = req.body || {};
  var url   = body.url   || '';
  var type  = body.type  || 'url';
  var jobId = body.jobId || '';

  if (!url) return res.status(400).json({ error: 'url manquante' });
  if (!jobId) return res.status(400).json({ error: 'jobId manquant' });

  if (type === 'url' && !/^https:\/\/(www\.)?instagram\.com\/reel\/[A-Za-z0-9_\-]+/.test(url)) {
    return res.status(400).json({ error: 'URL Instagram invalide' });
  }

  try {
    var result;
    if (type === 'url') {
      result = await extractor.extractFromUrl(url);
    } else {
      // type='file' : pour V2, frontend doit upload le mp4 séparément.
      // Pour l'instant, on log et on retourne erreur claire.
      return res.status(501).json({ error: 'Upload mp4 direct pas encore implémenté — utilise une URL Reel pour le moment' });
    }

    // Stocke les paths pour le job (réutilisés par generate-photo)
    jobStore.set(jobId, {
      framePath: result.framePath,
      mp4Path:   result.mp4Path
    });

    // Retourne la frame en data URL base64 pour affichage frontend
    var buf = fs.readFileSync(result.framePath);
    var dataUrl = 'data:image/png;base64,' + buf.toString('base64');

    res.json({ frame_url: dataUrl, jobId: jobId });
  } catch (e) {
    console.error('[content-extract-frame]', e);
    res.status(500).json({ error: 'Extraction échouée: ' + (e.message || e) });
  }
};
