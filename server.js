import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || "";
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || "+4581948173";
const TELNYX_APP_NAME = process.env.TELNYX_APP_NAME || "Traducere Live";
const APP_PIN = process.env.APP_PIN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const sessions = new Map();
let discoveredConnectionId = TELNYX_CONNECTION_ID;

function missingConfig() {
  const req = { OPENAI_API_KEY, TELNYX_API_KEY, TELNYX_FROM_NUMBER, APP_PIN, PUBLIC_BASE_URL };
  return Object.entries(req).filter(([,v]) => !v).map(([k]) => k);
}
function safeSend(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function normalizePhone(value) {
  const p = String(value || "").replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
function wsBase() {
  return PUBLIC_BASE_URL.replace(/^https:/,"wss:").replace(/^http:/,"ws:");
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
function closeSocket(ws) {
  try { if (ws && ws.readyState < 2) ws.close(); } catch {}
}
function cleanup(id, finalStatus = "ended") {
  const s = sessions.get(id);
  if (!s) return;
  safeSend(s.client, { type: "status", status: finalStatus });
  closeSocket(s.roDa);
  closeSocket(s.daRo);
  closeSocket(s.telnyxWs);
  closeSocket(s.client);
  sessions.delete(id);
}
function openRealtime({ instructions, inputFormat, outputFormat, turnDetection, onAudio, onText, onReady, onError }) {
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
            turn_detection: turnDetection
          },
          output: {
            format: outputFormat,
            voice: "cedar"
          }
        }
      }
    }));
    onReady?.();
  });

  ws.on("message", raw => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }

    if ((ev.type === "response.output_audio.delta" || ev.type === "response.audio.delta") && ev.delta) {
      onAudio?.(ev.delta);
      return;
    }
    if ((ev.type === "response.output_audio_transcript.delta" || ev.type === "response.audio_transcript.delta") && ev.delta) {
      onText?.(ev.delta);
      return;
    }
    if (ev.type === "error") onError?.(ev.error?.message || "OpenAI Realtime error");
  });

  ws.on("error", e => onError?.(e.message));
  return ws;
}
function languageConfig(code) {
  return code === "es"
    ? { code: "es", english: "Spanish", danish: "spansk" }
    : { code: "ro", english: "Romanian", danish: "rumænsk" };
}

function ensureRealtime(s) {
  if (!OPENAI_API_KEY) {
    safeSend(s.client, { type: "error", message: "OPENAI_API_KEY lipsește din Render" });
    return;
  }

  const lang = languageConfig(s.language);

  if (!s.roDa || s.roDa.readyState > WebSocket.OPEN) {
    s.roDa = openRealtime({
      instructions: "You are a strict live interpreter. Translate ONLY " + lang.english + " speech into natural spoken Danish. Preserve names, numbers, meaning and tone. Never answer the speaker, never explain, never add information. Output only the Danish translation.",
      inputFormat: { type: "audio/pcm", rate: 24000 },
      outputFormat: { type: "audio/pcmu" },
      turnDetection: null,
      onAudio: audio => {
        if (s.telnyxWs?.readyState === WebSocket.OPEN) {
          s.telnyxWs.send(JSON.stringify({ event: "media", media: { payload: audio } }));
        }
      },
      onText: delta => safeSend(s.client, { type: "text", lane: "you-da", delta }),
      onReady: () => safeSend(s.client, { type: "ready", lane: "ro-da" }),
      onError: message => safeSend(s.client, { type: "error", message })
    });
  }

  if (!s.daRo || s.daRo.readyState > WebSocket.OPEN) {
    s.daRo = openRealtime({
      instructions: "You are a strict live interpreter. Translate ONLY Danish speech into natural spoken " + lang.english + ". Preserve names, numbers, meaning and tone. Never answer the speaker, never explain, never add information. Output only the " + lang.english + " translation.",
      inputFormat: { type: "audio/pcmu" },
      outputFormat: { type: "audio/pcm", rate: 24000 },
      turnDetection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 250,
        silence_duration_ms: 500,
        create_response: true,
        interrupt_response: true
      },
      onAudio: audio => safeSend(s.client, { type: "audio", audio, sampleRate: 24000 }),
      onText: delta => safeSend(s.client, { type: "text", lane: "them-local", delta }),
      onReady: () => safeSend(s.client, { type: "ready", lane: "da-local" }),
      onError: message => safeSend(s.client, { type: "error", message })
    });
  }
}
async function playDisclosure(s) {
  if (!s?.callControlId || s.disclosureSent) return;
  s.disclosureSent = true;
  try {
    const lang = languageConfig(s.language);
    await telnyx("/calls/" + encodeURIComponent(s.callControlId) + "/actions/speak", {
      method: "POST",
      body: {
        payload: "Denne samtale bruger automatisk oversættelse mellem " + lang.danish + " og dansk.",
        payload_type: "text",
        service_level: "basic",
        voice: "female",
        language: "da-DK"
      }
    });
    safeSend(s.client, { type: "status", status: "disclosure" });
  } catch (e) {
    console.error("Disclosure error:", e.message);
    s.disclosureDone = true;
    safeSend(s.client, { type: "status", status: "call-audio-live" });
  }
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
    service: "live-ro-da-translator-telnyx",
    missing,
    telnyxOk,
    connectionId,
    telnyxError
  });
});

app.post("/api/call", async (req, res) => {
  try {
    const missing = missingConfig();
    if (missing.length) return res.status(503).json({ error: "Missing config: " + missing.join(", ") });
    if (String(req.body.pin || "") !== APP_PIN) return res.status(401).json({ error: "PIN greșit" });

    const to = normalizePhone(req.body.to);
    if (!to) return res.status(400).json({ error: "Numărul trebuie scris internațional, de exemplu +45..." });

    const language = req.body.language === "es" ? "es" : "ro";

    const connectionId = await resolveConnectionId();
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");

    const s = {
      id, token, to, language, created: Date.now(),
      callControlId: null,
      client: null,
      telnyxWs: null,
      roDa: null,
      daRo: null,
      disclosureDone: true
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
    res.json({
      sessionId: id,
      token,
      callControlId: s.callControlId,
      status: "initiated",
      language
    });
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
    s.disclosureDone = true;
    safeSend(s.client, { type: "status", status: "call-audio-live" });
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
  safeSend(ws, { type: "status", status: "app-connected" });
  if (s.telnyxWs) ensureRealtime(s);

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === "mic" && typeof m.audio === "string" && s.roDa?.readyState === WebSocket.OPEN) {
      s.roDa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: m.audio }));
    }

    if (m.type === "ptt-end" && s.roDa?.readyState === WebSocket.OPEN) {
      s.roDa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      s.roDa.send(JSON.stringify({ type: "response.create" }));
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
  ensureRealtime(s);

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.event === "start") {
      safeSend(s.client, { type: "status", status: s.disclosureDone ? "call-audio-live" : "audio-connected" });
      return;
    }

    if (m.event === "media" && m.media?.payload && s.daRo?.readyState === WebSocket.OPEN) {
      s.daRo.send(JSON.stringify({ type: "input_audio_buffer.append", audio: m.media.payload }));
      return;
    }

    if (m.event === "stop") {
      safeSend(s.client, { type: "status", status: "call-stream-ended" });
    }
  });

  ws.on("close", () => {
    if (s.telnyxWs === ws) s.telnyxWs = null;
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id,s] of sessions) {
    if (now - s.created > 2 * 60 * 60 * 1000) cleanup(id, "expired");
  }
}, 60000).unref();

server.listen(PORT, async () => {
  console.log("Live RO↔DA translator (Telnyx) listening on :" + PORT);
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
