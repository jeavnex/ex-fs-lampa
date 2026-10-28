"""Prepare the pinned original LAMPA with the complete Family Cinema overlay."""
from pathlib import Path
import shutil
import subprocess
import sys

UPSTREAM_COMMIT = '28d7616f52d969abd6a93d8692b15a8525b36efc'
ROOT = Path(__file__).resolve().parent
SOURCE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'upstream'
DEST = ROOT / 'generated'
if not SOURCE.exists():
    subprocess.run(['git', 'clone', 'https://github.com/lampa-app/LAMPA.git', str(SOURCE)], check=True)
    subprocess.run(['git', '-C', str(SOURCE), 'checkout', UPSTREAM_COMMIT], check=True)
head = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
if head != UPSTREAM_COMMIT:
    raise SystemExit('Wrong upstream revision: ' + head)
if DEST.exists():
    raise SystemExit('generated/ already exists. Use a fresh build directory.')
shutil.copytree(SOURCE, DEST, ignore=shutil.ignore_patterns('.git', '.github', '.idea', '.gradle', 'build', 'local.properties'))

def replace(path, before, after, count=1):
    file = DEST / path
    text = file.read_text(encoding='utf-8')
    found = text.count(before)
    if found != count:
        raise SystemExit(f'Patch mismatch in {path}: expected {count}, got {found}')
    file.write_text(text.replace(before, after), encoding='utf-8')

replace('app/build.gradle', 'applicationId "top.rootu.lampa"', 'applicationId "io.github.jeavnex.familycinema"')
replace('app/build.gradle', 'versionCode getVersionCode()', 'versionCode (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInteger()')
replace('app/build.gradle', 'versionName getVersionName()', 'versionName "1.0.${System.getenv("GITHUB_RUN_NUMBER") ?: "0"}"')
replace('app/build.gradle', '"enableUpdate", "true"', '"enableUpdate", "false"')
replace('app/build.gradle', '"defaultAppUrl", "\\"\\""', '"defaultAppUrl", "\\"https://jeavnex.github.io/ex-fs-lampa/lampa/\\""', count=2)
replace('app/src/main/res/values/strings.xml', '>LAMPA</string>', '>Family Cinema</string>')
replace('app/src/main/AndroidManifest.xml', 'android:screenOrientation="userLandscape"', 'android:screenOrientation="unspecified"')
replace('app/src/main/AndroidManifest.xml', '<activity\n            android:name=".CrashActivity"', '<activity android:name=".FamilyPlayerActivity" android:exported="false" android:configChanges="keyboard|keyboardHidden|orientation|screenSize" />\n        <activity\n            android:name=".CrashActivity"')
marker = '        Log.d(TAG, "LAMPA onLoadFinished $url")'
injection = '''        val familyUri = Uri.parse(url)
        if (familyUri.scheme == "https" && familyUri.host == "jeavnex.github.io"
            && familyUri.path?.trimEnd('/') == "/ex-fs-lampa/lampa") {
            val familyScript = assets.open("family_exfs_plugin.js").bufferedReader().use { it.readText() }
            browser?.evaluateJavascript("window.FAMILY_CINEMA_AUTO_START=true;\\n" + familyScript) { result ->
                Log.d(TAG, "Family Cinema plugin loaded")
            }
        }
'''
replace('app/src/main/java/top/rootu/lampa/MainActivity.kt', marker, injection + marker)
bridge = '''    @JavascriptInterface
    @org.xwalk.core.JavascriptInterface
    fun openFamilyPlayer(url: String) {
        val parsed = android.net.Uri.parse(url)
        if (parsed.scheme != "https" || parsed.host.isNullOrEmpty() || parsed.userInfo != null) return
        mainActivity.runOnUiThread {
            val intent = Intent(mainActivity, FamilyPlayerActivity::class.java)
            intent.putExtra("player_url", url)
            mainActivity.startActivity(intent)
        }
    }

'''
replace('app/src/main/java/top/rootu/lampa/AndroidJS.kt', '    fun openBrowser(url: String) {', '    fun openBrowser(url: String) {')
# Insert before the annotations of openBrowser to keep both methods annotated.
replace('app/src/main/java/top/rootu/lampa/AndroidJS.kt', '    @JavascriptInterface\n    @org.xwalk.core.JavascriptInterface\n    fun openBrowser', bridge + '    @JavascriptInterface\n    @org.xwalk.core.JavascriptInterface\n    fun openBrowser')
shutil.copy2(ROOT / 'overlay/FamilyPlayerActivity.kt', DEST / 'app/src/main/java/top/rootu/lampa/FamilyPlayerActivity.kt')
shutil.copy2(ROOT.parent / 'plugin-web/family_exfs_plugin.js', DEST / 'app/src/main/assets/family_exfs_plugin.js')
(DEST / 'FAMILY_UPSTREAM.txt').write_text('https://github.com/lampa-app/LAMPA/tree/' + UPSTREAM_COMMIT + '\n', encoding='utf-8')
print('Family Cinema Android sources prepared:', DEST)
