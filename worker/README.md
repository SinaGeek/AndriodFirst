# Iran Access Testing MVP — Cloudflare Worker (API + site relay)

Hosts the **token/auth API** on your own Cloudflare account's free plan
(100k requests/day — no card needed):

- `GET /health` — status
- `POST /api/v1/dev-grant` — issue a simulated-ad reward token (testing only)
- `POST /api/v1/ad-callback` — validate a token (the real AdMob SSV callback lands here later)
- `POST /api/v1/request-access` — token → **30-min session** UUID + a `vless://` link (link host comes from the `BRIDGE_HOST` var — point it at your Codespace bridge, then at your Iran VPS later)
- `POST|GET /api/v1/site-relay?url=...` — plain HTTPS relay for **websites** with a valid ad-reward token header (`x-access-token`). Lets you test Iran-restricted sites **today** through the app with no VPN core (mechanical test only — final geo-data comes from the Iran VPS path).
- `GET /api/v1/internal/session-check?uuid=...` — consumed by the Node vless bridge on every client connection (uses `x-internal-key` header), so revocation on the Worker propagates to live connections.

State lives in a KV namespace (one-time tokens + live sessions auto-expire).

## Deploy via dashboard (no CLI, no card)

1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Worker** (name it, Deploy the starter). Wait for the worker URL (`https://<name>.<account>.workers.dev`).
2. Click **Edit** on your new worker (Quick Edit) → paste everything from `worker.js` over the starter code → Save → Deploy.
3. Back in the worker → **Settings** → **Bindings** → **+ Add**:
   - **KV namespace**: Create one first (Workers & Pages → KV → Create: name `iran-access-test`). Then bind it with namespace name **SESSION**.
   - **Variables**: `DEV_GRANT_SECRET` (any random string), `INTERNAL_KEY` (any random string; give the same value to the bridge on Codespace), optional `TTL_MINUTES=30`; later set `BRIDGE_HOST` (Codespace public host, no protocol/port) and `BRIDGE_PORT=443`.
4. Test: `GET https://<worker>.workers.dev/health` in the browser → `{"ok":true}`.

## Testing path A (sites, today)

In the app: set Backend URL to your worker URL → "Test HTTP relay" → you see the relay response (e.g., the egress IP API) — mechanical plumbing verified.

## Testing path B (true VPN tunnel)

1. Codespace: from the repo GitHub page → **Code → Codespaces → New**; inside run:
   ```
   cd server
   npm install
   export REMOTE_CHECK_URL=https://<your-worker>.workers.dev
   export INTERNAL_KEY=<same as worker var>
   PORT=7860 npm start
   ```
2. Codespace **Ports** tab → port 7860 → **Port visibility: Public** → copy the URL host (host ONLY, e.g. `foo-7860-xyz.app.github.dev`).
3. Worker dashboard → add/edit var `BRIDGE_HOST=<that host>` and `BRIDGE_PORT=443`.
4. In the app: watch test ad → unlock → it now produces a `vless://...@<codespace-host>:443` → import to V2RayNG → connect → the whole ad→token→30-min-session machine runs end to end.
5. When you later get the Iran VPS: run the same `server/` folder there (or native Xray with the same vless+ws shape); update `BRIDGE_HOST` on the Worker — the app changes nothing.
