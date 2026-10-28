/**
 * worker.js — Iran Access (Testing MVP) — Cloudflare Worker edition
 * -----------------------------------------------------------------
 * FREE, no-card hosting for the token/auth API on the user's own Cloudflare.
 * Stateless crypto (HMAC ad-reward tokens) + state in KV:
 *   used tokens  -> key "u:<sha256(token)>" (auto-expiry)
 *   live session -> key "sr:<uuidHex>"      (auto-expiry at session end)
 *
 * Same API contract as server/session_server.js (the Node 版), so the
 * Android app needs zero changes — just switch the backend URL in-app:
 *   GET  /health
 *   POST|GET /api/v1/dev-grant        (simulated ad; testing only)
 *   POST|GET /api/v1/ad-callback      (token validity check; AdMob SSV lands here later)
 *   POST|GET /api/v1/request-access   (token -> 30-min session; returns vless:// link)
 *   POST|GET /api/v1/site-relay?url=  (plain-HTTPS relay for websites; requires a
 *            valid grant token header "x-access-token" - lets you test
 *            Iran-only SITES today with NO VPN core at all)
 *   GET /api/v1/internal/session-check  (bridge calls this per client WS
 *            connection; header "x-internal-key" === INTERNAL_KEY)
 *
 * Vars (set in dashboard Settings -> Variables):
 *   DEV_GRANT_SECRET   HMAC secret (MUST change from default)
 *   INTERNAL_KEY       shared secret for the bridge <-> worker check API
 *   BRIDGE_HOST        public host of the current vless/ws endpoint, e.g.
 *                      "xyz-7860-abcd.app.github.dev" (Codespace) or Cloudflare
 *                      domain pointing at the future Iran VPS. Update this var
 *                      to move hosts - the app never changes.
 *   BRIDGE_PORT        default 443
 *   TTL_MINUTES        default 30
 *   TOKEN_TTL_SECONDS  default 300
 *   ADMIT_DEV_GRANTS   default "1" (set "0" once real ads exist)
 * Bindings:
 *   SESSION            KV namespace
 */
'use strict';

const DEFAULT_TTL_MINUTES = 30;
const DEFAULT_TOKEN_TTL = 300;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function cors(h) {
  h['access-control-allow-origin'] = '*';
  h['access-control-allow-methods'] = 'GET,POST,OPTIONS';
  h['access-control-allow-headers'] = 'content-type,x-access-token,x-admin-token,x-internal-key';
  return h;
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64urlEncodeBuf(new Uint8Array(sig));
}

function b64urlEncodeBuf(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // chunk to avoid apply() limits
  for (let i = 0; i < arr.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeB(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexOf(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function newUuidHex() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return hexOf(b);
}

function prettyUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function issueToken(env, { minutes, device }) {
  const now = Math.floor(Date.now() / 1000);
  const ttlSec = Math.max(30, parseInt(env.TOKEN_TTL_SECONDS || DEFAULT_TOKEN_TTL, 10) || DEFAULT_TOKEN_TTL);
  const nonce = hexOf(crypto.getRandomValues(new Uint8Array(12)));
  const payload = { v: 1, iat: now, exp: now + ttlSec, minutes: Number(minutes) || DEFAULT_TTL_MINUTES, device: String(device || 'unknown').slice(0, 64), nonce };
  const body = b64urlEncodeBuf(new TextEncoder().encode(JSON.stringify(payload)));
  const token = `${body}.${await hmacSign(env.DEV_GRANT_SECRET, body)}`;
  const digest = hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  await env.SESSION.put(`u:${digest}`, '1', { expirationTtl: ttlSec + 60 }); // auto-evaporates; no deletes needed
  return { token, expires_at: new Date(payload.exp * 1000).toISOString(), ttl_seconds: ttlSec, minutes: payload.minutes };
}

async function verifyToken(env, tokenStr) {
  if (typeof tokenStr !== 'string' || tokenStr.length > 1024) return null;
  const dot = tokenStr.indexOf('.');
  if (dot <= 0) return null;
  const body = tokenStr.slice(0, dot);
  const expect = await hmacSign(env.DEV_GRANT_SECRET, body);
  if (expect !== tokenStr.slice(dot + 1)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecodeB(body)));
  } catch (_) {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function consumeToken(env, tokenStr) {
  const digest = hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenStr)));
  const key = `u:${digest}`;
  const seen = await env.SESSION.get(key);
  if (seen) return false;
  await env.SESSION.put(key, '1', { expirationTtl: 300 });
  return true;
}

