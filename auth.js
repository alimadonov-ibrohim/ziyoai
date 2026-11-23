'use strict';
/* ============================================================
   ZiyoAI server-side authentication — zero dependencies
   - email + password (scrypt hash, signed session cookie)
   - Google OAuth 2.0
   - GitHub OAuth 2.0
   - Telegram Login (widget signature verification)
   ============================================================ */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
// Vercel's filesystem is read-only except /tmp. Set AUTH_SECRET there so
// sessions stay valid across cold starts; user records live in /tmp.
const ON_VERCEL = !!process.env.VERCEL;
const DATA_DIR = ON_VERCEL ? path.join(os.tmpdir(), 'ziyoai-data') : path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = ON_VERCEL ? path.join(os.tmpdir(), 'ziyoai-auth-secret') : path.join(ROOT, '.auth-secret');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function createAuth(env) {
  const PORT = Number(env.PORT || 3000);
  const BASE_URL = String(env.PUBLIC_URL || env.BASE_URL || ('http://localhost:' + PORT)).replace(/\/+$/, '');

  let secret = String(env.AUTH_SECRET || '').trim();
  if (!secret) {
    try { secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    } catch (_) {}
    if (ON_VERCEL) {
      console.warn('[auth] AUTH_SECRET is not set — sessions will reset on every cold start. Set it in Vercel env vars.');
    }
  }

  const cfg = {
    google: {
      clientId: String(env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: String(env.GOOGLE_CLIENT_SECRET || '').trim(),
    },
    github: {
      clientId: String(env.GITHUB_CLIENT_ID || '').trim(),
      clientSecret: String(env.GITHUB_CLIENT_SECRET || '').trim(),
    },
    telegram: {
      token: String(env.TELEGRAM_BOT_TOKEN || '').trim(),
      username: String(env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, ''),
    },
  };

  /* ---------- storage ---------- */
  function loadUsers() {
    try {
      const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch (_) { return []; }
  }
  function saveUsers(list) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  }
  function publicUser(u) {
    return { email: u.email, name: u.name || u.email.split('@')[0], provider: u.provider || 'password' };
  }
  function upsert(profile) {
    const list = loadUsers();
    let u = list.find(x => x.email === profile.email);
    if (!u) {
      u = Object.assign({ createdAt: Date.now() }, profile);
      list.push(u);
    } else {
      u.name = profile.name || u.name;
      u.provider = profile.provider || u.provider;
      u.providerId = profile.providerId || u.providerId;
    }
    saveUsers(list);
    return publicUser(u);
  }

  /* ---------- signed tokens / cookies ---------- */
  function hmac(data) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
  }
  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return body + '.' + hmac(body);
  }
  function unsign(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = hmac(parts[0]);
    if (parts[1].length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
    try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
    catch (_) { return null; }
  }
  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function setSession(res, user) {
    const token = sign({ email: user.email, name: user.name, provider: user.provider, exp: Date.now() + SESSION_MAX_AGE * 1000 });
    res.setHeader('Set-Cookie', 'ziyo_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_MAX_AGE);
  }
  function currentUser(req) {
    const s = unsign(parseCookies(req).ziyo_session);
    if (!s || !s.email || !s.exp || s.exp < Date.now()) return null;
    const u = loadUsers().find(x => x.email === s.email);
    return u ? publicUser(u) : null;
  }

  /* ---------- http helpers ---------- */
  function send(res, status, obj, req) {
    const body = JSON.stringify(obj);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Credentials': 'true',
    };
    const origin = String((req && req.headers && req.headers.origin) || '');
    if (origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      headers['Access-Control-Allow-Origin'] = origin || '*';
      headers.Vary = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(body);
  }
  function redirect(res, url) {
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    res.end();
  }
  function finish(res, req, user) {
    setSession(res, user);
    redirect(res, BASE_URL + '/?auth_ok=' + encodeURIComponent(user.provider) + '#/chat');
  }
  function failRedirect(res, message) {
    redirect(res, BASE_URL + '/?auth_error=' + encodeURIComponent(String(message).slice(0, 200)) + '#/chat');
  }
  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1024 * 1024) throw new Error('Request too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function stateFor(provider) {
    return sign({ purpose: 'oauth:' + provider, iat: Date.now() });
  }
  function validState(provider, state) {
    const s = unsign(state);
    return !!s && s.purpose === 'oauth:' + provider && Date.now() - s.iat < 10 * 60 * 1000;
  }

  /* ---------- password auth ---------- */
  function register(body) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim().slice(0, 40);
    if (!EMAIL_RE.test(email)) return { status: 400, error: 'Enter a valid email address.' };
    if (password.length < 6) return { status: 400, error: 'Password must be at least 6 characters.' };
    const list = loadUsers();
    if (list.some(u => u.email === email)) return { status: 409, error: 'An account with this email already exists.' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const user = { email, name: name || email.split('@')[0], provider: 'password', salt, hash, createdAt: Date.now() };
    list.push(user);
    saveUsers(list);
    return { status: 200, user: publicUser(user) };
  }
  function login(body) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const u = loadUsers().find(x => x.email === email);
    if (!u || !u.hash) return { status: 401, error: 'Invalid email or password.' };
    const calc = crypto.scryptSync(password, u.salt, 64);
    const expected = Buffer.from(u.hash, 'hex');
    if (calc.length !== expected.length || !crypto.timingSafeEqual(calc, expected)) {
      return { status: 401, error: 'Invalid email or password.' };
    }
    return { status: 200, user: publicUser(u) };
  }

  /* ---------- OAuth providers ---------- */
  function cfgError(provider) {
    return provider === 'telegram'
      ? 'Telegram login is not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME to .env.'
      : provider.charAt(0).toUpperCase() + provider.slice(1) + ' login is not configured. Add its client credentials to .env.';
  }
  function oauthStart(res, provider) {
    const c = cfg[provider];
    if (!c.clientId) return failRedirect(res, cfgError(provider));

    // Google without a Client Secret: OpenID Connect implicit flow. The ID token
    // comes back in the URL fragment to our callback page, which posts it here
    // for signature verification. No secret is needed — only the Client ID.
    if (provider === 'google' && !c.clientSecret) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const state = sign({ purpose: 'google-implicit', nonce, iat: Date.now() });
      res.setHeader('Set-Cookie', 'ziyo_google_state=' + state + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600');
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: BASE_URL + '/google-callback.html',
        response_type: 'id_token',
        scope: 'openid email profile',
        state,
        nonce,
        prompt: 'select_account',
      });
      return redirect(res, url.toString());
    }

    if (!c.clientSecret) return failRedirect(res, cfgError(provider));
    const redirectUri = BASE_URL + '/api/auth/' + provider + '/callback';
    const state = stateFor(provider);
    let url;
    if (provider === 'google') {
      url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
    } else {
      url = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri,
        scope: 'user:email',
        state,
      });
    }
    redirect(res, url.toString());
  }
  async function oauthCallback(req, res, provider, url) {
    try {
      const code = String(url.searchParams.get('code') || '');
      const state = String(url.searchParams.get('state') || '');
      if (!code || !validState(provider, state)) return failRedirect(res, 'Invalid or expired login state. Please try again.');
      const c = cfg[provider];
      if (!c.clientId || !c.clientSecret) return failRedirect(res, cfgError(provider));
      const redirectUri = BASE_URL + '/api/auth/' + provider + '/callback';

      let tokenRes, profile;
      if (provider === 'google') {
        tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, client_id: c.clientId, client_secret: c.clientSecret,
            redirect_uri: redirectUri, grant_type: 'authorization_code',
          }),
        });
        if (!tokenRes.ok) return failRedirect(res, 'Google token exchange failed (HTTP ' + tokenRes.status + ').');
        const tokens = await tokenRes.json();
        const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: 'Bearer ' + tokens.access_token },
        });
        if (!infoRes.ok) return failRedirect(res, 'Could not read Google profile.');
        const info = await infoRes.json();
        if (!info.email) return failRedirect(res, 'Google did not return an email address.');
        profile = {
          email: String(info.email).toLowerCase(),
          name: String(info.name || info.email.split('@')[0]).slice(0, 60),
          provider: 'google',
          providerId: String(info.sub || info.email),
        };
      } else {
        tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirectUri }),
        });
        if (!tokenRes.ok) return failRedirect(res, 'GitHub token exchange failed (HTTP ' + tokenRes.status + ').');
        const tokens = await tokenRes.json();
        if (!tokens.access_token) return failRedirect(res, tokens.error_description || 'GitHub did not return an access token.');
        const headers = { Authorization: 'Bearer ' + tokens.access_token, 'User-Agent': 'ZiyoAI' };
        const userRes = await fetch('https://api.github.com/user', { headers });
        if (!userRes.ok) return failRedirect(res, 'Could not read GitHub profile.');
        const info = await userRes.json();
        let email = info.email;
        if (!email) {
          const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
          if (emailsRes.ok) {
            const rows = await emailsRes.json();
            const primary = (Array.isArray(rows) ? rows : []).find(x => x.primary && x.verified) || rows[0];
            if (primary) email = primary.email;
          }
        }
        profile = {
          email: String(email || (info.login + '@users.noreply.github.com')).toLowerCase(),
          name: String(info.name || info.login || 'GitHub user').slice(0, 60),
          provider: 'github',
          providerId: String(info.id || info.login),
        };
      }
      finish(res, req, upsert(profile));
    } catch (e) {
      failRedirect(res, 'Login failed: ' + (e.message || e));
    }
  }
  /* ---------- Google ID token (implicit flow, no client secret) ---------- */
  let jwksCache = { at: 0, keys: [] };
  async function googleKeys() {
    if (jwksCache.keys.length && Date.now() - jwksCache.at < 60 * 60 * 1000) return jwksCache.keys;
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!res.ok) throw new Error('Could not load Google signing keys');
    const j = await res.json();
    jwksCache = { at: Date.now(), keys: Array.isArray(j.keys) ? j.keys : [] };
    return jwksCache.keys;
  }
  function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }
  async function verifyGoogleIdToken(idToken, nonce) {
    const parts = String(idToken).split('.');
    if (parts.length !== 3) throw new Error('Malformed Google ID token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const keys = await googleKeys();
    const jwk = keys.find(k => k.kid === header.kid) || keys.find(k => k.kty === 'RSA');
    if (!jwk) throw new Error('Google signing key not found');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]),
      key,
      Buffer.from(parts[2], 'base64url')
    );
    if (!valid) throw new Error('Invalid Google ID token signature');
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) throw new Error('Wrong token issuer');
    if (payload.aud !== cfg.google.clientId) throw new Error('Token was issued for a different app');
    if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('Google ID token expired');
    if (nonce && payload.nonce !== nonce) throw new Error('Login nonce mismatch');
    if (!payload.email) throw new Error('Google did not return an email address');
    return {
      email: String(payload.email).toLowerCase(),
      name: String(payload.name || payload.email.split('@')[0]).slice(0, 60),
      provider: 'google',
      providerId: String(payload.sub || payload.email),
    };
  }
  async function googleTokenExchange(req, res) {
    try {
      const body = await readJson(req);
      const postedState = String(body.state || '');
      const cookieState = String(parseCookies(req).ziyo_google_state || '');
      if (!postedState || postedState !== cookieState) return send(res, 400, { ok: false, error: 'Invalid login state.' }, req);
      const s = unsign(postedState);
      if (!s || s.purpose !== 'google-implicit' || Date.now() - s.iat > 10 * 60 * 1000) {
        return send(res, 400, { ok: false, error: 'Expired login state.' }, req);
      }
      const profile = await verifyGoogleIdToken(body.id_token, s.nonce);
      const user = upsert(profile);
      // Clear the one-time state cookie and start the real session.
      res.setHeader('Set-Cookie', [
        'ziyo_google_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        'ziyo_session=' + sign({ email: user.email, name: user.name, provider: user.provider, exp: Date.now() + SESSION_MAX_AGE * 1000 }) +
          '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_MAX_AGE,
      ]);
      return send(res, 200, { ok: true, user, redirect: BASE_URL + '/?auth_ok=google#/chat' }, req);
    } catch (e) {
      return send(res, 401, { ok: false, error: 'Google sign-in failed: ' + (e.message || e) }, req);
    }
  }

  function telegramCallback(req, res, url) {
    if (!cfg.telegram.token) return failRedirect(res, cfgError('telegram'));
    const params = url.searchParams;
    const hash = String(params.get('hash') || '');
    if (!hash) return failRedirect(res, 'Telegram did not return a signature.');
    const check = [...params.entries()]
      .filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k + '=' + v)
      .join('\n');
    const key = crypto.createHash('sha256').update(cfg.telegram.token).digest();
    const expected = crypto.createHmac('sha256', key).update(check).digest('hex');
    if (expected.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) {
      return failRedirect(res, 'Telegram signature is invalid.');
    }
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) {
      return failRedirect(res, 'Telegram login has expired. Please try again.');
    }
    const id = String(params.get('id') || '');
    if (!id) return failRedirect(res, 'Telegram did not return a user id.');
    const name = [params.get('first_name'), params.get('last_name')].filter(Boolean).join(' ')
      || params.get('username') || 'Telegram user';
    finish(res, req, upsert({
      email: id + '@telegram.local',
      name: String(name).slice(0, 60),
      provider: 'telegram',
      providerId: id,
    }));
  }

  /* ---------- router ---------- */
  async function handle(req, res, url) {
    const p = url.pathname;

    if (p === '/api/auth/config' && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        methods: {
          password: true,
          google: !!cfg.google.clientId,
          github: !!(cfg.github.clientId && cfg.github.clientSecret),
          telegram: !!(cfg.telegram.token && cfg.telegram.username),
        },
        telegramBot: cfg.telegram.username,
        baseUrl: BASE_URL,
      }, req);
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
      const user = currentUser(req);
      return user ? send(res, 200, { ok: true, user }, req) : send(res, 401, { ok: false }, req);
    }
    if ((p === '/api/auth/register' || p === '/api/auth/login') && req.method === 'POST') {
      let body;
      try { body = await readJson(req); }
      catch (e) { return send(res, 400, { ok: false, error: 'Invalid request.' }, req); }
      const result = p.endsWith('register') ? register(body) : login(body);
      if (result.error) return send(res, result.status, { ok: false, error: result.error }, req);
      setSession(res, result.user);
      return send(res, 200, { ok: true, user: result.user }, req);
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'ziyo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return send(res, 200, { ok: true }, req);
    }
    if (p === '/api/auth/google' && req.method === 'GET') return oauthStart(res, 'google');
    if (p === '/api/auth/google/token' && req.method === 'POST') return await googleTokenExchange(req, res);
    if (p === '/api/auth/google/callback' && req.method === 'GET') return oauthCallback(req, res, 'google', url);
    if (p === '/api/auth/github' && req.method === 'GET') return oauthStart(res, 'github');
    if (p === '/api/auth/github/callback' && req.method === 'GET') return oauthCallback(req, res, 'github', url);
    if (p === '/api/auth/telegram' && req.method === 'GET') return telegramCallback(req, res, url);
    return null;
  }

  return { handle, currentUser, config: () => ({ baseUrl: BASE_URL, telegramBot: cfg.telegram.username }) };
}

module.exports = { createAuth };
