import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";
const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || "";
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || "";
const PLIVO_FROM_NUMBER = process.env.PLIVO_FROM_NUMBER || "";
const APP_PIN = process.env.APP_PIN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const sessions = new Map();

const missingConfig = () => Object.entries({
  OPENAI_API_KEY,
  PLIVO_AUTH_ID,
  PLIVO_AUTH_TOKEN,
  PLIVO_FROM_NUMBER,
  APP_PIN,
  PUBLIC_BASE_URL
}).filter(([,v]) => !v).map(([k]) => k);

function safeSend(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function normalizePhone(value) {
  const p = String(value || "").replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
function xml(value) {
  return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
}
function wsBase() {
  return PUBLIC_BASE_URL.replace(/^https:/,"wss:").replace(/^http:/,"ws:");
}
function plivoAuth() {
  return "Basic " + Buffer.from(PLIVO_AUTH_ID + ":" + PLIVO_AUTH_TOKEN).toString("base64");
}
async function plivoRequest(pathname, { method = "GET", body } = {}) {
  const response = await fetch("https://api.plivo.com/v1/Account/" + encodeURIComponent(PLIVO_AUTH_ID) + pathname, {
    method,
    headers: {
      Authorization: plivoAuth(),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(data.error || data.message || data.raw || ("Plivo HTTP " + response.status));
  return data;
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
  closeSocket(s.plivo);
  closeSocket(s.client);
  sessions.delete(id);
}
function parseExtraHeaders(value) {
  const out = {};
  for (const part of String(value || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0,i)] = part.slice(i+1);
  }
  return out;
}
function openRealtime({ instructions, inputFormat, outputFormat, turnDetection, onAudio, onText, onReady, onError }) {
  const ws = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(OPENAI_REALTIME_MODEL),
    { headers: { Authorization: "Bearer " + OPENAI_API_KEY, "OpenAI-Beta": "realtime=v1" } }
  );

  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "alloy",
        input_audio_format: inputFormat,
        output_audio_format: outputFormat,
        turn_detection: turnDetection
      }
    }));
    onReady?.();
  });

  ws.on("message", raw => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }

    if ((event.type === "response.audio.delta" || event.type === "response.output_audio.delta") && event.delta) {
      onAudio?.(event.delta);
    }
    if ((event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") && event.delta) {
      onText?.(event.delta);
    }
    if (event.type === "error") onError?.(event.error?.message || "OpenAI Realtime error");
  });

  ws.on("error", e => onError?.(e.message));
  return ws;
}
function ensureRealtime(s) {
  if (!s.plivo || !s.streamId) return;

  if (!s.roDa || s.roDa.readyState > WebSocket.OPEN) {
    s.roDa = openRealtime({
      instructions: "Act only as a live interpreter. Translate Romanian speech into natural Danish. Preserve names, numbers, meaning and tone. Never answer the speaker, never add information, never explain. Output only the Danish translation.",
      inputFormat: "pcm16",
      outputFormat: "g711_ulaw",
      turnDetection: null,
      onAudio: audio => {
        if (s.plivo?.readyState === WebSocket.OPEN) {
          s.plivo.send(JSON.stringify({
            event: "playAudio",
            media: {
              contentType: "audio/x-mulaw",
              sampleRate: 8000,
              payload: audio
            }
          }));
        }
      },
      onText: delta => safeSend(s.client, { type: "text", lane: "you-da", delta }),
      onReady: () => safeSend(s.client, { type: "ready", lane: "ro-da" }),
      onError: message => safeSend(s.client, { type: "error", message })
    });
  }

  if (!s.daRo || s.daRo.readyState > WebSocket.OPEN) {
    s.daRo = openRealtime({
      instructions: "Act only as a live interpreter. Translate Danish speech into natural Romanian. Preserve names, numbers, meaning and tone. Never answer the speaker, never add information, never explain. Output only the Romanian translation.",
      inputFormat: "g711_ulaw",
      outputFormat: "pcm16",
      turnDetection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: 500, create_response: true },
      onAudio: audio => safeSend(s.client, { type: "audio", audio, sampleRate: 24000 }),
      onText: delta => safeSend(s.client, { type: "text", lane: "them-ro", delta }),
      onReady: () => safeSend(s.client, { type: "ready", lane: "da-ro" }),
      onError: message => safeSend(s.client, { type: "error", message })
    });
  }
}

