package com.traducerelive.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://cita-fd42.onrender.com";
    private static final int AUDIO_REQUEST = 2401;
    private WebView webView;
    private PermissionRequest pendingMicrophoneRequest;
    private LinearLayout navBar;

    private boolean trusted(Uri uri) {
        return uri != null && "https".equals(uri.getScheme())
            && "cita-fd42.onrender.com".equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xff0e1425);
        getWindow().setNavigationBarColor(0xff0e1425);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.rgb(14, 20, 37));
        webView = new WebView(this);
        layout.addView(webView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        navBar = new LinearLayout(this);
        navBar.setOrientation(LinearLayout.HORIZONTAL);
        navBar.setGravity(Gravity.CENTER);
        navBar.setPadding(dp(10), dp(8), dp(10), dp(8));
        navBar.setBackgroundColor(Color.rgb(17, 28, 47));
        addNav(navBar, "Interpret", "◉", "/interpreter.html", true);
        addNav(navBar, "Apel", "☎", "/", false);
        addNav(navBar, "Agent AI", "✦", "/agent", false);
        layout.addView(navBar, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(72)));
        setContentView(layout);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                Uri uri = Uri.parse(url);
                if (trusted(uri)) selectNav(uri.getPath());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (trusted(uri)) return false;
                if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleMicrophoneRequest(request));
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingMicrophoneRequest == request) pendingMicrophoneRequest = null;
            }
        });
        webView.loadUrl(ORIGIN + "/interpreter.html");
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radiusDp));
        return shape;
    }

    private void addNav(LinearLayout nav, String label, String icon, String path, boolean selected) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setPadding(dp(6), dp(4), dp(6), dp(4));
        item.setTag(path);
        TextView glyph = new TextView(this);
        glyph.setText(icon);
        glyph.setTextSize(19);
        glyph.setGravity(Gravity.CENTER);
        TextView title = new TextView(this);
        title.setText(label);
        title.setTextSize(11);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        item.addView(glyph);
        item.addView(title);
        item.setBackground(rounded(selected ? 0xff203c57 : 0x00000000, 16));
        glyph.setTextColor(selected ? 0xff68dfc1 : 0xff9aabc2);
        title.setTextColor(selected ? 0xffe8f5f4 : 0xff9aabc2);
        item.setOnClickListener(v -> webView.loadUrl(ORIGIN + path));
        nav.addView(item, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f));
    }

    private void selectNav(String path) {
        if (navBar == null) return;
        String active = "/".equals(path) ? "/" : ("/agent".equals(path) ? "/agent" : "/interpreter.html");
        for (int i = 0; i < navBar.getChildCount(); i++) {
            View child = navBar.getChildAt(i);
            boolean selected = active.equals(child.getTag());
            child.setBackground(rounded(selected ? 0xff203c57 : 0x00000000, 16));
            LinearLayout item = (LinearLayout) child;
            ((TextView) item.getChildAt(0)).setTextColor(selected ? 0xff68dfc1 : 0xff9aabc2);
            ((TextView) item.getChildAt(1)).setTextColor(selected ? 0xffe8f5f4 : 0xff9aabc2);
        }
    }

    private void handleMicrophoneRequest(PermissionRequest request) {
        String[] resources = request.getResources();
        if (!trusted(request.getOrigin()) || resources.length != 1
            || !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0])) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else {
            if (pendingMicrophoneRequest != null) pendingMicrophoneRequest.deny();
            pendingMicrophoneRequest = request;
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, AUDIO_REQUEST);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != AUDIO_REQUEST || pendingMicrophoneRequest == null) return;
        PermissionRequest request = pendingMicrophoneRequest;
        pendingMicrophoneRequest = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && trusted(request.getOrigin())) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else request.deny();
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }
    @Override protected void onDestroy() {
        if (pendingMicrophoneRequest != null) {
            pendingMicrophoneRequest.deny();
            pendingMicrophoneRequest = null;
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
