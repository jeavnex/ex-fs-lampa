#!/usr/bin/env bash
set -u
root="$PWD"
cd android-tv-mobile-app/generated
chmod +x gradlew
result=0
./gradlew --no-daemon connectedDebugAndroidTest --stacktrace || result=$?
mkdir -p "$root/android-evidence"
adb exec-out run-as io.github.jeavnex.familycinema cat files/playback-report.json > "$root/android-evidence/playback-report.json" || true
adb exec-out run-as io.github.jeavnex.familycinema cat files/android-ui.png > "$root/android-evidence/android-ui.png" || true
adb exec-out run-as io.github.jeavnex.familycinema cat files/ui-report.json > "$root/android-evidence/ui-report.json" || true
adb logcat -d -s FamilyCinema chromium AndroidRuntime | tail -n 800 > "$root/android-evidence/android-runtime.txt" || true
tail -n 80 "$root/android-evidence/android-runtime.txt"
exit "$result"
