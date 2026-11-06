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
