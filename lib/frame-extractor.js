// ═══════════════════════════════════════════════════════════════════
//  FRAME EXTRACTOR — yt-dlp + ffmpeg
//
//  Télécharge un Reel Instagram (URL) ou prend un mp4 local, puis
//  extrait la 1ère frame (ou frame à un timestamp donné) en PNG.
//
//  Dépendances VPS : yt-dlp (binaire), ffmpeg (apt).
//  Installées par le workflow setup-content-studio-runtime.yml.
// ═══════════════════════════════════════════════════════════════════
'use strict';

const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TMP_DIR = process.env.ZENTY_FRAMES_DIR || '/tmp/zenty-frames';
const YT_DLP  = process.env.YT_DLP_PATH      || '/usr/local/bin/yt-dlp';
const FFMPEG  = process.env.FFMPEG_PATH      || '/usr/bin/ffmpeg';

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function execAsync(cmd, args, opts) {
  return new Promise(function(resolve, reject) {
    execFile(cmd, args, opts || {}, function(err, stdout, stderr) {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: stdout, stderr: stderr });
    });
  });
}

// ── Download Reel via yt-dlp ───────────────────────────────────────────
async function downloadReel(reelUrl) {
  ensureTmpDir();
  const id  = crypto.randomBytes(6).toString('hex');
  const out = path.join(TMP_DIR, 'reel_' + id + '.mp4');

  // yt-dlp avec format vidéo unique (pas merge audio/video — on veut juste la frame)
  // Limite à 30s et 1080p max (Reels font max 90s mais on prend le début)
  const args = [
    '-o', out,
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '-f', 'best[ext=mp4]/best',
    '--max-filesize', '50M',
    reelUrl
  ];
  await execAsync(YT_DLP, args, { timeout: 60000 });
  if (!fs.existsSync(out)) throw new Error('yt-dlp: fichier de sortie absent');
  return out;
}

// ── Extract frame via ffmpeg ───────────────────────────────────────────
// Par défaut prend la frame à 0.5s (évite éventuels logos d'intro à 0s)
async function extractFrame(mp4Path, opts) {
  ensureTmpDir();
  opts = opts || {};
  const timestamp = opts.timestamp || '0.5';  // secondes
  const id  = crypto.randomBytes(6).toString('hex');
  const out = path.join(TMP_DIR, 'frame_' + id + '.png');

  const args = [
    '-y',                          // overwrite
    '-loglevel', 'error',
    '-ss', String(timestamp),      // seek avant -i = rapide
    '-i', mp4Path,
    '-frames:v', '1',              // 1 frame seulement
    '-q:v', '2',                   // qualité haute
    out
  ];
  await execAsync(FFMPEG, args, { timeout: 30000 });
  if (!fs.existsSync(out)) throw new Error('ffmpeg: frame non générée');
  return out;
}

// ── API publique ───────────────────────────────────────────────────────
//
// extractFromUrl(reelUrl) → { framePath, mp4Path, cleanup() }
async function extractFromUrl(reelUrl) {
  const mp4 = await downloadReel(reelUrl);
  const frame = await extractFrame(mp4);
  return {
    framePath: frame,
    mp4Path:   mp4,
    cleanup:   function() {
      try { fs.unlinkSync(mp4); }   catch (_) {}
      try { fs.unlinkSync(frame); } catch (_) {}
    }
  };
}

// extractFromMp4(mp4Path) → { framePath, mp4Path:same, cleanup() }
async function extractFromMp4(mp4Path) {
  if (!fs.existsSync(mp4Path)) throw new Error('extractFromMp4: ' + mp4Path + ' introuvable');
  const frame = await extractFrame(mp4Path);
  return {
    framePath: frame,
    mp4Path:   mp4Path,
    cleanup:   function() {
      // Note : on ne supprime pas le mp4 source si fourni par l'utilisateur
      try { fs.unlinkSync(frame); } catch (_) {}
    }
  };
}

// extractFromBuffer(buf, ext='mp4') → { framePath, mp4Path, cleanup() }
async function extractFromBuffer(buf, ext) {
  ensureTmpDir();
  const id = crypto.randomBytes(6).toString('hex');
  const mp4 = path.join(TMP_DIR, 'upload_' + id + '.' + (ext || 'mp4'));
  fs.writeFileSync(mp4, buf);
  const frame = await extractFrame(mp4);
  return {
    framePath: frame,
    mp4Path:   mp4,
    cleanup:   function() {
      try { fs.unlinkSync(mp4); }   catch (_) {}
      try { fs.unlinkSync(frame); } catch (_) {}
    }
  };
}

module.exports = {
  extractFromUrl:    extractFromUrl,
  extractFromMp4:    extractFromMp4,
  extractFromBuffer: extractFromBuffer,
  downloadReel:      downloadReel,
  extractFrame:      extractFrame
};
