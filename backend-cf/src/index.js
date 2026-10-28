// Family Cinema: public metadata API. Video bytes never pass through this Worker.
const SOURCE_URL = 'http://ex-fs.net';
const ORIGIN = 'https://ex-fs.net';
const CATEGORIES = { movies: '/film/', series: '/serials/', cartoons: '/multfilm/' };
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
  if (!/^\/(?:film|serials|multfilm)\/\d+-[a-z\d_-]+\.html$/i.test(url.pathname) || url.search || url.hash) return null;
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

async function parseListing(html, page, search = false) {
  const cards = [];
  let current;
  let navigation = '';
  let noResults = '';
  const root = search ? '.srx-item' : '.MiniPostAllForm';
  await rewrite(html, parser => {
    parser.on(root, { element() { current = { title: '', original_title: '', year: '', poster: '', path: '' }; cards.push(current); } });
    parser.on(root + (search ? ' .srx-title a' : ' .MiniPostName a'), {
      element(el) { if (current) current.path = sourcePath(el.getAttribute('href')); },
      text(t) { if (current) current.title += t.text; }
    });
    parser.on(root + ' img', { element(el) { if (current && !current.poster) current.poster = imageUrl(el.getAttribute('data-src') || el.getAttribute('src')); } });
    parser.on(root + (search ? ' .srx-orig' : ' .CardOrig'), textHandler(t => { if (current) current.original_title += t; }));
    parser.on(root + (search ? ' .srx-meta a[href^="/year/"]' : ' .CardYear'), textHandler(t => { if (current) current.year += t; }));
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
    parser.on('#preroll iframe', { element(el) {
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
  result.players = result.players.slice(0, 8).map((p, i) => ({ url: p.url, title: clean(tabs[p.tab]) || (p.url.includes('trailer') ? 'Трейлер' : 'Плеер ' + (i + 1)) }));
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
function route(url) {
  const page = pageNumber(url.searchParams.get('page'));
  if (url.pathname === '/api/catalog') {
    const category = url.searchParams.get('category') || 'movies';
    if (!Object.hasOwn(CATEGORIES, category)) throw new ApiError(400, 'BAD_CATEGORY', 'Неизвестный раздел.');
    const path = CATEGORIES[category] + (page > 1 ? 'page/' + page + '/' : '');
    return { key: 'catalog:' + category + ':' + page, ttl: 1800, load: async () => parseListing(await fetchSource(path), page) };
  }
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').normalize('NFC').trim().replace(/\s+/g, ' ');
    if (q.length < 2 || q.length > 80 || /[\x00-\x1f]/.test(q)) throw new ApiError(400, 'BAD_QUERY', 'Введите от 2 до 80 символов.');
    const search = new URLSearchParams({ do: 'search', subaction: 'search', story: q, search_start: String(page), full_search: '0', result_from: String((page - 1) * 30 + 1) });
    return { key: 'search:' + q.toLowerCase() + ':' + page, ttl: 900, load: async () => parseListing(await fetchSource('/index.php?' + search), page, true) };
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
    'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': ttl ? 'public, max-age=' + ttl : 'no-store',
    'X-Content-Type-Options': 'nosniff'
  } });
}
async function cached(env, info, ctx) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.FAMILY_DB.prepare('SELECT payload, updated_at, expires_at FROM movie_cache WHERE cache_key = ?').bind(info.key).first();
  if (row && row.expires_at > now) return { ...JSON.parse(row.payload), cache: 'hit', updated_at: row.updated_at };
  if (pending.has(info.key)) return pending.get(info.key);
  const work = (async () => {
    try {
      const data = await info.load();
      const payload = JSON.stringify(data);
      await env.FAMILY_DB.prepare('INSERT INTO movie_cache (cache_key, payload, updated_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at, expires_at=excluded.expires_at').bind(info.key, payload, now, now + info.ttl).run();
      // Bound storage with an indexed expiry sweep and a fixed maximum row count.
      ctx.waitUntil(env.FAMILY_DB.prepare('DELETE FROM movie_cache WHERE cache_key IN (SELECT cache_key FROM movie_cache ORDER BY updated_at DESC LIMIT -1 OFFSET 2000)').run().catch(() => {}));
      return { ...data, cache: 'miss', updated_at: now };
    } catch (error) {
      if (row && now - row.updated_at < 7 * 86400) return { ...JSON.parse(row.payload), cache: 'stale', updated_at: row.updated_at, warning: 'EX-FS недоступен. Показана сохранённая копия; плееры могут устареть.' };
      throw error;
    }
  })();
  pending.set(info.key, work);
  try { return await work; } finally { pending.delete(info.key); }
}
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: json({}).headers });
    if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED', message: 'Разрешены GET и OPTIONS.' }, 405);
    const url = new URL(request.url);
    try {
      if (env.FAMILY_RATE_LIMITER) {
        const { success } = await env.FAMILY_RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
        if (!success) return json({ error: 'RATE_LIMIT', message: 'Слишком много запросов. Подождите минуту.' }, 429);
      }
      if (!env.FAMILY_DB) throw new ApiError(503, 'DB_NOT_BOUND', 'К Worker нужно привязать family_cinema_db с именем FAMILY_DB.');
      if (url.pathname === '/health') {
        await env.FAMILY_DB.prepare('SELECT cache_key FROM movie_cache LIMIT 1').all();
        return json({ ok: true, service: 'family-cinema-api', database: 'family_cinema_db', source: SOURCE_URL, version: '1.0.0' });
      }
      const info = route(url);
      const edgeKey = new Request(url.origin + '/_cache/' + encodeURIComponent(info.key));
      const edge = typeof caches !== 'undefined' ? caches.default : null;
      const hit = edge && await edge.match(edgeKey);
      if (hit) return hit;
      const data = await cached(env, info, ctx);
      const response = json(data, 200, data.cache === 'stale' ? 30 : 120);
      if (edge) ctx.waitUntil(edge.put(edgeKey, response.clone()));
      return response;
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.code, message: error.message }, error.status);
      console.error('Family Cinema:', error.message);
      return json({ error: 'DATABASE_UNAVAILABLE', message: 'Не удалось прочитать кэш. Проверьте привязку FAMILY_DB и выполнение schema.sql.' }, 503);
    }
  }
};
