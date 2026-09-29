# Traducere Live RO/ES ↔ DA

Aplicație mobilă pentru apeluri telefonice traduse în timp real prin Telnyx + OpenAI Realtime.

## Funcții
- Română ↔ daneză și spaniolă ↔ daneză
- conversație hands-free, fără push-to-talk
- detectare automată a vorbirii și întreruperi naturale
- voce selectabilă (Cedar implicit)
- test de voce înainte de apel
- transcriere live: original + traducere pentru ambii participanți
- repetarea ultimei replici traduse
- stare live: ascultă / traduce / redă
- durată și cost estimat în timpul apelului
- fără înregistrarea apelurilor

## Stack
- Telnyx Voice API + bidirectional Media Streaming
- OpenAI Realtime `gpt-realtime-2.1-mini`
- `gpt-live-transcribe` pentru transcrieri
- `gpt-4o-mini-tts` pentru preview voce
- Node.js + WebSocket + Render

## Environment
- TELNYX_API_KEY
- TELNYX_FROM_NUMBER (folosit numai de agentul privat; nu este identitatea apelurilor publice)
- TELNYX_APP_NAME
- OPENAI_API_KEY
- OPENAI_REALTIME_MODEL = gpt-realtime-2.1-mini
- APP_PIN
- PUBLIC_BASE_URL

Cheile rămân doar în variabilele de mediu Render și nu sunt trimise în browser.

## Apeluri beta cu numărul propriu al utilizatorului
Acest flux este în dezvoltare într-un branch separat; **nu activa înainte de testele de mai jos și de securizarea webhook-urilor**.
- `PUBLIC_CALLER_ACCOUNTS_ENABLED=true` numai după validarea telefoniei, protecțiilor de cost și a webhook-urilor Telnyx. Implicit este dezactivat și fără configurația completă backend-ul refuză apelurile traduse. Modul interpret față în față rămâne independent.
- `DATABASE_URL`: PostgreSQL persistent (nu stocare locală volatilă Render). Nu crea resurse plătite fără aprobare.
- `SESSION_SECRET`: aleator, minimum 32 caractere. Nu pune cheia în repo.
- `SIGNUP_INVITE_CODE`: aleator, minimum 24 caractere, pentru înscrieri beta; nu este o cheie publică.
- `/account.html`: înscriere cu invitație, autentificare în cookie HttpOnly Secure SameSite=Strict, solicitare de verificare număr cu consimțământ explicit, confirmare prin cod și verificare status.
- `POST /api/call`: cere sesiune autentificată și număr verificat în baza de date **și** prin `GET /v2/verified_numbers/{phone}` înainte de fiecare apel. Respinge câmpul `from` trimis de client și nu folosește `TELNYX_FROM_NUMBER` drept fallback.
- Verificarea cu SMS/apel poate costa bani. Metoda este pornită numai după confirmarea explicită a utilizatorului. Nu garantează afișarea identității pe fiecare rețea; rutele daneze și numerele aprobate trebuie testate cu Telnyx.
- Teste automate: `node scripts/check-own-number.mjs` și `node scripts/integration-own-number-call.mjs` cu PostgreSQL și furnizor simulat, fără consum real Telnyx.
- Limitări actuale beta: înregistrare numai cu invitație; lipsesc resetarea parolei, recuperarea contului, rate-limit partajat între instanțe, billing per user și validarea efectivă pe operatori. Acestea blochează lansarea publică.
- **Dependință:** PR #8 (semnături webhook Telnyx) trebuie configurat și integrat înainte de a permite apeluri reale pentru utilizatori publici.

