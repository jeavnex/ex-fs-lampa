package top.rootu.lampa

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object FamilySupport {
    const val API = "https://family-cinema-api.pvde.workers.dev"
    val executor = Executors.newFixedThreadPool(3)
    val handler = Handler(Looper.getMainLooper())
    val http = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS).build()
    private val entries = ArrayDeque<String>()
    fun version() = "Сборка #${BuildConfig.VERSION_CODE} · ${BuildConfig.BUILD_DATE} · ${BuildConfig.VERSION_NAME}"
    fun clean(value: String): String = value
        .replace(Regex("([?&](?:token|key|password|access_token|secret)=)[^&#\\s]+", RegexOption.IGNORE_CASE), "$1[hidden]")
        .replace(BuildConfig.FAMILY_APP_KEY, "[app key]")
    @Synchronized fun log(message: String) {
        entries.addLast("${java.time.Instant.now()} ${clean(message).take(800)}")
        android.util.Log.i("FamilyCinema", clean(message).take(800))
        while (entries.size > 120 || entries.sumOf { it.toByteArray(Charsets.UTF_8).size } > 24000) entries.removeFirst()
    }
    @Synchronized fun report(context: Context, reason: String) = JSONObject().put("version", version())
        .put("device", "${Build.MANUFACTURER} ${Build.MODEL}; Android ${Build.VERSION.RELEASE}; SDK ${Build.VERSION.SDK_INT}")
        .put("reason", clean(reason).take(1200)).put("events", JSONArray(entries.toList()))
    fun request(path: String, data: String? = null): String {
        require(path.startsWith("/api/") && !path.startsWith("/api/release/") && !path.contains("..") && !path.contains('#'))
        val request = Request.Builder().url(API + path).header("X-Family-App-Key", BuildConfig.FAMILY_APP_KEY)
        if (data != null) request.post(RequestBody.create(MediaType.parse("application/json; charset=utf-8"), data))
        http.newCall(request.build()).execute().use { response ->
            val body = response.body()?.string() ?: "{}"
            log("API ${path.substringBefore('?')} HTTP ${response.code()}")
            if (!response.isSuccessful) {
                val message = try { JSONObject(body).optString("message", "HTTP ${response.code()}") } catch (_: Exception) { "HTTP ${response.code()}" }
                throw IllegalStateException(message)
            }
            return body
        }
    }
    fun prefs(c: Context) = c.getSharedPreferences("family-cinema", Context.MODE_PRIVATE)
    @Synchronized fun library(c: Context): JSONArray = try { JSONArray(prefs(c).getString("library", "[]")) } catch (_: Exception) { JSONArray() }
    @Synchronized fun merge(c: Context, item: JSONObject, change: (JSONObject) -> Unit) {
        val all = library(c); val path = item.optString("path")
        if (path.isEmpty()) return
        var saved: JSONObject? = null
        val rest = mutableListOf<JSONObject>()
        for (i in 0 until all.length()) {
            val row = all.getJSONObject(i)
            if (row.optString("path") == path) saved = row else rest.add(row)
        }
        val row = saved ?: JSONObject()
        for (key in listOf("path", "title", "poster", "year", "original_title", "quality")) if (item.has(key)) row.put(key, item.get(key))
        row.put("saved_at", System.currentTimeMillis()); change(row)
        // Keep all favorites; bound ordinary history independently.
        val favorites = rest.filter { it.optBoolean("favorite") }
        val history = rest.filter { !it.optBoolean("favorite") }.take(300)
        prefs(c).edit().putString("library", JSONArray(listOf(row) + favorites + history).toString()).apply()
    }
    fun saved(c: Context, path: String): JSONObject {
        val all = library(c)
        for (i in 0 until all.length()) if (all.getJSONObject(i).optString("path") == path) return all.getJSONObject(i)
        return JSONObject()
    }
    fun copyLog(activity: Activity, reason: String = "Копирование отчёта") {
        val value = report(activity, reason).toString(2)
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Family Cinema ${version()}", value))
        Toast.makeText(activity, "Лог скопирован", Toast.LENGTH_SHORT).show()
    }
    fun diagnostics(activity: Activity, reason: String) {
        val report = report(activity, reason)
        Toast.makeText(activity, "Сохраняем отчёт…", Toast.LENGTH_SHORT).show()
        executor.execute {
            var code = "----"; var id = "local"; var status = "Отчёт сохранён на устройстве. Нет связи с сервером."
            try {
                val result = JSONObject(request("/api/logs", report.toString()))
                code = result.getString("code"); id = result.getString("id"); status = "Отчёт сохранён в family_cinema_db"
            } catch (e: Exception) { log("Diagnostic upload failed: ${e.message}") }
            val displayCode = code; val displayStatus = status
            prefs(activity).edit().putString("last_report", report.toString(2)).apply()
            val qrText = JSONObject().put("app", "Family Cinema").put("code", code).put("id", id).put("version", BuildConfig.VERSION_CODE).toString()
            val matrix = MultiFormatWriter().encode(qrText, BarcodeFormat.QR_CODE, 420, 420)
            val bitmap = Bitmap.createBitmap(420, 420, Bitmap.Config.RGB_565)
            for (x in 0 until 420) for (y in 0 until 420) bitmap.setPixel(x, y, if (matrix[x,y]) Color.BLACK else Color.WHITE)
            handler.post {
                if (activity.isFinishing) return@post
                val box = LinearLayout(activity); box.orientation = LinearLayout.VERTICAL; box.setPadding(32, 20, 32, 20)
                val codeView = TextView(activity); codeView.text = displayCode; codeView.textSize = 42f; codeView.setTextColor(0xffffb703.toInt()); codeView.gravity = android.view.Gravity.CENTER
                val text = TextView(activity); text.text = "${version()}\n$displayStatus\n${clean(reason).take(250)}"; text.textSize = 14f; text.setTextColor(Color.WHITE)
                val image = ImageView(activity); image.setImageBitmap(bitmap); image.adjustViewBounds = true
                val qrSize = (200 * activity.resources.displayMetrics.density).toInt().coerceAtMost((activity.resources.displayMetrics.widthPixels * .65).toInt())
                box.addView(codeView); box.addView(text); box.addView(image, LinearLayout.LayoutParams(qrSize, qrSize).apply { gravity = android.view.Gravity.CENTER_HORIZONTAL })
                val scroll = android.widget.ScrollView(activity); scroll.addView(box)
                AlertDialog.Builder(activity).setTitle("Логи / Диагностика").setView(scroll)
                    .setPositiveButton("Скопировать лог") { _, _ ->
                        (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Family Cinema $displayCode", report.toString(2)))
                        Toast.makeText(activity, "Лог скопирован", Toast.LENGTH_SHORT).show()
                    }.setNegativeButton("Закрыть", null).show()
            }
        }
    }
}
