"""Publish only the fixed FamilyCinema.apk; credentials never enter output."""
from pathlib import Path
import hashlib, json, os, sys, time, urllib.request, urllib.error

API = 'https://family-cinema-api.pvde.workers.dev'
folder = Path(sys.argv[2]); apk = folder / 'FamilyCinema.apk'
meta_file = folder / 'version.json'
metadata = json.loads(meta_file.read_text())
if sys.argv[1] == 'metadata':
    metadata.update(size=apk.stat().st_size, sha256=hashlib.sha256(apk.read_bytes()).hexdigest(), download_url=API+'/download/FamilyCinema.apk')
    meta_file.write_text(json.dumps(metadata, ensure_ascii=False, indent=2)+'\n')
    (folder / 'SHA256SUMS.txt').write_text(metadata['sha256']+'  FamilyCinema.apk\n')
    print('Prepared version',metadata['version_code'],'size',metadata['size'])
elif sys.argv[1] == 'upload':
    key = os.environ['FAMILY_RELEASE_KEY']
    def post(path, body, content_type='application/json'):
        if not isinstance(body,bytes): body=json.dumps(body).encode()
        for attempt in range(3):
            request=urllib.request.Request(API+path,data=body,method='POST',headers={'X-Family-Release-Key':key,'Content-Type':content_type})
            try:
                with urllib.request.urlopen(request,timeout=90) as response:return json.load(response)
            except urllib.error.HTTPError as error:
                if error.code < 500 or attempt == 2: raise RuntimeError('APK publication HTTP '+str(error.code)) from None
            except (TimeoutError, urllib.error.URLError):
                if attempt == 2: raise RuntimeError('APK publication connection failed') from None
            time.sleep(2**attempt)
    init=post('/api/release/init',metadata)
    with apk.open('rb') as source:
        index=0
        while True:
            data=source.read(init['chunk_size'])
            if not data:break
            post('/api/release/chunk?id='+init['id']+'&index='+str(index),data,'application/octet-stream');index+=1
    try: result=post('/api/release/commit?id='+init['id'],{})
    except RuntimeError:
        with urllib.request.urlopen(API+'/api/version',timeout=30) as response: current=json.load(response)
        if current.get('sha256')!=metadata['sha256']:raise
    print('Published permanent URL:',API+'/download/FamilyCinema.apk')
else:raise SystemExit('Unknown command')
