# Narcis IPTV pentru SmartOne (în același serviciu Cita-)

Panou: `https://cita-fd42.onrender.com/iptv` (Basic auth, user `narcis`).
Playlist: afișat în panou; folosește-l în SmartOne la tabul **M3u Playlist**, nu Xtream.

## Render Environment

- `IPTV_ADMIN_PASSWORD`: parolă nouă și separată, cel puțin 16 caractere.
- `IPTV_PLAYLIST_TOKEN`: token nou separat, cel puțin 24 caractere.
- `IPTV_CHANNELS_JSON` (opțional): listă JSON de canale cu câmpuri `name`, `url` (HTTPS), `group`, `tvgId`, `logo` (HTTPS opțional).

Exemplu: `[{"name":"Canal propriu autorizat","url":"https://example.org/stream.m3u8","group":"România"}]`

Fără `IPTV_CHANNELS_JSON`, playlistul conține doar un clip HLS de test (Big Buck Bunny). Nu este post TV.

**Important:** Render găzduiește doar metadatele playlistului; SmartOne accesează direct streamul video. Nu este inclusă o bază de date, iar editorul din panou generează configurația JSON pe care trebuie să o salvezi în Render. Evită surse nelicențiate, DRM, geoblocking bypass, fluxuri extrase din pagini TV care nu permit folosirea lor într-un player extern.

Test local: `node scripts/check-iptv.mjs`.

## Narcis IPTV 2.0 — monitorizare, status și deduplicare

Totul rulează în **același** Render web service cu aplicația de traducere.
Nu se creează al doilea serviciu, bază de date, disk sau Render Cron Job.
Nu sunt necesare dependințe npm noi și nu se retransmite video.

- GET /iptv/api/health — sub aceeași autentificare Basic ca panoul; returnează
  stările per URL și totalurile LIVE, OFFLINE, RESTRICȚIONAT, NEVERIFICAT.
- GET /iptv/api/health?check=1 — pornește verificarea a maximum 8 URL-uri
  în fundal; maximum o comandă manuală la 10 minute.
- Verificarea automată: maximum 1 URL la 90 de secunde; un rezultat se
  refolosește 6 ore. Fiecare verificare citește cel mult 8 KiB și nu urmărește
  redirecționări; conexiunile au timeout de 7 secunde.
- DNS se rezolvă spre IPv4 public și conexiunea utilizează numai IP-ul verificat;
  adresele private, loopback, rezervate și IPv6 sunt refuzate.
- LIVE înseamnă doar că manifestul sau primii octeți media au fost accesibili
  din Render: **nu** dovedește drepturi de vizionare, redare reală în SmartOne sau
  disponibilitatea în alte țări. HTTP 401, 403 și 451 sunt RESTRICȚIONAT.
- Dublurile cu *același URL* se elimină din playlistul M3U final. Alternativele
  de același canal cu URL-uri diferite se păstrează.
- Statusurile sunt în memoria procesului (se resetează la fiecare deploy);
  linkul SmartOne și variabilele de mediu existente rămân neschimbate.
- IPTV_HEALTH_CHECKS=false oprește verificarea periodică, dar administratorul
  poate cere verificări manuale din panou.

### Costuri

Această schimbare nu adaugă servicii cu abonament. Totuși, verificările trimit
trafic de ieșire limitat, iar Render poate factura depășirea cotelor de bandwidth
sau build minutes. Verifică Render Dashboard → Billing și Metrics.
