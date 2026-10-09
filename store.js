'use strict';
// Tiny file store. Holds ONLY: availability settings, minimum booking records (date, time, kind, random ref),
// and the admin password hash. No patient information is ever written here.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { defaultConfig, cleanConfig } = require('./slots');
const { nowLocal, addDays } = require('./tz');

let DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.accessSync(DIR, fs.constants.W_OK); }
catch (e) { // folder not allowed on this host: fall back instead of crashing (settings may reset on restart)
  const alt = path.join(require('os').tmpdir(), 'seaway-data');
  console.warn('!! Cannot use data folder ' + DIR + ' (' + e.code + '). Using ' + alt + ' instead; settings may reset when the server restarts.');
  DIR = alt; fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}
const file = (n) => path.join(DIR, n);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return fallback; }
}
function writeJson(name, obj) { // atomic: write temp, then rename
  const tmp = file(name + '.tmp-' + process.pid);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

let config = cleanConfig(readJson('config.json', defaultConfig()), addDays(nowLocal().date, -1));
let bookings = readJson('bookings.json', []);
if (!Array.isArray(bookings)) bookings = [];

function prune() { // keep only today and later; past bookings are not needed to prevent double booking
  const today = nowLocal().date, before = bookings.length;
  bookings = bookings.filter((b) => b.date >= today);
  if (bookings.length !== before) writeJson('bookings.json', bookings);
}
prune(); setInterval(prune, 6 * 3600 * 1000).unref();

module.exports = {
  DIR,
  getConfig: () => config,
  setConfig(c) { config = cleanConfig(c, nowLocal().date); writeJson('config.json', config); return config; },
  saveConfig() { writeJson('config.json', config); },
  getBookings: () => bookings,
  addBooking(b) { bookings.push(b); writeJson('bookings.json', bookings); },
  removeBooking(match) {
    const i = bookings.findIndex(match); if (i < 0) return null;
    const [b] = bookings.splice(i, 1); writeJson('bookings.json', bookings); return b;
  },
  readJson, writeJson,
  secret() { // random signing key for login cookies, created once
    let s = readJson('secret.json', null);
    if (!s || !s.key) { s = { key: crypto.randomBytes(32).toString('hex') }; writeJson('secret.json', s); }
    return Buffer.from(s.key, 'hex');
  },
};
