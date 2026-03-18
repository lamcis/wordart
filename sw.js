const CACHE='wa-v1';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{
  if(e.request.destination==='image'){
    e.respondWith(caches.open(CACHE).then(cache=>cache.match(e.request).then(hit=>{
      if(hit)return hit;
      return fetch(e.request).then(r=>{if(r.ok)cache.put(e.request,r.clone());return r;}).catch(()=>hit||new Response('',{status:404}));
    })));
  }
});
