'use strict';
// Tiny dependency-free PDF writer: black-and-white text on Letter pages, built-in Helvetica fonts.
// Built entirely in memory; nothing is written to disk.
const M = require('./metrics.json');

const CP1252 = { 0x20AC: 128, 0x201A: 130, 0x0192: 131, 0x201E: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135, 0x02C6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140, 0x017D: 142, 0x2018: 145, 0x2019: 146, 0x201C: 147, 0x201D: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x02DC: 152, 0x2122: 153, 0x0161: 154, 0x203A: 155, 0x0153: 156, 0x017E: 158, 0x0178: 159 };
function encode(str) { // JS string -> array of cp1252 byte values
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c === 9) out.push(32, 32, 32, 32);
    else if (c >= 32 && c < 127) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (CP1252[c]) out.push(CP1252[c]);
    else if (c === 10 || c === 13) out.push(32);
    else if (c >= 0x2010 && c <= 0x2015) out.push(45);
    else if (c === 0x2192) out.push(62);
    else out.push(63);
  }
  return out;
}
function textWidth(str, size, bold) {
  const t = M[bold ? 'b' : 'r']; let w = 0;
  for (const b of encode(str)) w += t[b] || 556;
  return w * size / 1000;
}
function wrap(str, size, bold, maxW) {
  const lines = [];
  for (const para of String(str).split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let cur = '';
    for (let w of words) {
      while (textWidth(w, size, bold) > maxW) { // break very long tokens
        let i = w.length; while (i > 1 && textWidth(w.slice(0, i), size, bold) > maxW) i--;
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, i)); w = w.slice(i);
      }
      const t = cur ? cur + ' ' + w : w;
      if (textWidth(t, size, bold) <= maxW) cur = t; else { lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines;
}
const hex = (bytes) => Buffer.from(bytes).toString('latin1').replace(/[\\()]/g, (c) => '\\' + c);

class Doc {
  constructor() { this.W = 612; this.H = 792; this.pages = []; this.newPage(); }
  newPage() { this.cur = []; this.pages.push(this.cur); }
  text(x, y, str, size, bold) { // y measured from top
    this.cur.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${(this.H - y).toFixed(2)} Td (${hex(encode(str))}) Tj ET`);
  }
  line(x1, y1, x2, y2, w) { this.cur.push(`${w || 1} w ${x1} ${this.H - y1} m ${x2} ${this.H - y2} l S`); }
  rect(x, y, w, h, lw) { this.cur.push(`${lw || 1} w ${x} ${this.H - y - h} ${w} ${h} re S`); }
  fillRect(x, y, w, h) { this.cur.push(`0 g ${x} ${this.H - y - h} ${w} ${h} re f`); }
  whiteText(x, y, str, size, bold) { this.cur.push('1 g'); this.text(x, y, str, size, bold); this.cur.push('0 g'); }
  build(title) {
    const objs = []; const add = (s) => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // pages, filled below
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const p of this.pages) {
      const stream = '0 g 0 G\n' + p.join('\n');
      const cid = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`));
    }
    objs[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] >>`;
    const info = add(`<< /Title (${hex(encode(title || 'Fax'))}) /Producer (Seaway Valley Pharmacy) >>`);
    let out = '%PDF-1.4\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
module.exports = { Doc, wrap, textWidth };
