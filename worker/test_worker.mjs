/**
 * test_worker.mjs — offline test of worker/worker.js on plain Node.
 * Mocks the KV binding and a local HTTP upstream; walks the same app flow as
 * the Android experience, plus negative checks. CI target.
 */
import { createServer } from 'node:http';
import assert from 'node:assert';
import handler from './worker.js';

const MARQUEE = 'worker-relay-ok';

function makeKV() {
  const map = new Map();
  return {
    async get(k) { return map.get(k) ?? null; },
    async put(k, v, opts) { map.set(k, v); if (opts && opts.expirationTtl) setTimeout(() => map.delete(k), Math.min(opts.expirationTtl, 50) * 1000).unref?.(); },
  };
}

function env(overrides = {}) {
  return {
    SESSION: makeKV(),
    DEV_GRANT_SECRET: overrides.DEV_GRANT_SECRET || 'ci-worker-secret',
    INTERNAL_KEY: overrides.INTERNAL_KEY || 'ci-internal-key',
    ADMIT_DEV_GRANTS: '1',
    TTL_MINUTES: '30',
    TOKEN_TTL_SECONDS: '300',
    ...overrides,
  };
}

async function call(env_, pathname, opts = {}) {
  const url = new URL(pathname, 'http://worker.test');
  const req = new Request(url, {
    method: opts.method || 'GET',
    headers: opts.headers || { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handler.fetch(req, env_, { waitUntil() {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep text */ }
  return { status: res.status, json, text };
}

const results = [];
let failed = false;
function ok(name, cond, extra) {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) failed = true;
  console.log(results[results.length - 1]);
}

/* -------- local upstream for the relay -------- */
const upstream = await new Promise((resolve) => {
  const s = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(MARQUEE);
  });
  s.listen(18181, '127.0.0.1', () => resolve(s));
});

try {
  const h = await call(env(), '/health');
  ok('health', h.status === 200 && h.json.ok === true);

  const root = await call(env(), '/');
  ok('status page lists bridge state', root.status === 200 && root.json.ok === true && root.json.bridge_host === null);

  // no bridge host yet -> request-access still succeeds (hint; no link)
  const g0 = await call(env(), '/api/v1/dev-grant', { method: 'POST', body: { minutes: 30, device: 'ci' } });
  ok('dev-grant issues token', g0.status === 200 && typeof g0.json.token === 'string' && g0.json.token.length > 30);
  const ra0 = await call(env(), '/api/v1/request-access', { method: 'POST', body: { token: g0.json.token } });
  ok('request-access without BRIDGE_HOST returns session + hint', ra0.status === 200 && /^[0-9a-f-]{36}$/.test(ra0.json.uuid) && ra0.json.vless_url === null, `hint=${(ra0.json.hint || '').slice(0, 60)}`);

  // reuse protection
  const ra0b = await call(env(), '/api/v1/request-access', { method: 'POST', body: { token: g0.json.token } });
  ok('token reuse rejected (409)', ra0b.status === 409);

  // with bridge host -> full link
  const env2 = env({ BRIDGE_HOST: 'ryefafaryq-7860.proxy.github.app.dev' });
  const g1 = await call(env2, '/api/v1/dev-grant', { method: 'POST', body: { minutes: 30, device: 'ci' } });
  const adcb = await call(env2, '/api/v1/ad-callback', { method: 'POST', body: { token: g1.json.token } });
  ok('ad-callback verifies', adcb.status === 200 && adcb.json.verified === true);
  const ra1 = await call(env2, '/api/v1/request-access', { method: 'POST', body: { token: g1.json.token } });
  const link = ra1.json.vless_url || '';
  ok('request-access with BRIDGE_HOST returns vless link', ra1.status === 200 && /^vless:\/\//.test(link), link);
  let linkOk = false;
  try {
    const u = new URL(link.replace(/^vless:/, 'https:'));
    linkOk = u.hostname === 'ryefafaryq-7860.proxy.github.app.dev'
      && u.username === ra1.json.uuid
      && u.searchParams.get('path') === '/ws'
      && u.searchParams.get('security') === 'tls'
      && u.searchParams.get('host') === 'ryefafaryq-7860.proxy.github.app.dev';
  } catch (_) { /* ignore */ }
  ok('vless link wired to BRIDGE_HOST', linkOk);

  // invalid token
  const bad = await call(env2, '/api/v1/request-access', { method: 'POST', body: { token: 'bogus.sig' } });
  ok('invalid token rejected (400)', bad.status === 400);

  // internal session check
  const uuidHex = ra1.json.uuid.replace(/-/g, '');
  const chk0 = await call(env2, `/api/v1/internal/session-check?uuid=${uuidHex}`);
  ok('internal check blocked without key (403)', chk0.status === 403);
  const chk1 = await call(env2, `/api/v1/internal/session-check?uuid=${uuidHex}`, { headers: { 'x-internal-key': 'ci-internal-key' } });
  ok('internal check passes with key', chk1.status === 200 && chk1.json.ok === true && chk1.json.seconds_left > 0, `left=${chk1.json.seconds_left}`);
  const chk2 = await call(env2, `/api/v1/internal/session-check?uuid=${'a'.repeat(32)}`, { headers: { 'x-internal-key': 'ci-internal-key' } });
  ok('internal check unknown uuid (404)', chk2.status === 404);

  // site relay
  const rel0 = await call(env2, `/api/v1/site-relay?url=http://127.0.0.1:18181/ping`);
  ok('site relay requires token (401)', rel0.status === 401);
  const rel1 = await call(env2, `/api/v1/site-relay?url=http://127.0.0.1:18181/ping`, {
    method: 'GET',
    headers: { 'x-access-token': g1.json.token },
  });
  ok('site relay proxies upstream (200 + marker)', rel1.status === 200 && rel1.text.includes(MARQUEE), `status=${rel1.status}`);

  // unknown route
  const nf = await call(env2, '/api/v1/nope');
  ok('unknown route 404', nf.status === 404);
} finally {
  upstream.close();
}

console.log('\n==== SUMMARY ====');
for (const r of results) console.log(r);
if (failed) {
  console.log('WORKER TEST FAILED');
  process.exit(1);
}
console.log(`WORKER TEST PASSED (${results.length} checks)`);