async function createSession(env, { minutes, device }) {
  const uuidHex = newUuidHex();
  const now = Date.now();
  const expMs = now + (Math.max(1, Math.round(minutes))) * 60 * 1000;
  const secondsLeft = Math.floor((expMs - now) / 1000);
  await env.SESSION.put(`sr:${uuidHex}`, JSON.stringify({
    uuid: prettyUuid(uuidHex), device, exp: Math.floor(expMs / 1000),
  }), { expirationTtl: secondsLeft + 120 }); // auto-cleanup + margin
  return { uuidHex, uuid: prettyUuid(uuidHex), expiresAtMs: expMs };
}

async function sessionState(env, uuidHex) {
  const raw = await env.SESSION.get(`sr:${uuidHex}`);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s.exp || s.exp * 1000 <= Date.now()) return null;
    return s;
  } catch (_) {
    return null;
  }
}

async function readBodyJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

/* ---------------- link builder ---------------- */
function buildVlessLink(uuid, { host, port, security, path }) {
  const params = new URLSearchParams({
    encryption: 'none',
    type: 'ws',
    host,
    path,
    security: security === 'tls' ? 'tls' : 'none',
  });
  if (security === 'tls') params.set('sni', host);
  return `vless://${uuid}@${host}:${port}?${params.toString()}#IranAccess-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
}

function bridgeTargetFromEnv(env) {
  const host = String(env.BRIDGE_HOST || '').toLowerCase().trim();
  if (!host) return null;
  return {
    host,
    port: parseInt(env.BRIDGE_PORT || '443', 10) || 443,
    security: String(env.BRIDGE_SECURITY || 'tls').toLowerCase() === 'none' ? 'none' : 'tls',
    path: String(env.WS_PATH || '/ws'),
  };
}

/* ---------------- worker entry ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors({}) });
    }
    const withCors = (r) => { r.headers.set('access-control-allow-origin', '*'); return r; };

    try {
      if (path === '/health' || path === '/') {
        const stats = parseInt(path === '/health' ? 0 : 1, 10);
        if (path === '/health') return withCors(json({ ok: true, now: new Date().toISOString() }));
        // status page
        const hasBridge = !!bridgeTargetFromEnv(env);
        return withCors(json({
          app: 'Iran Access (testing MVP, Cloudflare edition)',
          ok: true,
          bridge_host: hasBridge ? bridgeTargetFromEnv(env).host : null,
          dev_grants_enabled: (env.ADMIT_DEV_GRANTS || '1') !== '0',
          ttl_minutes: parseInt(env.TTL_MINUTES || DEFAULT_TTL_MINUTES, 10) || DEFAULT_TTL_MINUTES,
          endpoints: ['POST /api/v1/dev-grant', 'POST /api/v1/ad-callback', 'POST /api/v1/request-access', 'POST /api/v1/site-relay?url='],
        }));
      }

      if (path === '/api/v1/dev-grant') {
        if ((env.ADMIT_DEV_GRANTS || '1') === '0') {
          return withCors(json({ ok: false, error: 'dev grants disabled (ADMIT_DEV_GRANTS=0)' }, 403));
        }
        let q = {};
        if (method === 'POST') q = await readBodyJson(request);
        const minutes = Math.min(60, Math.max(1, parseInt(url.searchParams.get('minutes') || q.minutes || (env.TTL_MINUTES || DEFAULT_TTL_MINUTES), 10) || DEFAULT_TTL_MINUTES));
        const device = url.searchParams.get('device') || q.device || 'unknown';
        const g = await issueToken(env, { minutes, device });
        return withCors(json({ ok: true, ...g }));
      }

      if (path === '/api/v1/ad-callback') {
        let tokenStr = url.searchParams.get('token') || '';
        if (!tokenStr && method === 'POST') {
          const b = await readBodyJson(request);
          tokenStr = b.token || '';
        }
        const payload = await verifyToken(env, tokenStr);
        if (!payload) return withCors(json({ ok: false, error: 'invalid or expired ad-reward token' }, 400));
        return withCors(json({ ok: true, verified: true, minutes: payload.minutes, device: payload.device }));
      }

      if (path === '/api/v1/request-access') {
        let tokenStr = url.searchParams.get('token') || url.searchParams.get('grant') || '';
        if (!tokenStr && method === 'POST') {
          const b = await readBodyJson(request);
          tokenStr = b.token || b.grant || '';
        }
        const payload = await verifyToken(env, tokenStr);
        if (!payload) return withCors(json({ ok: false, error: 'invalid or expired ad-reward token' }, 400));
        if (!(await consumeToken(env, tokenStr))) {
          return withCors(json({ ok: false, error: 'ad-reward token already used (one token = one session)' }, 409));
        }
        const target = bridgeTargetFromEnv(env);
        const session = await createSession(env, { minutes: payload.minutes, device: payload.device });
        const base = {
          ok: true,
          uuid: session.uuid,
          ttl_minutes: payload.minutes,
          seconds_left: Math.max(0, Math.floor((session.expiresAtMs - Date.now()) / 1000)),
          expires_at: new Date(session.expiresAtMs).toISOString(),
          bridge_host: target ? target.host : null,
        };
        if (!target) {
          return withCors(json({
            ...base,
            vless_url: null,
            hint: 'BRIDGE_HOST not set: add the current bridge/codespace host in Workers settings.',
          }));
        }
        return withCors(json({
          ...base,
          server: { host: target.host, port: target.port, security: target.security, path: target.path },
          vless_url: buildVlessLink(session.uuid, target),
          message: 'Copy the vless_url and import it into V2RayNG (clipboard import), then connect.',
        }));
      }

      if (path === '/api/v1/site-relay') {
        // Plain-HTTPS relay for websites - test Iran-restricted SITES without any
        // VPN core. Requires a still-valid grant token (free-plan hygiene).
        const headerToken = request.headers.get('x-access-token');
        if (!(await verifyToken(env, headerToken))) {
          return withCors(json({ ok: false, error: 'site-relay requires valid x-access-token' }, 401));
        }
        const target = url.searchParams.get('url');
        if (!target || !/^https?:\/\//i.test(target)) {
          return withCors(json({ ok: false, error: '?url= required' }, 400));
        }
        const upstream = await fetch(target, {
          method: method === 'POST' ? 'POST' : 'GET',
          redirect: 'follow',
          headers: { 'user-agent': 'Mozilla/5.0 (IranAccess test relay)', 'accept-language': 'fa,en' },
          cf: { cacheTtl: 0 },
        });
        const respHeaders = cors({ 'content-type': upstream.headers.get('content-type') || 'application/octet-stream' });
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      }

      if (path === '/api/v1/internal/session-check') {
        // consumed by the vless/ws bridge on each client connection
        if (!env.INTERNAL_KEY || request.headers.get('x-internal-key') !== env.INTERNAL_KEY) {
          return withCors(json({ ok: false, error: 'bad internal key' }, 403));
        }
        const hex = (url.searchParams.get('uuid') || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        if (!/^[0-9a-f]{32}$/.test(hex)) return withCors(json({ ok: false, error: 'malformed uuid' }, 400));
        const s = await sessionState(env, hex);
        if (!s) return withCors(json({ ok: false, error: 'unknown or expired session' }, 404));
        return withCors(json({ ok: true, uuid: s.uuid, exp: s.exp, seconds_left: Math.floor(s.exp - Date.now() / 1000), device: s.device || 'unknown' }));
      }

      return withCors(json({ ok: false, error: 'unknown route' }, 404));
    } catch (err) {
      return withCors(json({ ok: false, error: 'worker error', detail: String(err && err.message || err) }, 500));
    }
  },
};
