'use strict';
// Turns one validated submission into a clear, black-and-white fax (PDF buffer).
const { Doc, wrap } = require('./pdf');
const { longDate, clock12 } = require('./tz');

const LM = 54, RM = 558, W = RM - LM, TOP = 54, BOT = 726;
const SZ = 11.5, LH = 14.5;

function render(m) {
  // m: { label, service, ref, receivedAt, appointment:{date,time}|null, to, sections:[{h, rows:[...]}] }
  const d = new Doc(); let y = TOP;
  const need = (h) => { if (y + h > BOT) { d.newPage(); y = TOP; } };
  const para = (str, o) => {
    o = o || {}; const size = o.size || SZ, ind = o.ind || 0, bold = !!o.bold;
    const lines = wrap(str, size, bold, W - ind - (o.right || 0));
    for (const l of lines) { need(size + 4); d.text(LM + ind + (o.x || 0), y + size, l, size, bold); y += o.lh || (size + 3.5); }
  };

  // ---- Banner: which form this is ----
  d.rect(LM, y, W, 2.5, 2.5); y += 10;
  para(m.label, { size: 21, bold: true, lh: 25 });
  if (m.service) para(m.service, { size: 15, bold: true, lh: 19 });
  y += 4; d.rect(LM, y, W, 2.5, 2.5); y += 14;

  // ---- Key facts box ----
  const facts = [['TO', 'Seaway Valley Compounding Pharmacy   Fax ' + m.to], ['REFERENCE', m.ref], ['RECEIVED', m.receivedAt]];
  if (m.appointment) facts.splice(1, 0, ['APPOINTMENT', longDate(m.appointment.date) + ' at ' + clock12(m.appointment.time)]);
  const boxH = facts.length * 21 + 12; need(boxH + 10);
  d.rect(LM, y, W, boxH, 1.5);
  let fy = y + 10;
  for (const [k, v] of facts) {
    d.text(LM + 10, fy + 11, k, 9.5, true);
    d.text(LM + 108, fy + 11, v, k === 'APPOINTMENT' ? 14 : 11.5, true); fy += 21;
  }
  y += boxH + 14;

  // ---- Sections ----
  for (const s of m.sections) {
    need(60);
    y += 6; para(s.h.toUpperCase(), { size: 12.5, bold: true, lh: 16 });
    d.line(LM, y - 1, RM, y - 1, 1.2); y += 7;
    for (const r of s.rows) {
      if (r.consent) { // full consent wording with its checkbox
        need(40);
        para((r.on ? '[X] ' : '[  ] ') + 'AGREED' + (r.on ? '' : ' - NOT AGREED'), { bold: true });
        para(r.consent, { ind: 18, size: 10.5, lh: 13 }); y += 6; continue;
      }
      need(44);
      para(r.q, { bold: true, right: 0 });
      if (r.opts) {
        for (const o of r.opts) para((o.on ? '[X]  ' : '[  ]  ') + o.t, { ind: 14, bold: o.on });
        if (r.note) para(r.note, { ind: 14 });
      } else para(r.a === '' || r.a == null ? '(not answered)' : r.a, { ind: 14 });
      y += 5;
    }
  }
  need(40); y += 8; d.line(LM, y, RM, y, 1); y += 6;
  para('End of form. ' + m.ref, { size: 10, bold: true });

  // ---- Footer on every page ----
  const n = d.pages.length;
  d.pages.forEach((p, i) => {
    d.cur = p;
    d.line(LM, 748, RM, 748, 0.8);
    d.text(LM, 762, 'CONFIDENTIAL: personal health information for the pharmacy named above. If received in error, please call (613) 253-3334 and destroy.', 7.8, false);
    d.text(LM, 774, m.label + '  |  Ref ' + m.ref, 8.5, true);
    d.text(RM - 52, 774, 'Page ' + (i + 1) + ' of ' + n, 8.5, true);
  });
  return d.build(m.label + ' ' + m.ref);
}
module.exports = { render };
