/**
 * session_server.js
 * ------------------
 * ONE small Node process that does everything for the testing MVP:
 *
 *   1) HTTP auth API  (TODO.md phase 2 - backend & token flow)
 *        GET  /                      -> status page (also acts as health probe)
 *        GET  /health                -> {"ok":true}
 *        POST|GET /api/v1/dev-grant          -> issue ad-reward token (simulated ad; testing only)
 *        POST|GET /api/v1/ad-callback        -> validates an ad-reward token (AdMob SSV hook lands here later)
 *        POST|GET /api/v1/request-access     -> exchange token for a 30-min session:
 *                                              creates temp UUID, returns vless:// link + JSON details
 *        GET /api/v1/admin/sessions          -> list active sessions   (needs x-admin-token)
 *        DELETE /api/v1/admin/sessions/<uuid>-> revoke one             (needs x-admin-token)
 *        POST /api/v1/admin/revoke-all       -> revoke everything     (needs x-admin-token)
 *
 *   2) VLESS-over-WebSocket inbound on the SAME port (see vless_ws.js).
 *        Clients connect to:  wss(s)://<host><WS_PATH>   (default /ws)
 *      This is the "VPN endpoint" while testing on free hosts where only
 *      HTTP(S)/WebSocket ports are exposed (Hugging Face Spaces etc).
 *
 *   3) TTL enforcement: expired uuids are rejected at both layers, and open
 *      streams get torn down by the 30-second janitor (session_store.cleanup).
 *
 * Endpoint-swap ergonomics:
 *   - PUBLIC_HOST env (e.g. your Cloudflare domain) forces generated vless
 *     links to use host<pub>:443 + TLS, no matter which PaaS URL fronts it.
 *   - Without PUBLIC_HOST, links derive from the incoming request's Host
 *     header, so *.hf.space / *.railway.app / test URLs Just Work.
 *   Moving servers later = change the env var or the DNS record. The Android
 *   app (and the vless:// link pattern) never changes.
 */
'use strict';

const http = require('http');
const store = require('./session_store');
const token = require('./token');
const { attachUpgradeHandler } = require('./vless_ws');

const PORT = parseInt(process.env.PORT || '7860', 10) || 7860;
const HOST = '0.0.0.0';
const WS_PATH = process.env.WS_PATH || '/ws';
const TTL_MINUTES = Math.max(1, parseInt(process.env.TTL_MINUTES || '30', 10) || 30);
const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').trim().toLowerCase();
const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || '443', 10) || 443;
// 'auto': tls -> use PUBLIC_HOST ? tls : infer from X-Forwarded-Proto of the request
const PUBLIC_SECURITY = (process.env.PUBLIC_SECURITY || 'auto').toLowerCase();
const ADMIT_DEV_GRANTS = (process.env.ADMIT_DEV_GRANTS || '1') !== '0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function demoDevice() {
  return 'api';
}

function pickLinkTarget(req) {
  if (PUBLIC_HOST) {
    return { host: PUBLIC_HOST, port: PUBLIC_PORT, security: 'tls' };
  }
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const host = hostHeader.split(':')[0] || 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const forwarded = proto.split(',')[0].trim();
  const isHttps = forwarded ? forwarded === 'https' : (req.socket && req.socket.encrypted === true);
  const security = PUBLIC_SECURITY === 'tls' ? 'tls' : PUBLIC_SECURITY === 'none' ? 'none' : (isHttps ? 'tls' : 'none');
  const port = security === 'tls' ? (hostHeader.includes(':') ? hostHeader.split(':')[1] : '443') : String(PORT);
  return { host, port: parseInt(port, 10) || (security === 'tls' ? 443 : PORT), security };
}

