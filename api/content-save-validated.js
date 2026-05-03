// ═══════════════════════════════════════════════════════
// CONTENT STUDIO — Save Validated (POST /api/content-save-validated)
// ═══════════════════════════════════════════════════════
// V2 : upload réel dans Drive via Service Account JWT.
// Body : { jobId, photo_url, account, model }
// Res  : { success: true, drive_file_id, drive_url }
'use strict';

var fs       = require('fs');
var dotenv   = require('dotenv');
dotenv.config({ path: __dirname + '/../.env' });

var driveLib  = require('../lib/drive-upload.js');
var jobStore  = require('../lib/job-store.js');
var resolver  = require('../lib/url-resolver.js');

module.exports = async function(req, res) {
  var body     = req.body || {};
  var photoUrl = body.photo_url || '';
  var account  = body.account   || '';
  var model    = body.model     || 'tina_fr';
  var jobId    = body.jobId     || '';

  if (!photoUrl) return res.status(400).json({ error: 'photo_url manquante' });
  if (!account)  return res.status(400).json({ error: 'account manquant (handle cible)' });
  if (!jobId)    return res.status(400).json({ error: 'jobId manquant' });

  try {
    // 1. Récupère le path local de la photo (generate-photo l'a stocké)
    var rec = jobStore.get(jobId);
    var photoPath = rec && rec.photoPath;
    if (!photoPath || !fs.existsSync(photoPath)) {
      // Fallback : décode photo_url (data URL) en local file
      photoPath = await resolver.resolveToFile(photoUrl);
    }

    // 2. Upload dans Drive (sous-dossier _pending_video/ par défaut)
    // _pending_video pour photos en attente (pas posté direct).
    // Drive scanner les indexera dans 30 min.
    var fname = 'tina_studio_' + Date.now() + '.png';
    var up = await driveLib.uploadValidatedPhoto({
      photoPath: photoPath,
      handle:    account,
      sub:       'pending',
      filename:  fname,
      mimeType:  'image/png'
    });

    // 3. Cleanup files temp du jobStore
    jobStore.cleanup(jobId);

    console.log('[content-studio] save-validated OK | account:' + account + ' file:' + up.drive_file_id);

    res.json({
      success:       true,
      drive_file_id: up.drive_file_id,
      drive_url:     up.drive_url,
      folder_id:     up.folder_id,
      account:       account,
      model:         model
    });
  } catch (e) {
    console.error('[content-save-validated]', e);
    res.status(500).json({ error: 'Upload Drive échoué: ' + (e.message || e) });
  }
};
