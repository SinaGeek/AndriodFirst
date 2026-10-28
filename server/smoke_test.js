/**
 * smoke_test.js  (runs ONLY in CI - GitHub Actions)
 * ------------------------------------------------
 * End-to-end validation of the whole testing MVP, with zero external deps
 * beyond the `ws` package and without any real internet target:
 *
 *   1. boots the server (spawned child)
 *   2. exercises the app flow: dev-grant -> ad-callback -> request-access
 *   3. performs a REAL VLESS-over-WS handshake against the bridge
 *      (request framing: ver/uuid/addons/cmd/port/atype/domain + HTTP)
 *      against a local mock upstream, proving the bridge behaves like Xray.
 *   4. negative tests: wrong uuid -> close; bad ver -> close; UDP cmd -> close
 *   5. enforcement: admin DELETE session -> that uuid stops working (TTL gate)
 *   6. one-time token: same grant token twice -> 409
 *
 * Exits 0 on success, 1 with diagnostics on failure.
 */
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { WebSocket } = require('ws');

const PORT = 7868;          // server under test
const MOCK_PORT = 18080;    // mock upstream target
const MOCK_MARKER = 'vless-smoke-ok';
const ADMIN = 'ci-admin-token';
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failed = false;

function ok(name, condition, extra) {
  const label = `${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`;
  results.push(label);
  if (!condition) failed = true;
  console.log(label);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON body allowed */ }
  return { status: res.status, json, text };
}

/* ---------------- mock upstream ---------------- */
function startMock() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write(
          'HTTP/1.1 200 OK\r\n' +
          'Content-Type: text/plain\r\n' +
          `Content-Length: ${MOCK_MARKER.length}\r\n` +
          'Connection: keep-alive\r\n\r\n' +
          MOCK_MARKER,
        );
      });
      sock.on('error', () => {});
    });
    srv.on('error', reject);
    srv.listen(MOCK_PORT, '127.0.0.1', () => resolve(srv));
  });
}

/* ------------- minimal VLESS-over-WS test client ------------- */
/**
 * Speaks the exact VLESS frame our bridge expects:
 *   ver(1) uuid(16) addonsLen(1) addons cmd(1) port(2BE) atype(1) addr
 * then reads [0x00,0x00] response header + raw upstream stream.
 */
function vlessHandshake(opts) {
  const { ver = 0, uuidHex, cmd = 1, atype = 2, domain = 'localhost', port = MOCK_PORT, timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    const out = { opened: false, closed: false, closeCode: null, gotResponseHeader: false, data: Buffer.alloc(0), error: null };
    let finished = false;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const finish = () => {
      if (finished) return;
      finished = true;
      try { ws.close(); } catch (_) { /* ignore */ }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);

    ws.on('open', () => {
      out.opened = true;
      let addr;
      if (atype === 2) {
        addr = Buffer.concat([Buffer.from([domain.length]), Buffer.from(domain, 'ascii')]);
      } else if (atype === 1) {
        addr = Buffer.from([127, 0, 0, 1]);
      } else {
        addr = Buffer.alloc(16);
      }
      const portB = Buffer.alloc(2);
      portB.writeUInt16BE(port);
      ws.send(Buffer.concat([
        Buffer.from([ver]),
        Buffer.from(uuidHex.replace(/-/g, ''), 'hex'),
        Buffer.from([0x00]), // addonsLen (plain vless+ws)
        Buffer.from([cmd]),
        portB,
        Buffer.from([atype]),
        addr,
      ]));
      if (cmd === 1 && ver === 0) {
        ws.send(
          Buffer.from(`GET / HTTP/1.1\r\nHost: ${domain}\r\nUser-Agent: smoke\r\nConnection: keep-alive\r\n\r\n`, 'ascii'),
        );
      }
    });

    ws.on('message', (d) => {
      if (finished) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.concat(Array.isArray(d) ? d : [Buffer.from(d)]);
      if (!out.gotResponseHeader) {
        if (chunk.length < 2) return;
        out.gotResponseHeader = chunk[0] === 0x00 && chunk[1] === 0x00;
        const rest = chunk.slice(2);
        out.data = Buffer.concat([out.data, rest]);
      } else {
        out.data = Buffer.concat([out.data, chunk]);
      }
      if (out.data.toString('latin1').includes(MOCK_MARKER)) {
        clearTimeout(timer);
        finish();
      }
    });

    ws.on('close', (code) => {
      if (!finished) {
        out.closed = true;
        out.closeCode = code;
        out.gotResponseHeader = false;
        clearTimeout(timer);
        finish();
      }
    });
    ws.on('error', (e) => {
      if (!finished) {
        out.error = e.message;
        clearTimeout(timer);
        finish();
      }
    });
  });
}

