// Service worker: lets the installed app open offline.
//
// Network first: when online, every request goes to the server (revalidated, so a new
// deploy shows up on the next load) and the fresh copy is stored; when offline, or the
// network takes too long, the stored copy is used instead. Because of that, publishing
// changes to the app needs nothing extra here. Only bump CACHE_NAME when this file's
// own caching rules change, to clear out the old cache.
var CACHE_NAME = 'vocab-drill-v1';
var NETWORK_TIMEOUT_MS = 4000;

var APP_SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(APP_SHELL); }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

// Google Fonts are the only outside files the app uses; cache them too so text looks right offline.
function isCacheable(url){
  return url.origin === self.location.origin ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);
  if(!isCacheable(url)) return;

  // Every screen is the same page (the screen lives in the #address), so all page loads share one cache entry.
  var cacheKey = req.mode === 'navigate' ? './' : req;

  event.respondWith(caches.open(CACHE_NAME).then(function(cache){
    var fromNetwork = fetch(req, {cache:'no-cache'}).then(function(res){
      if(res && (res.ok || res.type === 'opaque')) cache.put(cacheKey, res.clone());
      return res;
    });
    fromNetwork.catch(function(){}); // a late failure after the cache already answered isn't an error
    var timeout = new Promise(function(resolve){ setTimeout(resolve, NETWORK_TIMEOUT_MS); });
    var fromCache = function(){ return cache.match(cacheKey, {ignoreSearch:true}); };

    return Promise.race([fromNetwork, timeout]).then(function(res){
      return res || fromCache().then(function(hit){ return hit || fromNetwork; });
    }).catch(function(){
      return fromCache().then(function(hit){ return hit || Response.error(); });
    });
  }));
});
