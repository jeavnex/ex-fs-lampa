"""Reproducible local-only Family UI using the pinned LAMPA Android build base."""
from pathlib import Path
from datetime import datetime, timezone
import json
import os
import shutil
import subprocess
import sys

UPSTREAM_COMMIT = '28d7616f52d969abd6a93d8692b15a8525b36efc'
ROOT = Path(__file__).resolve().parent
SOURCE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'upstream'
DEST = Path(os.environ.get('FAMILY_BUILD_DIR', str(ROOT / 'generated'))).resolve()
if not SOURCE.exists():
    subprocess.run(['git', 'clone', 'https://github.com/lampa-app/LAMPA.git', str(SOURCE)], check=True)
    subprocess.run(['git', '-C', str(SOURCE), 'checkout', UPSTREAM_COMMIT], check=True)
head = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
if head != UPSTREAM_COMMIT:
    raise SystemExit('Wrong upstream revision: ' + head)
if DEST.exists():
    raise SystemExit('Build folder already exists; choose a fresh FAMILY_BUILD_DIR.')
key = os.environ.get('FAMILY_APP_KEY', '')
if len(key) < 32 or not all(c.isalnum() or c in '_-' for c in key):
    raise SystemExit('FAMILY_APP_KEY must be configured in the private build environment.')
DEST.mkdir(parents=True)
for name in ['gradlew', 'gradlew.bat', 'gradle.properties', 'build.gradle', 'settings.gradle']:
    shutil.copy2(SOURCE / name, DEST / name)
shutil.copytree(SOURCE / 'gradle', DEST / 'gradle')
code = 100000 + int(os.environ.get('GITHUB_RUN_NUMBER', '1')) * 100 + int(os.environ.get('GITHUB_RUN_ATTEMPT', '1'))
version = f'2.0.{code}'
date = datetime.now(timezone.utc)
build_date = date.strftime('%d.%m.%Y')
app = DEST / 'app'
src = app / 'src/main'
(src / 'java/top/rootu/lampa').mkdir(parents=True)
shutil.copytree(ROOT / 'assets', src / 'assets')
shutil.copytree(ROOT / 'res', src / 'res')
for file in (ROOT / 'overlay').glob('*.kt'):
    shutil.copy2(file, src / 'java/top/rootu/lampa' / file.name)
tests = app / 'src/androidTest/java/top/rootu/lampa'
tests.mkdir(parents=True)
for file in (ROOT / 'tests').glob('*.kt'):
    shutil.copy2(file, tests / file.name)
shutil.copy2(ROOT / 'AndroidManifest.xml', src / 'AndroidManifest.xml')
gradle = (ROOT / 'family-app.gradle').read_text(encoding='utf-8')
gradle = gradle.replace('@VERSION_CODE@', str(code)).replace('@VERSION_NAME@', version)
gradle = gradle.replace('@APP_KEY@', json.dumps(json.dumps(key))).replace('@BUILD_DATE@', json.dumps(json.dumps(build_date)))
(app / 'build.gradle').write_text(gradle, encoding='utf-8')
(app / 'proguard-rules.pro').write_text('-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }\n', encoding='utf-8')
metadata = {'version_code':code, 'version_name':version, 'built_at':date.isoformat()}
(DEST / 'version.json').write_text(json.dumps(metadata), encoding='utf-8')
# Include corresponding project source in the distributed APK, excluding generated secrets and backups.
import tarfile
with tarfile.open(src / 'assets/family-sources.tar.gz', 'w:gz') as archive:
    for file in ROOT.rglob('*'):
        if file.is_file() and not any(part in {'generated','upstream','__pycache__'} for part in file.relative_to(ROOT).parts):
            archive.add(file, arcname='android-tv-mobile-app/' + file.relative_to(ROOT).as_posix())
(DEST / 'FAMILY_UPSTREAM.txt').write_text('Android build base: https://github.com/lampa-app/LAMPA/tree/' + UPSTREAM_COMMIT + '\nOnly FamilyActivity is launched; no Lampa web client is shipped.\n', encoding='utf-8')
print('Prepared', version, 'at', DEST)
