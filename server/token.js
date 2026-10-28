/**
 * token.js
 * --------
 * Ad-Master tokens: tiny HMAC-signed payload blobs proving "a reward token
 * was issued after ad completion". For the TESTING phase the server also has
 * a simulated-ad grant endpoint; the real AdMob Server-Side Verification
 * chain will produce the *same token* later (issueToken call after SSV
 * verifies the AdMob signature), so the app flow never changes.
 *
 * Format:  base64url(JSON payload) + "." + base64url(HMAC-SHA256)
 * Payload: {v:1, iat, exp, minutes, device, nonce}
 * Policy:  short expiry (TOKEN_TTL_SECONDS), single-use (consumed by the
 *          successful /api/v1/request-access call).
 */
'use strict';

const crypto = require('crypto');

const NONCE_POOL = 16;

let SECRET = process.env.DEV_GRANT_SECRET || 'dev-secret-CHANGE-ME-1';
if (!process.env.DEV_GRANT_SECRET) {
  console.warn('[token] WARNING: DEV_GRANT_SECRET not set - using insecure default (fine for lab testing only).');
}

const TOKEN_TTL_SECONDS = Math.max(30, parseInt(process.env.TOKEN_TTL_SECONDS || '300', 10) || 300);

const used = new Set(); // one-time-use registry (key: token string)

function b64url(bufOrStr) {
  return Buffer.from(bufOrStr).toString('base64url');
}

function sign(payloadJson) {
  return crypto.createHmac('sha256', SECRET).update(payloadJson).digest('base64url');
}

function stableStringify(payload) {
  // deterministic key order for signature stability
  return JSON.stringify([
    payload.v, payload.iat, payload.exp, payload.minutes, payload.device, payload.nonce,
  ]);
}

/** Issue a fresh grant token. */
function issue({ minutes, device } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    minutes: Number(minutes) || 30,
    device: String(device || 'unknown').slice(0, 64),
    nonce: crypto.randomBytes(NONCE_POOL).toString('base64url'),
  };
  const body = b64url(stableStringify(payload));
  const token = `${body}.${sign(body)}`;
  prune();
  return { token, exp: payload.exp, ttl_seconds: TOKEN_TTL_SECONDS };
}

/** Verify signature + expiry. Returns payload or null. Usually followed by consume(). */
function verify(token) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payloadStr;
  try {
    payloadStr = Buffer.from(body, 'base64url').toString('utf8');
  } catch (_) {
    return null;
  }
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    const v = JSON.parse(payloadStr); // ["v", iat, exp, minutes, device, nonce]
    if (!Array.isArray(v) || v.length !== 6) return null;
    payload = { v: v[0], iat: v[1], exp: v[2], minutes: v[3], device: v[4], nonce: v[5] };
  } catch (_) {
    return null;
  }
  if (payload.v !== 1) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.minutes !== 'number') return null;
  return payload;
}

/** Consume a verified token (single use). Returns true once. */
function consume(token) {
  if (used.has(token)) return false;
  used.add(token);
  return true;
}

/** Drop expired entries from the one-time registry. */
function prune() {
  const now = Math.floor(Date.now() / 1000);
  for (const token of used) {
    const payload = verify(token);
    if (!payload || payload.exp <= now) used.delete(token);
  }
  // coarse cap safety for lab use
  if (used.size > 5000) used.clear();
}

module.exports = { issue, verify, consume, prune, TOKEN_TTL_SECONDS };
