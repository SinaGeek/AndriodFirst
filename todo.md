# 📝 Step-by-Step Implementation TODO List

State legend: ✅ done · 🔄 in progress · ⬜ pending

---

## Phase 0: Testing MVP (current build) ✅ mostly done
- [x] **0.1** Repo quick-restored: native Android Java app (was Counter demo).
- [x] **0.2** Backend API + token auth (HMAC, one-time, short expiry) — see `server/`.
- [x] **0.3** 30-min temporary sessions with two-layer enforcement (API + live-stream teardown) + admin revoke.
- [x] **0.4** **Mini VLESS-over-WebSocket bridge in pure Node** (no Xray binary) with UUID gating.
- [x] **0.5** CI: `test_server.yml` walks *dev-grant → ad-callback → request-access → real vless+ws handshake → negative cases → revoke*, and `build.yml` keeps building the debug APK.
- [x] **0.6** Android test UI: backend-URL setting, simulated ad, config fetch, session countdown, copy link, open in V2RayNG.
- [ ] **0.7** 🔄 Deploy backend to **Render (free)** via `render.yaml` blueprint.
- [ ] **0.8** End-to-end: phone + V2RayNG + Render server → connect → open an Iran-only service.
- [ ] **0.9** Optional: front it with your **Cloudflare domain** (set `PUBLIC_HOST` env; CNAME → *.onrender.com; SSL mode Full; WebSocket on).

## Phase 1: Iran VPS & Routing Setup ⬜ (the real box)
- [ ] **1.1** Purchase & configure Iran VPS (Ubuntu 22.04 LTS; clean IP for banks/Adl Iran/gov).
- [ ] **1.2** Migrate the endpoint: EITHER run `server/` as-is (`node` or the Dockerfile) behind nginx TLS, OR install native **Xray** with the same `vless+ws` shape (path unchanged, UUID-per-session logic equivalent).
- [ ] **1.3** Keep TTL enforcement: the bridge already does it; for the Xray-native variant add the cron/HTTP-API revoker (same 30-min semantics).
- [ ] **1.4** Firewall: allow only SSH (22) + HTTPS (443); fail2ban.

## Phase 2: Authentication & Token Backend (production hardening)
- [x] **2.1** Serverless-style single-process backend (done — swap for Workers/Express split later if needed).
- [ ] **2.2** Real AdMob **Server-Side Verification**: rewarded-SSV callback lands on `/api/v1/ad-callback` — verify AdMob RSA signature + `key_id`, then call the same internal `token.issue()`.
- [x] **2.3** `/api/v1/request-access` returns decrypted-free vless config: ✅ (one-time token → 30-min UUID → link).
- [ ] **2.4** Set `ADMIT_DEV_GRANTS=0` + your own `DEV_GRANT_SECRET` once real ads land.

## Phase 3: Mobile App (real polish)
- [x] **3.1** Android project exists (native Java; workspace minimal deps).
- [x] **3.2** VPN session controller (testing shape): fetch/link path via V2RayNG; countdown included.
- [ ] **3.3** Real rewarded video (AdMob `google_mobile_ads`): 1 video → grant → session; the simulated-ad dialog is the placeholder.
- [ ] **3.4** In-app VPN core (native `VpnService` + Xray/naive core, OR switch to Flutter+flutter_v2ray) so users don't need the V2RayNG side-app.
- [ ] **3.5** Obfuscation: enable R8/ProGuard minify; consider runtime backend provocation later.
- [ ] **3.6** Animations, POL, target-service badges (banking/Adl Iran/labor).

## Phase 4: CI/CD 👌 partially
- [x] **4.1** Auto-build debug APK on push (`build.yml`).
- [x] **4.2** Server smoke-test workflow (`test_server.yml`) — no Xray download needed.
- [ ] **4.3** Sign release: add `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `ALIAS` secrets → signed AAB artifacts.

## Phase 5: Store publishing ⬜ later
- [ ] **5.1** Play Console: listing, VpnService declaration, data-safety, closed testing.
- [ ] **5.2** (optional) App Store: VPN entitlement request, TestFlight.
