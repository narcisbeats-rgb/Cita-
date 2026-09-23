import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini";
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || "";
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || "+4581948173";
const TELNYX_APP_NAME = process.env.TELNYX_APP_NAME || "Traducere Live";
const APP_PIN = process.env.APP_PIN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const VOICES = new Set(["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"]);
const sessions = new Map();
let discoveredConnectionId = TELNYX_CONNECTION_ID;

function missingConfig() {
  const req = { OPENAI_API_KEY, TELNYX_API_KEY, TELNYX_FROM_NUMBER, APP_PIN, PUBLIC_BASE_URL };
  return Object.entries(req).filter(([, v]) => !v).map(([k]) => k);
}
function safeSend(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function safeJson(raw) {
  try { return JSON.parse(raw.toString()); } catch { return null; }
}
function normalizePhone(value) {
  const p = String(value || "").replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
function wsBase() {
  return PUBLIC_BASE_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
function languageConfig(code) {
  return code === "es"
    ? { code: "es", english: "Spanish", local: "spaniolă" }
    : { code: "ro", english: "Romanian", local: "română" };
}
function normalizeVoice(value) {
  return VOICES.has(String(value || "").toLowerCase()) ? String(value).toLowerCase() : "cedar";
}
function cancelResponse(ws) {
  if (ws?.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {}
  }
}
function closeSocket(ws) {
  try { if (ws && ws.readyState < 2) ws.close(); } catch {}
}
async function telnyx(pathname, { method = "GET", body } = {}) {
  const response = await fetch("https://api.telnyx.com/v2" + pathname, {
    method,
    headers: {
      Authorization: "Bearer " + TELNYX_API_KEY,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(data.errors?.[0]?.detail || data.error || data.message || data.raw || ("Telnyx HTTP " + response.status));
  return data;
}
async function resolveConnectionId() {
  if (discoveredConnectionId) return discoveredConnectionId;
  if (!TELNYX_API_KEY) throw new Error("TELNYX_API_KEY lipsește");
  const result = await telnyx("/call_control_applications?page[size]=100");
  const apps = Array.isArray(result.data) ? result.data : [];
  const exact = apps.find(x => String(x.application_name || "").trim().toLowerCase() === TELNYX_APP_NAME.toLowerCase());
  const webhookMatch = apps.find(x => String(x.webhook_event_url || "").startsWith(PUBLIC_BASE_URL));
  const picked = exact || webhookMatch || apps.find(x => x.active);
  if (!picked?.id) throw new Error('Nu am găsit aplicația Voice API "' + TELNYX_APP_NAME + '" în Telnyx');
  discoveredConnectionId = picked.id;
  console.log("Telnyx connection detected:", picked.application_name || "unnamed", picked.id);
  return discoveredConnectionId;
}

function estimateRealtimeResponseCost(usage) {
  if (!usage) return 0;
  const i = usage.input_token_details || {};
  const o = usage.output_token_details || {};
  const cached = i.cached_tokens_details || {};
  const inAudio = Number(i.audio_tokens || 0);
  const inText = Number(i.text_tokens || 0);
  const outAudio = Number(o.audio_tokens || 0);
  const outText = Number(o.text_tokens || 0);
  const cachedAudio = Math.min(inAudio, Number(cached.audio_tokens || 0));
  const cachedText = Math.min(inText, Number(cached.text_tokens || 0));
  const normalAudio = Math.max(0, inAudio - cachedAudio);
  const normalText = Math.max(0, inText - cachedText);

  if (OPENAI_REALTIME_MODEL.includes("mini")) {
    return normalAudio * 10 / 1e6 + cachedAudio * 0.30 / 1e6 +
      normalText * 0.60 / 1e6 + cachedText * 0.06 / 1e6 +
      outAudio * 20 / 1e6 + outText * 2.40 / 1e6;
  }
  return normalAudio * 32 / 1e6 + cachedAudio * 0.40 / 1e6 +
    normalText * 4 / 1e6 + cachedText * 0.40 / 1e6 +
    outAudio * 64 / 1e6 + outText * 24 / 1e6;
}

function cleanup(id, finalStatus = "ended") {
  const s = sessions.get(id);
  if (!s) return;
  safeSend(s.client, { type: "status", status: finalStatus });
  closeSocket(s.localToDa);
  closeSocket(s.daToLocal);
  closeSocket(s.telnyxWs);
  closeSocket(s.client);
  sessions.delete(id);
}

function openRealtime({
  instructions,
  inputFormat,
  outputFormat,
  voice,
  side,
  onAudio,
  onOutputText,
  onInputText,
  onSpeechStart,
  onSpeechStop,
  onResponseStart,
  onResponseDone,
  onReady,
  onError
}) {
  const ws = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(OPENAI_REALTIME_MODEL),
    { headers: { Authorization: "Bearer " + OPENAI_API_KEY } }
  );

  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions,
        audio: {
          input: {
            format: inputFormat,
            transcription: {
              model: "gpt-live-transcribe",
              delay: "low"
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.45,
              prefix_padding_ms: 180,
              silence_duration_ms: 350,
              create_response: true,
              interrupt_response: true
            }
          },
          output: {
            format: outputFormat,
            voice
          }
        }
      }
    }));
  });

  ws.on("message", raw => {
    const ev = safeJson(raw);
    if (!ev) return;

    if (ev.type === "session.updated") {
      onReady?.();
      return;
    }
    if (ev.type === "input_audio_buffer.speech_started") {
      onSpeechStart?.();
      return;
    }
    if (ev.type === "input_audio_buffer.speech_stopped") {
      onSpeechStop?.();
      return;
    }
    if (ev.type === "response.created") {
      onResponseStart?.();
      return;
    }
    if ((ev.type === "response.output_audio.delta" || ev.type === "response.audio.delta") && ev.delta) {
      onAudio?.(ev.delta);
      return;
    }
    if ((ev.type === "response.output_audio_transcript.delta" || ev.type === "response.audio_transcript.delta") && ev.delta) {
      onOutputText?.(ev.delta);
      return;
    }
    if (ev.type === "conversation.item.input_audio_transcription.delta" && ev.delta) {
      onInputText?.(ev.delta, false);
      return;
    }
    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      onInputText?.("", true);
      return;
    }
    if (ev.type === "response.done") {
      onResponseDone?.(ev.response?.usage || null);
      return;
    }
    if (ev.type === "error") {
      const msg = ev.error?.message || "OpenAI Realtime error";
      console.error("OpenAI", side, msg);
      onError?.(msg);
    }
  });

  ws.on("error", e => onError?.(e.message));
  return ws;
}

