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

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://cita-fd42.onrender.com";
    private static final int AUDIO_REQUEST = 2401;
    private WebView webView;
    private PermissionRequest pendingMicrophoneRequest;

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
        LinearLayout nav = new LinearLayout(this);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        addNav(nav, "Interpret", "/interpreter.html");
        addNav(nav, "Apel", "/");
        addNav(nav, "Agent", "/agent");
        layout.addView(nav);
        webView = new WebView(this);
        layout.addView(webView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
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

    private void addNav(LinearLayout nav, String label, String path) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        nav.addView(button, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        button.setOnClickListener(v -> webView.loadUrl(ORIGIN + path));
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
