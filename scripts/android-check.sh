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
exit "$result"
