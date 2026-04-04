const express = require('express');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3001;
const ONEUP_KEY = process.env.ONEUP_API_KEY || '';
const ONEUP_BASE = 'https://www.oneupapp.io';

// Allowed origins
const ALLOWED_ORIGINS = [
  'https://ofm-dashboard.onrender.com',
  'http://localhost',
  'http://127.0.0.1'
];

app.use(function(req, res, next) {
  var origin = req.headers.origin || '';
  var allowed = ALLOWED_ORIGINS.some(function(o) { return origin.startsWith(o); });
  if (allowed || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check
app.get('/health', function(req, res) {
  res.json({ status: 'ok', proxy: 'oneup' });
});

// Proxy GET requests
app.get('/api/*', async function(req, res) {
  try {
    var path   = req.path; // e.g. /api/listcategory
    var params = new URLSearchParams(req.query);
    params.set('apiKey', ONEUP_KEY);
    var url    = ONEUP_BASE + path + '?' + params.toString();
    var r      = await fetch(url);
    var data   = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy POST requests (form-encoded)
app.post('/api/*', async function(req, res) {
  try {
    var path = req.path;
    var body = new URLSearchParams(req.body);
    body.set('apiKey', ONEUP_KEY);
    var r    = await fetch(ONEUP_BASE + path, {
      method: 'POST',
      body:   body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    var data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, function() {
  console.log('OneUp proxy running on port ' + PORT);
});
