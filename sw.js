const CACHE='wa-v1';
const STATIC=['/index.html','/manifest.json','/libs/jszip.min.js','/libs/sql-asm.js','/wxzsm.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));

self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  
  // 缓存静态资源（HTML, JS, WASM等）
  if(url.origin===location.origin&&(url.pathname==='/'||url.pathname.endsWith('.html')||url.pathname.endsWith('.js')||url.pathname.endsWith('.wasm')||url.pathname.endsWith('.json'))){
    e.respondWith(caches.open(CACHE).then(cache=>cache.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{if(r.ok)cache.put(e.request,r.clone());return r;}))));
    return;
  }
  
  // 原有的图片缓存逻辑
  if(e.request.destination==='image'){
    e.respondWith(caches.open(CACHE).then(cache=>cache.match(e.request).then(hit=>{
      if(hit)return hit;
      return fetch(e.request).then(r=>{if(r.ok)cache.put(e.request,r.clone());return r;}).catch(()=>hit||new Response('',{status:404}));
    })));
  }
});