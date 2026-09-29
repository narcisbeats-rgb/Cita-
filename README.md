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
- TELNYX_PUBLIC_KEY (cheia publică Ed25519 de semnare a webhook-urilor, base64)
- TELNYX_FROM_NUMBER
- TELNYX_APP_NAME
- OPENAI_API_KEY
- OPENAI_REALTIME_MODEL = gpt-realtime-2.1-mini
- APP_PIN
- PUBLIC_BASE_URL

Cheile rămân doar în variabilele de mediu Render și nu sunt trimise în browser.

**Înainte de merge/deploy:** obține cheia publică de semnare Telnyx din Mission Control → Keys & Credentials → Public Key și seteaz-o drept `TELNYX_PUBLIC_KEY` în Render. Ambele endpoint-uri de webhook verifică semnătura Ed25519 a corpului JSON original și un timestamp în fereastra de 5 minute. Fără cheia publică, apelurile prin Telnyx sunt refuzate; interpretul față în față rămâne separat. Nu introduce cheia API sau PIN-ul în GitHub.
