import crypto from 'node:crypto';
import path from 'node:path';

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
    const name = safeText(item.name), url = safeHttpsUrl(item.url);
    if (!name || !url) throw new Error('Canalul ' + (i+1) + ' are nume sau URL HTTPS invalid');
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
function privateHeaders(res) {
  res.set('Cache-Control','private, no-store, max-age=0');
  res.set('Referrer-Policy','no-referrer');
  res.set('X-Content-Type-Options','nosniff');
}

export function registerIptv(app, env = process.env) {
  const adminPassword = env.IPTV_ADMIN_PASSWORD || '';
  const playlistToken = env.IPTV_PLAYLIST_TOKEN || '';
  const configured = adminPassword.length >= 16 && playlistToken.length >= 24;

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
  app.get('/iptv/api/config',adminOnly,(req,res) => {
    try {
      const channels = playlistData(env);
      const base = safeHttpsUrl(env.PUBLIC_BASE_URL || '') || ('https://' + req.get('host') + '/');
      const url = new URL('/iptv/playlist.m3u',base);
      url.searchParams.set('token',playlistToken);
      res.json({ channels, playlistUrl:url.href });
    } catch(e) {res.status(422).json({error:e.message});}
  });
  app.get('/iptv/playlist.m3u',(req,res) => {
    privateHeaders(res);
    if (!configured) return res.status(503).send('IPTV neconfigurat');
    if (typeof req.query.token !== 'string' || !secureEqual(req.query.token,playlistToken)) {
      return res.status(403).send('Token incorect');
    }
    try {
      res.set('Content-Type','application/vnd.apple.mpegurl; charset=utf-8');
      res.send(makeM3u(playlistData(env)));
    } catch(e) {res.status(422).send(e.message);}
  });
}