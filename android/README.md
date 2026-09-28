# Traducere Live — Android MVP

A minimal Android WebView shell for the existing HTTPS Render app.
It opens the translated-call screen at / by default. The bottom navigation has three modes:
provider-routed translated calls (beta), face-to-face interpretation, and native
SIM dialing. The AI phone agent is NOT in public navigation. No API keys are
stored in the APK.

## Build
GitHub Actions > Android interpreter APK > Artifacts > traducere-live-android-debug.
Or open the android/ directory with Android Studio and build the debug APK.
This is a debug APK, not a signed Play Store production release.

## Runtime
Server base URL: https://cita-fd42.onrender.com
The in-person interpreter uses a PIN-protected POST /api/interpreter-session
and an authenticated WebSocket /interpreter-socket. Server OPENAI_API_KEY and
APP_PIN must be configured. The interface uses 24-kHz PCM input/output and
two explicit speaker buttons; it does NOT dial a phone number. Internet
access is required. Live interpretation may incur OpenAI API charges.

The public Android app has a **Sună cu SIM** tab that opens Android's native dialer. Calls use the selected SIM/carrier caller ID; the user confirms the call in the dialer. This direct carrier call does not include AI translation. Face-to-face interpreting remains available in the app.

The **Apel tradus** tab opens the existing provider-routed audio bridge. It is a
separate internet/Telnyx call, not a native SIM call, and the callee sees the
provider-configured, authorized caller ID. Do not claim arbitrary users can
display their own SIM number; per-user caller ID requires actual provider
verification and identity/account controls. The beta route is disabled unless
`PHONE_TRANSLATION_ENABLED=true` is set server-side after reviewing provider
availability, calling permissions and expected charges. It requires explicit
audio/provider-cost consent and the APP_PIN, limits simultaneous test calls to
one, and ends calls after ten minutes. Never put Telnyx or OpenAI keys in APK.

The AI calling agent is omitted from public Android navigation. To enable it privately, set a unique, high-entropy `AGENT_PRIVATE_PIN` environment variable on the server and open `/agent` directly. When that variable is unset, `/agent` and `/api/agent-call` are disabled. Do not put this private PIN in the APK. The existing `APP_PIN` continues to protect the public face-to-face interpreter and Telnyx translation API.

## Privacy and Android permissions
RECORD_AUDIO is requested only when the trusted HTTPS origin requests audio.
The native shell grants only RESOURCE_AUDIO_CAPTURE, and never grants camera
or arbitrary future WebView permissions. The client holds session tokens in
memory, not in the APK; API credentials stay on the server. No audio recording
or persistent transcript storage is implemented in this MVP. As with any
cloud interpreter, live audio is transmitted to the translation provider.
