import crypto from 'node:crypto';
import path from 'node:path';
import { createHealthMonitor, deduplicateChannels } from './health.js';
import { getRomanianChannels, ROMANIAN_PLAYLIST_URL } from './ro-import.js';

const DEMO_CHANNELS = [{
  name: 'TEST – Big Buck Bunny (nu este TV live)',
  url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  group: '00 • Test SmartOne'
}];

function safeText(value, max = 120) {
  return String(value ?? '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function safeStreamUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function secureEqual(a,b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x,y);
}
export function playlistData(env = process.env) {
  let raw = DEMO_CHANNELS;
  if (env.IPTV_CHANNELS_JSON) {
    try { raw = JSON.parse(env.IPTV_CHANNELS_JSON); }
    catch { throw new Error('IPTV_CHANNELS_JSON nu este JSON valid'); }
  }
  if (!Array.isArray(raw) || raw.length > 200) throw new Error('IPTV_CHANNELS_JSON trebuie sa fie o lista de maxim 200 canale');
  return raw.map((item,i) => {
    if (!item || typeof item !== 'object') throw new Error('Canalul ' + (i+1) + ' nu este un obiect');
    const name = safeText(item.name), url = safeStreamUrl(item.url);
    if (!name || !url) throw new Error('Canalul ' + (i+1) + ' are nume sau URL HTTP(S) invalid');
    return {
      name, url, group: safeText(item.group || 'Altele',100),
      tvgId: safeText(item.tvgId,100), logo: safeHttpsUrl(item.logo)
    };
  });
}
function attr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
export function makeM3u(channels) {
  return '#EXTM3U\n' + channels.map(c => '#EXTINF:-1 tvg-id="' + attr(c.tvgId) +
    '" tvg-logo="' + attr(c.logo) + '" group-title="' + attr(c.group) + '",' +
    c.name + '\n' + c.url + '\n').join('');
}
// SmartOne displays the playlist in order. Pin one best-quality entry for each
// requested channel, leaving every other stream and alternate in its old order.
export function pinFavoriteChannels(channels) {
  const patterns = [
    /^pro\s*tv(?:\s+(?:hd|fhd|uhd|4k))?$/,
    /^antena\s*1(?:\s+(?:hd|fhd|uhd|4k))?$/,
    /^antena\s*3(?:\s+cnn)?(?:\s+(?:hd|fhd|uhd|4k))?$/,
    /^digi\s*sport\s*1(?:\s+(?:hd|fhd|uhd|4k))?$/,
    /^digi\s*sport\s*2(?:\s+(?:hd|fhd|uhd|4k))?$/,
    /^digi\s*sport\s*3(?:\s+(?:hd|fhd|uhd|4k))?$/,
    /^kanal\s*d(?:\s+(?:hd|fhd|uhd|4k))?$/,
    /^romania\s*tv(?:\s+(?:hd|fhd|uhd|4k))?$/
  ];
  const rest = [...channels];
  const pinned = [];
  for (const pattern of patterns) {
    let best = -1, bestQuality = -1;
    for (let i = 0; i < rest.length; i++) {
      const name = String(rest[i].name || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/\s*\([^)]*\)/g, '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      if (!pattern.test(name)) continue;
      const quality = /(?:4k|uhd)(?:\b|$)/.test(name) ? 4
        : /\b(?:fhd|full hd)\b|\(1080p\)|\(1440p\)/i.test(rest[i].name) ? 3
        : /\bhd\b|\(1080i\)|\(720p\)/i.test(rest[i].name) ? 2
        : 1;
      if (quality > bestQuality) { best = i; bestQuality = quality; }
    }
    if (best !== -1) pinned.push(rest.splice(best, 1)[0]);
  }
  return pinned.concat(rest);
}

// Prefer higher resolution alternatives from the same TV channel ID in the public
// source. Never delete lower-quality variants: they remain as playback fallbacks.
// Do not reorder user-supplied/manual entries, which may require specific access.
export function preferHigherQualityVariants(channels) {
  const positionsById = new Map();
  channels.forEach((channel, i) => {
    const id = String(channel.tvgId || '').trim().toLowerCase().split('@')[0];
    if (!id) return;
    if (!positionsById.has(id)) positionsById.set(id, []);
    positionsById.get(id).push(i);
  });
  const result = [...channels];
  const score = (channel) => {
    const matched = String(channel.name || '').match(/\((\d{3,4})([pi])\)/i);
    if (!matched) return 0; // Ignore unproven 4K/FHD marketing labels.
    return Number(matched[1]) * 2 + (matched[2].toLowerCase() === 'p' ? 1 : 0);
  };
  for (const positions of positionsById.values()) {
    if (positions.length < 2) continue;
    const sorted = positions.map(i => channels[i]).sort((a,b) => score(b) - score(a));
    positions.forEach((position, j) => { result[position] = sorted[j]; });
  }
  return result;
}

function privateHeaders(res) {
  res.set('Cache-Control','private, no-store, max-age=0');
  res.set('Referrer-Policy','no-referrer');
  res.set('X-Content-Type-Options','nosniff');
}

export function registerIptv(app, env = process.env) {
  const adminPassword = env.IPTV_ADMIN_PASSWORD || '';
  const playlistToken = env.IPTV_PLAYLIST_TOKEN || '';
  const configured = adminPassword.length >= 16 && playlistToken.length >= 24;
  const importEnabled = env.IPTV_IMPORT_RO_PUBLIC === 'true';
  const healthMonitor = createHealthMonitor();
  if (importEnabled) getRomanianChannels(true).then(r =>
    console.log('IPTV Romania import:', r.channels.length, 'entries, source:', r.source || 'unavailable', r.lastError || '')
  ).catch(e => console.error('IPTV Romania import error:', e.message));

  async function combinedChannels() {
    const manual = playlistData(env);
    // Separate environment variable: never overwrite the user's existing custom playlist.
    const added = env.IPTV_EXTRA_CHANNELS_JSON
      ? playlistData({ IPTV_CHANNELS_JSON: env.IPTV_EXTRA_CHANNELS_JSON })
      : [];
    const extraRadio = env.IPTV_CARLO_CHANNELS_JSON
      ? playlistData({ IPTV_CHANNELS_JSON: env.IPTV_CARLO_CHANNELS_JSON })
      : [];
    const digiSportTest = env.IPTV_DIGISPORT_TEST_JSON
      ? playlistData({ IPTV_CHANNELS_JSON: env.IPTV_DIGISPORT_TEST_JSON })
      : [];
    const imported = await getRomanianChannels(importEnabled);
    const seen = new Set();
    const distinct = (items) => items.filter(c => {
      const key = c.tvgId
        ? 'id:' + c.tvgId.toLowerCase() + ':' + c.url
        : 'name:' + c.name.toLowerCase() + ':' + c.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const custom = distinct(manual.concat(added,extraRadio,digiSportTest));
    const importedDistinct = distinct(imported.channels);
    const extra = env.IPTV_PREFER_HIGHEST_RESOLUTION === 'true'
      ? preferHigherQualityVariants(importedDistinct)
      : importedDistinct;
    return { manual, added:added.concat(extraRadio,digiSportTest), imported, extra:deduplicateChannels(extra), all: pinFavoriteChannels(deduplicateChannels(custom.concat(extra))) };
  }

  function adminOnly(req,res,next) {
    privateHeaders(res);
    if (!configured) return res.status(503).send('IPTV neconfigurat: seteaza IPTV_ADMIN_PASSWORD (minim 16 caractere) si IPTV_PLAYLIST_TOKEN (minim 24 caractere) in Render Environment.');
    let supplied = '';
    try {
      const authorization = req.headers.authorization || '';
      if (authorization.startsWith('Basic ')) {
        const decoded = Buffer.from(authorization.slice(6),'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx >= 0 && decoded.slice(0,idx) === 'narcis') supplied = decoded.slice(idx+1);
      }
    } catch {}
    if (!secureEqual(supplied,adminPassword)) {
      res.set('WWW-Authenticate','Basic realm="Narcis IPTV", charset="UTF-8"');
      return res.status(401).send('Autentificare necesara');
    }
    next();
  }

  app.get('/iptv',adminOnly,(_req,res) => res.sendFile(path.resolve('iptv/dashboard.html')));
  app.get('/iptv/api/config',adminOnly,async (req,res) => {
    try {
      const { manual, added, imported, extra, all } = await combinedChannels();
      const base = safeHttpsUrl(env.PUBLIC_BASE_URL || '') || ('https://' + req.get('host') + '/');
      const url = new URL('/iptv/playlist.m3u',base);
      url.searchParams.set('token',playlistToken);
      // SET IPTV validates the classic Xtream-style get.php URL even for M3U links.
      // Reuse our existing private playlist token; no new credentials or service needed.
      const setIptvUrl = new URL('/get.php',base);
      setIptvUrl.searchParams.set('username','narcis');
      setIptvUrl.searchParams.set('password',playlistToken);
      setIptvUrl.searchParams.set('type','m3u_plus');
      setIptvUrl.searchParams.set('output','ts');
      res.json({ channels:manual, addedChannels:added, importedChannels:extra, totalChannels:all.length,
        importedSource:imported.source || ROMANIAN_PLAYLIST_URL,
        importError:imported.lastError, importedUpdatedAt:imported.refreshedAt,
        playlistUrl:url.href, setIptvUrl:setIptvUrl.href });
    } catch(e) {res.status(422).json({error:e.message});}
  });
  app.get('/iptv/api/health',adminOnly,async (req,res) => {
    try {
      const { all } = await combinedChannels();
      const scan = req.query.check === '1' ? healthMonitor.requestScan(all) : null;
      if (!scan) healthMonitor.schedule(all);
      res.json({...healthMonitor.snapshot(all),scan,totalChannels:all.length});
    } catch(e) {res.status(422).json({error:e.message});}
  });
  async function sendPlaylist(res) {
    try {
      res.set('Content-Type','application/vnd.apple.mpegurl; charset=utf-8');
      const { all } = await combinedChannels();
      res.send(makeM3u(all));
    } catch(e) {res.status(422).send(e.message);}
  }
  app.get('/iptv/playlist.m3u',async (req,res) => {
    privateHeaders(res);
    if (!configured) return res.status(503).send('IPTV neconfigurat');
    if (typeof req.query.token !== 'string' || !secureEqual(req.query.token,playlistToken)) {
      return res.status(403).send('Token incorect');
    }
    await sendPlaylist(res);
  });
  // SET IPTV expects /get.php?username=...&password=..., not a token-only M3U URL.
  // This is a playlist-format adapter, NOT a full Xtream Codes API.
  app.get('/get.php',async (req,res) => {
    privateHeaders(res);
    if (!configured) return res.status(503).send('IPTV neconfigurat');
    if (req.query.username !== 'narcis' || typeof req.query.password !== 'string'
        || !secureEqual(req.query.password,playlistToken)) {
      return res.status(403).send('Acces refuzat');
    }
    await sendPlaylist(res);
  });
  // Reuse the existing translator web-service process: one tiny probe every 90 seconds.
  // The timer is unref'd so it will not keep tests or shutdowns running.
  if (configured && env.IPTV_HEALTH_CHECKS !== 'false')
    healthMonitor.start(async () => (await combinedChannels()).all);
}