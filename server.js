'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const store = require('./lib/store'), auth = require('./lib/auth'), fax = require('./lib/fax'), slots = require('./lib/slots');
const { render } = require('./lib/faxdoc');
const { nowLocal, validDate, validTime, addDays, longDate, clock12, TZ } = require('./lib/tz');

const PORT = +process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY = 160 * 1024;
const authState = auth.bootstrap();

const LABELS = { ailment: 'MINOR AILMENT APPOINTMENT', vaccine: 'VACCINATION APPOINTMENT' };
const RX_LABELS = { new: 'NEW PRESCRIPTION REQUEST', refill: 'PRESCRIPTION REFILL REQUEST', transfer: 'PRESCRIPTION TRANSFER REQUEST', renewal: 'PRESCRIPTION RENEWAL REQUEST' };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain', '.woff2': 'font/woff2' };

const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o })); // never include form content

function ip(req) {
  if (TRUST_PROXY) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
  return req.socket.remoteAddress || '?';
}
function send(res, code, obj, extra) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...(extra || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch (e) { reject(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const o = {}; for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); } return o;
}
const secure = (req) => process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
function setSession(req, res, tok) {
  res.setHeader('Set-Cookie', `sv_admin=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${tok ? auth.SESSION_MS / 1000 : 0}${secure(req) ? '; Secure' : ''}`);
}
const isAdmin = (req) => !!auth.readToken(cookies(req).sv_admin);

const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// ---------- fax model validation ----------
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, n);
function cleanSections(secs) {
  if (!Array.isArray(secs) || !secs.length || secs.length > 30) return null;
  const out = [];
  for (const s of secs) {
    if (!s || typeof s.h !== 'string' || !Array.isArray(s.rows) || s.rows.length > 120) return null;
    const rows = [];
    for (const r of s.rows) {
      if (!r || typeof r !== 'object') return null;
      if (typeof r.consent === 'string') rows.push({ consent: clip(r.consent, 3000), on: !!r.on });
      else if (typeof r.q === 'string') {
        const row = { q: clip(r.q, 600) };
        if (Array.isArray(r.opts)) { if (r.opts.length > 60) return null; row.opts = r.opts.map((o) => ({ t: clip(o && o.t, 400), on: !!(o && o.on) })); }
        else row.a = clip(r.a, 4000);
        rows.push(row);
      } else return null;
    }
    out.push({ h: clip(s.h, 120), rows });
  }
  return out;
}

// ---------- public API ----------
async function apiSlots(req, res) {
  const cfg = store.getConfig();
  send(res, 200, { tz: TZ, slotMinutes: cfg.slotMinutes, days: slots.availableDays(cfg, store.getBookings()) });
}

async function apiSubmit(req, res) {
  if (auth.limited('submit:' + ip(req), 10, 3600e3)) return send(res, 429, { error: 'rate', message: 'Too many requests from this connection. Please call the pharmacy at (613) 253-3334.' });
  let b; try { b = await readBody(req); } catch (e) { return send(res, e.code || 400, { error: 'bad_request' }); }
  if (b.website) return send(res, 200, { ok: true, ref: 'OK' }); // honeypot: bots fill hidden fields
  const kind = b.kind;
  if (kind !== 'ailment' && kind !== 'vaccine' && kind !== 'rx') return send(res, 400, { error: 'bad_request' });
  const sections = cleanSections(b.sections);
  if (!sections) return send(res, 400, { error: 'bad_request' });
  const service = clip(b.service, 120);
  let label = LABELS[kind];
  if (kind === 'rx') { label = RX_LABELS[b.svcId]; if (!label) return send(res, 400, { error: 'bad_request' }); }
  const st = fax.status();
  if (!st.ok) { log({ ev: 'submit', ok: false, why: 'fax_not_configured' }); return send(res, 503, { error: 'fax_unavailable', message: 'Online requests are temporarily unavailable. Please call (613) 253-3334.' }); }

  // Reserve the time first (synchronous check + write = no double booking), then fax.
  let booking = null;
  const ref = crypto.randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/[O0IL1]/g, '').slice(0, 6).padEnd(6, 'K');
  if (kind !== 'rx') {
    const sl = b.slot || {};
    if (!validDate(sl.date) || !validTime(sl.time)) return send(res, 400, { error: 'slot_required', message: 'Please choose an appointment date and time.' });
    if (!slots.isAvailable(store.getConfig(), store.getBookings(), sl.date, sl.time)) return send(res, 409, { error: 'slot_taken', message: 'That time is no longer available. Please choose another.' });
    booking = { ref, date: sl.date, time: sl.time, kind };
    store.addBooking(booking);
  }
  try {
    const when = nowLocal();
    const pdf = render({
      label, service: kind === 'rx' ? '' : (kind === 'ailment' ? 'Condition: ' : 'Vaccine: ') + service, ref,
      receivedAt: longDate(when.date) + ', ' + clock12(String(Math.floor(when.minutes / 60)).padStart(2, '0') + ':' + String(when.minutes % 60).padStart(2, '0')),
      appointment: booking ? { date: booking.date, time: booking.time } : null, to: fax.TO_DISPLAY, sections,
    });
    await fax.send(pdf, ref);
  } catch (e) {
    if (booking) store.removeBooking((x) => x.ref === ref);
    log({ ev: 'submit', ok: false, kind, ref, why: 'fax_failed', err: String(e.message).slice(0, 200) });
    return send(res, 502, { error: 'fax_failed', message: 'We could not send your request to the pharmacy. Nothing was booked. Please try again in a minute or call (613) 253-3334.' });
  }
  log({ ev: 'submit', ok: true, kind, ref });
  send(res, 200, { ok: true, ref, date: booking && booking.date, time: booking && booking.time });
}

