// Narcis IPTV 2.0: bounded, metadata-only health checks on the existing web service.
// No video proxy, database, paid cron service, redirects or continuous stream downloads.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 8192;
const CHECK_INTERVAL_MS = 90_000;
const FRESH_MS = 6 * 60 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 10 * 60 * 1000;

export function isPublicIpv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a,b,c,d] = ip.split('.').map(Number);
  if ([a,b,c,d].some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function deduplicateChannels(channels) {
  const seen = new Set();
  return channels.filter(channel => {
    // Same playback URL means the same stream, regardless of spelling or tvg-id.
    // Different URLs for one station are deliberately retained as alternatives.
    const key = String(channel.url || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkResponse(code, contentType, bytes) {
  if (code === 401 || code === 403 || code === 451) return {state:'restricted', reason:'Acces restricționat (HTTP ' + code + ')'};
  if (code >= 300 && code < 400) return {state:'unknown', reason:'Redirecționare netestată (HTTP ' + code + ')'};
  if (code < 200 || code >= 400) return {state:'offline', reason:'HTTP ' + code};
  const type = contentType.toLowerCase();
  const prefix = bytes.toString('utf8',0,Math.min(bytes.length,256)).replace(/^\uFEFF/,'').trimStart();
  if (prefix.startsWith('#EXTM3U')) return {state:'live',reason:'Playlist HLS accesibil'};
  if (/^(video\/mp2t|audio\/aac|audio\/mpeg|video\/mp4)/.test(type) && bytes.length > 0)
    return {state:'live',reason:'Flux media accesibil'};
  if (bytes.length > 0 && bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47))
    return {state:'live',reason:'Flux MPEG-TS accesibil'};
  if (type.includes('text/html') || /^(<!doctype|<html\b)/i.test(prefix))
    return {state:'offline',reason:'Pagina HTML, nu flux IPTV'};
  return {state:'unknown',reason:'Răspuns neconcludent'};
}

export async function probeStream(url) {
  let parsed;
  try { parsed = new URL(url); } catch {return {state:'unknown',reason:'URL invalid'};}
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    return {state:'unknown',reason:'Protocol neacceptat'};
  const host = parsed.hostname;
  if (host.includes(':') || host.includes('[') || !host || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost')
    return {state:'unknown',reason:'Adresă nepermisă'};
  let address;
  try {
    if (net.isIP(host) === 4) address = host;
    else {
      const answers = await Promise.race([
        dns.lookup(host,{family:4,all:true}),
        new Promise((_,reject) => {
          const t = setTimeout(() => reject(Error('DNS timeout')),2500);
          t.unref?.();
        })
      ]);
      // Never contact a hostname resolving to any reserved address.
      if (!answers.length || answers.some(a => !isPublicIpv4(a.address))) throw Error('DNS privat sau indisponibil');
      address = answers[0].address;
    }
    if (!isPublicIpv4(address)) throw Error('Adresă IP privată sau rezervată');
  } catch(e) {return {state:'unknown',reason:'DNS/IP: ' + String(e.message).slice(0,72)};}

  return await new Promise(resolve => {
    let finished = false, req;
    const finish = result => {
      if (finished) return;
      finished = true;
      req?.destroy();
      resolve(result);
    };
    try {
      const transport = parsed.protocol === 'https:' ? https : http;
      req = transport.request(parsed,{
        method:'GET',agent:false,timeout:7000,
        lookup:(_host,_opts,cb) => cb(null,address,4),
        headers:{'Range':'bytes=0-8191','Accept':'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*;q=0.5','User-Agent':'NarcisIPTV-Health/2.0'}
      },res => {
        const code = res.statusCode || 0, type = String(res.headers['content-type'] || '');
        if (code < 200 || code >= 300) {
          finish(checkResponse(code,type,Buffer.alloc(0)));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data',chunk => {
          if (finished) return;
          const piece = chunk.subarray(0,Math.max(0,MAX_BYTES-size));
          if (piece.length) {chunks.push(piece); size += piece.length;}
          const buffer = Buffer.concat(chunks);
          if (buffer.subarray(0,8).toString().includes('#EXTM3U') || size >= MAX_BYTES || /^(video\/mp2t|audio\/aac|audio\/mpeg|video\/mp4)/i.test(type)) {
            finish(checkResponse(code,type,buffer));
          }
        });
        res.on('end',() => finish(checkResponse(code,type,Buffer.concat(chunks))));
        res.on('error',() => finish({state:'unknown',reason:'Eroare la citirea răspunsului'}));
      });
      req.on('timeout',()=>finish({state:'unknown',reason:'Timeout'}));
      req.on('error',e=>finish({state:'unknown',reason:'Conexiune: ' + String(e.code || e.message).slice(0,60)}));
      req.end();
    } catch(e) {finish({state:'unknown',reason:String(e.message).slice(0,80)});}
  });
}

export function createHealthMonitor({probe=probeStream,now=()=>Date.now()}={}) {
  const results = new Map();
  const queue = [];
  const queued = new Set();
  let running = false;
  let manualAt = 0;
  function schedule(channels) {
    for (const c of channels) {
      const url = String(c.url || '');
      if (!url || queued.has(url)) continue;
      const old = results.get(url);
      if (old && now() - old.checkedMs < FRESH_MS) continue;
      queue.push(url); queued.add(url);
    }
  }
  async function runBatch(limit=1) {
    if (running) return;
    running = true;
    try {
      for (let i=0;i<limit && queue.length;i++) {
        const url = queue.shift();
        queued.delete(url);
        let result;
        try {result = await probe(url);}
        catch(e) {result = {state:'unknown',reason:String(e.message).slice(0,75)};}
        results.set(url,{state:result.state,reason:result.reason,checkedMs:now(),checkedAt:new Date(now()).toISOString()});
      }
    } finally {running = false;}
  }
  function snapshot(channels) {
    const counts = {live:0,offline:0,restricted:0,unknown:0};
    const byUrl = [];
    for (const c of channels) {
      const result = results.get(c.url) || {state:'unknown',reason:'Neverificat',checkedAt:null};
      const state = Object.hasOwn(counts,result.state) ? result.state : 'unknown';
      counts[state]++;
      byUrl.push({url:c.url,state,reason:result.reason,checkedAt:result.checkedAt});
    }
    return {counts,channels:byUrl,queued:queue.length,running,intervalSeconds:CHECK_INTERVAL_MS/1000};
  }
  function requestScan(channels) {
    const time = now();
    if (manualAt && time - manualAt < MANUAL_COOLDOWN_MS) return {accepted:false,reason:'Poți cere o nouă verificare manuală după 10 minute.'};
    if (running) return {accepted:false,reason:'Verificarea automată este deja în curs.'};
    manualAt = time || 1;
    schedule(channels);
    void runBatch(8);
    return {accepted:true,reason:'Verificarea a maximum 8 surse a pornit în fundal.'};
  }
  function start(getChannels) {
    const timer = setInterval(async()=>{
      if (running) return;
      try {schedule(await getChannels());await runBatch(1);}
      catch(e) {console.error('IPTV health check:',e.message);}
    },CHECK_INTERVAL_MS);
    timer.unref?.();
    return timer;
  }
  return {schedule,runBatch,snapshot,requestScan,start};
}
