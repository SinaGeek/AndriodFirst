/**
 * session_store.js
 * ----------------
 * In-memory registry of temporary access sessions (one UUID per unlocked user).
 * Every granted UUID expires strictly after TTL minutes. When it expires:
 *   - /api/* requests referring to it fail, and
 *   - the VLESS bridge drops any open TCP streams that were opened with it.
 *
 * This is intentionally simple (single instance, RAM only) - enough for
 * testing. For multi-instance/production, swap the Map for Redis later.
 */
'use strict';

const crypto = require('crypto');

/**
 * uuidHex -> {
 *   uuidHex, uuid, createdAt, expiresAt, device, consumedAt: null,
 * }
 */
const sessions = new Map();

/** uuidHex -> Set<{ ws, socket }> (managed by vless_ws.js) */
const connections = new Map();

function canonicalizeUuid(raw) {
  // Accepts "xxxxxxxx-xxxx-..." or bare 32-hex chars; returns bare lowercase hex.
  const hex = String(raw || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 32) return null;
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return hex;
}

function prettyUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function newSessionUuid() {
  return crypto.randomUUID().replace(/-/g, ''); // v4 UUID, bare hex
}

function createSession({ minutes = 30, device = 'unknown' } = {}) {
  const uuidHex = newSessionUuid();
  const now = Date.now();
  const session = {
    uuidHex,
    uuid: prettyUuid(uuidHex),
    createdAt: now,
    expiresAt: now + Math.max(1, Math.round(minutes)) * 60 * 1000,
    device,
    closedAt: null,
  };
  sessions.set(uuidHex, session);
  return session;
}

function getSession(uuidRaw) {
  const uuidHex = canonicalizeUuid(uuidRaw);
  if (!uuidHex) return null;
  const s = sessions.get(uuidHex);
  if (!s) return null;
  if (Date.now() >= s.expiresAt) {
    kill(uuidHex);
    return null;
  }
  return s;
}

/** Seconds left for the session (<=0 if missing/expired). */
function secondsLeft(s) {
  return s ? Math.floor((s.expiresAt - Date.now()) / 1000) : -1;
}

/** Track a bridge connection under a uuid (so expiry can tear it down). */
function trackConnection(uuidHex, handle) {
  if (!connections.has(uuidHex)) connections.set(uuidHex, new Set());
  connections.get(uuidHex).add(handle);
}

function untrackConnection(uuidHex, handle) {
  const set = connections.get(uuidHex);
  if (set) {
    set.delete(handle);
    if (set.size === 0) connections.delete(uuidHex);
  }
}

/** Tear down every TCP stream opened with this uuid. */
function killConnections(uuidHex) {
  const set = connections.get(uuidHex);
  if (!set) return 0;
  let killed = 0;
  for (const handle of [...set]) { // snapshot: teardown() mutates `set`
    try {
      handle.teardown();
    } catch (_) { /* ignore */ }
    killed++;
  }
  connections.delete(uuidHex);
  return killed;
}

function kill(uuidHex) {
  if (sessions.has(uuidHex)) {
    const s = sessions.get(uuidHex);
    s.closedAt = Date.now();
    sessions.delete(uuidHex);
  }
  return killConnections(uuidHex);
}

/** Remove every expired session; called on an interval. */
function cleanup() {
  const now = Date.now();
  let revoked = 0;
  for (const [uuidHex, s] of sessions) {
    if (now >= s.expiresAt) {
      kill(uuidHex);
      revoked++;
    }
  }
  return revoked;
}

function listSessions() {
  const now = Date.now();
  const out = [];
  for (const s of sessions.values()) {
    out.push({
      uuid: s.uuid,
      device: s.device,
      created_at: new Date(s.createdAt).toISOString(),
      expires_at: new Date(s.expiresAt).toISOString(),
      seconds_left: Math.max(0, Math.floor((s.expiresAt - now) / 1000)),
      active_streams: (connections.get(s.uuidHex) || new Set()).size,
    });
  }
  return out;
}

function stats() {
  return {
    active_sessions: sessions.size,
    active_streams: [...connections.values()].reduce((n, set) => n + set.size, 0),
  };
}

module.exports = {
  canonicalizeUuid,
  prettyUuid,
  createSession,
  getSession,
  secondsLeft,
  trackConnection,
  untrackConnection,
  kill,
  cleanup,
  listSessions,
  stats,
};
