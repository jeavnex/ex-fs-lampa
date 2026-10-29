"""Fixed APK metadata; HTTP publication uses the same tested Node client as CI."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

folder = Path(sys.argv[2]).resolve()
if sys.argv[1] == 'upload':
    subprocess.run(['node', str(Path(__file__).with_suffix('.mjs')), str(folder)], check=True)
elif sys.argv[1] == 'metadata':
    apk = folder / 'FamilyCinema.apk'
    metadata_file = folder / 'version.json'
    metadata = json.loads(metadata_file.read_text())
    metadata.update(size=apk.stat().st_size, sha256=hashlib.sha256(apk.read_bytes()).hexdigest(), download_url='https://family-cinema-api.pvde.workers.dev/download/FamilyCinema.apk')
    metadata_file.write_text(json.dumps(metadata, ensure_ascii=False, indent=2)+'\n')
    (folder / 'SHA256SUMS.txt').write_text(metadata['sha256']+'  FamilyCinema.apk\n')
    print('Prepared version', metadata['version_code'], 'size', metadata['size'])
else:
    raise SystemExit('Command must be metadata or upload')
