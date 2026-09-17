const CACHE='citanie-shell-v1';
const STATIC=['/','/manifest.webmanifest','/icon.svg'];
self.addEventListener('install',(event)=>{event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(STATIC)).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',(event)=>{event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==CACHE).map((key)=>caches.delete(key)))));self.clients.claim()});
self.addEventListener('fetch',(event)=>{
  if(event.request.method!=='GET')return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).then((response)=>{const copy=response.clone();caches.open(CACHE).then((cache)=>cache.put('/',copy));return response}).catch(()=>caches.match('/')));
    return;
  }
  const url=new URL(event.request.url);
  if(url.origin===self.location.origin&&STATIC.includes(url.pathname))event.respondWith(caches.match(event.request).then((cached)=>cached||fetch(event.request)));
});
self.addEventListener('push',(event)=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch{data={body:event.data?event.data.text():'Hay una actualización en CitaNIE.'}}
  const title=data.title||'CitaNIE Madrid';
  const options={body:data.body||'Hay una actualización en tu monitorización.',icon:'/icon.svg',badge:'/icon.svg',tag:data.tag||'citanie-alert',renotify:true,data:{url:data.url||'/'}};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',(event)=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||'/',self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then((clients)=>{
    for(const client of clients){if(client.url.startsWith(self.location.origin)){client.focus();if('navigate' in client)return client.navigate(target)}}
    return self.clients.openWindow(target);
  }));
});
