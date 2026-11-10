import assert from 'node:assert/strict';
import { playlistData, makeM3u, registerIptv, pinFavoriteChannels, preferHigherQualityVariants } from '../iptv/router.js';
import { isPublicIpv4, deduplicateChannels, createHealthMonitor, probeStream } from '../iptv/health.js';

const demo = playlistData({});
assert.equal(demo.length,1);
assert.match(makeM3u(demo),/^#EXTM3U\n/);
assert.match(makeM3u(demo),/test-streams.mux.dev/);
const channels=playlistData({IPTV_CHANNELS_JSON:JSON.stringify([{name:'TV Test',url:'https://example.org/live.m3u8',group:'RO'}])});
assert.equal(channels[0].name,'TV Test');
assert.match(makeM3u(channels),/group-title="RO"/);
assert.throws(()=>playlistData({IPTV_CHANNELS_JSON:'bad'}),/JSON valid/);
assert.throws(()=>playlistData({IPTV_CHANNELS_JSON:JSON.stringify([{name:'Bad',url:'file:///etc/passwd'}])}),/invalid/);
assert.equal(playlistData({IPTV_CHANNELS_JSON:JSON.stringify([{name:'Test HTTP',url:'http://example.org/stream.m3u8'}])})[0].url,
  'http://example.org/stream.m3u8');


// Favorites must be the first five entries, in the requested order.
// Preserve every entry, including HD alternatives and similarly named channels.
const favoriteFixture = [
  'TVR 1', 'PRO TV International', 'Kanal D2', 'Antena 1',
  'Romania TV (576p)', 'Kanal D (480p)', 'Antena 3 CNN (1080p)',
  'PRO TV HD (1080p)', 'Antena 1 HD (1440p)', 'TVR 2'
].map((name,i)=>({name,url:'https://example.org/channel-'+i+'.m3u8',group:'RO',tvgId:'id-'+i,logo:''}));
const pinned=pinFavoriteChannels(favoriteFixture);
assert.deepEqual(pinned.slice(0,5).map(c=>c.name),[
  'PRO TV HD (1080p)', 'Antena 1 HD (1440p)',
  'Antena 3 CNN (1080p)', 'Kanal D (480p)', 'Romania TV (576p)'
]);
assert.equal(pinned.length,favoriteFixture.length);
assert.equal(new Set(pinned.map(c=>c.url)).size,favoriteFixture.length);
assert.deepEqual(pinned.slice(5).map(c=>c.name),[
  'TVR 1', 'PRO TV International', 'Kanal D2', 'Antena 1', 'TVR 2'
]);
assert.deepEqual(pinFavoriteChannels([{name:'Altele',url:'https://example.org/test'}]).map(c=>c.name),['Altele']);


const requestedSix = [
  'TVR 1', 'Digi Sport 3 HD', 'PRO TV HD (1080p)', 'Antena 3 CNN (1080p)',
  'Digi Sport 2 HD', 'Kanal D', 'Antena 1 HD (1440p)', 'Digi Sport 1 HD', 'Romania TV'
].map((name,i)=>({name,url:'https://example.org/six-'+i+'.m3u8',group:'RO',tvgId:'six-'+i,logo:''}));
assert.deepEqual(pinFavoriteChannels(requestedSix).slice(0,6).map(c=>c.name),[
  'PRO TV HD (1080p)','Antena 1 HD (1440p)','Antena 3 CNN (1080p)',
  'Digi Sport 1 HD','Digi Sport 2 HD','Digi Sport 3 HD'
]);
// Do not fabricate absent Digi Sport channels or promote placeholder TEST names.
assert.equal(pinFavoriteChannels([{name:'Digi Sport 1 – TEST',url:'https://example.org/demo.m3u8'}]).length,1);

// Public source lists SD first for some channels (e.g. Super TV).
// Put higher resolution first but keep both alternatives, including their URLs.
const variants = [
  {name:'Super TV (576p)',tvgId:'SuperTV.ro@SD',url:'https://test.invalid/sd'},
  {name:'TVR 1 (1440p)',tvgId:'TVR1.ro@SD',url:'https://test.invalid/tvr'},
  {name:'Super TV (1080i) [Not 24/7]',tvgId:'SuperTV.ro@SD',url:'https://test.invalid/hd'},
  {name:'Super TV',tvgId:'SuperTV.ro@SD',url:'https://test.invalid/unknown'}
];
const qualityFirst = preferHigherQualityVariants(variants);
assert.deepEqual(qualityFirst.map(c=>c.name),[
  'Super TV (1080i) [Not 24/7]',
  'TVR 1 (1440p)',
  'Super TV (576p)',
  'Super TV'
]);
assert.equal(qualityFirst[0].url,'https://test.invalid/hd');
assert.equal(qualityFirst[2].url,'https://test.invalid/sd');
assert.deepEqual(variants.map(c=>c.name),[
  'Super TV (576p)','TVR 1 (1440p)',
  'Super TV (1080i) [Not 24/7]','Super TV'
]);

const routes = new Map();
const app={get(path,...handlers){routes.set(path,handlers);}};
const env={IPTV_ADMIN_PASSWORD:'A-strong-test-password-123',IPTV_PLAYLIST_TOKEN:'a-strong-test-token-12345678901234',PUBLIC_BASE_URL:'https://example.org/'};
registerIptv(app,env);
assert.equal(routes.size,8);
function res(){return {code:200,headers:{},body:'',set(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},send(v){this.body=v;return this;},json(v){this.body=v;return this;}};}
const getPlaylist=routes.get('/iptv/playlist.m3u')[0];
let response=res();
await getPlaylist({query:{token:'incorrect'}},response);
assert.equal(response.code,403);
response=res();await getPlaylist({query:{token:env.IPTV_PLAYLIST_TOKEN}},response);
assert.equal(response.code,200);assert.match(response.body,/^#EXTM3U/);
// Additional uploaded channels must appear alongside existing custom channels.
const extraEnv={...env,
  IPTV_CHANNELS_JSON:JSON.stringify([{name:'Original',url:'https://example.org/original.m3u8',group:'Generale'}]),
  IPTV_EXTRA_CHANNELS_JSON:JSON.stringify([{name:'Moldova TV',url:'https://moldovatv.ro/live-tv/live.m3u8',group:'Generale'}]),
  IPTV_CARLO_CHANNELS_JSON:JSON.stringify([{name:'Pro FM',url:'https://example.org/radio.mp3',group:'Muzica'}]),
  IPTV_DIGISPORT_TEST_JSON:JSON.stringify([{name:'Digi Sport 1 – TEST',url:'https://example.org/digisport1.m3u8',group:'▪●★ Sport – TEST ★●▪'}])
};
const routes2=new Map();
registerIptv({get(p,...handlers){routes2.set(p,handlers);}},extraEnv);
const extraPlaylist=routes2.get('/iptv/playlist.m3u')[0];
const extraResult=res();
await extraPlaylist({query:{token:extraEnv.IPTV_PLAYLIST_TOKEN}},extraResult);
assert.match(extraResult.body,/Original/);
assert.match(extraResult.body,/Moldova TV/);
assert.match(extraResult.body,/Pro FM/);
assert.match(extraResult.body,/Digi Sport 1/);
assert.match(extraResult.body,/Sport – TEST/);
const extraConfig=routes2.get('/iptv/api/config')[1];
const extraConfigResult=res();
await extraConfig({get:()=> 'example.org'},extraConfigResult);
assert.equal(extraConfigResult.body.addedChannels.length,3);
assert.equal(extraConfigResult.body.totalChannels,7);

const auth=routes.get('/iptv/api/config')[0];response=res();
auth({headers:{}},response,()=>{});assert.equal(response.code,401);
response=res();
auth({headers:{authorization:'Basic '+Buffer.from('narcis:'+env.IPTV_ADMIN_PASSWORD).toString('base64')}},response,()=>{response.code=200;});
assert.equal(response.code,200);
// 100 individual logins must be deterministic, distinct, and usable through Xtream and M3U.
const accountHandler=routes.get('/iptv/api/account')[1];
const account1=res();
accountHandler({query:{slot:'1'},get:()=> 'example.org'},account1);
assert.equal(account1.body.username,'narcis001');
assert.equal(account1.body.enabled,true);
assert.equal(account1.body.password.length,24);
const account2=res();
accountHandler({query:{slot:'100'},get:()=> 'example.org'},account2);
assert.equal(account2.body.username,'narcis100');
assert.notEqual(account2.body.password,account1.body.password);
let badSlot=res();
accountHandler({query:{slot:'101'},get:()=> 'example.org'},badSlot);
assert.equal(badSlot.code,400);
const xtreamHandler=routes.get('/player_api.php')[0];
let userLogin=res();
await xtreamHandler({query:{username:account1.body.username,password:account1.body.password},get:()=> 'example.org'},userLogin);
assert.equal(userLogin.body.user_info.auth,1);
assert.equal(userLogin.body.user_info.username,'narcis001');
let wrongLogin=res();
await xtreamHandler({query:{username:account1.body.username,password:account2.body.password},get:()=> 'example.org'},wrongLogin);
assert.equal(wrongLogin.code,401);
let legacyLogin=res();
await xtreamHandler({query:{username:'narcis',password:env.IPTV_PLAYLIST_TOKEN},get:()=> 'example.org'},legacyLogin);
assert.equal(legacyLogin.body.user_info.auth,1);
let accountPlaylist=res();
await routes.get('/get.php')[0]({query:{username:account1.body.username,password:account1.body.password}},accountPlaylist);
assert.equal(accountPlaylist.code,200);
assert.match(accountPlaylist.body,/^#EXTM3U/);
const disabledRoutes=new Map();
registerIptv({get(p,...handlers){disabledRoutes.set(p,handlers);}},{...env,IPTV_DISABLED_USERS:'1, 50'});
const disabledAccount=res();
disabledRoutes.get('/iptv/api/account')[1]({query:{slot:'1'},get:()=> 'example.org'},disabledAccount);
assert.equal(disabledAccount.body.enabled,false);
const disabledLogin=res();
await disabledRoutes.get('/player_api.php')[0]({query:{username:account1.body.username,password:account1.body.password}},disabledLogin);
assert.equal(disabledLogin.code,401);
console.log('100 stateless Xtream accounts, legacy login and disabling smoke tests passed');
console.log('SmartOne IPTV route smoke tests passed');

// IPTV 2.0: dedup preserves backup streams but removes exact playback-URL copies.
const duplicates = deduplicateChannels([
  {name:'TVR A',url:'https://example.org/same.m3u8'},
  {name:'TVR A HD',url:'https://example.org/backup.m3u8'},
  {name:'TVR copied',url:'https://example.org/same.m3u8'}
]);
assert.deepEqual(duplicates.map(c=>c.name),['TVR A','TVR A HD']);
for (const ip of ['127.0.0.1','10.1.2.3','172.16.0.4','192.168.1.1','169.254.169.254','100.64.1.1','203.0.113.7'])
  assert.equal(isPublicIpv4(ip),false,ip);
assert.equal(isPublicIpv4('8.8.8.8'),true);
assert.equal((await probeStream('http://127.0.0.1/internal')).state,'unknown');
assert.equal((await probeStream('http://localhost/')).state,'unknown');
const monitor=createHealthMonitor({probe:async url=>({state:url.endsWith('ok')?'live':'offline',reason:'Test'})});
const mockChannels=[{url:'https://example.org/ok'},{url:'https://example.org/bad'}];
monitor.schedule(mockChannels);
assert.equal(monitor.snapshot(mockChannels).counts.unknown,2);
await monitor.runBatch(2);
assert.deepEqual(monitor.snapshot(mockChannels).counts,{live:1,offline:1,restricted:0,unknown:0});
assert.equal(monitor.requestScan(mockChannels).accepted,true);
assert.equal(monitor.requestScan(mockChannels).accepted,false);
assert.equal(routes.get('/iptv/api/health').length,2);
console.log('IPTV 2.0 health, URL dedup and safety smoke tests passed');