function maybeStartRealtime(s) {
  if (!s || s.realtimeStarted || !s.answered || !s.telnyxWs || !s.client) return;
  if (!OPENAI_API_KEY) {
    safeSend(s.client, { type: "error", message: "OPENAI_API_KEY lipsește din Render" });
    return;
  }

  s.realtimeStarted = true;
  const lang = languageConfig(s.language);
  const baseRule = "Act only as a live interpreter. Never answer the speaker. Never add commentary, greetings, explanations or information. Preserve names, numbers, dates, tone and intent. Output only the translation.";

  s.localToDa = openRealtime({
    side: "local-to-da",
    instructions: baseRule + " Translate " + lang.english + " speech into natural spoken Danish.",
    inputFormat: { type: "audio/pcm", rate: 24000 },
    outputFormat: { type: "audio/pcmu" },
    voice: s.voice,
    onReady: () => {
      s.localReady = true;
      safeSend(s.client, { type: "engine-ready", side: "local" });
    },
    onSpeechStart: () => {
      s.localSpeaking = true;
      if (s.daToLocalActive) cancelResponse(s.daToLocal);
      safeSend(s.client, { type: "interrupt-playback" });
      safeSend(s.client, { type: "state", state: "local-speaking" });
    },
    onSpeechStop: () => {
      s.localSpeaking = false;
      safeSend(s.client, { type: "state", state: "translating-to-danish" });
    },
    onResponseStart: () => {
      s.localToDaActive = true;
      safeSend(s.client, { type: "state", state: "translating-to-danish" });
    },
    onAudio: audio => {
      if (!s.remoteSpeaking && s.telnyxWs?.readyState === WebSocket.OPEN) {
        s.telnyxWs.send(JSON.stringify({ event: "media", media: { payload: audio } }));
        safeSend(s.client, { type: "state", state: "speaking-to-remote" });
      }
    },
    onInputText: (delta, final) => safeSend(s.client, { type: "transcript", lane: "you-original", delta, final }),
    onOutputText: delta => safeSend(s.client, { type: "transcript", lane: "you-da", delta }),
    onResponseDone: usage => {
      s.localToDaActive = false;
      s.realtimeUsd += estimateRealtimeResponseCost(usage);
      safeSend(s.client, { type: "usage", realtimeUsd: s.realtimeUsd });
      safeSend(s.client, { type: "transcript", lane: "you-da", delta: "", final: true });
      safeSend(s.client, { type: "state", state: "listening" });
    },
    onError: message => safeSend(s.client, { type: "error", message })
  });

  s.daToLocal = openRealtime({
    side: "da-to-local",
    instructions: baseRule + " Translate Danish speech into natural spoken " + lang.english + ".",
    inputFormat: { type: "audio/pcmu" },
    outputFormat: { type: "audio/pcm", rate: 24000 },
    voice: s.voice,
    onReady: () => {
      s.remoteReady = true;
      safeSend(s.client, { type: "engine-ready", side: "remote" });
      safeSend(s.client, { type: "state", state: "listening" });
    },
    onSpeechStart: () => {
      s.remoteSpeaking = true;
      if (s.localToDaActive) cancelResponse(s.localToDa);
      safeSend(s.client, { type: "interrupt-playback" });
      safeSend(s.client, { type: "state", state: "remote-speaking" });
    },
    onSpeechStop: () => {
      s.remoteSpeaking = false;
      safeSend(s.client, { type: "state", state: "translating-to-local" });
    },
    onResponseStart: () => {
      s.daToLocalActive = true;
      safeSend(s.client, { type: "state", state: "translating-to-local" });
    },
    onAudio: audio => {
      if (!s.localSpeaking) {
        safeSend(s.client, { type: "audio", audio, sampleRate: 24000 });
        safeSend(s.client, { type: "state", state: "playing-local" });
      }
    },
    onInputText: (delta, final) => safeSend(s.client, { type: "transcript", lane: "them-original", delta, final }),
    onOutputText: delta => safeSend(s.client, { type: "transcript", lane: "them-local", delta }),
    onResponseDone: usage => {
      s.daToLocalActive = false;
      s.realtimeUsd += estimateRealtimeResponseCost(usage);
      safeSend(s.client, { type: "usage", realtimeUsd: s.realtimeUsd });
      safeSend(s.client, { type: "transcript", lane: "them-local", delta: "", final: true });
      safeSend(s.client, { type: "state", state: "listening" });
    },
    onError: message => safeSend(s.client, { type: "error", message })
  });
}