function buildVlessLink(uuid, target, tag) {
  const params = new URLSearchParams({
    encryption: 'none',
    type: 'ws',
    host: target.host,
    path: WS_PATH,
    security: target.security === 'tls' ? 'tls' : 'none',
  });
  if (target.security === 'tls') params.set('sni', target.host);
  return `vless://${uuid}@${target.host}:${target.port}?${params.toString()}#IranAccess-${tag}`;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, max = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  // ---------- status / health ----------
  if (path === '/health') {
    return sendJson(res, 200, { ok: true, now: new Date().toISOString() });
  }

  if (path === '/' || path === '') {
    const s = store.stats();
    return sendJson(res, 200, {
      app: 'Iran Access (testing MVP)',
      ok: true,
      ws_path: WS_PATH,
      ttl_minutes: TTL_MINUTES,
      dev_grants_enabled: ADMIT_DEV_GRANTS,
      active_sessions: s.active_sessions,
      active_streams: s.active_streams,
      endpoints: [
        'POST /api/v1/dev-grant      (simulated ad; testing only)',
        'POST /api/v1/ad-callback    (token conformity check; AdMob SSV lands here later)',
        'POST /api/v1/request-access (token -> 30-min vless session)',
        'GET  /api/v1/admin/sessions (x-admin-token)',
      ],
    });
  }

  // ---------- simulated ad grant (testing only) ----------
  if (path === '/api/v1/dev-grant') {
    if (!ADMIT_DEV_GRANTS) {
      return sendJson(res, 403, { ok: false, error: 'dev grants disabled (ADMIT_DEV_GRANTS=0)' });
    }
    let body = {};
    if (method === 'POST') {
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { body = {}; }
    }
    const minutes = Math.min(60, Math.max(1, parseInt(url.searchParams.get('minutes') || body.minutes || TTL_MINUTES, 10) || TTL_MINUTES));
    const device = url.searchParams.get('device') || body.device || demoDevice();
    const g = token.issue({ minutes, device });
    return sendJson(res, 200, { ok: true, token: g.token, expires_at: new Date(g.exp * 1000).toISOString(), ttl_seconds: g.ttl_seconds, minutes });
  }

  // ---------- ad callback (validates token; real AdMob SSV plug-in point) ----------
  if (path === '/api/v1/ad-callback') {
    let tokenStr = url.searchParams.get('token') || '';
    if (!tokenStr && (method === 'POST')) {
      try { const b = JSON.parse((await readBody(req)) || '{}'); tokenStr = b.token || ''; } catch (_) { /* ignore */ }
    }
    const payload = token.verify(tokenStr);
    if (!payload) {
      return sendJson(res, 400, { ok: false, error: 'invalid or expired ad-reward token' });
    }
    return sendJson(res, 200, { ok: true, verified: true, minutes: payload.minutes, device: payload.device });
  }

  // ---------- the call the app actually uses ----------
  if (path === '/api/v1/request-access') {
    let tokenStr = url.searchParams.get('token') || url.searchParams.get('grant') || '';
    if (!tokenStr && (method === 'POST')) {
      try { const b = JSON.parse((await readBody(req)) || '{}'); tokenStr = b.token || b.grant || ''; } catch (_) { /* ignore */ }
    }
    const payload = token.verify(tokenStr);
    if (!payload) {
      return sendJson(res, 400, { ok: false, error: 'invalid or expired ad-reward token' });
    }
    if (!token.consume(tokenStr)) {
      return sendJson(res, 409, { ok: false, error: 'ad-reward token already used (one token = one session)' });
    }
    const session = store.createSession({ minutes: payload.minutes, device: payload.device });
    const target = pickLinkTarget(req);
    const tag = new Date(session.expiresAt).toISOString().slice(11, 19).replace(/:/g, '');
    const secondsLeft = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    return sendJson(res, 200, {
      ok: true,
      uuid: session.uuid,
      server: { host: target.host, port: target.port, security: target.security, path: WS_PATH },
      ttl_minutes: payload.minutes,
      seconds_left: secondsLeft,
      expires_at: new Date(session.expiresAt).toISOString(),
      vless_url: buildVlessLink(session.uuid, target, tag),
      message: 'Copy the vless_url and import it into V2RayNG (clipboard import), then connect.',
    });
  }

  // ---------- admin ----------
  const isAdmin = ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN;
  if (path.startsWith('/api/v1/admin/')) {
    if (!isAdmin) {
      if (!ADMIN_TOKEN) {
        return sendJson(res, 503, { ok: false, error: 'admin API disabled: set ADMIN_TOKEN env to enable' });
      }
      return sendJson(res, 403, { ok: false, error: 'missing or wrong x-admin-token header' });
    }
    if (path === '/api/v1/admin/sessions' || path.startsWith('/api/v1/admin/sessions/')) {
      if (method === 'DELETE') {
        const parts = path.split('/');
        const maybeUuid = parts[parts.length - 1];
        const hex = store.canonicalizeUuid(maybeUuid);
        if (!hex || parts.length <= 4) {
          return sendJson(res, 400, { ok: false, error: 'uuid expected as /api/v1/admin/sessions/<uuid> for DELETE' });
        }
        const revoked = store.kill(hex);
        return sendJson(res, 200, { ok: true, revoked, uuid: store.prettyUuid(hex) });
      }
      return sendJson(res, 200, { ok: true, ...store.stats(), sessions: store.listSessions() });
    }
    if (path === '/api/v1/admin/revoke-all' && method === 'POST') {
      const all = store.listSessions();
      let revoked = 0;
      for (const s of all) {
        const hex = store.canonicalizeUuid(s.uuid);
        if (hex) revoked += store.kill(hex);
      }
      return sendJson(res, 200, { ok: true, revoked });
    }
    return sendJson(res, 404, { ok: false, error: 'unknown admin route' });
  }

  if (path.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: `unknown api route ${path}` });
  }
  return null; // not an API route we handle (upgrade path falls through)
}

