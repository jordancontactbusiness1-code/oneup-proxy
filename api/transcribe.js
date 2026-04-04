const https = require('https');

function doRequest(options, body) {
  return new Promise(function(resolve, reject) {
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ error: true, message: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  var allowed = ['https://ofm-dashboard.onrender.com', 'http://localhost', 'http://127.0.0.1'];
  var isAllowed = allowed.some(function(o) { return origin.startsWith(o); });
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : 'https://ofm-dashboard.onrender.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: true, message: 'Method not allowed' }); return; }

  var ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!ASSEMBLYAI_KEY) { res.status(500).json({ error: true, message: 'ASSEMBLYAI_API_KEY not configured' }); return; }

  var body = await new Promise(function(resolve) {
    var d = '';
    req.on('data', function(c) { d += c; });
    req.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
  });

  var action = body.action || 'submit';
  var transcriptId = body.transcript_id;
  var audioUrl = body.audio_url;

  if (action === 'submit') {
    if (!audioUrl) { res.status(400).json({ error: true, message: 'audio_url required' }); return; }
    var submitBody = JSON.stringify({ audio_url: audioUrl, language_detection: true });
    var result = await doRequest({
      hostname: 'api.assemblyai.com',
      path: '/v2/transcript',
      method: 'POST',
      headers: { 'Authorization': ASSEMBLYAI_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(submitBody) }
    }, submitBody);
    res.status(200).json(result);

  } else if (action === 'poll') {
    if (!transcriptId) { res.status(400).json({ error: true, message: 'transcript_id required' }); return; }
    var result = await doRequest({
      hostname: 'api.assemblyai.com',
      path: '/v2/transcript/' + transcriptId,
      method: 'GET',
      headers: { 'Authorization': ASSEMBLYAI_KEY }
    });
    res.status(200).json(result);
  } else {
    res.status(400).json({ error: true, message: 'Invalid action' });
  }
};
