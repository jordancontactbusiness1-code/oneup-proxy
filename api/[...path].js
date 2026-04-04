const fetch = require('node-fetch');

const ONEUP_KEY  = process.env.ONEUP_API_KEY || '';
const ONEUP_BASE = 'https://www.oneupapp.io';

const ALLOWED = [
  'https://ofm-dashboard.onrender.com',
  'http://localhost',
  'http://127.0.0.1'
];

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  var ok = ALLOWED.some(function(o) { return origin.startsWith(o); });
  res.setHeader('Access-Control-Allow-Origin', ok ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Extract path from URL: /api/listcategory → /api/listcategory on OneUp
  var rawUrl   = req.url || '';
  var urlPath  = rawUrl.split('?')[0]; // e.g. /api/listcategory
  // Remove the Vercel function prefix if present (Vercel may strip it already)
  var apiPath  = urlPath.startsWith('/api/') ? urlPath : '/api/' + urlPath.replace(/^\/+/, '');
  // Fallback: use query param path if URL path is just /api
  if (apiPath === '/api/' || apiPath === '/api') {
    var qPath = req.query.path;
    if (qPath) {
      apiPath = '/api/' + (Array.isArray(qPath) ? qPath.join('/') : qPath);
    }
  }

  try {
    if (req.method === 'GET') {
      var params = new URLSearchParams();
      params.set('apiKey', ONEUP_KEY);
      Object.keys(req.query).forEach(function(k) {
        if (k !== 'path') params.set(k, req.query[k]);
      });
      var r    = await fetch(ONEUP_BASE + apiPath + '?' + params.toString());
      var text = await r.text();
      try { res.json(JSON.parse(text)); } catch(e) { res.status(502).json({ error: 'OneUp returned non-JSON', body: text.slice(0, 200) }); }

    } else if (req.method === 'POST') {
      var body = new URLSearchParams();
      body.set('apiKey', ONEUP_KEY);
      var payload = req.body || {};
      Object.keys(payload).forEach(function(k) { body.set(k, payload[k]); });
      var r    = await fetch(ONEUP_BASE + apiPath, {
        method:  'POST',
        body:    body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      var text = await r.text();
      try { res.json(JSON.parse(text)); } catch(e) { res.status(502).json({ error: 'OneUp returned non-JSON', body: text.slice(0, 200) }); }
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
