// Program cache only. Never deletes IndexedDB or user data.
const CACHE='mswdb-v1.0.11-updatefix-20261010';
const ASSETS=['./index.html','./styles.css','./app.js','./manifest.webmanifest','./icon.svg','./icon-apple.svg','./icon-192.png','./icon-512.png'];
const APP_FILES=new Set(['','index.html','styles.css','app.js','manifest.webmanifest','icon.svg','icon-apple.svg','icon-192.png','icon-512.png']);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(path=>new Request(path,{cache:'reload'})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(key=>key.startsWith('mswdb-')&&key!==CACHE).map(key=>caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  const scope=new URL(self.registration.scope);
  if(!url.pathname.startsWith(scope.pathname))return;
  const relative=url.pathname.slice(scope.pathname.length);
  if(!APP_FILES.has(relative))return;
  // Prefer deployed code on every online launch; use offline cache only when offline.
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{
      const response=await fetch(new Request(request,{cache:'no-store'}));
      if(response.ok)await cache.put(request,response.clone());
      return response;
    }catch(error){
      const saved=await cache.match(request,{ignoreSearch:true});
      if(saved)return saved;
      if(request.mode==='navigate'){
        const shell=await cache.match('./index.html',{ignoreSearch:true});
        if(shell)return shell;
      }
      throw error;
    }
  })());
});
