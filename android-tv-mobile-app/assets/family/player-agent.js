(() => {
  'use strict';
  if(window.__familyAgent)return;window.__familyAgent=true;
  const restore=window.familyRestore||{},parentOrigin=(()=>{try{return new URL(document.referrer).origin;}catch{return '';}})();
  let stopped=false,started=false,tries=0,restored=false,selectionRestored=false,season=String(restore.season||''),episode=String(restore.episode||'');
  const post=data=>{try{window.FamilyMedia?.postMessage(JSON.stringify(data));}catch{}};
  let provider,lastSelection='',resumeNotBefore=0;
  const priorListen=window.listen;
  window.listen=function(player){if(player&&player.videoElement){provider=player;if(typeof player.on==='function')player.on('playlistItem',item=>{if(Date.now()>=resumeNotBefore)restored=true;post({type:'selection',season:String(item.season??''),episode:String(item.episode??''),episode_id:String(item.id??'')});});}if(typeof priorListen==='function')priorListen(player);};
  const venom=()=>provider||(window.app?.videoElement?window.app:null);
  function api(){for(const name of ['player','playerjs','pjs','app',...Object.keys(window).slice(-100)]){try{const d=Object.getOwnPropertyDescriptor(window,name);if(d?.value&&typeof d.value.api==='function')return d.value;}catch{}}}
  function video(){const all=Array.from(document.querySelectorAll('video'));return all.find(v=>v.currentSrc&&!v.error)||all[0];}
  function selection(){let s=season,e=episode;const current=venom()?.config?.playlist?.current;if(current)return {season:String(current.season??''),episode:String(current.episode??''),episode_id:String(current.id??'')};document.querySelectorAll('select').forEach(select=>{const key=[select.name,select.id,select.className,select.getAttribute('data-type')].join(' ');if(/season|сезон/i.test(key))s=select.value;if(/episode|серия|серии/i.test(key))e=select.value;});return {season:s,episode:e};}
  function restoreSelection(){if(selectionRestored)return;let found=false;document.querySelectorAll('select').forEach(select=>{const key=[select.name,select.id,select.className,select.getAttribute('data-type')].join(' ');const value=/season|сезон/i.test(key)?season:/episode|серия|серии/i.test(key)?episode:'';if(value&&Array.from(select.options).some(o=>o.value===value)){select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));found=true;}});if(found)selectionRestored=true;}
  function run(action){
    const v=video(),p=api();let command=action==='toggle'?(v?v.paused?'play':'pause':stopped?'play':'pause'):action;
    if(action==='left'||action==='right'){const time=Number(p?.api('time'))||v?.currentTime||0,next=Math.max(0,Math.min(v?.duration||Infinity,time+(action==='left'?-10:10)));if(p)p.api('seek',next);else if(v)v.currentTime=next;}
    else{stopped=command==='pause';if(p)p.api(command);const vp=venom();if(vp&&typeof vp[command]==='function')vp[command]();if(v){if(command==='play')v.play()?.catch(()=>{});else if(command==='pause')v.pause();}}
    if(command==='play'&&!p&&(!v||!v.currentSrc))document.querySelector('.vjs-big-play-button,.jw-icon-playback,.plyr__control--overlaid,button[aria-label="Play"],button[aria-label="Воспроизвести"]')?.click();
    document.querySelectorAll('iframe').forEach(frame=>frame.contentWindow?.postMessage({familyCommand:action},'*'));
  }
  window.familyCommand=run;
  window.addEventListener('message',event=>{if(event.source!==window.parent||!parentOrigin||event.origin!==parentOrigin)return;const action=event.data?.familyCommand;if(['play','pause','toggle','left','right'].includes(action))run(action);});
  document.addEventListener('change',event=>{if(!event.isTrusted)return;const next=selection();if(next.season!==season||next.episode!==episode){season=next.season;episode=next.episode;restored=true;post({type:'selection',season,episode});}},true);
  function tick(){
    const v=video(),p=api();let time=v?.currentTime||0,duration=v?.duration||0,paused=v?.paused??stopped;
    try{if(!v&&p){time=Number(p.api('time'))||0;duration=Number(p.api('duration'))||0;}}catch{}
    const vp=venom(),selected=selection();
    if(!selectionRestored&&restore.episode_id&&vp?.config?.playlist&&typeof vp.changeEpisode==='function'){
      selectionRestored=true;
      if(String(vp.config.playlist.current?.id)!==String(restore.episode_id)){const numeric=x=>/^\d+$/.test(String(x))?Number(x):x;resumeNotBefore=Date.now()+3000;vp.changeEpisode({id:numeric(restore.episode_id),season:numeric(restore.season),episode:numeric(restore.episode)});}
    }else restoreSelection();
    const identity=JSON.stringify(selected);if(lastSelection&&identity!==lastSelection){post({type:'selection',...selected});if(restored)restore.seconds=0;}lastSelection=identity;
    if(!restored&&Date.now()>=resumeNotBefore&&Number(restore.seconds)>10&&(v?.readyState>=1||duration>0)){try{const target=Math.min(Number(restore.seconds),Number.isFinite(duration)&&duration>0?Math.max(0,duration-5):Number(restore.seconds));if(p)p.api('seek',target);if(v)v.currentTime=target;restored=true;}catch{}}
    if(v?.error)post({type:'error',code:v.error.code});
    if((v&&v.readyState>=2)||(!v&&duration>0)){post({type:'media',seconds:time,duration:Number.isFinite(duration)?duration:0,paused,...selection()});}
    if(v&&!v.paused&&v.readyState>=2)started=true;
    if(!started&&!stopped&&++tries<18&&(!v||v.paused)){try{run('play');}catch{}}
  }
  setInterval(tick,1500);if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',tick,{once:true});else tick();
})();