// ---------- admin API ----------
function overview(cfg, bookings) {
  const now = nowLocal(), days = [];
  for (let i = 0; i <= cfg.windowDays; i++) {
    const date = addDays(now.date, i), sch = slots.daySchedule(cfg, bookings, date);
    days.push({ date, available: sch.filter((s) => s.status === 'available').length, booked: sch.filter((s) => s.status === 'booked').length, total: sch.length });
  }
  return days;
}
async function apiAdmin(req, res, url) {
  const m = req.method, p = url.pathname;
  if (p === '/api/admin/login' && m === 'POST') {
    const key = 'login:' + ip(req);
    if (auth.limited(key, 8, 15 * 60e3) || auth.limited('login:all', 60, 3600e3)) return send(res, 429, { error: 'rate', message: 'Too many attempts. Please wait 15 minutes and try again.' });
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad_request' }); }
    await new Promise((r) => setTimeout(r, 400));
    if (typeof b.password !== 'string' || !auth.verifyPassword(b.password)) return send(res, 401, { error: 'bad_password', message: 'That password is not correct.' });
    setSession(req, res, auth.newToken()); return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/logout' && m === 'POST') { setSession(req, res, ''); return send(res, 200, { ok: true }); }
  if (p === '/api/admin/me' && m === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { error: 'auth', setup: authState === 'missing' });
    const f = fax.status(); return send(res, 200, { ok: true, fax: { ok: f.ok, provider: f.provider, test: !!f.test, why: f.why || null }, tz: TZ });
  }
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  if (m !== 'GET') { // CSRF guard on every change
    if (req.headers['x-sv-admin'] !== '1') return send(res, 403, { error: 'csrf' });
    const o = req.headers.origin; if (o && (() => { try { return new URL(o).host !== req.headers.host; } catch (e) { return true; } })()) return send(res, 403, { error: 'csrf' });
  }
  const cfg = store.getConfig();
  if (p === '/api/admin/config' && m === 'GET') return send(res, 200, { config: cfg, choices: slots.SLOT_CHOICES, today: nowLocal().date });
  if (p === '/api/admin/config' && m === 'PUT') {
    let b; try { b = await readBody(req); } catch (e) { return send(res, e.code || 400, { error: 'bad_request' }); }
    return send(res, 200, { config: store.setConfig(b) });
  }
  if (p === '/api/admin/overview' && m === 'GET') return send(res, 200, { days: overview(cfg, store.getBookings()), slotMinutes: cfg.slotMinutes });
  if (p === '/api/admin/day' && m === 'GET') {
    const d = url.searchParams.get('date'); if (!validDate(d)) return send(res, 400, { error: 'bad_request' });
    return send(res, 200, { date: d, slotMinutes: cfg.slotMinutes, slots: slots.daySchedule(cfg, store.getBookings(), d) });
  }
  if (p === '/api/admin/upcoming' && m === 'GET') {
    const t = nowLocal().date;
    return send(res, 200, { bookings: store.getBookings().filter((x) => x.date >= t).sort((a, c) => (a.date + a.time).localeCompare(c.date + c.time)) });
  }
  if (p === '/api/admin/slot' && m === 'POST') {
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad_request' }); }
    if (b.action === 'cancel') { const r = store.removeBooking((x) => x.ref === b.ref); return send(res, r ? 200 : 404, { ok: !!r }); }
    if (!validDate(b.date) || !validTime(b.time)) return send(res, 400, { error: 'bad_request' });
    if (b.action === 'block') slots.blockSlot(cfg, b.date, b.time);
    else if (b.action === 'unblock') slots.unblockSlot(cfg, b.date, b.time);
    else return send(res, 400, { error: 'bad_request' });
    store.saveConfig(); return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/password' && m === 'POST') {
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad_request' }); }
    if (auth.limited('pw:' + ip(req), 6, 15 * 60e3)) return send(res, 429, { error: 'rate' });
    if (!auth.verifyPassword(String(b.current || ''))) return send(res, 401, { error: 'bad_password', message: 'Your current password is not correct.' });
    if (typeof b.next !== 'string' || b.next.length < 10) return send(res, 400, { error: 'weak', message: 'Choose a new password with at least 10 characters.' });
    auth.setPassword(b.next); setSession(req, res, auth.newToken()); return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not_found' });
}

// ---------- static files ----------
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  if (p === '/') p = '/index.html';
  const full = path.normalize(path.join(PUB, p));
  if (!full.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', ...(p === '/admin.html' ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/slots' && req.method === 'GET') return await apiSlots(req, res);
    if (url.pathname === '/api/submit' && req.method === 'POST') return await apiSubmit(req, res);
    if (url.pathname.startsWith('/api/admin/')) return await apiAdmin(req, res, url);
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (e) { log({ ev: 'error', err: String(e.message).slice(0, 200) }); if (!res.headersSent) send(res, 500, { error: 'server' }); }
});
server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  const f = fax.status();
  log({ ev: 'start', port: PORT, admin: authState, fax: f.ok ? f.provider : 'NOT CONFIGURED: ' + f.why });
  if (authState === 'missing') console.warn('!! No admin password yet. Set ADMIN_PASSWORD (10+ characters) and restart.');
});
