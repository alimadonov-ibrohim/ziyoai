'use strict';
/* ============================================================
   ZiyoAI backend — zero dependencies (Node.js 18+)
   - serves ziyoai.html
   - keeps GEMINI_API_KEY on the server (never sent to browser)
   - proxies Gemini streaming (SSE) through /api/chat
   - fetches the real model catalog through /api/models
   ============================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createAuth } = require('./auth');

const ROOT = __dirname;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/* ---------- .env (tiny parser, no dependency) ---------- */
function loadEnv(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch (_) {}
  return out;
}
const ENV = Object.assign({}, loadEnv(path.join(ROOT, '.env')), process.env);
const API_KEY = String(ENV.GEMINI_API_KEY || ENV.GOOGLE_API_KEY || '').trim();
const PORT = Number(ENV.PORT || 3000);
const HOST = ENV.HOST || '0.0.0.0';
const MODELS_CACHE_MS = Number(ENV.MODELS_CACHE_MS || 10 * 60 * 1000);
const auth = createAuth(ENV);

/* Models that currently have a free tier on the Gemini Developer API.
   The API itself does not expose tier info, so this list is a curated hint.
   /api/models still returns EVERY chat model your key can see. */
const FREE_MODEL_PATTERNS = [
  /^gemini-3\.5-flash-lite$/i,
  /^gemini-3\.1-flash-lite(-preview)?$/i,
  /^gemini-3\.6-flash$/i,
  /^gemini-3\.8-flash$/i,
  /^gemini-3-flash-preview$/i,
  /^gemini-2\.5-flash(-lite)?(-preview)?$/i,
  /^gemini-2\.0-flash(-lite)?(-001)?$/i,
  /^gemini-flash-lite-latest$/i,
  /^gemini-flash-latest$/i,
];
const NON_CHAT_RE = /embed|moderation|dall-?e|whisper|tts|audio|transcri|realtime|imagen|veo|aqa|codex|search|rerank|guard|instruct|babbage|davinci|computer-?use|sora|video|music|speech|image|nano-banana|omni|genie|decision|robotics|deep-research|antigravity|lyria|live/i;
// Gemini 2.x catalog entries are still listed by the API, but new keys get 404 from them.
const RETIRED_MODEL_RE = /^gemini-2\./i;

let modelsCache = { at: 0, data: null, inflight: null };

/* ---------- helpers ---------- */
// Allow the single file to be opened via file:// (origin "null") or localhost.
function corsHeaders(req) {
  const origin = String((req && req.headers && req.headers.origin) || '');
  const allowed = origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (!allowed) return {};
  return { 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' };
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }, corsHeaders(res.ziyoReq)));
  res.end(body);
}
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limitBytes || 12 * 1024 * 1024)) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function ctxLabel(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}
function isFree(id) { return FREE_MODEL_PATTERNS.some((r) => r.test(id)); }
function upstreamError(res, status, detail) {
  json(res, status, { error: { code: status, message: detail } });
}