app.get("/", (_req, res) => res.sendFile(path.resolve("index.html")));
app.get("/health", (_req, res) => {
  const missing = missingConfig();
  res.status(missing.length ? 503 : 200).json({ ok: missing.length === 0, service: "live-ro-da-translator-plivo", missing });
});

app.post("/api/call", async (req, res) => {
  try {
    const missing = missingConfig();
    if (missing.length) return res.status(503).json({ error: "Missing config: " + missing.join(", ") });
    if (String(req.body.pin || "") !== APP_PIN) return res.status(401).json({ error: "PIN greșit" });

    const to = normalizePhone(req.body.to);
    if (!to) return res.status(400).json({ error: "Numărul trebuie scris internațional, de exemplu +45..." });

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");
    const s = {
      id, token, to, created: Date.now(),
      client: null, plivo: null, streamId: null,
      callUuid: null, requestUuid: null,
      roDa: null, daRo: null
    };
    sessions.set(id, s);

    const call = await plivoRequest("/Call/", {
      method: "POST",
      body: {
        from: PLIVO_FROM_NUMBER,
        to,
        answer_url: PUBLIC_BASE_URL + "/plivo-answer?sid=" + encodeURIComponent(id),
        answer_method: "POST",
        ring_url: PUBLIC_BASE_URL + "/plivo-ring?sid=" + encodeURIComponent(id),
        ring_method: "POST",
        hangup_url: PUBLIC_BASE_URL + "/plivo-hangup?sid=" + encodeURIComponent(id),
        hangup_method: "POST"
      }
    });

    s.requestUuid = call.request_uuid || null;
    res.json({ sessionId: id, token, requestUuid: s.requestUuid, status: "initiated" });
  } catch (e) {
    res.status(500).json({ error: e.message || "Nu am putut porni apelul" });
  }
});

app.post("/api/hangup", async (req, res) => {
  const s = sessions.get(String(req.body.sessionId || ""));
  if (!s || req.body.token !== s.token) return res.status(401).json({ error: "Sesiune invalidă" });

  try {
    if (s.callUuid) {
      await plivoRequest("/Call/" + encodeURIComponent(s.callUuid) + "/", { method: "DELETE" });
    }
  } catch {}
  cleanup(s.id, "completed");
  res.json({ ok: true });
});

app.post("/api/verify-caller/start", async (req, res) => {
  try {
    if (String(req.body.pin || "") !== APP_PIN) return res.status(401).json({ error: "PIN greșit" });
    if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN) return res.status(503).json({ error: "Plivo nu este configurat încă" });
    const number = normalizePhone(req.body.phone || PLIVO_FROM_NUMBER);
    if (!number) return res.status(400).json({ error: "Număr invalid" });

    const result = await plivoRequest("/VerifiedCallerId/", {
      method: "POST",
      body: {
        phone_number: number,
        alias: "Personal Danish number",
        channel: req.body.channel === "call" ? "call" : "sms"
      }
    });
    res.json({
      ok: true,
      verificationUuid: result.verification_uuid,
      message: result.message || "Cod trimis"
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Nu am putut porni verificarea" });
  }
});

app.post("/api/verify-caller/complete", async (req, res) => {
  try {
    if (String(req.body.pin || "") !== APP_PIN) return res.status(401).json({ error: "PIN greșit" });
    if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN) return res.status(503).json({ error: "Plivo nu este configurat încă" });
    const uuid = String(req.body.verificationUuid || "");
    const otp = String(req.body.otp || "").trim();
    if (!uuid || !/^\d{4,8}$/.test(otp)) return res.status(400).json({ error: "UUID sau cod OTP invalid" });

    const result = await plivoRequest("/VerifiedCallerId/Verification/" + encodeURIComponent(uuid) + "/", {
      method: "POST",
      body: { otp }
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message || "Verificarea nu a reușit" });
  }
});

