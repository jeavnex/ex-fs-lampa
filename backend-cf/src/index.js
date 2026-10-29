// Family Cinema: authenticated metadata, diagnostics and bounded private APK storage. Video bytes never pass through this Worker.
const SOURCE_URL = 'http://ex-fs.net';
const ORIGIN = 'https://ex-fs.net';
const CATEGORIES = { movies: '/film/', series: '/serials/', cartoons: '/multfilm/', shows: '/tv-show/' };
const MAX_HTML = 1_500_000;
const pending = new Map();
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const clean = value => String(value || '').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
  const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
  return code <= 0x10ffff ? String.fromCodePoint(code) : '';
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[n]).replace(/\s+/g, ' ').trim();

function sourcePath(value) {
  let url;
  try { url = new URL(clean(value), ORIGIN); } catch { return null; }
  if (!['ex-fs.net', 'www.ex-fs.net'].includes(url.hostname) || url.port || url.username || url.password) return null;
  if (!/^\/(?:film|films|serials|series|multfilm|cartoon|tv-show|show)\/\d+-[a-z\d_-]+\.html$/i.test(url.pathname) || url.search || url.hash) return null;
  return url.pathname;
}
function imageUrl(value) {
  try {
    const url = new URL(clean(value), ORIGIN);
    if (!['ex-fs.net', 'www.ex-fs.net'].includes(url.hostname) || url.port || url.username || url.password) return '';
    if (url.pathname === '/thumbs.php') return imageUrl(url.searchParams.get('src'));
    if (!url.pathname.startsWith('/uploads/')) return '';
    url.protocol = 'https:';
    return url.href;
  } catch { return ''; }
}
function playerUrl(value) {
  try {
    const url = new URL(clean(value), ORIGIN);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    if (!url.hostname.includes('.') || /^(?:localhost|\d[\d.]*)$/i.test(url.hostname) || /\.(?:local|internal)$/i.test(url.hostname)) return '';
    // An HTTPS UI must not silently downgrade player traffic.
    return url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}
function textHandler(write) { return { text(chunk) { write(chunk.text); } }; }
async function rewrite(html, configure) {
  const parser = new HTMLRewriter();
  configure(parser);
  await parser.transform(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).text();
}

async function parseListing(html, page, search = false, profile = 'primary', rootOverride = '') {
  const cards = [];
  let current;
  let navigation = '';
  let noResults = '';
  const root = rootOverride || (search ? '.srx-item' : profile === 'primary' ? '.MiniPostAllForm' : '.MiniPost');
  await rewrite(html, parser => {
    parser.on(root, { element() { current = { title: '', original_title: '', year: '', poster: '', path: '' }; cards.push(current); } });
    parser.on(root + (search ? ' .srx-title a' : ' .MiniPostName a'), {
      element(el) { if (current) current.path = sourcePath(el.getAttribute('href')); },
      text(t) { if (current) current.title += t.text; }
    });
    parser.on(root + ' img', { element(el) { if (current && !current.poster) current.poster = imageUrl(el.getAttribute('data-src') || el.getAttribute('src')); } });
    parser.on(root + (search ? ' .srx-orig' : ' .CardOrig'), textHandler(t => { if (current) current.original_title += t; }));
    parser.on(root + (search ? ' .srx-meta a[href^="/year/"]' : ' .CardYear'), textHandler(t => { if (current) current.year += t; }));
    parser.on('.nav-next a', { element(el) { const next = el.getAttribute('href') || ''; if (/page\/|search_start=/.test(next)) navigation += ' ' + (page + 1); } });
    parser.on('.navigation, .navigations, .srx-nav, .searchpages', textHandler(t => { navigation += t; }));
    parser.on('.searchmsg, .srx-count', textHandler(t => { noResults += t; }));
  });
  const seen = new Set();
  const items = cards.filter(c => c.path && clean(c.title) && !seen.has(c.path) && seen.add(c.path)).slice(0, 60).map(c => ({
    id: Number(c.path.match(/\/(\d+)-/)[1]), path: c.path, url: ORIGIN + c.path,
    title: clean(c.title), original_title: clean(c.original_title),
    year: clean(c.year).match(/\b(?:19|20)\d{2}\b/)?.[0] || '', poster: c.poster
  }));
  if (!items.length && !(search && /не (?:найден|дали)|найдено 0|0 ответ|отсутствуют/i.test(clean(noResults)))) {
    throw new ApiError(502, 'SOURCE_FORMAT', 'EX-FS не вернул распознаваемые карточки. Возможно, сайт изменился или ограничил доступ.');
  }
  const totalMatch = clean(noResults).match(/найдено\s+(\d+)\s+ответ/i);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  const numbers = clean(navigation).match(/\d+/g)?.map(Number) || [];
  const hasNext = page < 50 && (numbers.some(n => n > page) || (search && total !== null && total > page * 30));
  return { items, page, has_next: hasNext, total };
}

async function parseDetail(html, path) {
  const result = { path, url: ORIGIN + path, title: '', original_title: '', poster: '', description: '', year: '', age: '', players: [] };
  const fields = {};
  let label = '';
  const tabs = {};
  let tab = '';
  let canonical = '';
  // HTMLRewriter ignores commented-out frames and does not execute source scripts.
  await rewrite(html, parser => {
    parser.on('link[rel="canonical"]', { element(el) { canonical = sourcePath(el.getAttribute('href')) || ''; } });
    parser.on('h1', textHandler(t => { result.title += t; }));
    parser.on('h2', textHandler(t => { result.original_title += t; }));
    parser.on('.FullstoryFormLeft > img', { element(el) { result.poster = imageUrl(el.getAttribute('src')); } });
    parser.on('.FullstorySubFormText', textHandler(t => { result.description += t; }));
    parser.on('.FullstoryInfoTitle', { element() { label = ''; }, text(t) { label += t.text; } });
    parser.on('.FullstoryInfoin', textHandler(t => { const key = clean(label); fields[key] = (fields[key] || '') + t; }));
    parser.on('#preroll .tab-pane', { element(el) { tab = el.getAttribute('id') || ''; } });
    parser.on('#preroll iframe, .player-container iframe, .video-box iframe', { element(el) {
      const url = playerUrl(el.getAttribute('data-src') || el.getAttribute('src'));
      if (url && !result.players.some(p => p.url === url)) result.players.push({ url, tab });
    } });
    parser.on('a[data-toggle="tab"]', { element(el) { tab = (el.getAttribute('href') || '').replace(/^#/, ''); }, text(t) { if (tab) tabs[tab] = (tabs[tab] || '') + t.text; } });
  });
  if (canonical && canonical !== path) throw new ApiError(404, 'NOT_FOUND', 'Страница фильма перенаправлена на другую запись.');
  result.title = clean(result.title).replace(/\s+смотреть онлайн.*$/i, '');
  result.original_title = clean(result.original_title).replace(/\s+watch online.*$/i, '');
  result.description = clean(result.description).slice(0, 6000);
  result.year = clean(fields['Год:']).match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
  result.age = clean(fields['Возраст:']);
  result.genres = clean(fields['Жанр:']);
  result.quality = clean(fields['Качество:']);
  result.players = result.players.slice(0, 16).map((p, i) => ({ url: p.url, title: clean(tabs[p.tab]) || (p.url.includes('trailer') ? 'Трейлер' : 'Плеер ' + (i + 1)) }));
  if (!result.title || !result.poster) throw new ApiError(502, 'SOURCE_FORMAT', 'Не удалось прочитать карточку EX-FS.');
  return result;
}

async function fetchSource(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    let url = new URL(path, ORIGIN);
    for (let redirect = 0; redirect < 4; redirect++) {
      const response = await fetch(url.href, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'text/html', 'User-Agent': 'FamilyCinema/1.0 (+https://github.com/jeavnex/ex-fs-lampa)' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get('Location'), url);
        await response.body?.cancel();
        if (!['ex-fs.net', 'www.ex-fs.net'].includes(next.hostname) || next.protocol !== 'https:' || next.username || next.password || next.port) throw new Error('Unexpected redirect');
        url = next;
        continue;
      }
      if (!response.ok) throw new ApiError(502, 'SOURCE_UNAVAILABLE', 'EX-FS сейчас недоступен (HTTP ' + response.status + ').');
      if (!response.headers.get('Content-Type')?.includes('text/html')) throw new Error('Expected HTML');
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_HTML) { await reader.cancel(); throw new Error('Source response too large'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const charset = /charset=([\w-]+)/i.exec(response.headers.get('Content-Type'))?.[1] || 'utf-8';
      return new TextDecoder(charset).decode(bytes);
    }
    throw new Error('Too many redirects');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'SOURCE_UNAVAILABLE', 'Нет ответа от EX-FS. Повторите позже.');
  } finally { clearTimeout(timer); }
}

function pageNumber(value) {
  if (value === null) return 1;
  if (!/^[1-9]\d?$/.test(value) || Number(value) > 50) throw new ApiError(400, 'BAD_PAGE', 'Номер страницы: от 1 до 50.');
  return Number(value);
}
function route(url, config) {
  const page = pageNumber(url.searchParams.get('page'));
  if (url.pathname === '/api/catalog') {
    const category = url.searchParams.get('category') || 'movies';
    if (!Object.hasOwn(CATEGORIES, category)) throw new ApiError(400, 'BAD_CATEGORY', 'Неизвестный раздел.');
    const filter = url.searchParams.get('filter') || '';
    if (filter && !config.filters.some(f => f.path === filter)) throw new ApiError(400, 'BAD_FILTER', 'Фильтр отсутствует на сайте.');
    const base = filter || config.categories[category];
    if (!base) throw new ApiError(503, 'CATEGORY_MISSING', 'Раздел не найден на EX-FS.');
    const path = base + (page > 1 ? 'page/' + page + '/' : '');
    return { key: 'catalog:' + category + ':' + page + ':' + filter, ttl: 1800, load: async () => parseListing(await fetchSource(path), page, false, config.profile) };
  }
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').normalize('NFC').trim().replace(/\s+/g, ' ');
    if (q.length < 2 || q.length > 80 || /[\x00-\x1f]/.test(q)) throw new ApiError(400, 'BAD_QUERY', 'Введите от 2 до 80 символов.');
    const search = new URLSearchParams({ do: 'search', subaction: 'search', story: q, search_start: String(page), full_search: '0', result_from: String((page - 1) * 30 + 1) });
    return { key: 'search:' + q.toLowerCase() + ':' + page, ttl: 900, load: async () => parseListing(await fetchSource('/index.php?' + search), page, true, config.profile) };
  }
  if (url.pathname === '/api/item') {
    const path = sourcePath(url.searchParams.get('path'));
    if (!path) throw new ApiError(400, 'BAD_PATH', 'Некорректная ссылка на фильм.');
    return { key: 'item:' + path, ttl: 900, load: async () => parseDetail(await fetchSource(path), path) };
  }
  throw new ApiError(404, 'NOT_FOUND', 'Такого раздела API нет.');
}
function json(data, status = 200, ttl = 0) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': ttl ? 'private, max-age=' + ttl : 'no-store',
    'X-Content-Type-Options': 'nosniff'
  } });
}
async function cached(env, info, ctx) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.FAMILY_DB.prepare('SELECT payload, updated_at, expires_at FROM media_cache WHERE cache_key = ?').bind(info.key).first();
  if (row && row.expires_at > now) return { ...JSON.parse(row.payload), cache: 'hit', updated_at: row.updated_at };
  if (pending.has(info.key)) return pending.get(info.key);
  const work = (async () => {
    try {
      const data = await info.load();
      const payload = JSON.stringify(data);
      await env.FAMILY_DB.prepare('INSERT INTO media_cache (cache_key, payload, updated_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at, expires_at=excluded.expires_at').bind(info.key, payload, now, now + info.ttl).run();
      // Bound storage with an indexed expiry sweep and a fixed maximum row count.
      ctx.waitUntil(env.FAMILY_DB.prepare('DELETE FROM media_cache WHERE cache_key IN (SELECT cache_key FROM media_cache ORDER BY updated_at DESC LIMIT -1 OFFSET 2000)').run().catch(() => {}));
      return { ...data, cache: 'miss', updated_at: now };
    } catch (error) {
      if (row && now - row.updated_at < 7 * 86400) return { ...JSON.parse(row.payload), cache: 'stale', updated_at: row.updated_at, warning: 'EX-FS недоступен. Показана сохранённая копия; плееры могут устареть.' };
      throw error;
    }
  })();
  pending.set(info.key, work);
  try { return await work; } finally { pending.delete(info.key); }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
