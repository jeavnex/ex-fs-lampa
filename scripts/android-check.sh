#!/usr/bin/env bash
set -u
root="$PWD"
mkdir -p "$root/android-evidence"
cd android-tv-mobile-app/generated
chmod +x gradlew
result=0
./gradlew --no-daemon assembleDebug assembleDebugAndroidTest --stacktrace || result=$?
if [ "$result" -eq 0 ]; then
  adb install -r app/build/outputs/apk/debug/app-debug.apk > "$root/android-evidence/install-app.txt" 2>&1 || result=$?
  cat "$root/android-evidence/install-app.txt"
fi
if [ "$result" -eq 0 ]; then
  adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk > "$root/android-evidence/install-tests.txt" 2>&1 || result=$?
  cat "$root/android-evidence/install-tests.txt"
fi
if [ "$result" -eq 0 ]; then
  if [ "${FAMILY_TEST_SUITE:-all}" = 'ui' ]; then
    adb shell am instrument -w -r -e class top.rootu.lampa.FamilyDeviceTest#touchBackDpadAndNativeClipboard io.github.jeavnex.familycinema.test/androidx.test.runner.AndroidJUnitRunner | tee "$root/android-evidence/test-output.txt"
    grep -q '^OK (1 test)' "$root/android-evidence/test-output.txt" || result=1
  else
    adb shell am instrument -w -r io.github.jeavnex.familycinema.test/androidx.test.runner.AndroidJUnitRunner | tee "$root/android-evidence/test-output.txt"
    grep -q '^OK (2 tests)' "$root/android-evidence/test-output.txt" || result=1
  fi
fi
adb exec-out run-as io.github.jeavnex.familycinema cat files/playback-report.json > "$root/android-evidence/playback-report.json" || true
adb exec-out run-as io.github.jeavnex.familycinema cat files/android-ui.png > "$root/android-evidence/android-ui.png" || true
adb exec-out run-as io.github.jeavnex.familycinema cat files/ui-report.json > "$root/android-evidence/ui-report.json" || true
adb logcat -d -s FamilyCinema chromium AndroidRuntime | tail -n 800 > "$root/android-evidence/android-runtime.txt" || true
tail -n 80 "$root/android-evidence/android-runtime.txt"
exit "$result"
