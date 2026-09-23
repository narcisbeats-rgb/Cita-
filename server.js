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
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const APP_PIN = process.env.APP_PIN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const sessions = new Map();

const missingConfig = () => Object.entries({
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
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
function basicAuth() {
  return "Basic " + Buffer.from(TWILIO_ACCOUNT_SID + ":" + TWILIO_AUTH_TOKEN).toString("base64");
}
async function twilioPost(pathname, fields) {
  const response = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + TWILIO_ACCOUNT_SID + pathname, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields)
  });
  const raw = await response.text();
  let data = {};
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!response.ok) throw new Error(data.message || data.raw || ("Twilio HTTP " + response.status));
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
  closeSocket(s.twilio);
  closeSocket(s.client);
  sessions.delete(id);
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
  if (!s.twilio || !s.streamSid) return;

  if (!s.roDa || s.roDa.readyState > WebSocket.OPEN) {
    s.roDa = openRealtime({
      instructions: "Act only as a live interpreter. Translate Romanian speech into natural Danish. Preserve names, numbers, meaning and tone. Never answer the speaker, never add information, never explain. Output only the Danish translation.",
      inputFormat: "pcm16",
      outputFormat: "g711_ulaw",
      turnDetection: null,
      onAudio: audio => {
        if (s.twilio?.readyState === WebSocket.OPEN && s.streamSid) {
          s.twilio.send(JSON.stringify({ event: "media", streamSid: s.streamSid, media: { payload: audio } }));
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
  res.status(missing.length ? 503 : 200).json({ ok: missing.length === 0, service: "live-ro-da-translator", missing });
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
    const s = { id, token, to, created: Date.now(), client: null, twilio: null, streamSid: null, callSid: null, roDa: null, daRo: null };
    sessions.set(id, s);

    const call = await twilioPost("/Calls.json", {
      To: to,
      From: TWILIO_FROM_NUMBER,
      Url: PUBLIC_BASE_URL + "/twiml?sid=" + encodeURIComponent(id),
      Method: "POST",
      StatusCallback: PUBLIC_BASE_URL + "/twilio-status?sid=" + encodeURIComponent(id),
      StatusCallbackMethod: "POST",
      "StatusCallbackEvent[0]": "initiated",
      "StatusCallbackEvent[1]": "ringing",
      "StatusCallbackEvent[2]": "answered",
      "StatusCallbackEvent[3]": "completed"
    });

    s.callSid = call.sid;
    res.json({ sessionId: id, token, callSid: call.sid, status: call.status });
  } catch (e) {
    res.status(500).json({ error: e.message || "Nu am putut porni apelul" });
  }
});

app.post("/api/hangup", async (req, res) => {
  const s = sessions.get(String(req.body.sessionId || ""));
  if (!s || req.body.token !== s.token) return res.status(401).json({ error: "Sesiune invalidă" });
  try {
    if (s.callSid) await twilioPost("/Calls/" + encodeURIComponent(s.callSid) + ".json", { Status: "completed" });
  } catch {}
  cleanup(s.id, "completed");
  res.json({ ok: true });
});

app.post("/twilio-status", (req, res) => {
  const s = sessions.get(String(req.query.sid || ""));
  if (s) {
    const status = String(req.body.CallStatus || "unknown");
    safeSend(s.client, { type: "status", status });
    if (["completed","busy","failed","no-answer","canceled"].includes(status)) {
      setTimeout(() => cleanup(s.id, status), 1200);
    }
  }
  res.sendStatus(204);
});

app.post("/twiml", (req, res) => {
  const id = String(req.query.sid || "");
  if (!sessions.has(id)) return res.type("text/xml").send('<?xml version="1.0"?><Response><Hangup/></Response>');

  const disclosure = "Denne samtale bruger automatisk oversættelse mellem rumænsk og dansk.";
  const body = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Say language="da-DK">' + xml(disclosure) + '</Say>' +
      '<Connect><Stream url="' + xml(wsBase() + "/twilio-media") + '">' +
        '<Parameter name="sessionId" value="' + xml(id) + '"/>' +
      '</Stream></Connect>' +
    '</Response>';
  res.type("text/xml").send(body);
});

const server = http.createServer(app);
const clientWss = new WebSocketServer({ noServer: true });
const twilioWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/client") return clientWss.handleUpgrade(req, socket, head, ws => clientWss.emit("connection", ws, req));
  if (u.pathname === "/twilio-media") return twilioWss.handleUpgrade(req, socket, head, ws => twilioWss.emit("connection", ws, req));
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

twilioWss.on("connection", ws => {
  let s = null;

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.event === "start") {
      const id = m.start?.customParameters?.sessionId || "";
      s = sessions.get(id);
      if (!s) return ws.close(1008, "Unknown session");
      s.twilio = ws;
      s.streamSid = m.streamSid || m.start?.streamSid || "";
      safeSend(s.client, { type: "status", status: "call-audio-live" });
      ensureRealtime(s);
      return;
    }

    if (m.event === "media" && s && m.media?.payload && s.daRo?.readyState === WebSocket.OPEN) {
      s.daRo.send(JSON.stringify({ type: "input_audio_buffer.append", audio: m.media.payload }));
    }
  });

  ws.on("close", () => {
    if (s?.twilio === ws) {
      s.twilio = null;
      s.streamSid = null;
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
  console.log("Live RO↔DA translator listening on :" + PORT);
  console.log("Missing runtime config:", missingConfig().join(", ") || "none");
});