app.get("/", (_req, res) => res.sendFile(path.resolve("index.html")));

app.get("/health", async (_req, res) => {
  const missing = missingConfig();
  let connectionId = discoveredConnectionId || null;
  let telnyxOk = false;
  let telnyxError = null;
  if (!missing.includes("TELNYX_API_KEY")) {
    try {
      connectionId = await resolveConnectionId();
      telnyxOk = Boolean(connectionId);
    } catch (e) {
      telnyxError = e.message;
    }
  }
  res.status(missing.length || !telnyxOk ? 503 : 200).json({
    ok: missing.length === 0 && telnyxOk,
    service: "live-ro-es-da-translator",
    model: OPENAI_REALTIME_MODEL,
    missing,
    telnyxOk,
    connectionId,
    telnyxError
  });
});

app.post("/api/voice-preview", async (req, res) => {
  try {
    if (String(req.body.pin || "") !== APP_PIN) return res.status(401).json({ error: "PIN greșit" });
    if (!OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY lipsește" });
    const voice = normalizeVoice(req.body.voice);
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: "Hej! Dette er en kort test af stemmen til din live oversættelse.",
        instructions: "Speak natural Danish, warm, clear and conversational, like a normal phone call.",
        response_format: "mp3"
      })
    });
    if (!response.ok) {
      const raw = await response.text();
      let message = raw;
      try { message = JSON.parse(raw).error?.message || raw; } catch {}
      return res.status(response.status).json({ error: message });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(bytes);
  } catch (e) {
    res.status(500).json({ error: e.message || "Nu am putut genera testul de voce" });
  }
});

