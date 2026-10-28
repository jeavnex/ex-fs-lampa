(function () {
    'use strict';
    if (window.family_exfs_plugin) return;
    window.family_exfs_plugin = { version: '1.0.0' };
    var BASE = 'https://jeavnex.github.io/ex-fs-lampa/';
    var configuredApi = '';
    var configWaiters = [];
    var configLoading = false;
    function validApi(value) {
        return /^https:\/\/family-cinema-api\.[a-z0-9-]+\.workers\.dev\/?$/i.test(value || '');
    }
    function request(url, done, fail) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 20000;
        xhr.onload = function () {
            var data;
            try { data = JSON.parse(xhr.responseText); } catch (e) { fail('Сервер вернул непонятный ответ.'); return; }
            if (xhr.status >= 200 && xhr.status < 300) done(data);
            else fail(data.message || 'Ошибка сервера: ' + xhr.status);
        };
        xhr.onerror = function () { fail('Нет связи с сервером. Проверьте интернет и адрес API в настройках.'); };
        xhr.ontimeout = function () { fail('Сервер долго не отвечает. Попробуйте ещё раз.'); };
        xhr.send();
        return xhr;
    }
    function getApi(done, fail) {
        var saved = Lampa.Storage.get('family_api_url', '');
        if (validApi(saved)) { done(saved.replace(/\/$/, '')); return; }
        if (configuredApi) { done(configuredApi); return; }
        configWaiters.push({ done: done, fail: fail });
        if (configLoading) return;
        configLoading = true;
        request(BASE + 'family-config.json?t=' + Math.floor(Date.now() / 300000), function (data) {
            configuredApi = validApi(data.api_url) ? data.api_url.replace(/\/$/, '') : '';
            finish(configuredApi ? '' : 'Адрес API ещё не настроен. Откройте кнопку «Настройки API».');
        }, finish);
        function finish(error) {
            configLoading = false;
            var waiters = configWaiters;
            configWaiters = [];
            waiters.forEach(function (w) { if (configuredApi) w.done(configuredApi); else w.fail(error); });
        }
    }
    function api(path, done, fail) { getApi(function (base) { request(base + path, done, fail); }, fail); }
    function stored(name) { return Lampa.Storage.get('family_' + name, []); }
    function remember(name, item, max) {
        var list = stored(name).filter(function (c) { return c.path !== item.path; });
        list.unshift({ title: item.title, path: item.path, poster: item.poster, year: item.year });
        Lampa.Storage.set('family_' + name, list.slice(0, max));
    }
    function push(options) {
        Lampa.Activity.push(Object.assign({ title: 'Семейный кинотеатр', component: 'family_exfs' }, options || {}));
    }
    function Component(object) {
        var self = this;
        var html = $('<div class="family-root"></div>');
        var body = $('<div class="family-body"></div>');
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var last = null;
        var destroyed = false;
        var activeFrame = null;
        scroll.append(body);
        html.append(scroll.render());
        function button(label, action, className, target) {
            var node = $('<button type="button" class="selector family-button"></button>').text(label);
            if (className) node.addClass(className);
            var activated = 0;
            node.on('hover:enter click', function (e) {
                e.preventDefault();
                if (Date.now() - activated < 350) return;
                activated = Date.now();
                action();
            }).on('hover:focus focus', function () {
                last = node[0];
                scroll.update(node, true);
            });
            (target || body).append(node);
            return node;
        }
        function title(text) { body.append($('<h1 class="family-title"></h1>').text(text)); }
        function note(text) { body.append($('<p class="family-note"></p>').text(text)); }
        function navigation() {
            var nav = $('<div class="family-nav"></div>').appendTo(body);
            [['Фильмы', 'movies'], ['Сериалы', 'series'], ['Мультфильмы', 'cartoons'], ['Избранное', 'favorites'], ['История', 'history']].forEach(function (pair) {
                button(pair[0], function () { push({ section: pair[1] }); }, object.section === pair[1] ? 'family-selected' : '', nav);
            });
            button('Найти фильм', search, '', nav);
            button('Настройки API', settings, '', nav);
        }
        function finish() {
            if (destroyed) return;
            self.activity.loader(false);
            self.activity.toggle();
            Lampa.Layer.update(html);
        }
        function failure(message) {
            if (destroyed) return;
            body.find('.family-loading').remove();
            note(message);
            button('Попробовать снова', function () { Lampa.Activity.replace(Object.assign({}, object)); });
            button('Настройки API', settings);
            finish();
        }
        function search() {
            Lampa.Input.edit({ title: 'Название фильма или сериала', value: object.query || '', free: true, nosave: true, nomic: true }, function (query) {
                if (query && query.trim().length >= 2) push({ query: query.trim(), section: 'search', page: 1 });
                else { self.start(); if (query) Lampa.Noty.show('Введите хотя бы 2 символа.'); }
            });
        }
        function settings() {
            Lampa.Input.edit({ title: 'HTTPS-адрес family-cinema-api…workers.dev', value: Lampa.Storage.get('family_api_url', configuredApi), free: true, nosave: true, nomic: true }, function (value) {
                if (!value) { self.start(); return; }
                value = value.trim().replace(/\/$/, '');
                if (!validApi(value)) { Lampa.Noty.show('Нужен адрес https://family-cinema-api.ваш-поддомен.workers.dev'); self.start(); return; }
                request(value + '/health', function (health) {
                    if (health.ok && health.service === 'family-cinema-api') {
                        Lampa.Storage.set('family_api_url', value);
                        Lampa.Noty.show('Сервер подключён.');
                        push({ section: 'movies' });
                    } else failure('Это не сервер Family Cinema.');
                }, function (error) { Lampa.Noty.show(error); self.start(); });
            });
        }
        function openExternal(url) {
            if (window.Android && typeof Android.openBrowser === 'function') Android.openBrowser(url);
            else window.open(url, '_blank', 'noopener,noreferrer');
        }
        function play(item, player) {
            remember('history', item, 50);
            if (window.Android && typeof Android.openFamilyPlayer === 'function') {
                Android.openFamilyPlayer(player.url);
                return;
            }
            // Web players are HTML documents, not media URLs for Lampa.Player.
            var overlay = $('<div class="family-player"></div>').appendTo('body');
            var close = $('<button class="selector family-button family-close">Закрыть плеер / Назад</button>').appendTo(overlay);
            var external = $('<button class="selector family-button">Открыть отдельно</button>').appendTo(overlay);
            var frame = $('<iframe title="Видеоплеер" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>').attr('src', player.url).appendTo(overlay);
            activeFrame = overlay;
            function leave() { frame.attr('src', 'about:blank'); overlay.remove(); activeFrame = null; self.start(); }
            close.on('hover:enter click', leave);
            external.on('hover:enter click', function () { openExternal(player.url); });
            Lampa.Controller.add('family_player', {
                toggle: function () { Lampa.Controller.collectionSet(overlay); Lampa.Controller.collectionFocus(close[0], overlay); },
                left: function () { window.Navigator.move('left'); }, right: function () { window.Navigator.move('right'); },
                up: function () { window.Navigator.move('up'); }, down: function () { frame[0].focus(); }, back: leave
            });
            Lampa.Controller.toggle('family_player');
        }
        function showDetail(item) {
            if (destroyed) return;
            body.empty();
            title(item.title);
            if (item.poster) body.append($('<img class="family-detail-poster" alt="">').attr('src', item.poster));
            note([item.year, item.age, item.quality, item.genres].filter(Boolean).join(' · '));
            var actions = $('<div class="family-actions"></div>').appendTo(body);
            item.players.forEach(function (player) { button('Смотреть: ' + player.title, function () { play(item, player); }, 'family-primary', actions); });
            if (!item.players.length) note('Сайт не передал встроенные плееры. Откройте оригинальную страницу ниже.');
            var isFavorite = stored('favorites').some(function (c) { return c.path === item.path; });
            var favorite = button(isFavorite ? 'Убрать из избранного' : 'В избранное', function () {
                if (isFavorite) Lampa.Storage.set('family_favorites', stored('favorites').filter(function (c) { return c.path !== item.path; }));
                else remember('favorites', item, 300);
                isFavorite = !isFavorite;
                favorite.text(isFavorite ? 'Убрать из избранного' : 'В избранное');
            }, '', actions);
            button('Открыть страницу EX-FS', function () { openExternal(item.url); }, '', actions);
            button('Назад к списку', function () { Lampa.Activity.backward(); }, '', actions);
            note(item.description || 'Описание на сайте отсутствует.');
            if (item.warning) note(item.warning);
            note('Встроенные плееры принадлежат сторонним сайтам. Они могут показывать рекламу или не работать в вашей сети.');
            finish();
        }
        function showList(data) {
            if (destroyed) return;
            body.find('.family-loading').remove();
            if (data.warning) note(data.warning);
            if (!data.items.length) note('Здесь пока пусто. Воспользуйтесь поиском или добавьте фильм в избранное.');
            var grid = $('<div class="family-grid"></div>').appendTo(body);
            data.items.forEach(function (item) {
                var card = button('', function () { push({ path: item.path, title: item.title }); }, 'family-card', grid);
                if (item.poster) card.append($('<img loading="lazy" alt="">').attr('src', item.poster).on('error', function () { $(this).hide(); }));
                else card.append($('<div class="family-no-poster">Кино</div>'));
                card.append($('<strong></strong>').text(item.title));
                if (item.year) card.append($('<span></span>').text(item.year));
            });
            var paging = $('<div class="family-nav"></div>').appendTo(body);
            if ((object.page || 1) > 1) button('Предыдущая страница', function () { push(Object.assign({}, object, { page: object.page - 1 })); }, '', paging);
            if (data.has_next) button('Следующая страница', function () { push(Object.assign({}, object, { page: (object.page || 1) + 1 })); }, '', paging);
            finish();
        }
        this.create = function () {
            if (object.path) { title('Открываю фильм…'); api('/api/item?path=' + encodeURIComponent(object.path), showDetail, failure); return; }
            object.section = object.section || 'movies';
            var labels = { movies: 'Фильмы', series: 'Сериалы', cartoons: 'Мультфильмы', favorites: 'Избранное', history: 'Недавно открытые плееры', search: 'Поиск: ' + (object.query || '') };
            title(labels[object.section] || 'Семейный кинотеатр');
            navigation();
            if (object.section === 'favorites' || object.section === 'history') { showList({ items: stored(object.section) }); return; }
            body.append('<p class="family-note family-loading">Загружаю список…</p>');
            var page = object.page || 1;
            var path = object.query ? '/api/search?q=' + encodeURIComponent(object.query) + '&page=' + page : '/api/catalog?category=' + object.section + '&page=' + page;
            api(path, showList, failure);
        };
        this.start = function () {
            if (destroyed) return;
            Lampa.Controller.add('content', {
                link: self,
                toggle: function () { Lampa.Controller.collectionSet(body); Lampa.Controller.collectionFocus(last || false, body); },
                up: function () { if (window.Navigator.canmove('up')) window.Navigator.move('up'); else Lampa.Controller.toggle('head'); },
                down: function () { window.Navigator.move('down'); },
                left: function () { if (window.Navigator.canmove('left')) window.Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
                right: function () { window.Navigator.move('right'); },
                back: function () { Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
        };
        this.render = function (asNode) { return asNode ? html[0] : html; };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () { destroyed = true; if (activeFrame) activeFrame.remove(); scroll.destroy(); html.remove(); };
    }
    function start() {
        if (window.family_exfs_plugin.started) return;
        window.family_exfs_plugin.started = true;
        Lampa.Component.add('family_exfs', Component);
        var icon = '<svg viewBox="0 0 32 32"><path fill="currentColor" d="M3 5h26v22H3zM6 9v14h20V9zM13 11l9 5-9 5z"/></svg>';
        var menu = $('<li class="menu__item selector"><div class="menu__ico">' + icon + '</div><div class="menu__text">Семейный кинотеатр</div></li>');
        menu.on('hover:enter', function () { push(); });
        $('.menu .menu__list').first().prepend(menu);
        $('<style id="family-cinema-style"></style>').text(
            '.family-root{height:100%;background:#151b27;color:#f5f7ff}.family-body{padding:1.4em 1.6em 4em;font-size:1.12em}.family-title{font-size:1.9em;font-weight:700;margin:0 0 .6em}.family-note{line-height:1.55;max-width:65em;margin:1em 0;color:#c8d2e5}.family-nav,.family-actions{display:flex;flex-wrap:wrap;gap:.6em;margin:1em 0 1.4em}.family-button{font:inherit;background:#29364e;border:2px solid transparent;color:#fff;border-radius:.55em;padding:.7em 1em;cursor:pointer;text-align:left}.family-button.focus,.family-button:focus{background:#eac87b;color:#131925;border-color:#fff;outline:0;box-shadow:0 0 0 3px #eac87b}.family-primary,.family-selected{background:#245c63}.family-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(9em,1fr));gap:1em}.family-card{padding:.4em;display:flex;flex-direction:column;min-width:0;gap:.5em}.family-card img,.family-no-poster{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:.3em;background:#33405a}.family-card strong{line-height:1.3;font-size:.95em}.family-card span{opacity:.8;font-size:.85em}.family-detail-poster{float:right;width:10em;margin:0 0 1em 1em;border-radius:.5em}.family-player{position:fixed;inset:0;z-index:20000;background:#000;display:flex;flex-wrap:wrap;align-content:flex-start;gap:.5em;padding:.5em}.family-player iframe{border:0;width:100%;height:calc(100% - 4em)}@media(max-width:600px){.family-body{padding:1em}.family-title{font-size:1.4em}.family-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.family-detail-poster{width:7em}}'
        ).appendTo('head');
        if (window.FAMILY_CINEMA_AUTO_START) setTimeout(function () { push(); }, 800);
    }
    var attempts = 0;
    var timer = setInterval(function () {
        attempts++;
        if (window.appready && window.Lampa && window.jQuery && Lampa.Component && Lampa.Listener && $('.menu .menu__list').length) { clearInterval(timer); start(); }
        else if (attempts > 180) { clearInterval(timer); console.error('Family Cinema: Lampa did not become ready within 90 seconds.'); }
    }, 500);
})();
