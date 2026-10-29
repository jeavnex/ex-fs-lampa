import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, createFetchMock } from 'miniflare';

const listing = `<div class="MiniPostAllForm"><a class="MiniPostPoster"><img src="/thumbs.php?src=https://ex-fs.net/uploads/poster.jpg&amp;w=152"></a><span class="CardYear">2020</span><div class="MiniPostName"><a href="https://ex-fs.net/film/123-test.html">Тест &amp; кино</a></div><span class="CardOrig">Test Movie</span></div><div class="navigation"><a>1</a><a>2</a></div>`;
const detail = `<link rel="canonical" href="https://ex-fs.net/film/123-test.html"><h1>Тест смотреть онлайн</h1><h2>Test watch online</h2><div class="FullstoryFormLeft"><img src="/uploads/poster.jpg"></div><h4 class="FullstoryInfoTitle">Год:</h4><p class="FullstoryInfoin">2020</p><h4 class="FullstoryInfoTitle">Возраст:</h4><p class="FullstoryInfoin">12+</p><div id="preroll"><div class="tab-pane" id="tab6"><iframe src="https://player.example/embed/123"></iframe><!-- <iframe src="https://removed.example/"></iframe> --><iframe src="javascript:alert(1)"></iframe></div></div><a data-toggle="tab" href="#tab6">Плеер HD</a><div class="FullstorySubFormText">Описание тестового фильма.</div>`;
let mf, db, mock;
before(async () => {
  mock = createFetchMock();
  mock.disableNetConnect();
  mf = new Miniflare({ modules: true, script: readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'), compatibilityDate: '2025-10-24', d1Databases: ['FAMILY_DB'], bindings: {FAMILY_APP_KEY:'test-key',FAMILY_RELEASE_KEY:'release-key',FAMILY_MAINTENANCE_KEY:'maintenance-key'}, fetchMock: mock });
  db = await mf.getD1Database('FAMILY_DB');
  await db.exec(readFileSync(new URL('../schema.sql', import.meta.url),'utf8').replace(/^--.*$/gm,'').replace(/\n/g,' '));
  await db.prepare('INSERT INTO parser_config(config_key,payload,updated_at) VALUES(?,?,?)').bind('verified',JSON.stringify({categories:{movies:'/film/',series:'/serials/',cartoons:'/multfilm/',shows:'/tv-show/'},filters:[{path:'/genre/comedy/',title:'Комедия',type:'genre'}],profile:'primary'}),1).run();
});
after(async () => { await mf?.dispose(); await mock?.close(); });
function source(path, body, status = 200) {
  mock.get('https://ex-fs.net').intercept({ path, method: 'GET' }).reply(status, body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
async function get(path, host = 'test') {
  const response = await mf.dispatchFetch('https://' + host + '.example' + path, {headers:{'X-Family-App-Key':'test-key'}});
  return { response, body: await response.json() };
}
test('health checks the actual D1 binding and cache table', async () => {
  const { response, body } = await get('/health');
  assert.equal(response.status, 200); assert.equal(body.database, 'family_cinema_db');
});
test('catalog parses source HTML, decodes titles and thumbnail URLs, and writes D1', async () => {
  source('/film/', listing);
  const { response, body } = await get('/api/catalog');
  assert.equal(response.status, 200); assert.equal(body.items.length, 1);
  assert.equal(body.items[0].title, 'Тест & кино');
  assert.equal(body.items[0].poster, 'https://ex-fs.net/uploads/poster.jpg');
  assert.equal(body.items[0].year, '2020'); assert.equal(body.has_next, true);
  assert.equal(body.cache, 'miss');
  const row = await db.prepare('SELECT payload FROM media_cache WHERE cache_key=?').bind('catalog:movies:1:').first();
  assert.ok(row);
});
test('another edge location can read D1 without another source fetch', async () => {
  const { body } = await get('/api/catalog', 'second-edge');
  assert.equal(body.cache, 'hit'); assert.equal(body.items[0].id, 123);
});
test('detail exposes only real HTTPS frames, ignores comments and JavaScript URLs', async () => {
  source('/film/123-test.html', detail);
  const { response, body } = await get('/api/item?path=/film/123-test.html');
  assert.equal(response.status, 200); assert.equal(body.title, 'Тест'); assert.equal(body.age, '12+');
  assert.deepEqual(body.players, [{ url: 'https://player.example/embed/123', title: 'Плеер HD' }]);
});
test('empty search is a valid empty result, not a broken catalog', async () => {
  source(/^\/index\.php\?/, '<div class="searchmsg">По вашему запросу ничего не найдено</div>');
  const { response, body } = await get('/api/search?q=несуществующий');
  assert.equal(response.status, 200); assert.deepEqual(body.items, []);
});
test('a blocked source is a clear error and is never saved as successful empty data', async () => {
  source('/serials/', '<h1>Access denied</h1>', 403);
  const { response, body } = await get('/api/catalog?category=series');
  assert.equal(response.status, 502); assert.equal(body.error, 'SOURCE_UNAVAILABLE');
  const row = await db.prepare('SELECT * FROM media_cache WHERE cache_key=?').bind('catalog:series:1:').first();
  assert.equal(row, null);
});
test('temporary source outage returns a labelled stale D1 copy', async () => {
  await db.prepare('UPDATE media_cache SET expires_at=0 WHERE cache_key=?').bind('catalog:movies:1:').run();
  source('/film/', 'Unavailable', 503);
  const { response, body } = await get('/api/catalog', 'stale-edge');
  assert.equal(response.status, 200); assert.equal(body.cache, 'stale'); assert.ok(body.warning);
});
test('source pages with changed markup raise an error', async () => {
  source('/multfilm/', '<h1>Unknown template</h1>');
  const { response, body } = await get('/api/catalog?category=cartoons');
  assert.equal(response.status, 502); assert.equal(body.error, 'SOURCE_FORMAT');
});
test('validation blocks arbitrary URLs, SQL fragments, invalid pages and prototype keys', async () => {
  for (const path of ['/api/item?path=https://evil.example/film/1-x.html', '/api/item?path=/actors/1-x.html', '/api/catalog?page=0', '/api/catalog?page=51', '/api/catalog?category=__proto__', '/api/catalog?category=toString', '/api/search?q=x', '/api/item?path=%27%20OR%201=1']) {
    const { response } = await get(path); assert.equal(response.status, 400, path);
  }
});
test('browser access and preflight are denied; method and unknown endpoints are explicit', async () => {
  const response = await mf.dispatchFetch('https://test.example/api/catalog', { method: 'OPTIONS' });
  assert.equal(response.status, 401); assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await mf.dispatchFetch('https://test.example/api/catalog', { method: 'POST',headers:{'X-Family-App-Key':'test-key'} })).status, 405);
  assert.equal((await get('/does-not-exist')).response.status, 404);
});

test('every media endpoint requires the app key even when D1 has cached data',async()=>{
  for(const path of ['/health','/api/home','/api/catalog','/api/filters','/api/item','/api/search','/api/logs']){
    const response=await mf.dispatchFetch('https://test.example'+path,{headers:{'X-Family-App-Key':'wrong'}});
    assert.equal(response.status,401,path);
  }
});
test('diagnostics creates a searchable 4-digit code, redacts credentials and stores valid JSON',async()=>{
  const response=await mf.dispatchFetch('https://test.example/api/logs',{method:'POST',headers:{'X-Family-App-Key':'test-key'},body:JSON.stringify({version:'test',reason:'https://player.example/?token=sensitive',cookie:'private',events:['video failed']})});
  assert.equal(response.status,201);const data=await response.json();assert.match(data.code,/^\d{4}$/);
  const row=await db.prepare('SELECT payload FROM diagnostics_logs WHERE id=?').bind(data.id).first();
  assert.ok(row);assert.equal(JSON.parse(row.payload).cookie,'[hidden]');assert.ok(!row.payload.includes('sensitive'));
});
test('filter cannot escape verified source links; actual source filter is requested',async()=>{
  assert.equal((await get('/api/catalog?filter=https://evil.example/')).response.status,400);
  source('/genre/comedy/',listing);
  const result=await get('/api/catalog?filter=/genre/comedy/');assert.equal(result.response.status,200);
});
test('private APK upload is atomic, checksum verified, public download supports Range and HEAD',async()=>{
  const bytes=new Uint8Array(530000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const {createHash}=await import('node:crypto');const sha=createHash('sha256').update(bytes).digest('hex');
  const post=(action,body,headers={})=>mf.dispatchFetch('https://test.example/api/release/'+action,{method:'POST',headers:{'X-Family-Release-Key':'release-key',...headers},body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)});
  assert.equal((await mf.dispatchFetch('https://test.example/api/version')).status,503);
  assert.equal((await mf.dispatchFetch('https://test.example/api/release/init',{method:'POST',body:'{}'})).status,401);
  const init=await (await post('init',{version_code:100,size:bytes.length,sha256:sha,version_name:'test',built_at:'2026-10-29'})).json();
  assert.ok(init.id);
  assert.equal((await post('chunk?id='+init.id+'&index=0',bytes.slice(0,init.chunk_size))).status,200);
  assert.equal((await post('commit?id='+init.id,{})).status,409);
  assert.equal((await mf.dispatchFetch('https://test.example/api/version')).status,503);
  await post('chunk?id='+init.id+'&index=1',bytes.slice(init.chunk_size));
  assert.equal((await post('commit?id='+init.id,{})).status,200);
  const version=await (await mf.dispatchFetch('https://test.example/api/version')).json();assert.equal(version.sha256,sha);
  const download=await mf.dispatchFetch('https://test.example/download/FamilyCinema.apk');assert.equal(download.status,200);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);
  const range=await mf.dispatchFetch('https://test.example/download/FamilyCinema.apk',{headers:{Range:'bytes=524280-524310'}});assert.equal(range.status,206);assert.deepEqual(new Uint8Array(await range.arrayBuffer()),bytes.slice(524280,524311));
  const head=await mf.dispatchFetch('https://test.example/download/FamilyCinema.apk',{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await mf.dispatchFetch('https://test.example/download/FamilyCinema.apk',{headers:{Range:'bytes=999999-'}})).status,416);
});
test('maintenance preserves last good parser config on broken source instead of inventing repair',async()=>{
  const old=await db.prepare('SELECT payload FROM parser_config WHERE config_key=?').bind('verified').first();
  source('/','<h1>Changed layout</h1>');
  const response=await mf.dispatchFetch('https://test.example/api/maintenance',{method:'POST',headers:{'X-Family-Maintenance-Key':'maintenance-key'}});
  assert.equal(response.status,502);assert.equal((await response.json()).ok,false);
  const current=await db.prepare('SELECT payload FROM parser_config WHERE config_key=?').bind('verified').first();assert.equal(current.payload,old.payload);
});