app.post("/api/call", async (req, res) => {
  try {
    const missing = missingConfig();
    if (missing.length) return res.status(503).json({ error: "Missing config: " + missing.join(", ") });
    if (String(req.body.pin || "") !== APP_PIN) return res.status(401).json({ error: "PIN greșit" });

    const to = normalizePhone(req.body.to);
    if (!to) return res.status(400).json({ error: "Numărul trebuie scris internațional, de exemplu +45..." });

    const language = req.body.language === "es" ? "es" : "ro";
    const voice = normalizeVoice(req.body.voice);
    const connectionId = await resolveConnectionId();
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");

    const s = {
      id, token, to, language, voice, created: Date.now(),
      answered: false,
      answeredAt: null,
      callControlId: null,
      client: null,
      telnyxWs: null,
      localToDa: null,
      daToLocal: null,
      realtimeStarted: false,
      localReady: false,
      remoteReady: false,
      localSpeaking: false,
      remoteSpeaking: false,
      localToDaActive: false,
      daToLocalActive: false,
      realtimeUsd: 0
    };
    sessions.set(id, s);

    const result = await telnyx("/calls", {
      method: "POST",
      body: {
        connection_id: connectionId,
        to,
        from: TELNYX_FROM_NUMBER,
        webhook_url: PUBLIC_BASE_URL + "/telnyx-webhook?sid=" + encodeURIComponent(id),
        stream_url: wsBase() + "/telnyx-media?sid=" + encodeURIComponent(id) + "&token=" + encodeURIComponent(token),
        stream_track: "inbound_track",
        stream_codec: "PCMU",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: "PCMU",
        stream_bidirectional_sampling_rate: 8000,
        stream_bidirectional_target_legs: "self",
        command_id: crypto.randomUUID()
      }
    });

    s.callControlId = result.data?.call_control_id || null;
    res.json({ sessionId: id, token, status: "initiated", language, voice });
  } catch (e) {
    res.status(500).json({ error: e.message || "Nu am putut porni apelul" });
  }
});

app.post("/api/hangup", async (req, res) => {
  const s = sessions.get(String(req.body.sessionId || ""));
  if (!s || req.body.token !== s.token) return res.status(401).json({ error: "Sesiune invalidă" });
  try {
    if (s.callControlId) {
      await telnyx("/calls/" + encodeURIComponent(s.callControlId) + "/actions/hangup", {
        method: "POST",
        body: { command_id: crypto.randomUUID() }
      });
    }
  } catch {}
  cleanup(s.id, "completed");
  res.json({ ok: true });
});

