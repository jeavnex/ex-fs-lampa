from pathlib import Path
import json
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
web = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
expected = '86f3afa5997793242cc2a081da96efb0934ae71f'
actual = subprocess.check_output(['git', '-C', str(web), 'rev-parse', 'HEAD'], text=True).strip()
if actual != expected:
    raise SystemExit('Unexpected Lampa web revision: ' + actual)
if output.exists():
    raise SystemExit('Choose a fresh output folder for Pages.')
shutil.copytree(root / 'plugin-web', output)
shutil.copytree(web, output / 'lampa', ignore=shutil.ignore_patterns('.git', '.github'))
index = output / 'lampa/index.html'
text = index.read_text(encoding='utf-8')
if '</body>' not in text:
    raise SystemExit('Lampa index has no body tag.')
text = text.replace('</body>', '<script>window.FAMILY_CINEMA_AUTO_START=true;</script><script src="../family_exfs_plugin.js"></script></body>')
index.write_text(text, encoding='utf-8')
with (output / 'lampa-source.tar.gz').open('wb') as archive:
    subprocess.run(['git', '-C', str(web), 'archive', '--format=tar.gz', 'HEAD'], stdout=archive, check=True)
(output / '.nojekyll').touch()
config = json.loads((output / 'family-config.json').read_text(encoding='utf-8'))
if not config['api_url'].startswith('https://family-cinema-api.'):
    raise SystemExit('Invalid API URL in family-config.json')
print('Prepared Pages:', output)
