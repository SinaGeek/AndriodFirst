/**
 * vless_ws.js
 * -----------
 * A tiny "VLESS over WebSocket" inbound implemented in pure Node - so we do
 * NOT need the Xray binary at all for testing. Any standard client
 * (v2rayNG, v2rayN, sing-box) that can speak vless+ws (+tls termination in
 * front) connects to this exactly like it would connect to Xray.
 *
 * Wire protocol (XTLS/Xray-core "VLESS" spec):
 *   Request  (client -> us, first bytes over WS):
 *       1 byte  version    (0)
 *      16 bytes uuid
 *       1 byte  addonsLen  (0 for plain vless+ws; anything else rejected)
 *       n bytes addons
 *       1 byte  cmd        (1 = TCP, 2 = UDP, 3 = MUX - only 1 accepted)
 *       2 bytes port       (BIG endian)
 *       1 byte  atype      (1 = IPv4, 2 = domain, 3 = IPv6)
 *       atype-specific address bytes
 *   Response (us -> client, first bytes):
 *       1 byte version (0), 1 byte addonsLen (0)  -> 0x00 0x00
 *   ...then everything is a raw TCP byte stream, both directions.
 *
 * Auth/TTL model: the 16-byte uuid must map to an active (non-expired)
 * session from session_store. Unknown or expired uuid => connection closed,
 * which is exactly TODO.md item 1.3 ("30-min enforcer").
 */
'use strict';

const net = require('net');
const { WebSocketServer } = require('ws');
const store = require('./session_store');

const CMD_TCP = 1;

function attachUpgradeHandler(httpServer, options = {}) {
  const wsPath = options.path || '/ws';
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      socket.destroy();
      return;
    }
    if (pathname !== wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    handleConnection(ws, options);
  });

  return wss;
}

