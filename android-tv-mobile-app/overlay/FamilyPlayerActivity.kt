package top.rootu.lampa

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout

/** A separate browser for embedded players. It deliberately has no AndroidJS bridge. */
class FamilyPlayerActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var root: LinearLayout
    private var fullscreen: View? = null
    private var fullCallback: WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("player_url") ?: run { finish(); return }
        if (!safeUrl(url)) { finish(); return }
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK) }
        val close = Button(this).apply { text = "Назад к фильму"; setOnClickListener { finish() } }
        root.addView(close, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (52 * resources.displayMetrics.density).toInt()))
        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            if (android.os.Build.VERSION.SDK_INT >= 21) mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        web.webViewClient = object : WebViewClient() {
            @Deprecated("Compatibility with older Android")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = !safeUrl(url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !safeUrl(request.url.toString())
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullscreen != null) { callback.onCustomViewHidden(); return }
                fullscreen = view
                fullCallback = callback
                root.visibility = View.GONE
                addContentView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            override fun onHideCustomView() { leaveFullscreen() }
        }
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        web.loadUrl(url)
        close.requestFocus()
    }
    private fun safeUrl(value: String): Boolean {
        val uri = android.net.Uri.parse(value)
        val host = uri.host ?: return false
        return uri.scheme == "https" && uri.userInfo == null && uri.port == -1 && host.contains('.') && !host.matches(Regex("[0-9.]+")) && !host.endsWith(".local")
    }
    private fun leaveFullscreen() {
        fullscreen?.let { (it.parent as? ViewGroup)?.removeView(it) }
        fullscreen = null
        fullCallback?.onCustomViewHidden()
        fullCallback = null
        root.visibility = View.VISIBLE
    }
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (fullscreen != null) leaveFullscreen() else finish()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
    override fun onPause() { if (::web.isInitialized) web.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); if (::web.isInitialized) web.onResume() }
    override fun onDestroy() {
        if (::web.isInitialized) { web.stopLoading(); web.loadUrl("about:blank"); root.removeView(web); web.destroy() }
        super.onDestroy()
    }
}
