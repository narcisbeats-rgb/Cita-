import assert from 'node:assert/strict';
import { playlistData, makeM3u, registerIptv } from '../iptv/router.js';

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


const routes = new Map();
const app={get(path,...handlers){routes.set(path,handlers);}};
const env={IPTV_ADMIN_PASSWORD:'A-strong-test-password-123',IPTV_PLAYLIST_TOKEN:'a-strong-test-token-12345678901234',PUBLIC_BASE_URL:'https://example.org/'};
registerIptv(app,env);
assert.equal(routes.size,3);
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
  IPTV_EXTRA_CHANNELS_JSON:JSON.stringify([{name:'Moldova TV',url:'https://moldovatv.ro/live-tv/live.m3u8',group:'Generale'}])
};
const routes2=new Map();
registerIptv({get(p,...handlers){routes2.set(p,handlers);}},extraEnv);
const extraPlaylist=routes2.get('/iptv/playlist.m3u')[0];
const extraResult=res();
await extraPlaylist({query:{token:extraEnv.IPTV_PLAYLIST_TOKEN}},extraResult);
assert.match(extraResult.body,/Original/);
assert.match(extraResult.body,/Moldova TV/);
const extraConfig=routes2.get('/iptv/api/config')[1];
const extraConfigResult=res();
await extraConfig({get:()=> 'example.org'},extraConfigResult);
assert.equal(extraConfigResult.body.addedChannels.length,1);
assert.equal(extraConfigResult.body.totalChannels,2);

const auth=routes.get('/iptv/api/config')[0];response=res();
auth({headers:{}},response,()=>{});assert.equal(response.code,401);
response=res();
auth({headers:{authorization:'Basic '+Buffer.from('narcis:'+env.IPTV_ADMIN_PASSWORD).toString('base64')}},response,()=>{response.code=200;});
assert.equal(response.code,200);
console.log('SmartOne IPTV route smoke tests passed');