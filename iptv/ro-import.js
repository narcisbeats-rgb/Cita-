// Public community list. Keep streams direct-to-player: never proxy the video.
export const ROMANIAN_PLAYLIST_URL = 'https://iptv-org.github.io/iptv/countries/ro.m3u';
const BACKUP_URL = 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ro.m3u';
const TTL_MS = 30 * 60 * 1000;
let snapshot = { channels: [], refreshedAt: null, lastError: '', source: '' };
let expiresAt = 0;
let pending = null;

const CATEGORIES = {
  general: '▪●★ Generale ★●▪',
  film: '▪●★ Filme ★●▪',
  documentary: '▪●★ Documentare ★●▪',
  sport: '▪●★ Sport ★●▪',
  music: '▪●★ Muzica ★●▪',
  kids: '▪●★ Kids ★●▪',
  regional: '▪●★ Regionale ★●▪'
};

function clean(value, max = 140) {
  return String(value || '').replace(/[\r\n\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
function allowedUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function attribute(line, name) {
  const match = line.match(new RegExp('(?:^|\\s)' + name.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + '="([^"]*)"','i'));
  return match ? match[1] : '';
}

export function categoryForRomanianChannel(name, originalGroup = '') {
  const s = (String(name) + ' ' + String(originalGroup)).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if (/(sport|arena|fotbal|football|racing|tennis|eurosport|sportiv)/.test(s)) return CATEGORIES.sport;
  if (/(cartoon|kids|copii|junior|baby|minimax|nickelodeon|disney|ducktv|boomerang)/.test(s)) return CATEGORIES.kids;
  if (/(documentar|discovery|history|historia|explor|nature|animal planet|nat geo|national geographic|viasat)/.test(s)) return CATEGORIES.documentary;
  if (/(muzic|music|radio|mtv|utv|hit ?tv|atomic|kiss|rock|folclor)/.test(s)) return CATEGORIES.music;
  if (/(film|cinema|cine|movie|bollywood|hbo|comedy central|filmbox|cinemaraton|axn)/.test(s)) return CATEGORIES.film;
  if (/(regional|local|judet|targu.mures|targu mures|cluj|iasi|craiova|timisoara|bucovina|banat|bihor|arges|suceava|constanta|brasov|moldova)/.test(s)) return CATEGORIES.regional;
  return CATEGORIES.general;
}

export function parseRomanianPlaylist(text) {
  const rows = String(text).split(/\r?\n/);
  const output = [];
  let current = null;
  for (const raw of rows) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      if (comma < 0) { current = null; continue; }
      current = {
        name: clean(line.slice(comma+1)),
        tvgId: clean(attribute(line.slice(0,comma), 'tvg-id'), 100),
        logo: allowedUrl(attribute(line.slice(0,comma), 'tvg-logo')),
        originalGroup: clean(attribute(line.slice(0,comma), 'group-title'), 100)
      };
    } else if (current && (line.startsWith('https://') || line.startsWith('http://'))) {
      const url = allowedUrl(line);
      if (url && current.name) {
        output.push({
          name: current.name,
          url,
          tvgId: current.tvgId,
          logo: current.logo,
          group: categoryForRomanianChannel(current.name,current.originalGroup),
          source: 'iptv-org'
        });
      }
      current = null;
      if (output.length >= 2000) break;
    }
  }
  const seen = new Set();
  return output.filter(c => {
    const key = c.name.toLowerCase() + '\x00' + c.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'text/plain,application/vnd.apple.mpegurl,*/*;q=0.5', 'User-Agent': 'NarcisIPTV-PersonalPlaylist/1.0' }, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (Number(res.headers.get('content-length') || 0) > 2_000_000) throw new Error('Playlist prea mare');
    const body = await res.text();
    if (body.length > 2_000_000 || !body.startsWith('#EXTM3U')) throw new Error('Playlist M3U invalid');
    const channels = parseRomanianPlaylist(body);
    if (channels.length === 0) throw new Error('Playlist gol');
    return channels;
  } finally { clearTimeout(timer); }
}

export async function getRomanianChannels(enabled = false) {
  if (!enabled) return {channels:[], refreshedAt:null, lastError:'', source:''};
  if (pending) return pending;
  if (expiresAt > Date.now()) return snapshot;
  pending = (async () => {
    for (const url of [ROMANIAN_PLAYLIST_URL, BACKUP_URL]) {
      try {
        const channels = await download(url);
        snapshot = { channels, refreshedAt:new Date().toISOString(), lastError:'', source:url };
        expiresAt = Date.now() + TTL_MS;
        return snapshot;
      } catch (e) {
        snapshot.lastError = 'Nu se poate actualiza lista sursa: ' + String(e.message || e).slice(0,130);
      }
    }
    // Keep the last successful list if the upstream stops answering.
    expiresAt = Date.now() + 90_000;
    return snapshot;
  })();
  try { return await pending; }
  finally { pending = null; }
}
