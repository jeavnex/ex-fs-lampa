package top.rootu.lampa

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognizerIntent
import android.webkit.*
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

class FamilyActivity : Activity() {
    private lateinit var web: WebView
    private var updateBusy = false
    private var pendingApk: File? = null
    private var uiReady = false
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.statusBarColor = 0xff0f1014.toInt(); window.navigationBarColor = 0xff0f1014.toInt()
        web = WebView(this); web.setBackgroundColor(0xff0f1014.toInt()); setContentView(web)
        web.settings.javaScriptEnabled = true; web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false; web.settings.allowContentAccess = false
        web.settings.javaScriptCanOpenWindowsAutomatically = false
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean { FamilySupport.log("Local UI ${message.messageLevel()}: ${message.message()}"); return true }
        }
        web.addJavascriptInterface(Bridge(), "Family")
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val local = loader.shouldInterceptRequest(request.url)
                if (local != null) return local
                // Only posters leave this local WebView. No remote scripts, pages or plugin runtime.
                if (request.url.scheme == "https" && request.url.host in listOf("ex-fs.net", "www.ex-fs.net") && request.url.path?.startsWith("/uploads/") == true) return null
                return WebResourceResponse("text/plain", "utf-8", java.io.ByteArrayInputStream(ByteArray(0)))
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.url.host != "appassets.androidplatform.net"
            override fun onPageFinished(view: WebView, url: String) { FamilySupport.log("Local UI loaded ${FamilySupport.version()}") }
        }
        web.loadUrl("https://appassets.androidplatform.net/assets/family/index.html")
        FamilySupport.log("WebView ${web.settings.userAgentString}")
        web.postDelayed({ if (!uiReady && !isFinishing) AlertDialog.Builder(this).setTitle("Интерфейс не запустился").setMessage("Проверьте обновление Android System WebView. Технический отчёт можно открыть здесь.").setPositiveButton("Логи") { _, _ -> FamilySupport.diagnostics(this, "Local UI did not become ready") }.setNegativeButton("Закрыть", null).show() }, 15000)
        migrateLegacyFavorites()
        if (!BuildConfig.DEBUG) web.postDelayed({ checkUpdate(false) }, 3500)
    }
    inner class Bridge {
        @JavascriptInterface fun ready() { uiReady = true }
        @JavascriptInterface fun version() = FamilySupport.version()
        @JavascriptInterface fun library() = FamilySupport.library(this@FamilyActivity).toString()
        @JavascriptInterface fun request(id: String, path: String, body: String) {
            if (!id.matches(Regex("\\d{1,9}"))) return
            FamilySupport.executor.execute {
                val result = try { FamilySupport.request(path, body.takeIf { it.isNotEmpty() }) }
                catch (e: Exception) { JSONObject().put("error", "REQUEST_FAILED").put("message", FamilySupport.clean(e.message ?: "Нет ответа")).toString() }
                runOnUiThread { if (!isFinishing) web.evaluateJavascript("window.FamilyReply(${JSONObject.quote(id)},${JSONObject.quote(result)})", null) }
            }
        }
        @JavascriptInterface fun favorite(value: String) {
            try { FamilySupport.merge(this@FamilyActivity, JSONObject(value)) { it.put("favorite", !it.optBoolean("favorite")) } } catch (_: Exception) { }
        }
        @JavascriptInterface fun play(value: String, index: Int) { runOnUiThread {
            try {
                val item = JSONObject(value); val players = item.getJSONArray("players")
                val chosen = if (index < 0) FamilySupport.saved(this@FamilyActivity, item.optString("path")).optInt("player", 0).coerceIn(0, maxOf(0, players.length()-1)) else index
                if (players.length() == 0 || chosen !in 0 until players.length()) return@runOnUiThread
                // Large descriptions never cross Binder's transaction-size limit.
                item.remove("description")
                startActivity(Intent(this@FamilyActivity, FamilyPlayerActivity::class.java).putExtra("item", item.toString()).putExtra("index", chosen))
            } catch (e: Exception) { FamilySupport.log("Play request: ${e.message}") }
        } }
        @JavascriptInterface fun diagnostics(reason: String) { runOnUiThread { FamilySupport.diagnostics(this@FamilyActivity, reason) } }
        @JavascriptInterface fun copyLog() { runOnUiThread { FamilySupport.copyLog(this@FamilyActivity) } }
        @JavascriptInterface fun checkUpdate() { runOnUiThread { checkUpdate(true) } }
        @JavascriptInterface fun voiceSearch() { runOnUiThread {
            try { startActivityForResult(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU").putExtra(RecognizerIntent.EXTRA_PROMPT, "Название фильма или сериала"), 11) }
            catch (_: ActivityNotFoundException) { toast("Голосовой поиск недоступен. Введите название на экране.") }
        } }
        @JavascriptInterface fun confirmExit() { runOnUiThread { AlertDialog.Builder(this@FamilyActivity).setMessage("Выйти из приложения?").setPositiveButton("Выйти") { _, _ -> finish() }.setNegativeButton("Остаться", null).show() } }
    }
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    @SuppressLint("SetJavaScriptEnabled")
    private fun migrateLegacyFavorites() {
        val prefs = FamilySupport.prefs(this)
        if (prefs.getBoolean("legacy_imported", false)) return
        val old = WebView(this)
        old.settings.javaScriptEnabled = true; old.settings.domStorageEnabled = true
        old.settings.blockNetworkLoads = true; old.settings.allowFileAccess = false
        old.addJavascriptInterface(object {
            @JavascriptInterface fun accept(value: String) {
                if (value.length > 500000) return
                try {
                    val data = JSONObject(value)
                    for (key in listOf("favorites", "history")) {
                        val rows = data.optJSONArray(key) ?: continue
                        for (i in 0 until minOf(rows.length(), 350)) {
                            val row = rows.optJSONObject(i) ?: continue
                            if (!row.optString("path").matches(Regex("/(film|serials|multfilm|tv-show)/[0-9]+-[a-zA-Z0-9_-]+\\.html"))) continue
                            FamilySupport.merge(this@FamilyActivity, row) {
                                if (key == "favorites") it.put("favorite", true)
                                else it.put("last_opened", System.currentTimeMillis() - i * 1000)
                            }
                        }
                    }
                    prefs.edit().putBoolean("legacy_imported", true).apply()
                    FamilySupport.log("Imported legacy local favorites/history without loading the old website")
                } catch (e: Exception) { FamilySupport.log("Legacy import: ${e.javaClass.simpleName}") }
            }
        }, "FamilyMigration")
        old.loadDataWithBaseURL("https://jeavnex.github.io/ex-fs-lampa/lampa/", """<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"></head><body><script>try{FamilyMigration.accept(JSON.stringify({favorites:JSON.parse(localStorage.getItem('family_favorites')||'[]'),history:JSON.parse(localStorage.getItem('family_history')||'[]')}))}catch(e){FamilyMigration.accept('{}')}</script></body></html>""", "text/html", "utf-8", null)
        web.postDelayed({ old.removeJavascriptInterface("FamilyMigration"); old.destroy() }, 3000)
    }
    override fun onBackPressed() { web.evaluateJavascript("window.FamilyBack && window.FamilyBack()", null) }
    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent): Boolean {
        if (keyCode in listOf(android.view.KeyEvent.KEYCODE_SEARCH, android.view.KeyEvent.KEYCODE_VOICE_ASSIST, android.view.KeyEvent.KEYCODE_ASSIST)) { Bridge().voiceSearch(); return true }
        return super.onKeyDown(keyCode, event)
    }
    override fun onResume() { super.onResume(); if (::web.isInitialized) { web.onResume(); web.evaluateJavascript("window.FamilyReturned && window.FamilyReturned()", null) } }
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onDestroy() { web.removeJavascriptInterface("Family"); web.destroy(); super.onDestroy() }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 11 && resultCode == RESULT_OK) data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let { web.evaluateJavascript("window.FamilyVoice(${JSONObject.quote(it)})", null) }
        if (requestCode == 12 && (Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls())) pendingApk?.let { install(it) }
    }
    private fun checkUpdate(manual: Boolean) {
        if (updateBusy) return
        updateBusy = true
        FamilySupport.executor.execute {
            try {
                val metadata = FamilySupport.http.newCall(Request.Builder().url(FamilySupport.API + "/api/version").build()).execute().use { r ->
                    if (!r.isSuccessful) throw IllegalStateException("Обновление пока недоступно: HTTP ${r.code()}")
                    JSONObject(r.body()!!.string())
                }
                if (metadata.getInt("version_code") <= BuildConfig.VERSION_CODE) { if (manual) runOnUiThread { toast("Установлена последняя сборка") }; return@execute }
                runOnUiThread { toast("Загружаем новую сборку #${metadata.getInt("version_code")}…") }
                val directory = File(cacheDir, "updates"); directory.mkdirs()
                val apk = File(directory, "FamilyCinema.apk"); val partial = File(directory, "FamilyCinema.part")
                val digest = MessageDigest.getInstance("SHA-256")
                FamilySupport.http.newCall(Request.Builder().url(FamilySupport.API + "/download/FamilyCinema.apk").build()).execute().use { response ->
                    check(response.isSuccessful) { "HTTP ${response.code()}" }
                    val expected = metadata.getLong("size"); require(expected in 1000..(24 * 1024 * 1024))
                    var total = 0L
                    response.body()!!.byteStream().use { input -> partial.outputStream().use { output ->
                        val buffer = ByteArray(65536)
                        while (true) { val n = input.read(buffer); if (n < 0) break; total += n; require(total <= expected); output.write(buffer, 0, n); digest.update(buffer, 0, n) }
                    } }
                    check(total == expected) { "Размер обновления не совпал" }
                }
                val sha = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
                check(sha == metadata.getString("sha256")) { "SHA-256 не совпал" }
                @Suppress("DEPRECATION") val archive = packageManager.getPackageArchiveInfo(partial.absolutePath, PackageManager.GET_SIGNATURES) ?: error("Неверный APK")
                @Suppress("DEPRECATION") val current = packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
                @Suppress("DEPRECATION") val valid = archive.packageName == packageName && archive.versionCode == metadata.getInt("version_code") && archive.signatures?.isNotEmpty() == true && archive.signatures?.map { it.toCharsString() }?.toSet() == current.signatures?.map { it.toCharsString() }?.toSet()
                check(valid) { "Подпись обновления не совпала с установленным приложением" }
                if (apk.exists()) apk.delete()
                check(partial.renameTo(apk))
                FamilySupport.log("Verified update #${metadata.getInt("version_code")}")
                runOnUiThread { if (!isFinishing) install(apk) }
            } catch (e: Exception) { FamilySupport.log("Update: ${e.message}"); if (manual) runOnUiThread { toast(e.message ?: "Не удалось проверить обновление") } }
            finally { updateBusy = false }
        }
    }
    private fun install(apk: File) {
        pendingApk = apk
        if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(this).setTitle("Обновление готово").setMessage("Разрешите установку обновлений для «Домашнее кино» в следующем системном окне.")
                .setPositiveButton("Открыть настройки") { _, _ -> startActivityForResult(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")), 12) }.setNegativeButton("Позже", null).show()
            return
        }
        try { startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(FileProvider.getUriForFile(this, "$packageName.family.files", apk), "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }
        catch (_: ActivityNotFoundException) { toast("На устройстве не найден установщик APK") }
    }
}