app.post("/telnyx-webhook", async (req, res) => {
  res.sendStatus(204);
  const id = String(req.query.sid || "");
  const s = sessions.get(id);
  const eventType = req.body?.data?.event_type || "";
  const payload = req.body?.data?.payload || {};
  console.log("Telnyx webhook:", eventType, payload.call_control_id || payload.call_leg_id || "");
  if (!s) return;
  if (payload.call_control_id) s.callControlId = payload.call_control_id;

  if (eventType === "call.initiated") {
    safeSend(s.client, { type: "status", status: "initiated" });
  } else if (eventType === "call.ringing") {
    safeSend(s.client, { type: "status", status: "ringing" });
  } else if (eventType === "call.answered") {
    s.answered = true;
    s.answeredAt = Date.now();
    safeSend(s.client, { type: "status", status: "call-audio-live" });
    safeSend(s.client, { type: "call-start", at: s.answeredAt });
    maybeStartRealtime(s);
  } else if (eventType === "call.hangup") {
    cleanup(s.id, "completed");
  }
});

const server = http.createServer(app);
const clientWss = new WebSocketServer({ noServer: true });
const telnyxWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/client") {
    return clientWss.handleUpgrade(req, socket, head, ws => clientWss.emit("connection", ws, req));
  }
  if (u.pathname === "/telnyx-media") {
    return telnyxWss.handleUpgrade(req, socket, head, ws => telnyxWss.emit("connection", ws, req));
  }
  socket.destroy();
});

clientWss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("sid") || "";
  const token = u.searchParams.get("token") || "";
  const s = sessions.get(id);
  if (!s || token !== s.token) return ws.close(1008, "Invalid session");

  s.client = ws;
  safeSend(ws, { type: "status", status: s.answered ? "call-audio-live" : "app-connected" });
  if (s.answeredAt) safeSend(ws, { type: "call-start", at: s.answeredAt });
  safeSend(ws, { type: "usage", realtimeUsd: s.realtimeUsd });
  maybeStartRealtime(s);

  ws.on("message", raw => {
    const m = safeJson(raw);
    if (!m) return;

    if (m.type === "mic" && typeof m.audio === "string" && s.localToDa?.readyState === WebSocket.OPEN) {
      s.localToDa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: m.audio }));
    } else if (m.type === "local-speech-start") {
      s.localSpeaking = true;
      if (s.daToLocalActive) cancelResponse(s.daToLocal);
      safeSend(s.client, { type: "state", state: "local-speaking" });
    } else if (m.type === "local-speech-stop") {
      s.localSpeaking = false;
    }
  });

  ws.on("close", () => {
    if (s.client === ws) s.client = null;
  });
});

telnyxWss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("sid") || "";
  const token = u.searchParams.get("token") || "";
  const s = sessions.get(id);
  if (!s || token !== s.token) return ws.close(1008, "Invalid media session");

  s.telnyxWs = ws;
  maybeStartRealtime(s);

  ws.on("message", raw => {
    const m = safeJson(raw);
    if (!m) return;
    if (m.event === "start") {
      safeSend(s.client, { type: "status", status: "audio-connected" });
      maybeStartRealtime(s);
      return;
    }
    if (m.event === "media" && m.media?.payload && s.daToLocal?.readyState === WebSocket.OPEN) {
      s.daToLocal.send(JSON.stringify({ type: "input_audio_buffer.append", audio: m.media.payload }));
      return;
    }
    if (m.event === "stop") safeSend(s.client, { type: "status", status: "call-stream-ended" });
  });

  ws.on("close", () => {
    if (s.telnyxWs === ws) s.telnyxWs = null;
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.created > 2 * 60 * 60 * 1000) cleanup(id, "expired");
  }
}, 60000).unref();

server.listen(PORT, async () => {
  console.log("Live RO/ES↔DA translator listening on :" + PORT);
  console.log("Realtime model:", OPENAI_REALTIME_MODEL);
  console.log("Missing runtime config:", missingConfig().join(", ") || "none");
  if (TELNYX_API_KEY) {
    try {
      const id = await resolveConnectionId();
      console.log("Telnyx ready, connection_id:", id);
    } catch (e) {
      console.error("Telnyx setup error:", e.message);
    }
  }
});
