/* All privileged actions stay in the native bridge of the local APK page. */
(() => {
  'use strict';
  if(!Element.prototype.replaceChildren)Element.prototype.replaceChildren=function(...nodes){while(this.firstChild)this.removeChild(this.firstChild);this.append(...nodes);};
  const native = window.Family;
  const main = document.getElementById('main');
  const routes = [], pending = new Map();
  let serial = 0, generation = 0, current = { name: 'home' }, filters = null;
  const menu = [['home','Главная'],['movies','Фильмы'],['series','Сериалы'],['cartoons','Мультфильмы'],['shows','Передачи и шоу'],['search','Поиск'],['continue','Продолжить'],['favorites','Избранное'],['history','История']];
  const labels = Object.fromEntries(menu);
  const el = (tag, text, cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e; };
  const button = (text, click, cls) => {const b=el('button',text,cls); b.onclick=click; return b;};
  function toast(text){ const t=document.getElementById('toast');t.textContent=text;t.className='show';clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.className='',4000); }
  function api(path, body){return new Promise((resolve,reject)=>{const id=String(++serial);const timer=setTimeout(()=>{pending.delete(id);reject(Error('Сервис не ответил. Проверьте интернет.'));},35000);pending.set(id,{resolve,reject,timer});native.request(id,path,body===undefined?'':JSON.stringify(body));});}
  window.FamilyReply=(id,text)=>{const p=pending.get(id);if(!p)return;clearTimeout(p.timer);pending.delete(id);try{const data=JSON.parse(text);if(data.error)p.reject(Error(data.message||data.error));else p.resolve(data);}catch(e){p.reject(e);}};
  window.FamilyToast=toast;
  window.FamilyVoice=q=>{open({name:'search',q});};
  window.FamilyReturned=()=>{if(['home','continue','history','favorites'].includes(current.name))render();};
  window.FamilyBack=()=>{if(routes.length){current=routes.pop();render(true);}else if(current.name!=='home'){current={name:'home'};render();}else native.confirmExit();};
  function library(){try{return JSON.parse(native.library());}catch{return [];}}
  function open(route){routes.push({...current,scroll:main.scrollTop,focus:document.activeElement?.dataset?.path});current=route;render();}
  function card(item){const b=button('',()=>open({name:'item',item}),'card');b.dataset.path=item.path;const art=el('div',undefined,'art');const img=el('img');img.src=item.poster||'logo.svg';img.alt='';img.loading='lazy';img.onerror=()=>{img.onerror=null;img.src='logo.svg';};art.append(img);if(item.year)art.append(el('span',item.year,'badge'));const state=library().find(x=>x.path===item.path);if(state?.seconds>0&&state?.duration>0){const progress=el('progress');progress.className='resume';progress.max=state.duration;progress.value=state.seconds;art.append(progress);}b.append(art,el('strong',item.title),el('small',item.quality||item.original_title||''));return b;}
  function cards(items,row=false){const grid=el('div',undefined,row?'row':'grid');items.forEach(item=>grid.append(card(item)));return grid;}
  function section(title,items){if(!items.length)return;main.append(el('h2',title),cards(items,true));}
  function localList(kind){return library().filter(x=>kind==='favorites'?x.favorite:kind==='continue'?x.seconds>10&&(!x.duration||x.seconds<x.duration-30):(x.last_played||x.last_opened)).sort((a,b)=>(b.last_played||b.saved_at||0)-(a.last_played||a.saved_at||0));}
  async function render(restore=false){const mine=++generation;const route=current;main.replaceChildren(el('p','Загружаем…','status'));main.scrollTop=0;document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.route===route.name));
    try{
      if(route.name==='home'){
        const data=await api('/api/home');if(mine!==generation)return;main.replaceChildren();const hero=el('div',undefined,'intro');hero.append(el('span','ВЕЧЕР В ХОРОШЕЙ КОМПАНИИ','eyebrow'),el('h1','Ваш домашний кинозал'),el('p','Любимые истории. Тёплый свет. Всё для уютного вечера.'));main.append(hero);section('Продолжить просмотр',localList('continue'));data.sections.forEach(s=>section(s.title,s.items));if(data.warning)toast(data.warning);
      }else if(['continue','favorites','history'].includes(route.name)){
        main.replaceChildren(el('h1',labels[route.name]));const items=localList(route.name);main.append(items.length?cards(items):el('p',route.name==='favorites'?'Нажмите «В избранное» в карточке фильма.':'Здесь появятся фильмы после начала просмотра.','empty'));
      }else if(route.name==='settings'){
        main.replaceChildren(el('h1','Настройки'));const panel=el('div',undefined,'settings-panel');panel.append(el('h2','Домашнее кино'),el('p',native.version()),el('p','Каталог EX-FS. Избранное и история сохраняются на этом устройстве.'),button('Проверить обновление',()=>native.checkUpdate()),button('Логи / Диагностика',()=>native.diagnostics('Отчёт пользователя')),button('Скопировать лог',()=>native.copyLog()),button('Лицензии',()=>open({name:'licenses'})));main.append(panel);
      }else if(route.name==='licenses'){
        main.replaceChildren(el('h1','О приложении'),el('p','Android-основа: lampa-app/LAMPA. Логотип адаптирован из Lampa (GPL-2.0). Интерфейс «Домашнее кино» работает из файлов APK. Каталог и встроенные плееры предоставляет EX-FS. Исходные тексты и лицензия включены в APK.'));
      }else if(route.name==='item'){
        const data=await api('/api/item?path='+encodeURIComponent(route.item.path));if(mine!==generation)return;main.replaceChildren();const box=el('div',undefined,'detail'),poster=el('img');poster.src=data.poster;poster.alt='';const info=el('div');info.append(el('span',[data.year,data.quality,data.age].filter(Boolean).join(' · '),'eyebrow'),el('h1',data.title),el('p',data.original_title||''));const actions=el('div',undefined,'actions');const saved=library().find(x=>x.path===data.path)||{};const players=data.players.filter(p=>!(/трейлер/i.test(p.title)||/trailer/i.test(p.url)));const start=(index=0)=>{native.play(JSON.stringify({...data,players}),index);};if(players.length)actions.append(button(saved.seconds>10?'▶ Продолжить с '+Math.floor(saved.seconds/60)+' мин':'▶ Смотреть',()=>start(0),'primary'));const fav=button(saved.favorite?'♥ В избранном':'♡ В избранное',()=>{native.favorite(JSON.stringify(data));fav.textContent=library().find(x=>x.path===data.path)?.favorite?'♥ В избранном':'♡ В избранное';});actions.append(fav);info.append(actions);if(players.length>1){const choose=el('select');players.forEach((p,i)=>{const o=el('option',p.title);o.value=i;choose.append(o);});info.append(choose,button('Открыть выбранный плеер',()=>start(Number(choose.value))));}if(!players.length)info.append(el('p','На странице источника пока нет доступного плеера.'),button('Отправить диагностику',()=>native.diagnostics('Нет iframe: '+data.path)));box.append(poster,info,el('p',data.description,'description'));main.append(box);
      }else if(route.name==='search'){
        main.replaceChildren(el('h1','Поиск'));const form=el('form'),input=el('input');input.placeholder='Название фильма или сериала';input.type='search';input.value=route.q||'';input.setAttribute('aria-label','Название фильма');form.append(input,button('Найти',()=>{} ,'primary'),button('🎙 Голос',()=>native.voiceSearch()));form.lastChild.type='button';form.onsubmit=e=>{e.preventDefault();open({name:'search',q:input.value});};main.append(form);if(route.q){const data=await api('/api/search?q='+encodeURIComponent(route.q)+'&page='+(route.page||1));if(mine!==generation)return;main.append(data.items.length?cards(data.items):el('p','Ничего не найдено.','empty'));if(data.has_next)main.append(button('Следующая страница',()=>open({...route,page:(route.page||1)+1})));}else input.focus();
      }else{
        if(!filters)filters=await api('/api/filters');if(mine!==generation)return;main.replaceChildren(el('h1',labels[route.name]||'Каталог'));const bar=el('div',undefined,'filters');const select=el('select');select.setAttribute('aria-label','Жанр или год');const all=el('option','Все жанры и годы');all.value='';select.append(all);for(const type of ['genre','year']){const group=el('optgroup');group.label=type==='genre'?'Жанр':'Год';filters.filters.filter(f=>f.type===type).forEach(f=>{const o=el('option',f.title);o.value=f.path;group.append(o);});select.append(group);}select.value=route.filter||'';select.onchange=()=>open({...route,filter:select.value,page:1});bar.append(select);main.append(bar);const data=await api('/api/catalog?category='+route.name+'&page='+(route.page||1)+'&filter='+encodeURIComponent(route.filter||''));if(mine!==generation)return;main.append(cards(data.items));if(data.warning)toast(data.warning);if(data.has_next)main.append(button('Следующая страница',()=>open({...route,page:(route.page||1)+1})));}
      if(mine!==generation)return;
      requestAnimationFrame(()=>{if(restore){main.scrollTop=route.scroll||0;const target=Array.from(main.querySelectorAll('[data-path]')).find(e=>e.dataset.path===route.focus);if(target)target.focus({preventScroll:true});}else if(!main.querySelector('input:focus'))main.querySelector('button,select')?.focus({preventScroll:true});});
    }catch(e){if(mine!==generation)return;main.replaceChildren(el('h1','Не удалось загрузить'),el('p',e.message,'error'),button('Повторить',()=>render()),button('Логи / Диагностика',()=>native.diagnostics(e.message)));}
    finally{document.getElementById('splash')?.remove();}
  }
  // Spatial D-pad navigation leaves touch scrolling to WebView's native scroll containers.
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'||e.key==='BrowserBack'){e.preventDefault();window.FamilyBack();return;}
    const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!direction)return;
    if(document.activeElement?.matches('input,select'))return;
    const origin=document.activeElement?.getBoundingClientRect();if(!origin)return;
    const ox=origin.left+origin.width/2,oy=origin.top+origin.height/2;
    const candidates=Array.from(document.querySelectorAll('button,input,select')).filter(x=>x!==document.activeElement&&!x.disabled&&x.getClientRects().length).map(x=>{const r=x.getBoundingClientRect(),dx=r.left+r.width/2-ox,dy=r.top+r.height/2-oy;return{x,dx,dy,score:Math.abs(direction[0]?dx:dy)+Math.abs(direction[0]?dy:dx)*3};}).filter(c=>(direction[0]?c.dx*direction[0]:c.dy*direction[1])>4).sort((a,b)=>a.score-b.score);
    if(candidates.length){e.preventDefault();candidates[0].x.focus({preventScroll:true});candidates[0].x.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});}
  });
  menu.forEach(([key,title])=>{const b=button(title,()=>{routes.length=0;current={name:key};render();});b.dataset.route=key;document.getElementById('nav').append(b);});
  document.getElementById('back').onclick=window.FamilyBack;document.getElementById('settings').onclick=()=>open({name:'settings'});
  if(!native){main.replaceChildren(el('p','Этот интерфейс работает внутри приложения FamilyCinema.apk.'));document.getElementById('splash').remove();return;}
  document.getElementById('version').textContent=native.version();native.ready();render();
})();
