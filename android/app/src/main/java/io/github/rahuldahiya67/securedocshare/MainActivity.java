package io.github.rahuldahiya67.securedocshare;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Toast;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
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

    private static final int PICK_FILE = 4201;
    private static final String APK_MIME = "application/vnd.android.package-archive";

    private long updateDownloadId = -1;
    private BroadcastReceiver downloadReceiver;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

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

        // Photo picker for <input type="file"> (payment screenshots).
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent pick = params.createIntent();
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(pick, PICK_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        // "Download latest app" and similar links open in the browser.
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> openExternal(url));

        setContentView(web);
        registerUpdateReceiver();

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
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
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
        if (downloadReceiver != null) {
            try { unregisterReceiver(downloadReceiver); } catch (Exception ignored) { }
        }
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }

    // ---------- one-tap updates ----------

    /** Download the new APK from the GitHub release, then open Android's installer. */
    private void startUpdate(String url) {
        Uri u;
        try { u = Uri.parse(url); } catch (Exception e) { return; }
        if (!"https".equals(u.getScheme()) || !"github.com".equals(u.getHost())) return;
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request r = new DownloadManager.Request(u);
            r.setTitle("Secure Doc Share update");
            r.setMimeType(APK_MIME);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS,
                    "SecureDocShare-" + System.currentTimeMillis() + ".apk");
            updateDownloadId = dm.enqueue(r);
            Toast.makeText(this, "Downloading the update…", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            openExternal(url);   // fall back to the browser download
        }
    }

    private void registerUpdateReceiver() {
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id == -1 || id != updateDownloadId) return;
                updateDownloadId = -1;
                try {
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    Uri apk = dm.getUriForDownloadedFile(id);
                    if (apk == null) {
                        Toast.makeText(MainActivity.this, "The download didn't finish. Try again.", Toast.LENGTH_LONG).show();
                        return;
                    }
                    Intent install = new Intent(Intent.ACTION_VIEW);
                    install.setDataAndType(apk, APK_MIME);
                    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(install);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Couldn't open the installer. Open the download from your notifications.", Toast.LENGTH_LONG).show();
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(downloadReceiver, filter);
            }
        } catch (Exception ignored) {
            downloadReceiver = null;
        }
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

    // Payment apps the page may open: generic UPI, Google Pay, PhonePe, Paytm.
    private static final String[] PAY_SCHEMES = {"upi", "tez", "phonepe", "paytmmp"};

    private static boolean isPayScheme(String scheme) {
        if (scheme == null) return false;
        for (String s : PAY_SCHEMES) if (s.equalsIgnoreCase(scheme)) return true;
        return false;
    }

    private void openExternal(String url) {
        Uri u;
        try { u = Uri.parse(url); } catch (Exception e) { return; }
        String scheme = u.getScheme();
        boolean web = "https".equals(scheme) || "http".equals(scheme);
        boolean pay = isPayScheme(scheme) && "pay".equals(u.getHost()) || isPayScheme(scheme) && "upi".equals(u.getHost());
        if (!web && !pay) return;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, u);
            if (web) i.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(pay && "upi".equalsIgnoreCase(scheme) ? Intent.createChooser(i, "Pay with") : i);
        } catch (Exception e) {
            if (pay) Toast.makeText(this, "That payment app isn't installed. Try another option.", Toast.LENGTH_LONG).show();
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
        public boolean supportsUpload() {
            return true;
        }

        @JavascriptInterface
        public boolean supportsUpi() {
            return true;
        }

        /** Build number; matches the release tag app-v<number>. */
        @JavascriptInterface
        public int appVersion() {
            return BuildConfig.VERSION_CODE;
        }

        /** Stable per-phone ID for this app (survives reinstalls with the same signing key). */
        @JavascriptInterface
        public String deviceId() {
            try {
                String id = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
                return id == null ? "" : id;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void installUpdate(String url) {
            runOnUiThread(() -> startUpdate(url));
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