function handleConnection(ws, options) {
  const connectTimeoutMs = options.connectTimeoutMs || 20000;
  const idleTimeoutMs = options.idleTimeoutMs || 120000;
  const MAX_HEADER_BUFFER = 8192;

  const acc = [];              // pre-protocol bytes accumulated as Buffer[]
  let accLen = 0;
  let headerParsed = false;
  let socket = null;           // upstream TCP socket
  let connected = false;
  let uuidHex = null;
  let pending = [];            // payload bytes awaiting the upstream connect
  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (handle.recheckTimer) { clearInterval(handle.recheckTimer); handle.recheckTimer = null; }
    try { ws.terminate(); } catch (_) { /* ignore */ }
    if (socket) { try { socket.destroy(); } catch (_) { /* ignore */ } }
    if (uuidHex) store.untrackConnection(uuidHex, handle);
  };

  const handle = { teardown, uuidHex: null, openedAt: Date.now() };

  ws.on('error', () => teardown());
  ws.on('close', () => teardown());

  const startRemoteRecheck = () => {
    if (!options.remoteCheck) return;
    const ms = options.remoteRecheckMs || 45000;
    handle.recheckTimer = setInterval(async () => {
      const res = await options.remoteCheck(uuidHex).catch(() => null);
      if (!res) {
        console.log('[vless] remote check failed: revoked/expired - closing connection');
        teardown();
      }
    }, ms);
    if (handle.recheckTimer && typeof handle.recheckTimer.unref === 'function') handle.recheckTimer.unref();
  };

  ws.on('message', async (data) => {
    if (closed) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);

    if (headerParsed) {
      if (connected && socket.writable) socket.write(chunk);
      else if (pending.length < 2 * 1024 * 1024) pending.push(chunk); // buffer a little while connecting
      return;
    }

    acc.push(chunk);
    accLen += chunk.length;
    if (accLen < 26) return;                  // minimum header: 1+16+1+1+2+1+4 (IPv4 addr)
    if (accLen > MAX_HEADER_BUFFER) {
      console.log('[vless] request header too large - closing');
      teardown();
      return;
    }

    const full = Buffer.concat(acc);
    const header = parseHeader(full);
    if (header === null) return;              // need more bytes yet
    if (header instanceof Error) {
      console.log(`[vless-client] bad request: ${header.message}`);
      try { ws.close(1008, 'bad request'); } catch (_) { /* ignore */ }
      teardown();
      return;
    }

    const { uuid: parsedUuidHex, addonsLen, cmd, target, rest } = header;
    if (parsedUuidHex === null) { teardown(); return; }
    if (addonsLen > 0) {
      console.log('[vless-client] rejected: flow/addons not supported by this test bridge');
      try { ws.close(1008, 'unsupported addons'); } catch (_) { /* ignore */ }
      teardown();
      return;
    }
    if (cmd !== CMD_TCP) {
      console.log(`[vless-client] rejected: cmd ${cmd} (only TCP/1 supported; disable UDP/MUX in client)`);
      try { ws.close(1008, 'unsupported command'); } catch (_) { /* ignore */ }
      teardown();
      return;
    }

    // Wire protocol requires that we stop interpreting the buffer here; a
    // remote auth check may follow (async), after which we connect upstream.
    uuidHex = parsedUuidHex;
    handle.uuidHex = parsedUuidHex;
    headerParsed = true;
    if (rest.length > 0) pending.push(rest);

    let session = store.getSession(parsedUuidHex);
    if (!session && options.remoteCheck) {
      const remote = await options.remoteCheck(parsedUuidHex);
      if (remote && remote.ok !== false) {
        session = { uuid: remote.uuid || parsedUuidHex, expiresAt: remote.expiresAt || 0 };
        handle.expiresAt = remote.expiresAt || null;
      }
    }
    if (!session) {
      console.log('[vless-client] rejected: unknown or expired uuid');
      try { ws.close(1008, 'unauthorized'); } catch (_) { /* ignore */ }
      teardown();
      return;
    }

    store.trackConnection(uuidHex, handle);
    startRemoteRecheck();

    connectUpstream(target, {
      uuidHex,
      connectTimeoutMs,
      idleTimeoutMs,
      onReady: (sock) => {
        socket = sock;
        connected = true;
        // Response header per spec, then drain any queued payload.
        try { ws.send(Buffer.from([0x00, 0x00])); } catch (_) { teardown(); return; }
        for (const p of pending) { if (socket.writable) socket.write(p); }
        pending = [];
      },
      onFail: (msg) => {
        console.log(`[vless-client] upstream connect failed: ${msg}`);
        try { ws.close(1014, 'upstream connect failed'); } catch (_) { /* ignore */ }
        teardown();
      },
    });
  });

  /** On success returns {uuid, addonsLen, cmd, target, rest}; null = need more; Error = bad. */
  function parseHeader(b) {
    if (b.length < 18) return null;
    if (b[0] !== 0) return new Error(`unknown protocol version ${b[0]}`);
    const uuidHex = b.toString('hex', 1, 17);
    if (!store.canonicalizeUuid(uuidHex)) return new Error('malformed uuid');
    const addonsLen = b[17];
    let off = 18;
    if (b.length < off + addonsLen) return null;
    off += addonsLen; // only acceptable amount is 0 (checked by caller)
    if (b.length < off + 1) return null;
    const cmd = b[off++];
    if (b.length < off + 2) return null;
    const port = b.readUInt16BE(off); off += 2;
    if (b.length < off + 1) return null;
    const atype = b[off++];
    let host;
    if (atype === 1) {              // IPv4
      if (b.length < off + 4) return null;
      host = `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`;
      off += 4;
    } else if (atype === 2) {       // domain
      if (b.length < off + 1) return null;
      const dlen = b[off++];
      if (dlen === 0 || b.length < off + dlen) return null;
      host = b.toString('ascii', off, off + dlen);
      off += dlen;
      if (!/^[\w.-]+$/.test(host)) return new Error('bad domain encoding');
    } else if (atype === 3) {       // IPv6
      if (b.length < off + 16) return null;
      const groups = [];
      for (let i = 0; i < 16; i += 2) groups.push(b.toString('hex', off + i, off + i + 2).padStart(4, '0'));
      host = `[${groups.join(':')}]`;
      off += 16;
    } else {
      return new Error(`bad address type ${atype}`);
    }
    return { uuid: uuidHex, addonsLen, cmd, target: { host, port }, rest: b.slice(off) };
  }

  function connectUpstream(target, ctx) {
    const { uuidHex: uh, connectTimeoutMs: connTo, idleTimeoutMs: idleTo, onReady, onFail } = ctx;
    if (!store.getSession(uh)) { onFail('session expired'); return; }
    const sock = net.connect({ host: target.host, port: target.port, noDelay: true });
    sock.setTimeout(connTo);
    sock.on('connect', () => {
      sock.setTimeout(idleTo); // re-arm as idle guard between bytes
      onReady(sock);
    });
    sock.on('data', (buf) => {
      if (!closed && ws.readyState === ws.OPEN) {
        try { ws.send(buf, { binary: true }); } catch (_) { teardown(); }
      }
    });
    sock.on('timeout', () => sock.destroy(new Error(connected ? 'idle timeout' : 'connect timeout')));
    sock.on('error', (err) => {
      if (!connected) onFail(`${target.host}:${target.port}: ${err.message}`);
      else teardown();
    });
    sock.on('close', () => { if (connected) teardown(); });
  }
}

module.exports = { attachUpgradeHandler };
