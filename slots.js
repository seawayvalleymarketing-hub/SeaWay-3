'use strict';
const { nowLocal, validDate, validTime, toMin, fromMin, addDays, dowOf, DOW } = require('./tz');

const SLOT_CHOICES = [10, 15, 20, 30, 45, 60];

function defaultConfig() {
  const day = (a, b) => [{ start: a, end: b }];
  return {
    slotMinutes: 15,        // length of one appointment
    windowDays: 30,         // how far ahead patients can book
    minNoticeHours: 2,      // earliest a patient can book from "now"
    weekly: {               // starts as the store hours; the pharmacist edits these in the dashboard
      mon: day('09:00', '18:00'), tue: day('09:00', '18:00'), wed: day('09:00', '18:00'),
      thu: day('09:00', '18:00'), fri: day('09:00', '18:00'), sat: day('10:00', '15:00'), sun: [],
    },
    extra: {},              // { "2026-12-24": [{start,end}] }  extra availability on a date
    blocked: {},            // { "2026-12-25": {all:true} | {ranges:[{start,end}]} }
  };
}

function cleanRanges(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list.slice(0, 8)) {
    if (!r || !validTime(r.start) || !validTime(r.end)) continue;
    if (toMin(r.end) <= toMin(r.start)) continue;
    out.push({ start: r.start, end: r.end });
  }
  return mergeRanges(out);
}
function mergeRanges(list) {
  const a = list.map((r) => [toMin(r.start), toMin(r.end)]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of a) {
    if (out.length && r[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], r[1]);
    else out.push(r.slice());
  }
  return out.map((r) => ({ start: fromMin(r[0]), end: fromMin(r[1]) }));
}

// Validate/normalise a whole config object coming from the dashboard.
function cleanConfig(input, today) {
  const base = defaultConfig(), c = input || {};
  const out = { slotMinutes: base.slotMinutes, windowDays: base.windowDays, minNoticeHours: base.minNoticeHours, weekly: {}, extra: {}, blocked: {} };
  if (SLOT_CHOICES.includes(+c.slotMinutes)) out.slotMinutes = +c.slotMinutes;
  if (Number.isInteger(+c.windowDays) && +c.windowDays >= 1 && +c.windowDays <= 120) out.windowDays = +c.windowDays;
  if (+c.minNoticeHours >= 0 && +c.minNoticeHours <= 168) out.minNoticeHours = Math.round(+c.minNoticeHours);
  for (const d of DOW) out.weekly[d] = cleanRanges(c.weekly && c.weekly[d]);
  const cutoff = addDays(today, -1);
  for (const [date, v] of Object.entries(c.extra || {})) {
    if (!validDate(date) || date < cutoff) continue;
    const r = cleanRanges(v); if (r.length) out.extra[date] = r;
  }
  for (const [date, v] of Object.entries(c.blocked || {})) {
    if (!validDate(date) || date < cutoff || !v) continue;
    if (v.all) out.blocked[date] = { all: true };
    else { const r = cleanRanges(v.ranges); if (r.length) out.blocked[date] = { ranges: r }; }
  }
  return out;
}

function overlaps(startMin, endMin, ranges) {
  return ranges.some((r) => startMin < toMin(r.end) && endMin > toMin(r.start));
}

/*
  Every slot of one day with a status:
   available | booked | blocked | past
  "Open" slots come from the weekly hours plus any extra hours for that date.
  Blocks (whole day or time ranges) remove slots. A booked slot always shows as booked.
*/
function daySchedule(cfg, bookings, date, nowMs) {
  const slot = cfg.slotMinutes;
  const ranges = mergeRanges([...(cfg.weekly[dowOf(date)] || []), ...(cfg.extra[date] || [])]);
  const blk = cfg.blocked[date];
  const now = nowLocal(nowMs);
  const earliest = now.minutes + cfg.minNoticeHours * 60; // minutes since local midnight of today
  const lastDate = addDays(now.date, cfg.windowDays);
  const booked = new Map(bookings.filter((b) => b.date === date).map((b) => [b.time, b]));
  const times = new Set();
  for (const r of ranges) for (let m = toMin(r.start); m + slot <= toMin(r.end); m += slot) times.add(m);
  for (const t of booked.keys()) times.add(toMin(t));
  const out = [];
  for (const m of [...times].sort((a, b) => a - b)) {
    const time = fromMin(m), b = booked.get(time);
    let status = 'available';
    if (b) status = 'booked';
    else if (blk && (blk.all || overlaps(m, m + slot, blk.ranges || []))) status = 'blocked';
    else if (date < now.date || (date === now.date && m < earliest) || date > lastDate) status = 'past';
    else if (date > now.date) {
      const dayGap = (new Date(date + 'T00:00:00Z') - new Date(now.date + 'T00:00:00Z')) / 86400000;
      if (dayGap * 1440 + m < earliest) status = 'past';
    }
    const row = { time, status };
    if (b) { row.ref = b.ref; row.kind = b.kind; }
    out.push(row);
  }
  return out;
}

function availableDays(cfg, bookings, nowMs) {
  const now = nowLocal(nowMs), days = [];
  for (let i = 0; i <= cfg.windowDays; i++) {
    const date = addDays(now.date, i);
    const times = daySchedule(cfg, bookings, date, nowMs).filter((s) => s.status === 'available').map((s) => s.time);
    if (times.length) days.push({ date, times });
  }
  return days;
}

function isAvailable(cfg, bookings, date, time, nowMs) {
  if (!validDate(date) || !validTime(time)) return false;
  return daySchedule(cfg, bookings, date, nowMs).some((s) => s.time === time && s.status === 'available');
}

// Block / unblock one slot-length range on a date.
function blockSlot(cfg, date, time) {
  const m = toMin(time), end = m + cfg.slotMinutes;
  const cur = cfg.blocked[date];
  if (cur && cur.all) return;
  const list = (cur && cur.ranges) || [];
  list.push({ start: fromMin(m), end: fromMin(Math.min(end, 1439)) });
  cfg.blocked[date] = { ranges: mergeRanges(list) };
}
function unblockSlot(cfg, date, time) {
  const cur = cfg.blocked[date]; if (!cur) return;
  if (cur.all) { // un-block one slot of a closed day: open the whole day except... keep it simple: lift the whole-day block
    delete cfg.blocked[date]; return;
  }
  const m = toMin(time), end = m + cfg.slotMinutes, out = [];
  for (const r of cur.ranges) {
    const a = toMin(r.start), b = toMin(r.end);
    if (end <= a || m >= b) { out.push(r); continue; }
    if (a < m) out.push({ start: r.start, end: fromMin(m) });
    if (b > end) out.push({ start: fromMin(end), end: r.end });
  }
  if (out.length) cfg.blocked[date] = { ranges: out }; else delete cfg.blocked[date];
}

module.exports = { SLOT_CHOICES, defaultConfig, cleanConfig, cleanRanges, daySchedule, availableDays, isAvailable, blockSlot, unblockSlot };
