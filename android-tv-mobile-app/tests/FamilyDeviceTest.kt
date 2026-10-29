package top.rootu.lampa

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Runs on an actual Android runtime, with genuine MotionEvent and ClipboardManager. */
class FamilyDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun findWeb(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findWeb(view.getChildAt(i))?.let { return it }
        return null
    }
    private fun js(web: WebView, script: String): Any? {
        val latch = CountDownLatch(1); var result: Any? = null
        instrumentation.runOnMainSync { web.evaluateJavascript(script) { value -> result = JSONArray("[$value]").opt(0); latch.countDown() } }
        check(latch.await(8, TimeUnit.SECONDS)) { "JavaScript callback timed out" }
        return result
    }
    private fun waitFor(timeout: Long = 45000, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < deadline) { if (condition()) return; Thread.sleep(500) }
        error("Android condition not reached within ${timeout}ms")
    }
    @Test fun touchBackDpadAndNativeClipboard() {
        ActivityScenario.launch(FamilyActivity::class.java).use { scenario ->
            var web: WebView? = null; var activity: FamilyActivity? = null
            scenario.onActivity { activity = it; web = findWeb(it.window.decorView) }
            val page = web!!
            waitFor { ((js(page, "document.querySelectorAll('.card').length") as? Number)?.toInt() ?: 0) > 5 }
            js(page,"document.getElementById('main').scrollTop=0;document.activeElement.blur();true")
            val before = (js(page,"document.getElementById('main').scrollTop") as Number).toInt()
            val start = SystemClock.uptimeMillis()
            val x = page.width * .6f; val bottom = page.height * .8f; val top = page.height * .35f
            for (i in 0..15) {
                val action = if (i == 0) MotionEvent.ACTION_DOWN else if (i == 15) MotionEvent.ACTION_UP else MotionEvent.ACTION_MOVE
                val y = bottom + (top-bottom)*i/15
                instrumentation.runOnMainSync { val event=MotionEvent.obtain(start,SystemClock.uptimeMillis(),action,x,y,0); page.dispatchTouchEvent(event); event.recycle() }
                Thread.sleep(22)
            }
            Thread.sleep(700)
            val after = (js(page,"document.getElementById('main').scrollTop") as Number).toInt()
            assertTrue("Real touch must scroll main content: $before -> $after", after > before + 60)
            js(page,"document.querySelector('[data-route=movies]').click();true")
            waitFor { js(page,"document.querySelector('main h1')?.textContent") == "Фильмы" && (js(page,"document.querySelectorAll('.card').length") as Number).toInt() > 0 }
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_DOWN)
            assertTrue(js(page,"document.activeElement.matches('button,select,input')") as Boolean)
            js(page,"document.getElementById('settings').click();true")
            waitFor { js(page,"document.querySelector('main h1')?.textContent") == "Настройки" }
            js(page,"Array.from(document.querySelectorAll('main button')).find(b=>b.textContent==='Скопировать лог').click();true")
            Thread.sleep(500)
            var copied = ""
            scenario.onActivity { copied=(it.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString() ?: "" }
            assertTrue("ClipboardManager must receive the actual report",copied.contains("version") && copied.contains("events"))
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            waitFor { js(page,"document.querySelector('main h1')?.textContent") == "Фильмы" }
            js(page,"document.querySelector('[data-route=home]').click();true")
            waitFor { js(page,"document.querySelectorAll('.card').length") is Number }
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            Thread.sleep(400)
            assertFalse(activity!!.isFinishing)
            val screenshot = instrumentation.uiAutomation.takeScreenshot()
            File(instrumentation.targetContext.filesDir,"android-ui.png").outputStream().use { screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        }
    }
    @Test fun realExfsPlayerMustAdvanceTime() {
        val context = instrumentation.targetContext
        val item = JSONObject(FamilySupport.request("/api/item?path=/film/88463-apgreyd.html"))
        val full = item.getJSONArray("players"); val players = JSONArray()
        for (i in 0 until full.length()) if (!full.getJSONObject(i).optString("title").contains("Трейлер",true)) players.put(full.getJSONObject(i))
        item.put("players",players); assertTrue(players.length()>0)
        FamilySupport.prefs(context).edit().remove("library").commit()
        val intent = Intent(context,FamilyPlayerActivity::class.java).putExtra("item",item.toString()).putExtra("index",0).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            ActivityScenario.launch<FamilyPlayerActivity>(intent).use {
                waitFor(130000) { FamilySupport.saved(context,item.getString("path")).optDouble("seconds",0.0)>3 }
                val saved = FamilySupport.saved(context,item.getString("path"))
                assertTrue("Video clock must advance; loading an iframe is insufficient",saved.optDouble("seconds")>3)
            }
        } finally {
            File(context.filesDir,"playback-report.json").writeText(FamilySupport.report(context,"Android emulator playback verification").toString(2))
        }
    }
}
