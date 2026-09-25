# Traducere Live — Android MVP

A minimal Android WebView shell for the existing HTTPS Render app.
It opens /interpreter.html by default. Top buttons also open the existing
/ translator (phone calls) and /agent (AI phone agent). No API keys are
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

The telephone tab still depends on the Telnyx setup and its route/caller-ID
configuration. Android packaging does not repair the pre-existing Telnyx
outbound "No Routes Found" issue.

## Privacy and Android permissions
RECORD_AUDIO is requested only when the trusted HTTPS origin requests audio.
The native shell grants only RESOURCE_AUDIO_CAPTURE, and never grants camera
or arbitrary future WebView permissions. The client holds session tokens in
memory, not in the APK; API credentials stay on the server. No audio recording
or persistent transcript storage is implemented in this MVP. As with any
cloud interpreter, live audio is transmitted to the translation provider.
