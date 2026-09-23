# Live Romanian ↔ Danish phone translator

Live phone translation using Telnyx Voice API + OpenAI Realtime Translation. The caller can choose Romanian ↔ Danish or Spanish ↔ Danish before starting a call.

## Flow
1. Enter a destination phone number and the private app PIN.
2. Telnyx starts the outbound call using the verified Danish caller ID.
3. The called party hears a short Danish disclosure that automatic translation is being used.
4. Choose Romanian or Spanish, then hold push-to-talk and speak.
5. OpenAI Realtime Translate returns Danish PCMU audio directly into the Telnyx call.
6. The called party's Danish PCMU audio is translated back into the selected language for the browser.

No call recording is enabled.

## Telnyx
The backend automatically discovers the Voice API application named `Traducere Live`, so a manual Connection ID is optional.

## Render environment variables
- TELNYX_API_KEY
- TELNYX_FROM_NUMBER = +4581948173
- TELNYX_APP_NAME = Traducere Live
- OPENAI_API_KEY
- OPENAI_REALTIME_MODEL = gpt-realtime-translate
- APP_PIN
- PUBLIC_BASE_URL
