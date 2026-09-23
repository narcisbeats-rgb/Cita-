# Live Romanian ↔ Danish phone translator

This repository runs a live Romanian ↔ Danish phone translator using Plivo + OpenAI Realtime.

## Flow
1. Enter a phone number and your private app PIN.
2. Plivo starts the outbound call.
3. The called person hears one short Danish disclosure that automatic translation is being used.
4. Hold the push-to-talk button and speak Romanian.
5. OpenAI Realtime translates Romanian speech into Danish audio for the call.
6. Danish speech from the other person is translated into Romanian audio in your browser.

## Plivo
- Bidirectional audio streaming uses mu-law 8 kHz.
- Your personal Danish number can be configured as PLIVO_FROM_NUMBER after verification.
- Caller-ID verification endpoints are built into the backend:
  - POST /api/verify-caller/start
  - POST /api/verify-caller/complete

## Render environment variables
- OPENAI_API_KEY
- OPENAI_REALTIME_MODEL (default: gpt-realtime-translate)
- PLIVO_AUTH_ID
- PLIVO_AUTH_TOKEN
- PLIVO_FROM_NUMBER
- APP_PIN
- PUBLIC_BASE_URL

No call recording is enabled by this MVP.
