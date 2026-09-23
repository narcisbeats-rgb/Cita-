# Live Romanian ↔ Danish phone translator

This repository replaces the old Cita appointment checker.

## Flow
1. Enter a phone number and your private app PIN.
2. Twilio starts the outbound call.
3. The called person hears one short Danish disclosure that automatic translation is being used.
4. Hold the push-to-talk button and speak Romanian.
5. OpenAI Realtime translates Romanian speech into Danish audio for the call.
6. Danish speech from the other person is translated into Romanian audio in your browser.

No call recording is enabled by this MVP.

## Render environment variables
- OPENAI_API_KEY
- OPENAI_REALTIME_MODEL (default: gpt-realtime)
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_FROM_NUMBER
- APP_PIN
- PUBLIC_BASE_URL
