package com.example.counterapp;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

import java.util.Locale;

/**
 * VPN test-skeleton UI (TODO.md phase 3, testing build):
 *  - "Watch test ad" simulates the future rewarded-ad here (AdMob goes later).
 *  - Then: dev-grant -> request-access -> 30-min vless:// config.
 *  - One tap opens the link in V2RayNG (or copies it for clipboard import).
 *  - Backend URL is configurable at runtime so you can point at laptop,
 *    Render, or a future Iran VPS without rebuilding the app.
 */
public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "vpn_test_prefs";
    private static final String K_BACKEND = "backend_url";
    private static final String K_VLESS = "vless_url";
    private static final String K_EXPIRES = "expires_at_ms";
    private static final String K_TOKEN = "grant_token";
    private static final String K_TOKEN_EXP = "grant_token_exp_ms";
    private static final String K_LOG = "log_text";

    private static final int SESSION_MINUTES = 30;

    private TextView statusText;
    private TextView vlessText;
    private TextView logText;

    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            refreshStatus();
            uiHandler.postDelayed(this, 1000);
        }
    };

    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        statusText = findViewById(R.id.statusText);
        vlessText = findViewById(R.id.vlessText);
        logText = findViewById(R.id.logText);
        logText.setText(prefs.getString(K_LOG, ""));

        log(prefs.getString(K_BACKEND, "") == null || prefs.getString(K_BACKEND, "").isEmpty()
                ? "Backend not set yet"
                : "Backend: " + prefs.getString(K_BACKEND, ""));

        findViewById(R.id.unlockBtn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onUnlockClicked();
            }
        });
        findViewById(R.id.copyBtn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onCopyClicked();
            }
        });
        findViewById(R.id.relayBtn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onRelayTestClicked();
            }
        });
        findViewById(R.id.openBtn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onOpenV2rayClicked();
            }
        });
        findViewById(R.id.backendBtn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showBackendDialog(true);
            }
        });
        findViewById(R.id.resetBtn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onResetClicked();
            }
        });
        findViewById(R.id.counterDemoBtn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, CounterActivity.class));
            }
        });

        uiHandler.post(ticker);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        uiHandler.removeCallbacks(ticker);
        prefs.edit().putString(K_LOG, logText.getText().toString()).apply();
    }

    /* ------------------------- actions ------------------------- */

    private void onUnlockClicked() {
        if (activeSessionRemainingMs() > 0) {
            long min = activeSessionRemainingMs() / 60000;
            toast("Session still active for " + min + " more minute(s).");
            return;
        }
        String base = backendUrl();
        if (base == null) {
            showBackendDialog(true);
            return;
        }
        simulateAdThen();
    }

    /** Placeholder for the real rewarded-video flow (TODO 3.3). */
    private void simulateAdThen() {
        final AlertDialog playing = new AlertDialog.Builder(this)
                .setTitle("Test reward ad")
                .setMessage("Simulating a short rewarded video…\n(Real AdMob rewarded + SSV plugs in here later.)")
                .setCancelable(false)
                .create();
        playing.show();
        log("▶ simulated ad started");
        uiHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                playing.dismiss();
                log("✓ simulated ad finished → requesting grant");
                grantAndRequest();
            }
        }, 2500);
    }

    private void grantAndRequest() {
        String base = backendUrl();
        if (base == null) return;
        String grantUrl = base + "/api/v1/dev-grant";
        log("→ POST " + grantUrl);
        Api.postJson(grantUrl, "{\"minutes\":" + SESSION_MINUTES + ",\"device\":\"android-test\"}", new Api.Callback() {
            @Override
            public void onResult(Api.Response r) {
                JSONObject grant = tryParse(r);
                if (grant == null) { showNetError("dev-grant", r); return; }
                String token = grant.optString("token", "");
                if (token.isEmpty()) { showError("dev-grant returned no token", r.body); return; }
                double ttlSec = grant.optDouble("ttl_seconds", 300);
                prefs.edit()
                        .putString(K_TOKEN, token)
                        .putLong(K_TOKEN_EXP, System.currentTimeMillis() + (long) (ttlSec * 1000))
                        .apply();
                log("✓ grant received (valid " + (long) ttlSec + "s)");
                requestAccess(token);
            }
        });
    }

    /** Returns a still-valid grant token, refreshing it when needed. */
    private void ensureGrantToken(final TokenConsumer consumer) {
        String token = prefs.getString(K_TOKEN, null);
        long exp = prefs.getLong(K_TOKEN_EXP, 0);
        if (token != null && exp - System.currentTimeMillis() > 5000) {
            consumer.got(token);
            return;
        }
        String base = backendUrl();
        if (base == null) {
            showBackendDialog(true);
            return;
        }
        log("→ refreshing ad-reward token");
        Api.postJson(base + "/api/v1/dev-grant", "{\"minutes\":" + SESSION_MINUTES + ",\"device\":\"android-test\"}", new Api.Callback() {
            @Override
            public void onResult(Api.Response r) {
                JSONObject grant = tryParse(r);
                if (grant == null) { showNetError("dev-grant (refresh)", r); return; }
                String fresh = grant.optString("token", "");
                if (fresh.isEmpty()) { showError("no token on refresh", r.body); return; }
                prefs.edit()
                        .putString(K_TOKEN, fresh)
                        .putLong(K_TOKEN_EXP, System.currentTimeMillis() + grant.optLong("ttl_seconds", 300) * 1000)
                        .apply();
                consumer.got(fresh);
            }
        });
    }

    interface TokenConsumer {
        void got(String token);
    }

    /** Mechanical relay test: fetches a site through the backend without any VPN. */
    private void onRelayTestClicked() {
        final String base = backendUrl();
        if (base == null) { showBackendDialog(true); return; }
        final String target = "https://api.ipify.org?format=json";
        ensureGrantToken(new TokenConsumer() {
            @Override
            public void got(String token) {
                String url = base + "/api/v1/site-relay?url=" + android.net.Uri.encode(target);
                log("→ relay GET " + target);
                Api.getWithHeader(url, "x-access-token", token, new Api.Callback() {
                    @Override
                    public void onResult(Api.Response r) {
                        if (r == null || !r.ok()) { showNetError("site-relay", r); return; }
                        log("✓ relay HTTP " + r.status + ": " + (r.body == null ? "" : r.body.trim()));
                        new AlertDialog.Builder(MainActivity.this)
                                .setTitle("Relay test OK")
                                .setMessage("Fetched through your backend:\n\n" + target + "\n\nResponse:\n" + r.body)
                                .setPositiveButton("OK", null)
                                .show();
                    }
                });
            }
        });
    }

    private void requestAccess(String token) {
        final String url = backendUrl() + "/api/v1/request-access";
        Api.postJson(url, "{\"token\":\"" + token + "\"}", new Api.Callback() {
            @Override
            public void onResult(Api.Response r) {
                JSONObject access = tryParse(r);
                if (access == null) { showNetError("request-access", r); return; }
                if (!access.optBoolean("ok", false)) {
                    showError("request-access: " + access.optString("error", "failed"), r.body);
                    return;
                }
                String vless = access.optString("vless_url", "");
                String expiresIso = access.optString("expires_at", "");
                int secondsLeft = access.optInt("seconds_left", -1);
                if (vless.isEmpty()) {
                    // Worker deployed but BRIDGE_HOST not set yet
                    String hint = access.optString("hint", "bridge host not configured on backend");
                    log("⚠ session created but no vless_url: " + hint);
                    log("  uuid: " + access.optString("uuid", "?"));
                    toast("Session created; set BRIDGE_HOST on the backend to get a connect link");
                    refreshStatus();
                    return;
                }

                long expiresAtMs = System.currentTimeMillis() + (secondsLeft > 0 ? secondsLeft * 1000L : SESSION_MINUTES * 60_000L);
                prefs.edit()
                        .putString(K_VLESS, vless)
                        .putLong(K_EXPIRES, expiresAtMs)
                        .apply();
                vlessText.setText(vless);
                refreshStatus();
                log("✓ session active until " + expiresIso);
                log("  uuid: " + access.optString("uuid", "?"));
                toast("30-min session unlocked — import the link into V2RayNG");
                onOpenV2rayClicked();
            }
        });
    }

    private void onCopyClicked() {
        String vless = prefs.getString(K_VLESS, "");
        if (vless.isEmpty()) { toast("Nothing to copy yet — unlock first."); return; }
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("vless", vless));
        toast("vless:// link copied — in V2RayNG press + → Import clipboard");
    }

    private void onOpenV2rayClicked() {
        String vless = prefs.getString(K_VLESS, "");
        if (vless.isEmpty()) { toast("No session yet — unlock first."); return; }
        // try direct deep link first
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(vless));
            startActivity(i);
            return;
        } catch (Exception ignored) { }
        // then share text to v2rayNG specifically
        try {
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setPackage("com.v2ray.ang");
            share.setType("text/plain");
            share.putExtra(Intent.EXTRA_TEXT, vless);
            startActivity(share);
            return;
        } catch (Exception ignored) { }
        // fallback: copy and instruct
        onCopyClicked();
        new AlertDialog.Builder(this)
                .setTitle("V2RayNG not found")
                .setMessage("Install V2RayNG (github.com/2dust/v2rayNG releases → sideload),\nthen in V2RayNG tap + → Import config from clipboard.")
                .setPositiveButton("OK", null)
                .show();
    }

    private void onResetClicked() {
        new AlertDialog.Builder(this)
                .setTitle("Reset local session")
                .setMessage("Clears the stored session in THIS app (server TTL is untouched and will also expire it).")
                .setPositiveButton("Reset", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        prefs.edit().remove(K_VLESS).remove(K_EXPIRES).apply();
                        vlessText.setText("");
                        refreshStatus();
                        log("reset local session");
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    /* ------------------------- backend dialog ------------------------- */

    private void showBackendDialog(final boolean instruct) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setText(prefs.getString(K_BACKEND, ""));
        input.setHint("https://your-app.onrender.com");
        new AlertDialog.Builder(this)
                .setTitle("Backend URL")
                .setMessage(instruct ? "Point the app at your test server.\nExamples:\n • https://your-app.onrender.com\n • http://192.168.x.x:7860 (laptop/LAN)\nNo trailing slash." : null)
                .setView(input)
                .setPositiveButton("Save", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        String url = input.getText().toString().trim();
                        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
                        if (url.startsWith("http://") || url.startsWith("https://")) {
                            prefs.edit().putString(K_BACKEND, url).apply();
                            log("backend set to " + url);
                        } else {
                            toast("URL must start with http:// or https://");
                        }
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    /* ------------------------- helpers ------------------------- */

    private String backendUrl() {
        String url = prefs.getString(K_BACKEND, "");
        return url == null || url.isEmpty() ? null : url;
    }

    private long activeSessionRemainingMs() {
        long exp = prefs.getLong(K_EXPIRES, 0);
        return exp - System.currentTimeMillis();
    }

    private void refreshStatus() {
        long remaining = activeSessionRemainingMs();
        String backend = prefs.getString(K_BACKEND, null);
        if (remaining > 0) {
            long mins = remaining / 60000;
            long secs = (remaining / 1000) % 60;
            statusText.setText(String.format(Locale.US, "🔓 Unlocked  (%02d:%02d left)\n%s", mins, secs, backend));
        } else {
            statusText.setText(String.format(Locale.US, "🔒 Locked   •   30-min session model\n%s", backend == null ? "(backend not set)" : backend));
        }
    }

    private void log(String line) {
        String ts = new java.text.SimpleDateFormat("HH:mm:ss", Locale.US).format(new java.util.Date());
        String combined = logText.getText().toString() + ts + "  " + line + "\n";
        // cap to last 30 lines
        String[] lines = combined.split("\n");
        StringBuilder capped = new StringBuilder();
        for (int i = Math.max(0, lines.length - 30); i < lines.length; i++) {
            capped.append(lines[i]).append('\n');
        }
        logText.setText(capped.toString());
    }

    private JSONObject tryParse(Api.Response r) {
        if (r == null || !r.ok() || r.body == null || r.body.isEmpty()) return null;
        try {
            return new JSONObject(r.body);
        } catch (Exception e) {
            return null;
        }
    }

    private void showNetError(String step, Api.Response r) {
        String msg = step + " failed.\n";
        if (r == null) msg += "no response";
        else if (r.error != null) msg += "network: " + r.error;
        else msg += "HTTP " + r.status + "\n" + (r.body == null ? "" : r.body);
        log("✗ " + msg.split("\n")[0]);
        showError(msg, null);
    }

    private void showError(String title, String detail) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(detail == null || detail.isEmpty() ? "" : detail)
                .setPositiveButton("OK", null)
                .show();
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }
}
