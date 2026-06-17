#!/usr/bin/env node
/**
 * Smoke test end-to-end contro un server WattLab in esecuzione.
 *
 *   node test/smoke.mjs                       # default http://localhost:3000
 *   node test/smoke.mjs https://tuodominio    # contro produzione
 *
 * Verifica: health, readiness, register→login→refresh→logout,
 * protezione admin, rate-limit, ownership sync. Stampa PASS/FAIL e
 * esce con codice ≠0 se qualcosa fallisce (usabile in CI).
 */

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const jar = new Map(); // cookie jar minimale

let pass = 0, fail = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
function ko(name, detail) { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); fail++; }
function assert(cond, name, detail) { cond ? ok(name) : ko(name, detail); }

function setCookies(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (jar.size) headers['Cookie'] = cookieHeader();
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  setCookies(res);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data, headers: res.headers };
}

async function main() {
  console.log(`\nSmoke test → ${BASE}\n`);
  const email = `smoke_${Date.now()}@example.com`;
  const password = 'Sm0ke-Test-pw9';

  // 1) Health
  let r = await api('/api/health');
  assert(r.status === 200 && r.data?.ok === true, 'GET /api/health → 200 ok');

  // 2) Readiness (DB)
  r = await api('/api/health/ready');
  assert(r.status === 200 && r.data?.db === 'up', 'GET /api/health/ready → DB up', `status ${r.status}`);

  // 3) Register
  r = await api('/api/auth/register', { method: 'POST', body: { email, password } });
  assert(r.status === 201 && r.data?.id, 'POST /auth/register → 201', `status ${r.status} ${JSON.stringify(r.data)}`);
  const userId = r.data?.id;

  // 4) Register doppione → 409
  r = await api('/api/auth/register', { method: 'POST', body: { email, password } });
  assert(r.status === 409, 'register email duplicata → 409', `status ${r.status}`);

  // 5) Password debole → 400
  r = await api('/api/auth/register', { method: 'POST', body: { email: `w_${Date.now()}@x.com`, password: 'password' } });
  assert(r.status === 400, 'register password comune → 400', `status ${r.status}`);

  // 6) /auth/me autenticato (cookie dal register)
  r = await api('/api/auth/me');
  assert(r.status === 200 && r.data?.email === email, 'GET /auth/me → utente corrente');

  // 7) Content-Type non-JSON su POST → 415
  r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert(r.status === 415, 'POST non-JSON → 415', `status ${r.status}`);

  // 8) Logout
  r = await api('/api/auth/logout', { method: 'POST', body: {} });
  assert(r.status === 200, 'POST /auth/logout → 200');

  // 9) /auth/me senza sessione → 401
  jar.clear();
  r = await api('/api/auth/me');
  assert(r.status === 401, '/auth/me senza cookie → 401', `status ${r.status}`);

  // 10) Login credenziali errate → 401
  r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-pass-1' } });
  assert(r.status === 401, 'login password errata → 401', `status ${r.status}`);

  // 11) Login corretto
  r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  assert(r.status === 200 && r.data?.id === userId, 'login corretto → 200');

  // 12) Refresh
  r = await api('/api/auth/refresh', { method: 'POST', body: {} });
  assert(r.status === 200, 'POST /auth/refresh → 200 (rotation)', `status ${r.status}`);

  // 13) Sync snapshot (autenticato)
  r = await api('/api/sync/snapshot', { method: 'POST', body: { payload: { wl_test: '1' }, deviceId: 'smoke' } });
  assert(r.status === 200 && r.data?.ok, 'POST /sync/snapshot → 200');

  // 14) Sync latest
  r = await api('/api/sync/latest');
  assert(r.status === 200 && r.data?.snapshot?.payload?.wl_test === '1', 'GET /sync/latest → snapshot proprio');

  // 15) Admin gate: utente normale → 403
  r = await api('/api/admin/stats');
  assert(r.status === 403, 'admin stats da non-admin → 403', `status ${r.status}`);

  // 16) Rate limit su login (>10/min → 429)
  jar.clear();
  let got429 = false;
  for (let i = 0; i < 15; i++) {
    const rr = await api('/api/auth/login', { method: 'POST', body: { email, password: 'x' } });
    if (rr.status === 429) { got429 = true; break; }
  }
  assert(got429, 'rate-limit login → 429 dopo burst', 'nessun 429 ricevuto');

  console.log(`\n${pass} pass, ${fail} fail\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Errore smoke test:', e.message); process.exit(2); });
