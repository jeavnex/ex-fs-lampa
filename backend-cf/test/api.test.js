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
  mf = new Miniflare({ modules: true, script: readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'), compatibilityDate: '2025-10-24', d1Databases: ['FAMILY_DB'], fetchMock: mock });
  db = await mf.getD1Database('FAMILY_DB');
  await db.exec('CREATE TABLE movie_cache (cache_key TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL); CREATE INDEX movie_cache_updated ON movie_cache(updated_at DESC);');
});
after(async () => { await mf?.dispose(); await mock?.close(); });
function source(path, body, status = 200) {
  mock.get('https://ex-fs.net').intercept({ path, method: 'GET' }).reply(status, body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
async function get(path, host = 'test') {
  const response = await mf.dispatchFetch('https://' + host + '.example' + path);
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
  const row = await db.prepare('SELECT payload FROM movie_cache WHERE cache_key=?').bind('catalog:movies:1').first();
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
  const row = await db.prepare('SELECT * FROM movie_cache WHERE cache_key=?').bind('catalog:series:1').first();
  assert.equal(row, null);
});
test('temporary source outage returns a labelled stale D1 copy', async () => {
  await db.prepare('UPDATE movie_cache SET expires_at=0 WHERE cache_key=?').bind('catalog:movies:1').run();
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
test('CORS, methods and unknown endpoints are explicit', async () => {
  const response = await mf.dispatchFetch('https://test.example/api/catalog', { method: 'OPTIONS' });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await mf.dispatchFetch('https://test.example/api/catalog', { method: 'POST' })).status, 405);
  assert.equal((await get('/does-not-exist')).response.status, 404);
});
