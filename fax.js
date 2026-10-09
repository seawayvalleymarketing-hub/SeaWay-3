'use strict';
// Fax delivery. The PDF only ever exists in memory: it is handed to the fax provider and dropped.
// Pick a provider with FAX_PROVIDER=documo | phaxio | dryrun  (see README for the credentials each one needs).
const fs = require('fs'), path = require('path');
const TO = (process.env.PHARMACY_FAX || '613-691-7667').replace(/\D/g, '');
const TO_E164 = (TO.length === 10 ? '1' : '') + TO;
const provider = (process.env.FAX_PROVIDER || '').toLowerCase();

function status() {
  if (provider === 'documo') return process.env.DOCUMO_API_KEY ? { ok: true, provider } : { ok: false, provider, why: 'DOCUMO_API_KEY is not set' };
  if (provider === 'phaxio') return process.env.PHAXIO_API_KEY && process.env.PHAXIO_API_SECRET ? { ok: true, provider } : { ok: false, provider, why: 'PHAXIO_API_KEY / PHAXIO_API_SECRET not set' };
  if (provider === 'dryrun') return { ok: true, provider, test: true };
  return { ok: false, provider: provider || 'none', why: 'FAX_PROVIDER is not set' };
}

async function post(url, init) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const body = await r.text().catch(() => '');
    if (!r.ok) throw new Error('fax provider answered HTTP ' + r.status + ' ' + body.slice(0, 160).replace(/\s+/g, ' '));
    return body;
  } finally { clearTimeout(t); }
}

async function send(pdf, ref) {
  const s = status(); if (!s.ok) throw new Error('fax not configured: ' + s.why);
  const file = new Blob([pdf], { type: 'application/pdf' });
  if (provider === 'documo') {
    // Documo mFax API: POST /v1/faxes (multipart), Authorization: <api key>
    const f = new FormData();
    f.append('faxNumber', TO_E164); f.append('coverPage', 'false');
    f.append('subject', 'Online form ' + ref); f.append('files', file, ref + '.pdf');
    await post(process.env.DOCUMO_URL || 'https://api.documo.com/v1/faxes', { method: 'POST', headers: { Authorization: 'Basic ' + process.env.DOCUMO_API_KEY }, body: f });
  } else if (provider === 'phaxio') {
    // Phaxio v2.1: POST /faxes (multipart), HTTP basic auth key:secret
    const f = new FormData();
    f.append('to', '+' + TO_E164); f.append('file', file, ref + '.pdf');
    const auth = Buffer.from(process.env.PHAXIO_API_KEY + ':' + process.env.PHAXIO_API_SECRET).toString('base64');
    await post(process.env.PHAXIO_URL || 'https://api.phaxio.com/v2.1/faxes', { method: 'POST', headers: { Authorization: 'Basic ' + auth }, body: f });
  } else if (provider === 'dryrun') {
    // Testing only. Writes the PDF to FAX_DRYRUN_DIR if (and only if) you set it.
    if (process.env.FAX_DRYRUN_DIR) { fs.mkdirSync(process.env.FAX_DRYRUN_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.FAX_DRYRUN_DIR, ref + '.pdf'), pdf); }
  }
}
module.exports = { send, status, TO_DISPLAY: '(' + TO.slice(-10, -7) + ') ' + TO.slice(-7, -4) + '-' + TO.slice(-4) };
