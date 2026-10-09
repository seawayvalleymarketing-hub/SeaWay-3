'use strict';
// All pharmacy times are Eastern (Carleton Place, ON). Dates are "YYYY-MM-DD", times are "HH:MM" (24h).
const TZ = process.env.PHARMACY_TZ || 'America/Toronto';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function nowLocal(ms) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms == null ? Date.now() : ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (+p.hour) * 60 + (+p.minute) };
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const validTime = (s) => typeof s === 'string' && TIME_RE.test(s);
const toMin = (t) => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
const fromMin = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dowOf = (date) => DOW[new Date(date + 'T00:00:00Z').getUTCDay()];
function longDate(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
function clock12(t) {
  const m = toMin(t), h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}
module.exports = { TZ, nowLocal, validDate, validTime, toMin, fromMin, addDays, dowOf, DOW, longDate, clock12 };
