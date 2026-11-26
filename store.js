'use strict';
/* ============================================================
   Persistent user store for ZiyoAI auth.
   Priority: PostgreSQL (DATABASE_URL) -> Upstash Redis REST
             -> local JSON file (development only).
   All methods are async so the same code works on Vercel's
   serverless runtime, where the filesystem is read-only.
   ============================================================ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseBoolUrl(url) {
  return /localhost|127\.0\.0\.1|\[::1\]/.test(url) ? false : 'require';
}

function createFileStore(env) {
  const ON_VERCEL = !!process.env.VERCEL;
  const dir = ON_VERCEL ? path.join(os.tmpdir(), 'ziyoai-data') : path.join(__dirname, 'data');
  const file = path.join(dir, 'users.json');
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch (_) { return []; }
  }
  function write(list) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
  }
  return {
    name: 'file',
    async getUser(email) { return read().find((u) => u.email === email) || null; },
    async putUser(user) {
      const list = read();
      const i = list.findIndex((u) => u.email === user.email);
      if (i === -1) list.push(user); else list[i] = user;
      write(list);
    },
  };
}

function createUpstashStore(url, token) {
  const base = url.replace(/\/+$/, '');
  async function call(method, command, key, value) {
    const target = base + '/' + command + '/' + encodeURIComponent(key);
    const headers = { Authorization: 'Bearer ' + token };
    const init = { method, headers };
    if (value !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(value);
    }
    const res = await fetch(target, init);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new Error('Upstash returned invalid JSON (HTTP ' + res.status + ')'); }
    if (!res.ok || json.error) throw new Error(json.error || ('Upstash HTTP ' + res.status));
    return json.result;
  }
  return {
    name: 'upstash',
    async getUser(email) {
      const raw = await call('GET', 'get', 'ziyo:user:' + email);
      if (!raw) return null;
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
    },
    async putUser(user) {
      await call('POST', 'set', 'ziyo:user:' + user.email, JSON.stringify(user));
    },
  };
}

function createPostgresStore(url) {
  // Loaded lazily: local/dev installs without a DB need no npm dependency.
  let postgres;
  try { postgres = require('postgres'); }
  catch (e) { throw new Error('DATABASE_URL is set but the "postgres" package is missing. Run npm install.'); }

  const sql = postgres(url, {
    max: 2,
    prepare: false, // works with PgBouncer / Supabase transaction poolers
    ssl: parseBoolUrl(url),
    connect_timeout: 10,
  });
  let schemaReady = null;
  async function ready() {
    if (!schemaReady) {
      schemaReady = sql`CREATE TABLE IF NOT EXISTS ziyo_users (
        email text PRIMARY KEY,
        name text,
        provider text,
        provider_id text,
        salt text,
        hash text,
        created_at bigint NOT NULL DEFAULT 0,
        data jsonb NOT NULL DEFAULT '{}'::jsonb
      )`;
    }
    await schemaReady;
  }
  function fromRow(row) {
    if (!row) return null;
    return {
      email: row.email,
      name: row.name || row.email.split('@')[0],
      provider: row.provider || 'password',
      providerId: row.provider_id || undefined,
      salt: row.salt || undefined,
      hash: row.hash || undefined,
      createdAt: Number(row.created_at) || 0,
    };
  }
  return {
    name: 'postgres',
    async getUser(email) {
      await ready();
      const rows = await sql`SELECT * FROM ziyo_users WHERE email = ${email} LIMIT 1`;
      return fromRow(rows[0]);
    },
    async putUser(user) {
      await ready();
      await sql`INSERT INTO ziyo_users
        (email, name, provider, provider_id, salt, hash, created_at, data)
        VALUES (${user.email}, ${user.name || null}, ${user.provider || null},
                ${user.providerId || null}, ${user.salt || null}, ${user.hash || null},
                ${Number(user.createdAt) || Date.now()}, ${sql.json({})})
        ON CONFLICT (email) DO UPDATE SET
          name = EXCLUDED.name,
          provider = EXCLUDED.provider,
          provider_id = EXCLUDED.provider_id,
          salt = EXCLUDED.salt,
          hash = EXCLUDED.hash,
          data = EXCLUDED.data`;
    },
  };
}

function createStore(env) {
  const databaseUrl = String(env.DATABASE_URL || env.POSTGRES_URL || '').trim();
  const upstashUrl = String(env.UPSTASH_REDIS_REST_URL || '').trim();
  const upstashToken = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (databaseUrl) {
    try { return createPostgresStore(databaseUrl); }
    catch (e) { console.error('[store] ' + e.message + ' Falling back to file storage.'); }
  }
  if (upstashUrl && upstashToken) return createUpstashStore(upstashUrl, upstashToken);
  return createFileStore(env);
}

module.exports = { createStore };
