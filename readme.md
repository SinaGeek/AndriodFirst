# Iran Access & Banking VPN (Ad-Supported IP Gateway)

An ad-supported, secure VPN application built with **native Android Java** (mobile) and **Node.js** (backend). This system provides overseas Iranian citizens with temporary 30-minute access to Iranian IP addresses to use restricted Iran-Access services, including online banking, government portals (**Adl Iran / عدل ایران**, **Worker-Employer Relations / سامانه روابط کار**, Complaint Systems), and private domestic platforms safely and legally.

---

## 🧪 Current status: TESTING MVP (this build)

What is already implemented in this repo:

| Piece | Status | Where |
|---|---|---|
| Backend: ad-token API (HMAC, one-time use, TTL) | ✅ coded | `server/token.js`, `server/session_server.js` |
| Backend: 30-min temp sessions + revocation | ✅ coded | `server/session_store.js` |
| VPN endpoint: **mini VLESS-over-WS bridge in pure Node** (no Xray binary!) | ✅ coded | `server/vless_ws.js` |
| CI smoke test (boots server, walks app flow, performs a real vless+ws handshake) | ✅ coded | `server/smoke_test.js` + `.github/workflows/test_server.yml` |
| Android test UI (simulated ad → grant → config → open in v2rayNG) | ✅ coded | `app/src/main/.../MainActivity.java` |
| Placeholder for real rewarded AdMob + SSV | ⬜ later | TODO.md 2.2 / 3.3 |
| Hosting for the test backend | 🔄 deploying now | **Render free** (Docker + WebSocket, no card) |
| Real Iran VPS | ⬜ future (swap is 1 env var) | `server/README.md` |

### Why there is no Xray involved (for testing)

The free hosts we are testing on (Render/HF/etc.) only expose HTTP(S) ports — raw TCP VPN protocols need Docker + TCP, which costs money. Instead the testing server implements the **VLESS protocol over WebSocket by hand** in ~300 lines of Node: same wire protocol, same client behavior, tiny footprint. When you later move to the real Iran VPS you can run this *same* folder there, or replace it with a native Xray install — the app and the `vless://` links stay identical.

### Test flow (matches the final design)

```
[Android app] ──(simulated ad for now)──► POST /api/v1/dev-grant → reward token
[Android app] ──► POST /api/v1/request-access {token}  → temp UUID + vless:// link (30 min)
[Android app] ──► import to V2RayNG (clipboard/deep link)
[V2RayNG] ──► wss://<server>/ws   (UUID must be a live session)
[Node bridge] ──► raw TCP to the world  ↔  server-side revocation at exactly 30:00
```

### Deploy the backend (Render, free)

1. The repo already contains `render.yaml` (Blueprint). On dashboard.render.com → **New + → Blueprint** → pick this repo → Apply. Root dir is `server/`, runtime Docker, health check `/health`.
2. You get `https://iran-access-test-xxxx.onrender.com` — set that in the app via **Backend URL…** button.
3. Sleep note: free tier sleeps after 15 idle minutes; the first connection wakes it (~30–50 s).

### Swap to your real Iran VPS later (no app changes)

Options (same repo folder works for both):
- **Same software**: run `server/` on the VPS (plain `node server` or the provided Dockerfile) behind nginx TLS.
- **Native Xray**: install Xray on the VPS, use the identical `vless+ws` shape on the same path.
Either way just update the address the app points at (in-app "Backend URL…" — nothing to rebuild).

---

## 📌 Original system architecture (vision)

```
[Mobile App] → [Ad completion trigger → Server-Side Verification (SSV)]
→ [Auth backend: short-lived 30-min dynamic connection token]
→ [App connects via V2Ray/Xray protocol using token]
→ [Iran VPS endpoint — disconnected strictly at 30 minutes]
→ Iranian Banks / Adl Iran / Government portals / domestic-only sites
```

## 🔒 Security & anti-reverse-engineering strategy

1. **No static credentials:** no UUIDs, IPs, or V2Ray configs are ever hardcoded in the app — everything arrives at runtime from the token backend.
2. **Dynamic one-time tokens:** ad reward tokens are HMAC-signed, expire in 5 minutes, and are consumed exactly once (`server/token.js`).
3. **Short-lived configs:** sessions live strictly `TTL_MINUTES` (default 30); expiry is enforced in **two layers** — the API and the WS bridge — plus a 30-s janitor tearing down open streams.
4. **No secrets in APK:** the app ships with no backend URL built in; you set it in-app (later builds can pin it).
5. Later hardening: ProGuard/R8 + Flutter-style obfuscation notes remain in TODO.md.

## 🛠️ Tech stack (actual)

* **Mobile:** native Android (Java), `minSdk 29` — pure `HttpURLConnection` + `org.json`, **zero** external libraries.
* **Backend:** single Node 20 process (`ws` is the only npm dependency), Dockerfile included.
* **VPN wire:** VLESS over WebSocket (hand-implemented server side for testing; standard clients fully compatible).
* **CI:** GitHub Actions — `build.yml` (debug APK) + `test_server.yml` (end-to-end server smoke test).
* **Testing host:** Render free tier (Docker + HTTPS + WebSocket).

## 📄 License
This project is licensed under the MIT License.
