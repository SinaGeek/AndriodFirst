package com.example.counterapp;

import android.os.Handler;
import android.os.Looper;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Tiny JSON-over-HttpURLConnection client (no extra dependencies).
 * Calls run on a background thread; the callback arrives on the main thread.
 */
public final class Api {

    private Api() { }

    public interface Callback {
        void onResult(Response response);
    }

    public static final class Response {
        public final int status;    // HTTP status or -1 on network error
        public final String body;   // raw body text (usually JSON)
        public final String error;  // error message or null

        Response(int status, String body, String error) {
            this.status = status;
            this.body = body;
            this.error = error;
        }

        public boolean ok() {
            return error == null && status >= 200 && status < 300;
        }
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    public static void get(String url, Callback cb) {
        send(url, "GET", null, cb);
    }

    public static void postJson(String url, String json, Callback cb) {
        send(url, "POST", json, cb);
    }

    private static void send(String url, String method, final String json, final Callback cb) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Response response = doRequest(url, method, json);
                MAIN.post(new Runnable() {
                    @Override
                    public void run() {
                        cb.onResult(response);
                    }
                });
            }
        }, "api-call").start();
    }

    private static Response doRequest(String urlStr, String method, String json) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod(method);
            conn.setRequestProperty("Accept", "application/json");
            if (json != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                OutputStream os = conn.getOutputStream();
                os.write(json.getBytes(StandardCharsets.UTF_8));
                os.flush();
                os.close();
            }
            int status = conn.getResponseCode();
            String body = read(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
            return new Response(status, body, null);
        } catch (Exception e) {
            return new Response(-1, "", String.valueOf(e));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String read(InputStream in) {
        if (in == null) return "";
        try (BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[2048];
            int n;
            while ((n = br.read(buf)) != -1) {
                sb.append(buf, 0, n);
                if (sb.length() > 100_000) break; // sanity cap
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
