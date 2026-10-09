'use strict';
const crypto = require('crypto');
const store = require('./store');

function hash(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex') };
}
function verifyPassword(pw) {
  const a = store.readJson('auth.json', null); if (!a) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(a.salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(a.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
function setPassword(pw) {
  const h = hash(pw);
  store.writeJson('auth.json', { salt: h.salt, hash: h.hash, v: ((store.readJson('auth.json', {}) || {}).v || 0) + 1 });
}
function authVersion() { return (store.readJson('auth.json', {}) || {}).v || 0; }
function hasPassword() { return !!store.readJson('auth.json', null); }
// First run: create the password from ADMIN_PASSWORD (then it can be changed inside the dashboard).
function bootstrap() {
  if (hasPassword()) return 'ready';
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 10) { setPassword(process.env.ADMIN_PASSWORD); return 'created'; }
  return 'missing';
}

const b64 = (b) => Buffer.from(b).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return body + '.' + crypto.createHmac('sha256', store.secret()).update(body).digest('base64url');
}
function readToken(tok) {
  if (typeof tok !== 'string' || tok.length > 600) return null;
  const [body, sig] = tok.split('.'); if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', store.secret()).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p || p.exp < Date.now() || p.v !== authVersion()) return null; return p;
  } catch (e) { return null; }
}
const SESSION_MS = 12 * 3600 * 1000;
const newToken = () => sign({ exp: Date.now() + SESSION_MS, v: authVersion(), n: crypto.randomBytes(8).toString('hex') });

// Simple sliding-window rate limiter (in memory).
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

module.exports = { bootstrap, verifyPassword, setPassword, newToken, readToken, limited, SESSION_MS };
