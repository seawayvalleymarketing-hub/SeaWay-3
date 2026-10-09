'use strict';
// End-to-end test of the server with a throw-away data folder and the "dryrun" fax provider.
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-')), faxDir = path.join(tmp, 'faxes'), dataDir = path.join(tmp, 'data');
const PORT = 3911, B = 'http://127.0.0.1:' + PORT;
const env = { ...process.env, PORT, DATA_DIR: dataDir, FAX_PROVIDER: 'dryrun', FAX_DRYRUN_DIR: faxDir, ADMIN_PASSWORD: 'correct-horse-battery' };
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let out = ''; srv.stdout.on('data', (d) => (out += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function call(method, url, body, admin) {
  const h = { 'Content-Type': 'application/json' }; if (cookie) h.Cookie = cookie; if (admin && method !== 'GET') h['X-SV-Admin'] = '1';
  const r = await fetch(B + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && /sv_admin=[^;]/.test(sc)) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { s: r.status, j };
}
const model = (name) => [{ h: 'Patient information', rows: [{ q: 'Patient name', a: name }, { q: 'Pick', opts: [{ t: 'A', on: true }, { t: 'B', on: false }] }, { consent: 'I agree to things.', on: true }] }];
(async () => {
  for (let i = 0; i < 40 && !/"ev":"start"/.test(out); i++) await sleep(100);
  const pass = (m) => console.log('  ok  ' + m);

  let r = await call('GET', '/api/slots'); assert.equal(r.s, 200); assert(r.j.days.length > 5); pass('public slots come from default hours (' + r.j.days.length + ' open days)');
  const day = r.j.days.slice(1).find((d) => new Date(d.date + 'T12:00:00Z').getUTCDay() !== 6), time = day.times[Math.min(10, day.times.length-1)];

  r = await call('GET', '/api/admin/config'); assert.equal(r.s, 401); pass('dashboard API refuses anonymous access');
  r = await call('POST', '/api/admin/login', { password: 'wrong' }); assert.equal(r.s, 401); pass('wrong password rejected');
  r = await call('PUT', '/api/admin/config', {}, true); assert.equal(r.s, 401);

  // race: 6 patients grab the same slot at once
  const body = (n) => ({ kind: 'vaccine', svcId: 'x', service: 'Flu vaccine', sections: model('Patient Secret' + n), slot: { date: day.date, time } });
  const res = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => call('POST', '/api/submit', body(n))));
  const okN = res.filter((x) => x.s === 200).length, taken = res.filter((x) => x.s === 409).length;
  assert.equal(okN, 1); assert.equal(taken, 5); pass('double booking prevented: 1 booked, 5 told "slot taken"');
  assert.equal(fs.readdirSync(faxDir).length, 1); pass('exactly one fax generated');
  const ref = res.find((x) => x.s === 200).j.ref;
  const pdf = fs.readFileSync(path.join(faxDir, ref + '.pdf')).toString('latin1');
  assert(pdf.startsWith('%PDF-1.4')); pass('fax is a valid PDF');

  r = await call('GET', '/api/slots'); assert(!r.j.days.find((d) => d.date === day.date).times.includes(time)); pass('booked time disappears from the public site');

  // no patient information on disk in the data folder
  for (const f of fs.readdirSync(dataDir)) { const t = fs.readFileSync(path.join(dataDir, f), 'utf8'); assert(!/Secret|Flu vaccine|Patient/.test(t), f + ' contains patient data'); }
  pass('data folder holds no patient information: ' + fs.readdirSync(dataDir).join(', '));
  assert(!/Secret/.test(out)); pass('server log contains no patient information');

  // dashboard
  r = await call('POST', '/api/admin/login', { password: 'correct-horse-battery' }); assert.equal(r.s, 200); pass('pharmacist can sign in');
  r = await call('PUT', '/api/admin/config', {}, false); assert.equal(r.s, 403); pass('changes need the CSRF header');
  r = await call('GET', '/api/admin/day?date=' + day.date); assert(r.j.slots.find((s) => s.time === time && s.status === 'booked' && s.ref === ref)); pass('dashboard shows the booking');
  r = await call('GET', '/api/admin/config'); const cfg = r.j.config;
  cfg.weekly.sat = []; cfg.blocked[day.date] = { ranges: [{ start: '09:00', end: '10:00' }] };
  r = await call('PUT', '/api/admin/config', cfg, true); assert.equal(r.s, 200);
  r = await call('GET', '/api/slots'); const dd = r.j.days.find((d) => d.date === day.date);
  assert(!dd || !dd.times.some((t) => t >= '09:00' && t < '10:00')); assert(!r.j.days.some((d) => new Date(d.date + 'T12:00:00Z').getUTCDay() === 6)); pass('saturday closed + 9-10am block immediately change the public times');
  r = await call('POST', '/api/submit', { ...body(9), slot: { date: day.date, time: '09:15' } }); assert([409].includes(r.s)); pass('blocked time cannot be booked');
  r = await call('POST', '/api/admin/slot', { action: 'cancel', ref }, true); assert.equal(r.s, 200);
  r = await call('POST', '/api/submit', { ...body(7) }); assert.equal(r.s, 200); pass('cancelled time can be booked again');
  r = await call('POST', '/api/submit', { kind: 'rx', svcId: 'refill', service: 'Prescription refill', sections: model('Rx Person') }); assert.equal(r.s, 200); assert(!r.j.date); pass('prescription forms fax without needing a time');
  r = await call('POST', '/api/submit', { kind: 'vaccine', service: 'x', sections: model('NoSlot') }); assert.equal(r.s, 400); pass('appointment without a time is refused');
  r = await call('POST', '/api/admin/logout', {}, true); cookie = '';
  r = await call('GET', '/api/admin/config'); assert.equal(r.s, 401); pass('sign out works');
  console.log('\nALL TESTS PASSED'); console.log('faxes:', fs.readdirSync(faxDir).join(' ')); console.log('tmp:', tmp);
  srv.kill(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); srv.kill(); process.exit(1); });