app.post("/plivo-ring", (req, res) => {
  const s = sessions.get(String(req.query.sid || ""));
  if (s) {
    s.callUuid = req.body.CallUUID || s.callUuid;
    safeSend(s.client, { type: "status", status: "ringing" });
  }
  res.sendStatus(204);
});

app.post("/plivo-hangup", (req, res) => {
  const s = sessions.get(String(req.query.sid || ""));
  if (s) {
    s.callUuid = req.body.CallUUID || s.callUuid;
    safeSend(s.client, {
      type: "status",
      status: "completed",
      cause: req.body.HangupCauseName || req.body.HangupCause || ""
    });
    setTimeout(() => cleanup(s.id, "completed"), 800);
  }
  res.sendStatus(204);
});

app.post("/plivo-answer", (req, res) => {
  const id = String(req.query.sid || "");
  const s = sessions.get(id);
  if (!s) return res.type("text/xml").send('<?xml version="1.0"?><Response><Hangup/></Response>');

  s.callUuid = req.body.CallUUID || s.callUuid;
  safeSend(s.client, { type: "status", status: "answered" });

  const disclosure = "Denne samtale bruger automatisk oversættelse mellem rumænsk og dansk.";
  const streamUrl = wsBase() + "/plivo-media";
  const responseXml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Speak language="da-DK" voice="WOMAN">' + xml(disclosure) + '</Speak>' +
      '<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" extraHeaders="sessionId=' + xml(id) + '">' +
        xml(streamUrl) +
      '</Stream>' +
    '</Response>';

  res.type("text/xml").send(responseXml);
});

const server = http.createServer(app);
const clientWss = new WebSocketServer({ noServer: true });
const plivoWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/client") return clientWss.handleUpgrade(req, socket, head, ws => clientWss.emit("connection", ws, req));
  if (u.pathname === "/plivo-media") return plivoWss.handleUpgrade(req, socket, head, ws => plivoWss.emit("connection", ws, req));
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
  ensureRealtime(s);

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === "mic" && typeof m.audio === "string" && s.roDa?.readyState === WebSocket.OPEN) {
      s.roDa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: m.audio }));
    }
    if (m.type === "ptt-end" && s.roDa?.readyState === WebSocket.OPEN) {
      s.roDa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      s.roDa.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
    }
  });

  ws.on("close", () => { if (s.client === ws) s.client = null; });
});

plivoWss.on("connection", ws => {
  let s = null;

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.event === "start") {
      const headers = parseExtraHeaders(m.extra_headers);
      const id = headers.sessionId || "";
      s = sessions.get(id);
      if (!s) return ws.close(1008, "Unknown session");

      s.plivo = ws;
      s.streamId = m.start?.streamId || "";
      s.callUuid = m.start?.callId || s.callUuid;
      safeSend(s.client, { type: "status", status: "call-audio-live" });
      ensureRealtime(s);
      return;
    }

    if (m.event === "media" && s && m.media?.payload && s.daRo?.readyState === WebSocket.OPEN) {
      s.daRo.send(JSON.stringify({ type: "input_audio_buffer.append", audio: m.media.payload }));
    }
  });

  ws.on("close", () => {
    if (s?.plivo === ws) {
      s.plivo = null;
      s.streamId = null;
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id,s] of sessions) {
    if (now - s.created > 2 * 60 * 60 * 1000) cleanup(id, "expired");
  }
}, 60000).unref();

server.listen(PORT, () => {
  console.log("Live RO↔DA translator (Plivo) listening on :" + PORT);
  console.log("Missing runtime config:", missingConfig().join(", ") || "none");
});
