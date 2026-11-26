'use strict';
/* Vercel catch-all function: every /api/* request lands here.
   The local server and this function share the exact same router. */

const { handleRequest } = require('../server.js');

module.exports = async function handler(req, res) {
  // With a catch-all route Vercel exposes the real path as req.query.path.
  // Restore it so server.js sees the same URL it does during `npm start`.
  const query = req.query || {};
  const segs = query.path;
  if (Array.isArray(segs) && segs.length) {
    // Keep query params (e.g. ?refresh=1) that Vercel puts in req.query.
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === 'path') continue;
      if (Array.isArray(value)) value.forEach(v => params.append(key, String(v)));
      else if (value !== undefined) params.append(key, String(value));
    }
    const suffix = params.toString();
    req.url = '/' + segs.map(s => encodeURIComponent(String(s))).join('/') + (suffix ? '?' + suffix : '');
  }
  await handleRequest(req, res);
};
