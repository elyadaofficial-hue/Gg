'use strict';
const VERSION='v12.0.0-a1';
const SHELL='life-dash-shell-'+VERSION, FONTS='life-dash-fonts-v1';
const ASSETS=['./','./index.html','./coach.js','./manifest.json','./icon-180.png','./icon-192.png','./icon-512.png','./icon-maskable-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(SHELL).then(c=>c.addAll(ASSETS)));}); // no auto skipWaiting: the page asks the user
self.addEventListener('activate',e=>{e.waitUntil((async()=>{
  const keep=[SHELL,FONTS];
  for(const k of await caches.keys())if(k.indexOf('life-dash')===0&&keep.indexOf(k)<0)await caches.delete(k);
  await self.clients.claim();})());});
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING')self.skipWaiting();});
async function networkFirst(req,fallbackKey){
  const cache=await caches.open(SHELL);
  try{const res=await Promise.race([fetch(req),new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),4000))]);
    if(res&&res.ok)cache.put(req,res.clone());return res;}
  catch(err){return (await cache.match(req))||(await cache.match(fallbackKey))||Response.error();}
}
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin&&url.pathname.indexOf('/api/')===0)return; // push API: always network, never cached
  if(url.origin===location.origin){
    if(req.mode==='navigate'){e.respondWith(networkFirst(req,'./index.html'));return;}
    if(/\/coach\.js$/.test(url.pathname)){e.respondWith(networkFirst(req,'./coach.js'));return;} // always the freshest Coach code
    e.respondWith(caches.match(req).then(hit=>hit||networkFirst(req,'./index.html')));return;
  }
  if(url.hostname==='fonts.googleapis.com'||url.hostname==='fonts.gstatic.com'){
    e.respondWith(caches.open(FONTS).then(async c=>{const hit=await c.match(req);
      const net=fetch(req).then(r=>{if(r&&(r.ok||r.type==='opaque'))c.put(req,r.clone());return r;}).catch(()=>hit);
      return hit||net;}));
  } // everything else (Google Calendar API, accounts.google.com, etc.) goes straight to the network, never cached
});

/* ===== v10.1: Evening Reset push ===== */
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch(err){}
  const title=d.title||'Evening Reset 🌙', body=d.body||'עדיין גולל? בוא נעשה את הערב קל יותר.';
  e.waitUntil(self.registration.showNotification(title,{
    body,icon:'icon-192.png',badge:'icon-192.png',tag:d.tag||'evening-reset',renotify:true, // same tag: the repeat replaces the first, never stacks
    silent:false,vibrate:[200,100,200,100,300],lang:'he',dir:'rtl',
    data:{url:d.url||'./index.html?reset=1&src=push',kind:d.kind||'first'}}));
});
self.addEventListener('notificationclick',e=>{
  const n=e.notification,data=n.data||{};n.close();
  const target=new URL(data.url||'./index.html?reset=1&src=push',self.registration.scope).href;
  e.waitUntil((async()=>{
    // tapping = interaction: cancel the pending repeat (best effort; the page also does it)
    if(data.kind!=='test'&&data.kind!=='reminder'){try{const sub=await self.registration.pushManager.getSubscription();
      if(sub)await fetch('/api/push/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});}catch(err){}}
    const all=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of all){if(c.url.indexOf(self.registration.scope)===0){await c.focus();if(data.kind!=='reminder')c.postMessage({type:'open-reset'});return;}}
    await clients.openWindow(target);
  })());
});