/* ---------- Gemini: model catalog ---------- */
async function fetchGeminiModels() {
  const url = GEMINI_BASE + '/models';
  const res = await fetch(url, { headers: { 'x-goog-api-key': API_KEY } });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try { const j = JSON.parse(text); msg = (j.error && j.error.message) || j.message || msg; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const payload = JSON.parse(text);
  const rows = Array.isArray(payload.models) ? payload.models : [];
  const seen = new Set();
  const models = [];
  for (const m of rows) {
    const id = String(m.name || '').replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    if (!methods.includes('generateContent')) continue;
    if (NON_CHAT_RE.test(id)) continue;
    if (RETIRED_MODEL_RE.test(id)) continue;
    seen.add(id);
    const free = isFree(id);
    models.push({
      model: id,
      name: m.displayName || id,
      description: String(m.description || '').slice(0, 300),
      inputTokenLimit: m.inputTokenLimit || null,
      outputTokenLimit: m.outputTokenLimit || null,
      ctx: ctxLabel(m.inputTokenLimit),
      vision: true,
      free,
      tier: free ? 'free' : 'api',
      supportedGenerationMethods: methods,
    });
  }
  // free models first, then by name
  models.sort((a, b) => (b.free - a.free) || a.name.localeCompare(b.name));
  return { fetchedAt: Date.now(), total: rows.length, count: models.length, models };
}
async function getModels(refresh) {
  const now = Date.now();
  if (!refresh && modelsCache.data && now - modelsCache.at < MODELS_CACHE_MS) return modelsCache.data;
  if (modelsCache.inflight) return modelsCache.inflight;
  modelsCache.inflight = (async () => {
    const data = await fetchGeminiModels();
    modelsCache = { at: Date.now(), data, inflight: null };
    return data;
  })().catch((e) => { modelsCache.inflight = null; throw e; });
  return modelsCache.inflight;
}

/* ---------- Gemini: streaming chat ---------- */
async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return upstreamError(res, 400, e.message); }

  const model = String(body.model || '').replace(/^gemini:/, '').trim();
  if (!model || !/^[\w.\-]+$/.test(model)) return upstreamError(res, 400, 'Invalid model id');
  if (!Array.isArray(body.contents) || !body.contents.length) return upstreamError(res, 400, 'contents must be a non-empty array');

  const payload = { contents: body.contents };
  if (body.systemInstruction) payload.systemInstruction = body.systemInstruction;
  if (body.generationConfig && typeof body.generationConfig === 'object') payload.generationConfig = body.generationConfig;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(
      GEMINI_BASE + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );
  } catch (e) {
    return upstreamError(res, 502, 'Could not reach Gemini API: ' + e.message);
  }
  if (!upstream.ok) {
    const txt = await upstream.text();
    let detail = txt.slice(0, 600);
    try { const j = JSON.parse(txt); detail = (j.error && j.error.message) || j.message || detail; } catch (_) {}
    return upstreamError(res, upstream.status, detail);
  }

  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  }, corsHeaders(req)));
  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) res.write(chunk);
    }
    res.write('data: [DONE]\n\n');
  } catch (e) {
    if (!controller.signal.aborted) res.write('event: error\ndata: ' + JSON.stringify({ message: String(e.message || e) }) + '\n\n');
  } finally {
    res.end();
  }
}

/* ---------- static files ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '/index.html') rel = '/ziyoai.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^([\\/])+/, ''));
  if (!file.startsWith(ROOT)) return upstreamError(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return upstreamError(res, 404, 'Not found: ' + rel);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ---------- router (works both as a Node server and a Vercel function) ---------- */
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  res.ziyoReq = req;

  try {
    if (req.method === 'OPTIONS' && p.startsWith('/api/')) {
      res.writeHead(204, Object.assign({
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-goog-api-key',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      }, corsHeaders(req)));
      return res.end();
    }
    // Real sign-up / sign-in: password accounts + Google, GitHub, Telegram.
    const authHandled = await auth.handle(req, res, url);
    if (authHandled !== null) return authHandled;

    if (p === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: !!API_KEY,
        apiKeyConfigured: !!API_KEY,
        provider: 'gemini',
        base: GEMINI_BASE,
        modelsEndpoint: '/api/models',
        hint: API_KEY ? 'Gemini API key loaded on server' : 'Add GEMINI_API_KEY to .env and restart',
      });
    }
    if (p === '/api/models' && req.method === 'GET') {
      if (!API_KEY) return json(res, 503, { error: { code: 503, message: 'GEMINI_API_KEY is not configured on the server' } });
      try {
        const data = await getModels(url.searchParams.get('refresh') === '1');
        return json(res, 200, data);
      } catch (e) {
        return upstreamError(res, e.status && e.status < 600 ? e.status : 502, e.message);
      }
    }
    if (p === '/api/chat' && req.method === 'POST') {
      if (!API_KEY) return upstreamError(res, 503, 'GEMINI_API_KEY is not configured on the server');
      return await handleChat(req, res);
    }
    if (p.startsWith('/api/')) return upstreamError(res, 404, 'Unknown API endpoint');
    if (req.method !== 'GET' && req.method !== 'HEAD') return upstreamError(res, 405, 'Method not allowed');
    return serveStatic(p, res);
  } catch (e) {
    if (!res.headersSent) upstreamError(res, 500, e.message || 'Internal error');
    else res.end();
  }
}

module.exports = handleRequest;
module.exports.handleRequest = handleRequest;

if (require.main === module) {
  const server = http.createServer((req, res) => { handleRequest(req, res); });
  server.listen(PORT, HOST, () => {
    console.log('ZiyoAI backend ready: http://localhost:' + PORT);
    console.log('Auth endpoints ready: password / Google / GitHub / Telegram (configure credentials in .env).');
    if (!API_KEY) console.warn('WARNING: GEMINI_API_KEY is not set. Copy .env.example -> .env and add your key.');
    else console.log('Gemini API key loaded from ' + (ENV.GEMINI_API_KEY ? '.env/environment' : 'GOOGLE_API_KEY') + '.');
  });
}
