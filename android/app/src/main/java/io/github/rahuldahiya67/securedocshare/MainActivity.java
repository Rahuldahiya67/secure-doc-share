package io.github.rahuldahiya67.securedocshare;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.nio.charset.StandardCharsets;

/**
 * Secure Doc Share viewer.
 *
 * A WebView around the Secure Doc Share site with FLAG_SECURE switched on, so
 * Android blocks screenshots, screen recording and the recent-apps preview.
 * The page gets a small JavaScript bridge ("SecureDocApp") that provides the
 * app key the database requires before it will hand out a document.
 */
public class MainActivity extends Activity {

    private static final String HOST = "rahuldahiya67.github.io";
    private static final String PATH_PREFIX = "/secure-doc-share/";
    private static final String BASE = "https://" + HOST + PATH_PREFIX;
    private static final String SCHEME = "securedocshare";

    private WebView web;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Block screenshots, screen recording and the app-switcher thumbnail.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE);

        WebView.setWebContentsDebuggingEnabled(false);
        web = new WebView(this);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " SecureDocShareApp/1");

        // No long-press menus (save image, copy, etc.).
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);
        web.setHapticFeedbackEnabled(false);

        web.addJavascriptInterface(new Bridge(), "SecureDocApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (isOwnPage(u)) return false;     // stay inside the app
                openExternal(u.toString());          // everything else goes to the browser
                return true;
            }
        });

        // "Download latest app" and similar links open in the browser.
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> openExternal(url));

        setContentView(web);

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(urlFor(getIntent()));
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        web.loadUrl(urlFor(intent));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }

    /** Map the launch intent to a page of the site. */
    private String urlFor(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !SCHEME.equals(data.getScheme())) {
            return BASE;
        }

        String host = data.getHost();

        // Back from Google sign-in: hand the ?code=... to the site so it can finish signing in.
        if ("auth".equals(host)) {
            String query = data.getEncodedQuery();
            String fragment = data.getEncodedFragment();
            return BASE + (query != null ? "?" + query : "") + (fragment != null ? "#" + fragment : "");
        }

        // Opened from a share link: securedocshare://open?doc=<uuid>
        if ("open".equals(host)) {
            String doc = data.getQueryParameter("doc");
            if (doc != null && doc.matches("[0-9a-fA-F-]{36}")) {
                return BASE + "?doc=" + doc;
            }
        }
        return BASE;
    }

    private static boolean isOwnPage(Uri u) {
        if (u == null) return false;
        String path = u.getPath() == null ? "" : u.getPath();
        return "https".equals(u.getScheme())
                && HOST.equals(u.getHost())
                && (path.startsWith(PATH_PREFIX) || path.equals("/secure-doc-share"));
    }

    private void openExternal(String url) {
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            if (!"https".equals(scheme) && !"http".equals(scheme)) return;
            Intent i = new Intent(Intent.ACTION_VIEW, u);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(i);
        } catch (Exception ignored) {
            // No browser available; nothing to do.
        }
    }

    /** Decode the XOR-masked app key baked in at build time. */
    private static String appKey() {
        String hex = BuildConfig.K;
        String mask = BuildConfig.M;
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int v = Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
            out[i] = (byte) (v ^ mask.charAt(i % mask.length()));
        }
        return new String(out, StandardCharsets.UTF_8);
    }

    /** Exposed to the page as window.SecureDocApp. */
    private class Bridge {
        @JavascriptInterface
        public boolean isApp() {
            return true;
        }

        @JavascriptInterface
        public String getKey() {
            return appKey();
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> MainActivity.this.openExternal(url));
        }
    }
}
