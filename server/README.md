---
title: Iran Access (Testing MVP)
emoji: 🕹️
colorFrom: indigo
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# Iran Access — Testing MVP server

One tiny Node process (no Xray binary!) with two roles on **one HTTP port**:

1. **Auth/token API** — the app calls this after a (simulated, for now) rewarded ad:
   - `GET /health` — health probe
   - `POST /api/v1/dev-grant` — issue an ad-reward token (simulated ad, testing only)
   - `POST /api/v1/ad-callback` — validate a token (this is where the real AdMob SSV callback plugs in later)
   - `POST /api/v1/request-access` — exchange the token for a **strict 30-minute session** and get a `vless://` link
   - admin (with `x-admin-token`): `GET /api/v1/admin/sessions`, `DELETE /api/v1/admin/sessions/<uuid>`, `POST /api/v1/admin/revoke-all`
2. **VLESS-over-WebSocket inbound** at path **`/ws`** — a hand-written mini implementation of the Xray VLESS protocol.
   Any standard client (v2rayNG / sing-box) connects as usual, but every connection's 16-byte UUID must belong to a live,
   non-expired session — expired/revoked UUIDs are refused and any still-open streams are torn down.

## Try it with a client (no app needed)

1. `curl -X POST https://<your-space>.hf.space/api/v1/dev-grant -H 'content-type: application/json' -d '{"minutes":30,"device":"manual"}'`
2. `curl -X POST https://<your-space>.hf.space/api/v1/request-access -H 'content-type: application/json' -d '{"token":"<token-from-step-1>"}'`
3. Copy the `vless_url` from the JSON → V2RayNG → `+` → *Paste from clipboard* → connect.

## Config (environment)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `7860` | listen port (HF: `app_port` in README metadata) |
| `TTL_MINUTES` | `30` | session lifetime |
| `WS_PATH` | `/ws` | vless websocket path |
| `PUBLIC_HOST` | *(empty)* | force links to a domain (e.g. your Cloudflare one) |
| `PUBLIC_PORT` | `443` | port advertised with `PUBLIC_HOST` |
| `PUBLIC_SECURITY` | `auto` | `auto`/`tls`/`none` linking policy |
| `DEV_GRANT_SECRET` | (insecure default) | HMAC secret for tokens — set a secret in prod |
| `TOKEN_TTL_SECONDS` | `300` | how long a granted token may be redeemed |
| `ADMIT_DEV_GRANTS` | `1` | simulated-ad endpoint on/off |
| `ADMIN_TOKEN` | *(empty)* | enables the admin API when set |

## CI

`smoke_test.js` boots this server in GitHub Actions, walks the full app flow and performs a
real vless+ws handshake against a mock upstream — no Xray download needed.
