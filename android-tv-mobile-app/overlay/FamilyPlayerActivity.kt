package top.rootu.lampa

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.*
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream

class FamilyPlayerActivity : Activity() {
    private lateinit var item: JSONObject
    private lateinit var web: WebView
    private lateinit var frame: FrameLayout
    private lateinit var status: TextView
    private var fullscreen: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var index = 0
    private val attempted = mutableSetOf<Int>()
    private var selectedAt = 0L
    private var seconds = 0.0
    private var duration = 0.0
    private var season = ""
    private var episode = ""
    private var episodeId = ""
    private var previousMediaTime = -1.0
    private var lastSaved = 0L
    private var lastProgress = 0L
    private var paused = false
    private var confirmed = false
    private var failed = false
    private var active = true
    private var generation = 0
    private var restoreAfterPause = false
    private val players get() = item.getJSONArray("players")
    private val hosts get() = (0 until players.length()).mapNotNull { Uri.parse(players.getJSONObject(it).optString("url")).host }.toSet() + setOf("api.domem.ws")
    private val ads = listOf("distribrey.com", "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adsterra.com", "popads.net", "popcash.net", "onclicka.com", "onclickalgo.com", "realsrv.com", "exoclick.com", "betweendigital.com", "1xbet.com", "1x-bet.com", "melbet.com", "mostbet.com", "1win.com", "trafficjunky.net", "advmaker.net", "adskeeper.com", "criteo.com", "propellerads.com")
    private val watchdog = object : Runnable {
        override fun run() {
            if (isFinishing || !active) return
            if (!failed && !confirmed && SystemClock.elapsedRealtime() - selectedAt > 35000) fallback("Нет подтверждённого видео за 35 секунд")
            if (!failed && confirmed && !paused && SystemClock.elapsedRealtime() - lastProgress > 45000) fallback("Видеопоток остановился на 45 секунд")
            FamilySupport.handler.postDelayed(this, 1000)
        }
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        try { item = JSONObject(intent.getStringExtra("item") ?: ""); index = intent.getIntExtra("index", 0); require(players.length() > 0) }
        catch (_: Exception) { finish(); return }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val container = LinearLayout(this); container.orientation = LinearLayout.VERTICAL; container.setBackgroundColor(Color.BLACK)
        val toolbar = LinearLayout(this); toolbar.setPadding(6, 3, 6, 3); toolbar.setBackgroundColor(0xff16181f.toInt())
        fun control(label: String, action: () -> Unit) { val b = Button(this); b.text = label; b.textSize = 12f; b.setTextColor(0xffffb703.toInt()); b.setOnClickListener { action() }; toolbar.addView(b, LinearLayout.LayoutParams(0, 52, 1f)) }
        control("‹ Назад") { close() }; control("−10 с") { command("left") }; control("▶ / Ⅱ") { command("toggle") }; control("+10 с") { command("right") }; control("Плеер") { choosePlayer() }; control("Логи") { FamilySupport.diagnostics(this, "Плеер: ${item.optString("path")}") }
        status = TextView(this); status.setTextColor(0xffc5c6ce.toInt()); status.textSize = 11f; status.setPadding(12, 2, 12, 4)
        frame = FrameLayout(this)
        container.addView(toolbar); container.addView(status); container.addView(frame, LinearLayout.LayoutParams(-1, 0, 1f)); setContentView(container)
        val saved = FamilySupport.saved(this, item.optString("path"))
        seconds = saved.optDouble("seconds", 0.0); duration = saved.optDouble("duration", 0.0); season = saved.optString("season"); episode = saved.optString("episode")
        episodeId = saved.optString("episode_id")
        select(index); FamilySupport.handler.postDelayed(watchdog, 1000)
    }
    private fun blocked(host: String) = ads.any { host == it || host.endsWith(".$it") }
    private fun permitted(uri: Uri) = uri.scheme == "https" && !uri.host.isNullOrBlank() && !blocked(uri.host!!) && uri.userInfo == null
    @SuppressLint("SetJavaScriptEnabled")
    private fun select(selected: Int) {
        if (selected !in 0 until players.length()) return
        if (::web.isInitialized) destroyWeb()
        index = selected; attempted.add(index); selectedAt = SystemClock.elapsedRealtime(); previousMediaTime = -1.0; confirmed = false; failed = false
        val mine = ++generation
        val player = players.getJSONObject(index); val url = player.optString("url"); val uri = Uri.parse(url)
        FamilySupport.log("Player ${player.optString("title")} host=${uri.host}")
        status.text = "${player.optString("title")} · ${FamilySupport.version()} · Ожидаем запуск…"
        if (!permitted(uri)) { fallback("Недопустимый адрес плеера"); return }
        web = WebView(this); web.setBackgroundColor(Color.BLACK)
        web.settings.javaScriptEnabled = true; web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.settings.allowFileAccess = false; web.settings.allowContentAccess = false
        web.settings.setSupportMultipleWindows(false); web.settings.javaScriptCanOpenWindowsAutomatically = false
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        val agent = assets.open("family/player-agent.js").bufferedReader().use { it.readText() }
        val restore = JSONObject().put("seconds", seconds).put("season", season).put("episode", episode).put("episode_id", episodeId)
        val script = "window.familyRestore=$restore;\n$agent"
        val early = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Remote frames receive ONLY a bounded media telemetry protocol, never native privileges.
            WebViewCompat.addWebMessageListener(web, "FamilyMedia", setOf("*")) { _, message, origin, _, _ ->
                if (mine == generation && origin.scheme == "https" && !blocked(origin.host ?: "") && !failed) {
                    try { val data = message.data ?: ""; if (data.length <= 2000) telemetry(JSONObject(data)) } catch (_: Exception) { }
                }
            }
        } else {
            web.addJavascriptInterface(object {
                @JavascriptInterface fun postMessage(data: String) {
                    if (data.length > 2000) return
                    runOnUiThread { if (mine == generation && !failed) try { telemetry(JSONObject(data)) } catch (_: Exception) { } }
                }
            }, "FamilyMedia")
        }
        if (early) WebViewCompat.addDocumentStartJavaScript(web, script, setOf("*"))
        else FamilySupport.log("Old WebView: update Android System WebView for frame telemetry")
        web.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView, dialog: Boolean, gesture: Boolean, result: android.os.Message) = false
            override fun onShowCustomView(view: View, callback: CustomViewCallback) { if (fullscreen != null) { callback.onCustomViewHidden(); return }; fullscreen = view; fullscreenCallback = callback; frame.addView(view, FrameLayout.LayoutParams(-1, -1)) }
            override fun onHideCustomView() { hideFullscreen() }
            override fun onConsoleMessage(message: ConsoleMessage): Boolean { if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) FamilySupport.log("Player JS ${message.message().take(250)}"); return true }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!permitted(request.url)) return true
                if (request.isForMainFrame && request.url.host !in hosts) { FamilySupport.log("Blocked navigation ${request.url.host}"); return true }
                return false
            }
            override fun onPageFinished(view: WebView, url: String) { if (!early && mine == generation) view.evaluateJavascript(script, null) }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (android.os.Build.VERSION.SDK_INT >= 23 && request.isForMainFrame && mine == generation) fallback("WebView: ${error.errorCode}") }
            @Suppress("DEPRECATION")
            override fun onReceivedError(view: WebView, code: Int, description: String, url: String) { if (android.os.Build.VERSION.SDK_INT < 23 && mine == generation) fallback("WebView: $code") }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) { if (request.isForMainFrame && mine == generation) fallback("Плеер HTTP ${response.statusCode}") }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                if (uri.scheme in listOf("blob", "data")) return null
                if (blocked(uri.host ?: "") && uri.path?.contains("xml") == true) return WebResourceResponse("application/xml", "utf-8", ByteArrayInputStream("<VAST version=\"3.0\"></VAST>".toByteArray()))
                if (!permitted(uri)) return empty()
                // WebView retains its own TLS, cookies, Range requests and provider Referer.
                // The initial source Referer is supplied by loadUrl below; no video proxy is needed.
                return null
            }
        }
        frame.addView(web, FrameLayout.LayoutParams(-1, -1)); web.loadUrl(url, mapOf("Referer" to "http://ex-fs.net/"))
    }
    private fun empty() = WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    private fun telemetry(data: JSONObject) {
        when (data.optString("type")) {
            "media" -> {
                val time = data.optDouble("seconds", -1.0); val length = data.optDouble("duration", 0.0)
                if (!time.isFinite() || time < 0 || time > 864000 || !length.isFinite() || length < 0) return
                paused = data.optBoolean("paused")
                if (previousMediaTime >= 0 && time > previousMediaTime + 0.2 && !paused) {
                    if (!confirmed) FamilySupport.log("Playback clock advancing: ${item.optString("path")}")
                    confirmed = true; lastProgress = SystemClock.elapsedRealtime(); status.text = "${players.getJSONObject(index).optString("title")} · ${FamilySupport.version()}"
                }
                previousMediaTime = time
                if (confirmed) {
                    seconds = time; duration = length
                    if (data.optString("season").isNotBlank()) season = data.optString("season").take(40)
                    if (data.optString("episode").isNotBlank()) episode = data.optString("episode").take(40)
                    if (data.optString("episode_id").isNotBlank()) episodeId = data.optString("episode_id").take(100)
                    if (SystemClock.elapsedRealtime() - lastSaved > 5000) save()
                }
            }
            "error" -> fallback("Ошибка видеопотока ${data.optString("code")}")
            "selection" -> { season = data.optString("season").take(40); episode = data.optString("episode").take(40); episodeId = data.optString("episode_id").take(100); seconds = 0.0; duration = 0.0; previousMediaTime = -1.0; save() }
        }
    }
    private fun save() {
        if (!confirmed && seconds <= 0) return
        lastSaved = SystemClock.elapsedRealtime()
        FamilySupport.merge(this, item) { it.put("seconds", seconds).put("duration", duration).put("season", season).put("episode", episode).put("episode_id", episodeId).put("player", index).put("last_played", System.currentTimeMillis()) }
    }
    private fun fallback(reason: String) {
        if (isFinishing || failed || !active) return
        FamilySupport.log("Playback fallback: $reason"); save()
        val next = (1..players.length()).map { (index + it) % players.length() }.firstOrNull { it !in attempted }
        if (next != null) { select(next); return }
        failed = true; command("pause"); status.text = "Плееры не подтвердили запуск. ${FamilySupport.version()}"
        if (::web.isInitialized) { web.stopLoading(); web.loadUrl("about:blank") }
        FamilySupport.diagnostics(this, "Все плееры недоступны: ${item.optString("path")}; $reason")
    }
    private fun choosePlayer() {
        val labels = (0 until players.length()).map { players.getJSONObject(it).optString("title") }.toTypedArray()
        AlertDialog.Builder(this).setTitle("Выберите плеер / озвучку").setSingleChoiceItems(labels, index) { dialog, which -> attempted.clear(); save(); select(which); dialog.dismiss() }.setNegativeButton("Закрыть", null).show()
    }
    private fun command(action: String) { if (::web.isInitialized) web.evaluateJavascript("window.familyCommand && window.familyCommand(${JSONObject.quote(action)})", null) }
    private fun hideFullscreen() { fullscreen?.let { frame.removeView(it) }; fullscreen = null; fullscreenCallback?.onCustomViewHidden(); fullscreenCallback = null }
    private fun destroyWeb() { hideFullscreen(); command("pause"); web.stopLoading(); web.loadUrl("about:blank"); frame.removeView(web); web.removeAllViews(); web.destroy() }
    private fun close() { save(); finish() }
    override fun onBackPressed() { close() }
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) { close(); return true }
            if (event.keyCode in listOf(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE)) { command(if (event.keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) "pause" else if (event.keyCode == KeyEvent.KEYCODE_MEDIA_PLAY) "play" else "toggle"); return true }
            if (event.keyCode == KeyEvent.KEYCODE_MEDIA_REWIND) { command("left"); return true }
            if (event.keyCode == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) { command("right"); return true }
        }
        return super.dispatchKeyEvent(event)
    }
    override fun onPause() { active = false; save(); command("pause"); if (::web.isInitialized) { web.onPause(); web.stopLoading(); web.loadUrl("about:blank"); restoreAfterPause = true }; FamilySupport.handler.removeCallbacks(watchdog); super.onPause() }
    override fun onResume() { super.onResume(); active = true; if (::web.isInitialized) { web.onResume(); if (restoreAfterPause && !isFinishing) { restoreAfterPause = false; attempted.clear(); select(index) }; selectedAt = SystemClock.elapsedRealtime(); FamilySupport.handler.removeCallbacks(watchdog); FamilySupport.handler.postDelayed(watchdog, 1000) } }
    override fun onDestroy() { FamilySupport.handler.removeCallbacks(watchdog); if (::web.isInitialized) destroyWeb(); window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); super.onDestroy() }
}