const server = http.createServer(async (req, res) => {  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const handled = await handleApi(req, res, url);
    if (handled === null && !res.headersSent) {
      sendJson(res, 404, { ok: false, error: 'not found (api lives under /api/ ... ; ws at ' + WS_PATH + ')' });
    }
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: 'internal error', detail: String(err.message || err) });
    }
  }
});

attachUpgradeHandler(server, { path: WS_PATH, remoteCheck: remoteCheckForBridge() });

/**
 * Optional remote authority for session validity (used when bridge and
 * token backend live in different places: bridge on Codespace, backend on
 * Cloudflare Workers). vless_ws consults it on every client connection and
 * re-checks periodically, so Worker-side revocations propagate live.
 * Config: REMOTE_CHECK_URL + INTERNAL_KEY env vars.
 */
function remoteCheckForBridge() {
  const urlStr = (process.env.REMOTE_CHECK_URL || '').trim();
  if (!urlStr) return null;
  const key = (process.env.INTERNAL_KEY || '').trim();
  return async function remoteCheck(uuidHex) {
    try {
      const res = await fetch(`${urlStr.replace(/\/+$/, '')}/api/v1/internal/session-check?uuid=${uuidHex}`, {
        headers: { 'x-internal-key': key },
      });
      const j = await res.json();
      if (res.ok && j && j.ok) return { ok: true, uuid: j.uuid, seconds_left: j.seconds_left };
      return null;
    } catch (err) {
      console.error('[remote-check] error:', err.message || err);
      return null;
    }
  };
}

// 30-second janitor: enforces the strict TTL (kills expired sessions + streams)
const janitor = setInterval(() => {
  try {
    const revoked = store.cleanup();
    if (revoked > 0) console.log(`[janitor] revoked ${revoked} expired session(s)`);
  } catch (err) {
    console.error('[janitor] error:', err);
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`Iran-access testing MVP listening on ${HOST}:${PORT}`);
  console.log(`  WS (vless) path .... ${WS_PATH}`);
  console.log(`  TTL ................ ${TTL_MINUTES} minutes`);
  console.log(`  PUBLIC_HOST ........ ${PUBLIC_HOST || '(derive from request Host header)'}`);
  console.log(`  dev-grant endpoint . ${ADMIT_DEV_GRANTS ? 'ENABLED (testing only)' : 'disabled'}`);
  console.log(`  admin API .......... ${ADMIN_TOKEN ? 'enabled' : 'disabled (set ADMIN_TOKEN)'}`);
  console.log(`  remote-check ....... ${process.env.REMOTE_CHECK_URL ? 'ON (' + process.env.REMOTE_CHECK_URL + ')' : 'off (local store only)'}`);
});

function shutdown() {
  console.log('\nShutting down...');
  clearInterval(janitor);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
