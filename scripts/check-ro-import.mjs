import assert from 'node:assert/strict';
import { parseRomanianPlaylist, categoryForRomanianChannel, getRomanianChannels } from '../iptv/ro-import.js';
const raw = '#EXTM3U\n'
 + '#EXTINF:-1 tvg-id="ProTV.ro@HD" tvg-logo="https://cdn.example/logo.png" group-title="General",PRO TV FHD (1080p)\n'
 + 'https://example.org/protv.m3u8\n'
 + '#EXTINF:-1 tvg-id="Sport.ro@HD",SPORT TV HD\n'
 + '#EXTVLCOPT:http-user-agent=Mozilla/5.0\n'
 + 'http://example.org/sport.m3u8\n'
 + '#EXTINF:-1,Cartoon Kids\n'
 + 'https://example.org/kids.m3u8\n'
 + '#EXTINF:-1,Documentare Nature\n'
 + 'https://example.org/nature.m3u8\n'
 + '#EXTINF:-1 tvg-id="News.ro@SD" http-user-agent="Mozilla/5.0 (KHTML, like Gecko) Chrome" group-title="News",Antena 3 CNN\n'
 + 'https://example.org/antena3.m3u8\n'
 + '#EXTINF:-1,Hack\n'
 + 'file:///etc/passwd\n';
const result=parseRomanianPlaylist(raw);
assert.equal(result.length,5);
assert.equal(result[0].tvgId,'ProTV.ro@HD');
assert.equal(result[0].group,'▪●★ Generale ★●▪');
assert.equal(result[1].group,'▪●★ Sport ★●▪');
assert.equal(result[2].group,'▪●★ Kids ★●▪');
assert.equal(result[3].group,'▪●★ Documentare ★●▪');
assert.equal(result[4].name,'Antena 3 CNN');
assert.equal(result[4].tvgId,'News.ro@SD');
assert.equal(categoryForRomanianChannel('TVR Cluj'),'▪●★ Regionale ★●▪');
assert.equal(categoryForRomanianChannel('Cinemaraton'),'▪●★ Filme ★●▪');
let called=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async () => {
  called++;
  return {ok:true,headers:new Headers(),text:async ()=>raw};
};
try {
  const fetched=await getRomanianChannels(true);
  assert.equal(fetched.channels.length,5);
  assert.equal(fetched.lastError,'');
  assert.equal((await getRomanianChannels(true)).channels.length,5);
  assert.equal(called,1,'30 minute cache should prevent duplicate fetch');
} finally {globalThis.fetch=originalFetch;}
console.log('IPTV-org Romanian M3U import tests passed');
