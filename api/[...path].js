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
  res.setHeader('Access-Control-Allow-Origin', ok ? origin : '');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Build OneUp path from Vercel's path params
  var pathParts = req.query.path || [];
  var apiPath   = '/api/' + (Array.isArray(pathParts) ? pathParts.join('/') : pathParts);

  try {
    if (req.method === 'GET') {
      var params = new URLSearchParams();
      params.set('apiKey', ONEUP_KEY);
      Object.keys(req.query).forEach(function(k) {
        if (k !== 'path') params.set(k, req.query[k]);
      });
      var r    = await fetch(ONEUP_BASE + apiPath + '?' + params.toString());
      var data = await r.json();
      res.json(data);

    } else if (req.method === 'POST') {
      var body = new URLSearchParams();
      body.set('apiKey', ONEUP_KEY);
      // req.body is already parsed by Vercel for application/x-www-form-urlencoded
      var payload = req.body || {};
      Object.keys(payload).forEach(function(k) { body.set(k, payload[k]); });
      var r    = await fetch(ONEUP_BASE + apiPath, {
        method:  'POST',
        body:    body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      var data = await r.json();
      res.json(data);
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
