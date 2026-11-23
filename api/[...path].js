'use strict';
/* Vercel catch-all function: every /api/* request lands here.
   The local server and this function share the exact same router. */

const { handleRequest } = require('../server.js');

module.exports = async function handler(req, res) {
  // With a catch-all route Vercel exposes the real path as req.query.path.
  // Restore it so server.js sees the same URL it does during `npm start`.
  const segs = req.query && req.query.path;
  if (Array.isArray(segs) && segs.length) {
    req.url = '/' + segs.map(s => encodeURIComponent(String(s))).join('/');
  }
  await handleRequest(req, res);
};