/* ---------------- main ---------------- */
async function main() {
  const serverDir = path.join(__dirname);
  const mock = await startMock();

  const child = spawn(process.execPath, ['session_server.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      TTL_MINUTES: '30',
      ADMIN_TOKEN: ADMIN,
      ADMIT_DEV_GRANTS: '1',
      DEV_GRANT_SECRET: 'ci-smoke-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => console.log('[srv] ' + d.toString().trim()));
  child.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d.toString()));

  try {
    // wait for health
    let healthy = false;
    for (let i = 0; i < 50; i++) {
      try {
        const h = await api('/health');
        if (h.status === 200 && h.json && h.json.ok === true) { healthy = true; break; }
      } catch (_) { /* not up yet */ }
      await sleep(200);
    }
    ok('server boots and /health responds', healthy);

    // status page
    const root = await api('/');
    ok('status page at /', root.status === 200 && root.json && root.json.app === 'Iran Access (testing MVP)', `ws_path=${root.json && root.json.ws_path}`);

    // app flow: grant -> callback -> request-access
    const g = await api('/api/v1/dev-grant', { method: 'POST', body: { minutes: 30, device: 'android-test' } });
    ok('dev-grant issues token', g.status === 200 && typeof g.json.token === 'string' && g.json.token.length > 40, `minutes=${g.json && g.json.minutes}`);

    const cb = await api('/api/v1/ad-callback', { method: 'POST', body: { token: g.json.token } });
    ok('ad-callback verifies token', cb.status === 200 && cb.json && cb.json.verified === true);

    const ra = await api('/api/v1/request-access', { method: 'POST', body: { token: g.json.token } });
    const uuid = ra.json && ra.json.uuid;
    ok('request-access returns session', ra.status === 200 && !!uuid && typeof uuid === 'string' && /^[0-9a-f-]{36}$/.test(uuid), `expires=${ra.json && ra.json.expires_at}`);
    let linkOk = false, linkDetail = 'no url';
    try {
      const u = new URL(ra.json.vless_url.replace(/^vless:/, 'https:'));
      linkOk = u.username === uuid
        && u.searchParams.get('path') === '/ws'
        && u.searchParams.get('type') === 'ws'
        && u.searchParams.get('security') === 'none'
        && u.searchParams.get('host') === '127.0.0.1'
        && u.hostname === '127.0.0.1';
      linkDetail = `user=${u.username} path=${u.searchParams.get('path')} type=${u.searchParams.get('type')} sec=${u.searchParams.get('security')}`;
    } catch (_) { /* keep detail */ }
    ok('vless_url well-formed', !!ra.json.vless_url && linkOk, linkDetail);

    // one-time token
    const ra2 = await api('/api/v1/request-access', { method: 'POST', body: { token: g.json.token } });
    ok('token reuse rejected (409)', ra2.status === 409);

    // bad token
    const bad = await api('/api/v1/request-access', { method: 'POST', body: { token: 'nonsense.sig' } });
    ok('invalid token rejected (400)', bad.status === 400);

    /* ---- real VLESS handshake with the granted uuid ---- */
    let hs = await vlessHandshake({ uuidHex: uuid });
    ok('vless+ws handshake: response header 00 00 present', hs.gotResponseHeader);
    ok('vless+ws handshake: upstream HTTP proxies through bridge', hs.data.toString('latin1').indexOf(MOCK_MARKER) !== -1, `${hs.data.length} bytes received`);

    /* ---- negative: unknown uuid ---- */
    hs = await vlessHandshake({ uuidHex: crypto.randomUUID() });
    ok('unknown uuid is rejected (connection closed)', hs.closed && !hs.gotResponseHeader, `code=${hs.closeCode}`);

    /* ---- negative: bad protocol version ---- */
    hs = await vlessHandshake({ ver: 5, uuidHex: uuid, cmd: 1, atype: 1 });
    ok('bad ver byte rejected', hs.closed && !hs.gotResponseHeader, `code=${hs.closeCode}`);

    /* ---- negative: cmd=2 (UDP) unsupported (full IPv4-shaped frame) ---- */
    hs = await vlessHandshake({ uuidHex: uuid, cmd: 2, atype: 1, port: 53 });
    ok('UDP cmd rejected', hs.closed && !hs.gotResponseHeader, `code=${hs.closeCode}`);

    /* ---- enforcement: revoke via admin API ---- */
    const g2 = await api('/api/v1/dev-grant', { method: 'POST', body: { minutes: 30, device: 'android-test' } });
    const ra3 = await api('/api/v1/request-access', { method: 'POST', body: { token: g2.json.token } });
    const uuid2 = ra3.json.uuid;
    const list = await api('/api/v1/admin/sessions', { headers: { 'x-admin-token': ADMIN } });
    ok('admin list shows sessions', list.status === 200
      && Array.isArray(list.json.sessions)
      && list.json.sessions.some((s) => s.uuid === uuid2),
      `status=${list.status} body=${String(list.text).slice(0, 160)}`);

    const del = await api(`/api/v1/admin/sessions/${uuid2}`, { method: 'DELETE', headers: { 'x-admin-token': ADMIN } });
    ok('admin revoke single session', del.status === 200 && del.json.revoked >= 0, `status=${del.status} body=${String(del.text).slice(0, 160)}`);

    hs = await vlessHandshake({ uuidHex: uuid2 });
    ok('revoked uuid rejected at bridge', hs.closed && !hs.gotResponseHeader, `code=${hs.closeCode}`);

    const badAdmin = await api('/api/v1/admin/sessions', { headers: { 'x-admin-token': 'wrong' } });
    ok('admin requires token', badAdmin.status === 403);
  } finally {
    child.kill('SIGTERM');
    mock.close();
  }

  console.log('\n==== SUMMARY ====');
  for (const r of results) console.log(r);
  if (failed) {
    console.log('SMOKE TEST FAILED');
    process.exit(1);
  }
  console.log(`SMOKE TEST PASSED (${results.length} checks)`);
}

main().catch((e) => {
  console.error('smoke test crashed:', e);
  process.exit(1);
});