async function authorized(actual, expected) {
  if (!expected || !actual) return false;
  const hash = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let mismatch = 0;
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  for (let i = 0; i < aa.length; i++) mismatch |= aa[i] ^ bb[i];
  return mismatch === 0;
}
function listingPath(value) {
  try {
    const u = new URL(clean(value), ORIGIN);
    if (!['ex-fs.net', 'www.ex-fs.net'].includes(u.hostname) || u.search || u.hash || u.username || u.password || u.port) return '';
    return /^\/(?:film|films|serials|series|multfilm|cartoon|tv-show|show|genre\/[^/]+|year\/\d{4})\/$/.test(u.pathname) ? u.pathname : '';
  } catch { return ''; }
}
async function discover(html) {
  const categories = {}, filters = [], links = [];
  let current;
  await rewrite(html, p => p.on('a[href]', {
    element(el) { current = { path: listingPath(el.getAttribute('href')), title: '' }; links.push(current); },
    text(t) { if (current) current.title += t.text; }
  }));
  for (const l of links) {
    const title = clean(l.title);
    const key = /^Фильмы$/.test(title) ? 'movies' : /^Сериалы$/.test(title) ? 'series' : /^Мультфильмы$/.test(title) ? 'cartoons' : /Передачи и шоу/i.test(title) ? 'shows' : '';
    if (key && l.path) categories[key] = l.path;
    if (/^\/(genre|year)\//.test(l.path) && title && !filters.some(f => f.path === l.path)) filters.push({ path: l.path, title, type: l.path.startsWith('/year/') ? 'year' : 'genre' });
  }
  if (Object.keys(categories).length !== 4) throw new ApiError(502, 'SOURCE_MENU', 'Не удалось проверить все четыре раздела EX-FS.');
  return { categories, filters: filters.slice(0, 150) };
}
async function getConfig(env) {
  const row = await env.FAMILY_DB.prepare('SELECT payload FROM parser_config WHERE config_key=?').bind('verified').first();
  if (row) return JSON.parse(row.payload);
  const html = await fetchSource('/');
  const discovered = await discover(html);
  await parseListing(html, 1);
  const config = { ...discovered, profile: 'primary', verified_at: nowSeconds() };
  await saveConfig(env, config);
  return config;
}
async function saveConfig(env, config) {
  await env.FAMILY_DB.prepare('INSERT INTO parser_config(config_key,payload,updated_at) VALUES(?,?,?) ON CONFLICT(config_key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').bind('verified', JSON.stringify(config), nowSeconds()).run();
}
async function home(config) {
  const html = await fetchSource('/');
  // Actual EX-FS homepage contains three mtabs-pane blocks per section: latest, popular, rating.
  const sections = [];
  const groups = [];
  let group = null;
  await rewrite(html, p => {
    p.on('.mtabs-pane', { element() { group = { html: '', items: [] }; groups.push(group); } });
    p.on('.mtabs-pane .MiniPostAllForm', { element() { if (group) group.items.push({ title: '', path: '', poster: '', year: '' }); } });
    p.on('.mtabs-pane .MiniPostName a', { element(e) { const c = group?.items.at(-1); if (c) c.path = sourcePath(e.getAttribute('href')); }, text(t) { const c = group?.items.at(-1); if (c) c.title += t.text; } });
    p.on('.mtabs-pane img', { element(e) { const c = group?.items.at(-1); if (c) c.poster = imageUrl(e.getAttribute('data-src') || e.getAttribute('src')); } });
    p.on('.mtabs-pane .CardYear', textHandler(t => { const c = group?.items.at(-1); if (c) c.year += t; }));
  });
  for (const [index, title] of [[0, 'Новинки кино'], [1, 'Сейчас популярно'], [3, 'Сериалы'], [6, 'Мультфильмы'], [9, 'Передачи и шоу']]) {
    const items = (groups[index]?.items || []).filter(c => c.path && clean(c.title)).map(c => ({ ...c, id: Number(c.path.match(/\/(\d+)-/)[1]), title: clean(c.title), year: clean(c.year) }));
    if (items.length) sections.push({ title, items });
  }
  if (!sections.length) {
    const result = await parseListing(html, 1, false, config.profile);
    sections.push({ title: 'Новинки EX-FS', items: result.items });
  }
  return { sections };
}
function redact(value) {
  return String(value).replace(/([?&](?:token|key|password|access_token|secret)=)[^&#\s"]+/gi, '$1[hidden]')
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, '$1[hidden]')
    .replace(/("?(?:X-Family-App-Key|X-Family-Release-Key|cookie|authorization)"?\s*[:=]\s*)[^\n,}]+/gi, '$1[hidden]');
}
function redactObject(value, key = '') {
  if (/^(authorization|cookie|x-family-.+-key|password|secret|token)$/i.test(key)) return '[hidden]';
  if (Array.isArray(value)) return value.map(v => redactObject(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redactObject(v,k)]));
  return typeof value === 'string' ? redact(value) : value;
}
async function readJson(request, limit = 40000) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new ApiError(413, 'TOO_LARGE', 'Отчёт слишком большой.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'BAD_JSON', 'Пустой запрос.');
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) { await reader.cancel(); throw new ApiError(413, 'TOO_LARGE', 'Запрос слишком большой.'); }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); } catch { throw new ApiError(400, 'BAD_JSON', 'Некорректный JSON.'); }
}
async function logReport(request, env) {
  const data = await readJson(request);
  const id = crypto.randomUUID();
  // The code is a human aid, not a password. QR also includes the unique id, avoiding ambiguity.
  const code = String(1000 + crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
  const payload = JSON.stringify(redactObject(data));
  await env.FAMILY_DB.batch([
    env.FAMILY_DB.prepare('INSERT INTO diagnostics_logs(id,code,created_at,version,payload) VALUES(?,?,?,?,?)').bind(id, code, nowSeconds(), String(data.version || '').slice(0, 100), payload),
    env.FAMILY_DB.prepare('DELETE FROM diagnostics_logs WHERE id IN (SELECT id FROM diagnostics_logs ORDER BY created_at DESC LIMIT -1 OFFSET 300)')
  ]);
  return json({ id, code, created_at: nowSeconds() }, 201);
}
async function maintenance(env, ctx) {
  const report = { source: SOURCE_URL, at: nowSeconds(), checks: [], repair: 'none' };
  let config;
  try {
    const html = await fetchSource('/');
    const menu = await discover(html);
    let profile = 'primary';
    try { await parseListing(html, 1, false, profile); }
    catch { profile = 'alternate'; await parseListing(html, 1, false, profile); report.repair = 'verified-alternate-selector'; }
    config = { ...menu, profile, verified_at: nowSeconds() };
    const searchHtml = await fetchSource('/index.php?' + new URLSearchParams({ do: 'search', subaction: 'search', story: 'Шрек', search_start: '1', full_search: '0' }));
    const search = await parseListing(searchHtml, 1, true, profile);
    if (!search.items.length) throw new Error('Search check produced no expected results');
    report.checks.push('homepage', 'menu', 'search');
    const recent = await env.FAMILY_DB.prepare("SELECT cache_key FROM media_cache WHERE cache_key LIKE 'item:%' ORDER BY updated_at DESC LIMIT 3").all();
    for (const row of recent.results || []) {
      const path = sourcePath(row.cache_key.slice(5));
      if (!path) continue;
      const detail = await parseDetail(await fetchSource(path), path);
      if (!detail.players.length) throw new Error('No player iframe for cached item');
      await env.FAMILY_DB.prepare('UPDATE media_cache SET payload=?,updated_at=?,expires_at=? WHERE cache_key=?').bind(JSON.stringify(detail), nowSeconds(), nowSeconds()+900, row.cache_key).run();
      report.checks.push(path);
    }
    // Commit configuration only after independent homepage AND search validation.
    await saveConfig(env, config);
    report.ok = true;
  } catch (e) { report.ok = false; report.error = e instanceof ApiError ? e.code : 'SOURCE_CHECK_FAILED'; }
  await env.FAMILY_DB.batch([
    env.FAMILY_DB.prepare('INSERT INTO maintenance_runs(created_at,ok,payload) VALUES(?,?,?)').bind(nowSeconds(), report.ok ? 1 : 0, JSON.stringify(report)),
    env.FAMILY_DB.prepare('DELETE FROM maintenance_runs WHERE id NOT IN (SELECT id FROM maintenance_runs ORDER BY id DESC LIMIT 60)'),
    env.FAMILY_DB.prepare('DELETE FROM apk_chunks WHERE release_id IN (SELECT id FROM apk_releases WHERE active=0 AND created_at<?)').bind(nowSeconds() - 86400),
    env.FAMILY_DB.prepare('DELETE FROM apk_releases WHERE active=0 AND created_at<?').bind(nowSeconds() - 86400)
  ]);
  return report;
}

const APK_CHUNK = 512 * 1024;
async function upload(request, env, url) {
  if (!await authorized(request.headers.get('X-Family-Release-Key'), env.FAMILY_RELEASE_KEY)) throw new ApiError(401, 'UNAUTHORIZED', 'Нужен ключ публикации.');
  const action = url.pathname.split('/').pop();
  if (action === 'init') {
    const data = await readJson(request);
    if (!Number.isInteger(data.version_code) || data.version_code < 1 || !Number.isInteger(data.size) || data.size < 1000 || data.size > 24 * 1024 * 1024 || !/^[a-f\d]{64}$/.test(data.sha256)) throw new ApiError(400, 'BAD_RELEASE', 'Некорректные данные APK.');
    const active = await env.FAMILY_DB.prepare('SELECT version_code FROM apk_releases WHERE active=1').first();
    if (active && data.version_code <= active.version_code) throw new ApiError(409, 'OLD_RELEASE', 'Номер сборки должен увеличиваться.');
    const id = crypto.randomUUID();
    const metadata = { version_code: data.version_code, version_name: String(data.version_name).slice(0, 50), built_at: String(data.built_at).slice(0, 40), size: data.size, sha256: data.sha256, download_url: '/download/FamilyCinema.apk' };
    await env.FAMILY_DB.prepare('INSERT INTO apk_releases(id,version_code,metadata,created_at) VALUES(?,?,?,?)').bind(id, data.version_code, JSON.stringify(metadata), nowSeconds()).run();
    return json({ id, chunk_size: APK_CHUNK });
  }
  const id = url.searchParams.get('id');
  const release = await env.FAMILY_DB.prepare('SELECT * FROM apk_releases WHERE id=? AND active=0').bind(id).first();
  if (!release) throw new ApiError(404, 'UPLOAD_MISSING', 'Загрузка не найдена.');
  const metadata = JSON.parse(release.metadata);
  if (action === 'chunk') {
    const index = Number(url.searchParams.get('index'));
    if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(metadata.size / APK_CHUNK)) throw new ApiError(400, 'BAD_CHUNK', 'Некорректный номер части.');
    const data = await request.arrayBuffer();
    if (data.byteLength !== Math.min(APK_CHUNK, metadata.size - index * APK_CHUNK)) throw new ApiError(400, 'BAD_CHUNK', 'Некорректный размер части.');
    await env.FAMILY_DB.prepare('INSERT INTO apk_chunks(release_id,chunk_index,data) VALUES(?,?,?) ON CONFLICT(release_id,chunk_index) DO UPDATE SET data=excluded.data').bind(id, index, data).run();
    return json({ ok: true, index });
  }
  if (action !== 'commit') throw new ApiError(404, 'NOT_FOUND', 'Неизвестное действие.');
  const bytes = new Uint8Array(metadata.size);
  let offset = 0;
  for (let i = 0; i < Math.ceil(metadata.size / APK_CHUNK); i++) {
    const row = await env.FAMILY_DB.prepare('SELECT data FROM apk_chunks WHERE release_id=? AND chunk_index=?').bind(id, i).first();
    if (!row) throw new ApiError(409, 'INCOMPLETE', 'Не хватает части APK.');
    const chunk = new Uint8Array(row.data);
    if (offset + chunk.length > bytes.length) throw new ApiError(409, 'INCOMPLETE', 'Размер APK не совпал.');
    bytes.set(chunk, offset); offset += chunk.length;
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
  if (offset !== metadata.size || digest !== metadata.sha256) throw new ApiError(409, 'HASH_MISMATCH', 'APK не прошёл проверку SHA-256.');
  await env.FAMILY_DB.batch([
    env.FAMILY_DB.prepare('UPDATE apk_releases SET active=0'),
    env.FAMILY_DB.prepare('UPDATE apk_releases SET active=1 WHERE id=?').bind(id)
  ]);
  // Keep the previous complete APK briefly: downloads already in progress must finish.
  return json({ ok: true, ...metadata });
}
async function releaseResponse(request, env, download) {
  const release = await env.FAMILY_DB.prepare('SELECT id,metadata FROM apk_releases WHERE active=1 ORDER BY version_code DESC LIMIT 1').first();
  if (!release) throw new ApiError(503, 'RELEASE_PENDING', 'Первая новая сборка ещё публикуется.');
  const meta = JSON.parse(release.metadata);
  if (!download) return json(meta);
  const headers = { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="FamilyCinema.apk"', 'Content-Length': String(meta.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'ETag': '"' + meta.sha256 + '"', 'Accept-Ranges': 'bytes' };
  let start = 0, end = meta.size - 1, status = 200;
  const range = request.headers.get('Range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + meta.size } });
    if (!match[1]) start = Math.max(0, meta.size - Number(match[2]));
    else { start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end; }
    if (start > end || start >= meta.size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + meta.size } });
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${meta.size}`;
    headers['Content-Length'] = String(end - start + 1);
  }
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  let index = Math.floor(start / APK_CHUNK);
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const row = await env.FAMILY_DB.prepare('SELECT data FROM apk_chunks WHERE release_id=? AND chunk_index=?').bind(release.id, index).first();
        if (!row) throw new Error('APK chunk unavailable');
        const data = new Uint8Array(row.data);
        controller.enqueue(data.slice(Math.max(0, start - index * APK_CHUNK), Math.min(data.length, end - index * APK_CHUNK + 1)));
        if (++index * APK_CHUNK > end) controller.close();
      } catch (e) { controller.error(e); }
    }
  });
  return new Response(stream, { status, headers });
}
export default {
  async scheduled(controller, env, ctx) { ctx.waitUntil(maintenance(env, ctx)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (!env.FAMILY_DB) throw new ApiError(503, 'DB_NOT_BOUND', 'Не настроена family_cinema_db.');
      if (['/download/FamilyCinema.apk', '/api/version'].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method)) return await releaseResponse(request, env, url.pathname.startsWith('/download/'));
      if (url.pathname.startsWith('/api/release/') && request.method === 'POST') return await upload(request, env, url);
      if (url.pathname === '/api/maintenance' && request.method === 'POST') {
        if (!await authorized(request.headers.get('X-Family-Maintenance-Key'), env.FAMILY_MAINTENANCE_KEY)) throw new ApiError(401, 'UNAUTHORIZED', 'Нет доступа.');
        const report = await maintenance(env, ctx);
        return json(report, report.ok ? 200 : 502);
      }
      if (!await authorized(request.headers.get('X-Family-App-Key'), env.FAMILY_APP_KEY)) throw new ApiError(401, 'UNAUTHORIZED', 'Откройте Family Cinema на телефоне или телевизоре.');
      if (url.pathname === '/api/logs' && request.method === 'POST') return await logReport(request, env);
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.');
      if (url.pathname === '/health') {
        await env.FAMILY_DB.prepare('SELECT cache_key FROM media_cache LIMIT 1').all();
        return json({ ok: true, service: 'family-cinema-api', database: 'family_cinema_db', source: SOURCE_URL, version: '2.0' });
      }
      const config = await getConfig(env);
      if (url.pathname === '/api/filters') return json(config);
      const info = url.pathname === '/api/home' ? { key: 'home', ttl: 900, load: () => home(config) } : route(url, config);
      return json(await cached(env, info, ctx));
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status);
      console.error('Family Cinema request failed:', e.name);
      return json({ error: 'SERVICE_UNAVAILABLE', message: 'Сервис временно недоступен. Отправьте диагностику.' }, 503);
    }
  }
};
