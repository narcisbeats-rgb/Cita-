// Separate, phone-free interpreter. No Telnyx call is placed by this module.
import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const LANGUAGES = Object.freeze({
  ro: "Romanian", da: "Danish", en: "English", es: "Spanish"
});
const VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const MAX_SESSION_MS = 30 * 60 * 1000;
const MAX_TURNS = 100;
const MIN_AUDIO_BYTES = 4800; // 100ms of mono PCM16 at 24kHz.
const MAX_AUDIO_BYTES = 30 * 24000 * 2; // 30 seconds per turn.
const MAX_ACTIVE_SESSIONS = 10;

function send(ws, value) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}
function parse(raw) {
  try { return JSON.parse(raw.toString()); } catch { return null; }
}
function verifyPin(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function close(ws) {
  try { if (ws && ws.readyState < WebSocket.CLOSING) ws.close(); } catch {}
}

export function createInterpreter(app, { apiKey, model, pin }) {
  const sessions = new Map();
  const wss = new WebSocketServer({ noServer: true });

  app.post("/api/interpreter-session", (req, res) => {
    if (!pin || !apiKey) return res.status(503).json({ error: "Interpreterul nu este configurat pe server." });
    if (!verifyPin(req.body?.pin, pin)) return res.status(401).json({ error: "PIN greșit." });
    if (sessions.size >= MAX_ACTIVE_SESSIONS) return res.status(429).json({ error: "Prea multe sesiuni simultane." });
    const from = String(req.body?.from || "ro");
    const to = String(req.body?.to || "da");
    const voice = VOICES.has(req.body?.voice) ? req.body.voice : "cedar";
    if (!LANGUAGES[from] || !LANGUAGES[to] || from === to) {
      return res.status(400).json({ error: "Alege două limbi diferite și acceptate." });
    }
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(id, { id, token, from, to, voice, created: Date.now(), client: null, lanes: {}, active: null, busy: false, turns: 0 });
    res.set("Cache-Control", "no-store").json({ id, token, expiresIn: MAX_SESSION_MS / 1000 });
  });

  function openLane(session, laneName, from, to) {
    const lane = { name: laneName, from, to, ws: null, ready: false, audioBytes: 0 };
    const ws = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(model),
      { headers: { Authorization: "Bearer " + apiKey } }
    );
    lane.ws = ws;
    session.lanes[laneName] = lane;
    ws.on("open", () => {
      send(ws, {
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "You are an interpreter. Translate only from " + LANGUAGES[from] +
            " to natural spoken " + LANGUAGES[to] +
            ". Never answer the speaker or add commentary. Preserve names, addresses, numbers, dates, uncertainty, tone and meaning. Output ONLY the translation.",
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: "gpt-live-transcribe" },
              turn_detection: null
            },
            output: { format: { type: "audio/pcm", rate: 24000 }, voice: session.voice }
          }
        }
      });
    });
    ws.on("message", raw => {
      const event = parse(raw);
      if (!event) return;
      if (event.type === "session.updated") {
        lane.ready = true;
        if (Object.values(session.lanes).length === 2 &&
            Object.values(session.lanes).every(item => item.ready)) send(session.client, { type: "ready" });
      } else if (event.type === "conversation.item.input_audio_transcription.completed") {
        send(session.client, { type: "transcript", lane: laneName, role: "original", text: event.transcript || "" });
      } else if ((event.type === "response.output_audio.delta" || event.type === "response.audio.delta") && event.delta) {
        send(session.client, { type: "audio", lane: laneName, data: event.delta, sampleRate: 24000 });
      } else if ((event.type === "response.output_audio_transcript.delta" || event.type === "response.audio_transcript.delta") && event.delta) {
        send(session.client, { type: "translation", lane: laneName, text: event.delta });
      } else if (event.type === "response.done") {
        session.busy = false;
        send(session.client, { type: "done", lane: laneName, usage: event.response?.usage || null });
        send(session.client, { type: "ready" });
      } else if (event.type === "error") {
        session.busy = false;
        send(session.client, { type: "error", message: event.error?.message || "Eroare OpenAI." });
        send(session.client, { type: "ready" });
      }
    });
    ws.on("error", () => send(session.client, { type: "error", message: "Conexiunea audio nu a putut fi stabilită." }));
    ws.on("close", () => {
      lane.ready = false;
      if (session.client?.readyState === WebSocket.OPEN)
        send(session.client, { type: "error", message: "Conexiunea cu serviciul de traducere s-a întrerupt. Repornește sesiunea." });
    });
  }

  wss.on("connection", (client, _req, session) => {
    session.client = client;
    openLane(session, "local", session.from, session.to);
    openLane(session, "other", session.to, session.from);
    send(client, { type: "connecting" });

    client.on("message", raw => {
      const message = parse(raw);
      if (!message || Date.now() - session.created >= MAX_SESSION_MS) return;
      const lane = session.lanes[message.lane];
      if (message.type === "start") {
        if (session.busy || session.active || !lane?.ready || session.turns >= MAX_TURNS) {
          if (session.turns >= MAX_TURNS) send(client, { type: "error", message: "Limita de replici pentru această sesiune a fost atinsă." });
          return;
        }
        session.active = message.lane;
        lane.audioBytes = 0;
        send(client, { type: "recording", lane: message.lane });
      } else if (message.type === "audio") {
        if (!lane || session.active !== message.lane || !lane.ready || typeof message.data !== "string" || message.data.length > 65536) return;
        const bytes = Buffer.byteLength(message.data, "base64");
        if (bytes <= 0 || bytes % 2 || lane.audioBytes + bytes > MAX_AUDIO_BYTES) {
          send(client, { type: "error", message: "Replică prea lungă; limita este 30 de secunde." });
          return;
        }
        lane.audioBytes += bytes;
        send(lane.ws, { type: "input_audio_buffer.append", audio: message.data });
      } else if (message.type === "stop" && lane && session.active === message.lane) {
        session.active = null;
        if (lane.audioBytes < MIN_AUDIO_BYTES) {
          send(lane.ws, { type: "input_audio_buffer.clear" });
          send(client, { type: "ready" });
          return;
        }
        session.busy = true;
        session.turns++;
        send(client, { type: "translating", lane: message.lane });
        send(lane.ws, { type: "input_audio_buffer.commit" });
        send(lane.ws, { type: "response.create" });
      }
    });

    client.on("close", () => {
      for (const lane of Object.values(session.lanes)) close(lane.ws);
      sessions.delete(session.id);
    });
  });

  const janitor = setInterval(() => {
    for (const session of sessions.values()) {
      if (Date.now() - session.created >= MAX_SESSION_MS) {
        send(session.client, { type: "error", message: "Sesiune expirată. Pornește una nouă." });
        close(session.client);
        for (const lane of Object.values(session.lanes)) close(lane.ws);
        sessions.delete(session.id);
      }
    }
  }, 60000);
  janitor.unref?.();

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url, "http://localhost");
      const session = sessions.get(url.searchParams.get("id") || "");
      if (!session || session.client || url.searchParams.get("token") !== session.token ||
          Date.now() - session.created >= MAX_SESSION_MS) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req, session));
    }
  };
}
