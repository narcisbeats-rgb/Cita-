import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createInterpreter } from "./interpreter.js";

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
const AGENT_PRIVATE_PIN = process.env.AGENT_PRIVATE_PIN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const VOICES = new Set(["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"]);
const sessions = new Map();
const agentSessions = new Map();
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
  const table = {
    ro: { code: "ro", english: "Romanian", local: "română" },
    en: { code: "en", english: "English", local: "engleză" },
    es: { code: "es", english: "Spanish", local: "spaniolă" }
  };
  return table[code] || table.ro;
}
function normalizeVoice(value) {
  return VOICES.has(String(value || "").toLowerCase()) ? String(value).toLowerCase() : "cedar";
}
function normalizeAgentRealtimeModel(value) {
  const model = String(value || "").trim();
  return ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"].includes(model)
    ? model
    : "gpt-realtime-2.1-mini";
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

function estimateRealtimeResponseCost(usage, model = OPENAI_REALTIME_MODEL) {
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

  if (String(model).includes("mini")) {
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
  const localIsDanish = s.direction === "local-da";
  const localLanguage = localIsDanish ? "Danish" : lang.english;
  const remoteLanguage = localIsDanish ? lang.english : "Danish";
  const baseRule = "Act only as a live interpreter. Never answer the speaker. Never add commentary, greetings, explanations or information. Preserve names, numbers, dates, tone and intent. Output only the translation.";

  s.localToDa = openRealtime({
    side: "local-to-remote",
    instructions: baseRule + " Translate " + localLanguage + " speech into natural spoken " + remoteLanguage + ".",
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
      safeSend(s.client, { type: "state", state: "translating-to-remote" });
    },
    onResponseStart: () => {
      s.localToDaActive = true;
      safeSend(s.client, { type: "state", state: "translating-to-remote" });
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
    side: "remote-to-local",
    instructions: baseRule + " Translate " + remoteLanguage + " speech into natural spoken " + localLanguage + ".",
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
      safeSend(s.client, { type: "state", state: "translating-to-you" });
    },
    onResponseStart: () => {
      s.daToLocalActive = true;
      safeSend(s.client, { type: "state", state: "translating-to-you" });
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

function agentPersonalityInstructions(code) {
  const styles = {
    formal: "Use a formal, professional and respectful tone. Be concise, structured and courteous. Avoid slang, jokes and unnecessary small talk.",
    normal: "Use a natural, neutral and conversational tone. Be clear, concise and polite without sounding overly formal.",
    friendly: "Use a warm, relaxed and friendly tone. Sound approachable and human-like in rhythm, with brief natural acknowledgements, while staying focused on the objective.",
    negotiator: "Use a calm, confident and tactful negotiation style. Politely explore flexibility, alternatives, best available terms, discounts or options when relevant. Ask follow-up questions before giving up. Never pressure, threaten, deceive, invent leverage, misrepresent facts, or make commitments on the user's behalf."
  };
  return styles[code] || styles.normal;
}
function summaryLanguageName(code) {
  return ({ ro: "Romanian", en: "English", da: "Danish", es: "Spanish" })[code] || "Romanian";
}
function agentLanguageConfig(code) {
  const table = {
    auto: { code: null, name: "Automatic", initial: "Danish" },
    da: { code: "da", name: "Danish" },
    en: { code: "en", name: "English" },
    es: { code: "es", name: "Spanish" },
    ro: { code: "ro", name: "Romanian" }
  };
  return table[code] || table.auto;
}
function agentSend(s, data) {
  safeSend(s?.client, data);
}
function agentTranscript(s, who, delta, final = false) {
  if (!s) return;
  const key = who === "agent" ? "agentText" : "remoteText";
  if (delta) s[key] += delta;
  if (final && s[key] && !s[key].endsWith("\n")) s[key] += "\n";
  agentSend(s, { type: "transcript", who, delta: delta || "", final });
}
function extractResponseText(data) {
  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") parts.push(content.text);
      if (typeof content?.output_text === "string") parts.push(content.output_text);
    }
  }
  return parts.join("\n").trim();
}
function parseStructuredAgentSummary(text) {
  const cleaned = String(text || "").trim()
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/, "");
  try {
    const value = JSON.parse(cleaned);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const list = key => Array.isArray(value[key]) ? value[key].filter(Boolean).slice(0, 20) : [];
    return {
      status: String(value.status || "partial").slice(0, 40),
      result: String(value.result || "").slice(0, 1200),
      answers: list("answers").map(x => ({
        question: String(x?.question || "").slice(0, 500),
        answer: String(x?.answer || "").slice(0, 1000)
      })).filter(x => x.question || x.answer),
      facts: list("facts").map(x => ({
        label: String(x?.label || "").slice(0, 200),
        value: String(x?.value || "").slice(0, 1000)
      })).filter(x => x.label || x.value),
      prices: list("prices").map(String).map(x => x.slice(0, 500)),
      dates: list("dates").map(String).map(x => x.slice(0, 500)),
      conditions: list("conditions").map(String).map(x => x.slice(0, 800)),
      unanswered: list("unanswered").map(String).map(x => x.slice(0, 800)),
      next_steps: list("next_steps").map(String).map(x => x.slice(0, 800))
    };
  } catch {
    return null;
  }
}
function publishAgentSummary(s, summaryText, fallbackMessage = "Apel încheiat. Rezumatul automat nu a putut fi generat.") {
  if (!s) return;
  const text = String(summaryText || "").trim();
  s.summaryData = parseStructuredAgentSummary(text);
  s.summary = s.summaryData?.result || text || fallbackMessage;
  s.summaryPending = false;
  if (s.summaryTimer) {
    clearTimeout(s.summaryTimer);
    s.summaryTimer = null;
  }
  agentSend(s, { type: "summary", text: s.summary, data: s.summaryData || null });
  agentSend(s, { type: "summary-status", status: "ready" });
}
function requestAgentSummaryFromRealtime(s) {
  if (!s || s.summaryStarted) return;
  s.summaryStarted = true;

  if (!s.openaiWs || s.openaiWs.readyState !== WebSocket.OPEN || !s.openaiReady) {
    publishAgentSummary(s, "", "Apel încheiat. Nu există suficient context pentru un rezumat.");
    closeSocket(s.openaiWs);
    return;
  }

  s.summaryPending = true;
  const summaryInstructions =
    "INTERNAL POST-CALL TASK. The phone call has ended. Do not speak audio and do not call any tools. " +
    "Using only the conversation you heard in this Realtime session, create a concise structured summary for Narcis. " +
    "Objective of the call: " + s.objective + ". " +
    (s.context ? "User context: " + s.context + ". " : "") +
    "Write all user-facing text in " + summaryLanguageName(s.summaryLanguage) + ". " +
    "Return ONLY valid JSON, with no markdown and no code fences. Use exactly this shape: " +
    '{"status":"obtained|partial|no_answer","result":"one clear overall result","answers":[{"question":"what needed to be learned","answer":"direct answer"}],"facts":[{"label":"short label","value":"exact useful fact"}],"prices":["price or money fact"],"dates":["date/time/deadline"],"conditions":["condition, requirement, limitation or offer"],"unanswered":["important point not answered"],"next_steps":["what Narcis should do next, if anything"]}. ' +
    "Include only information actually supported by the call. Preserve exact numbers, currencies, dates and names when you are confident. Do not invent missing details.";

  const sendSummaryRequest = () => {
    if (!s.openaiWs || s.openaiWs.readyState !== WebSocket.OPEN || !s.summaryPending) {
      publishAgentSummary(s, "", "Apel încheiat. Rezumatul automat nu a putut fi generat.");
      closeSocket(s.openaiWs);
      return;
    }
    s.openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        metadata: { purpose: "post_call_summary" },
        output_modalities: ["text"],
        tool_choice: "none",
        instructions: summaryInstructions
      }
    }));
    s.summaryTimer = setTimeout(() => {
      if (!s.summaryPending) return;
      publishAgentSummary(s, "", "Apel încheiat. Rezumatul a expirat înainte să fie generat.");
      closeSocket(s.openaiWs);
    }, 12000);
    s.summaryTimer.unref?.();
  };

  if (s.responseActive) {
    try { s.openaiWs.send(JSON.stringify({ type: "response.cancel" })); } catch {}
    setTimeout(sendSummaryRequest, 180).unref?.();
  } else {
    sendSummaryRequest();
  }
}
async function startAgentRecording(s, toolCallId) {
  if (!s?.recordRequested || !s?.callControlId || s.recordingActive) return false;
  try {
    await telnyx("/calls/" + encodeURIComponent(s.callControlId) + "/actions/record_start", {
      method: "POST",
      body: {
        channels: "dual",
        format: "mp3",
        recording_track: "both",
        play_beep: true,
        command_id: crypto.randomUUID()
      }
    });
    s.recordingActive = true;
    agentSend(s, { type: "recording-status", status: "recording" });
    if (s.openaiWs?.readyState === WebSocket.OPEN && toolCallId) {
      s.openaiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify({ ok: true, recording_started: true })
        }
      }));
      s.openaiWs.send(JSON.stringify({ type: "response.create" }));
    }
    return true;
  } catch (e) {
    console.error("Agent recording start error:", e.message);
    agentSend(s, { type: "recording-status", status: "error", message: e.message });
    if (s.openaiWs?.readyState === WebSocket.OPEN && toolCallId) {
      s.openaiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify({ ok: false, error: "Recording could not be started. Continue the call without recording." })
        }
      }));
      s.openaiWs.send(JSON.stringify({ type: "response.create" }));
    }
    return false;
  }
}
async function stopAgentRecording(s) {
  if (!s?.recordingActive || s.recordStopRequested || !s.callControlId) return;
  s.recordStopRequested = true;
  try {
    await telnyx("/calls/" + encodeURIComponent(s.callControlId) + "/actions/record_stop", {
      method: "POST",
      body: { command_id: crypto.randomUUID() }
    });
  } catch (e) {
    console.error("Agent recording stop error:", e.message);
  }
}
async function endAgentTelnyxCall(s) {
  if (!s?.callControlId || s.hangupRequested) return;
  s.hangupRequested = true;
  await stopAgentRecording(s);
  try {
    await telnyx("/calls/" + encodeURIComponent(s.callControlId) + "/actions/hangup", {
      method: "POST",
      body: { command_id: crypto.randomUUID() }
    });
  } catch (e) {
    console.error("Agent hangup error:", e.message);
  }
}
function finalizeAgentSession(s, status = "completed") {
  if (!s || s.ended) return;
  s.ended = true;
  s.status = status;
  s.state = "ended";
  agentSend(s, { type: "status", status });
  agentSend(s, { type: "state", state: "ended" });
  agentSend(s, { type: "summary-status", status: "generating" });
  closeSocket(s.telnyxWs);
  requestAgentSummaryFromRealtime(s);
  setTimeout(() => {
    closeSocket(s.openaiWs);
    closeSocket(s.client);
    agentSessions.delete(s.id);
  }, 30 * 60 * 1000).unref?.();
}
function maybeStartAgentGreeting(s) {
  if (!s || !s.answered || !s.amdHuman || !s.openaiReady || s.greetingStarted || s.openaiWs?.readyState !== WebSocket.OPEN || s.telnyxWs?.readyState !== WebSocket.OPEN) return;
  s.greetingStarted = true;
  s.openaiWs.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: s.testMode
          ? "The phone has just been answered. This is a test call to Narcis Rug. Start naturally and briefly, then follow the test objective. Ask only one opening question and wait for the answer. Do not say you are calling on behalf of Narcis Rug."
          : (s.mode === "natural"
              ? "The phone has just been answered. Start the call naturally and briefly. Say that Narcis Rug asked you to call, then use the objective to choose ONE short opening question. Do not explain the whole objective, do not ask multiple questions at once, and wait for the other person to answer."
              : "The phone has just been answered. Start the call now. Say naturally that you are calling on behalf of Narcis Rug, state the purpose briefly, and pursue the objective. Do not announce that you are an AI assistant and do not claim to be Narcis Rug.")
      }]
    }
  }));
  s.openaiWs.send(JSON.stringify({ type: "response.create" }));
}
function openAgentRealtime(s) {
  if (!s || !s.amdHuman || s.openaiWs || !OPENAI_API_KEY) return;
  const lang = agentLanguageConfig(s.language);
  const personality = agentPersonalityInstructions(s.personality);
  const languageInstruction = s.language === "auto"
    ? (s.testMode
        ? "Start the test call in Romanian. Automatically detect the language actually spoken by Narcis. If he clearly switches to another language, switch with him naturally. Do not announce language detection."
        : "Start the call in Danish. Automatically detect the language actually spoken by the other party. If they clearly reply in another language, switch to that language and continue naturally in it. If they later change language, follow them. Do not announce that you detected or switched languages.")
    : "Speak ONLY in " + lang.name + ".";
  const identityInstruction = s.testMode
    ? "This is a test call directly to Narcis Rug. At the beginning, say naturally that this is a short test call to check the agent audio and behavior. Do not say you are calling on behalf of Narcis Rug."
    : "You are calling on behalf of Narcis Rug. At the beginning of the call, say that naturally and briefly. Do not announce that you are an AI assistant, but never claim to be Narcis Rug or falsely claim to be human.";
  const modeInstruction = s.mode === "natural"
    ? "NATURAL CONVERSATION MODE: Treat the objective as a conversation goal or topic, not as a checklist. Behave like a flexible conversational partner rather than a scripted agent. Speak in short turns: normally one sentence, maximum two short sentences, then STOP and wait. Ask only ONE question at a time. Never stack several questions. React to what the other person actually says before moving on. If they change the subject, ask something unexpected, make a joke, or ask a reasonable general question outside the original objective, respond naturally and briefly before deciding whether to return to the original topic. Do NOT say that something is outside your task just because it is off-topic. You may use general knowledge when you are reasonably confident, but never invent current facts, private facts, or personal details about Narcis that were not provided in the objective/context. If you genuinely do not know, say so briefly and naturally. If asked directly whether you are AI, automated, or human, answer truthfully and briefly; never falsely claim to be human. Do not volunteer long explanations, lists, summaries or all instructions at once. Leave comfortable space for the other person to speak. Do not turn the call into an interview. Do not recap the conversation unless the other person asks or a recap is genuinely needed. If the objective asks you to change language later, wait until the stated moment or permission before switching."
    : "INFORMATION MODE: Pursue the objective efficiently. Ask concise follow-up questions when information is missing. Confirm important numbers, dates, prices and names when useful. Keep each turn concise and avoid asking too many questions at once.";
  const instructions =
    "You are a phone-call assistant. " + languageInstruction + " " +
    "Conversation style: " + personality + " " +
    identityInstruction + " " +
    modeInstruction + " " +
    (s.recordRequested
      ? "The user requested an audio recording. Immediately after the brief greeting and before the substantive conversation, clearly ask the other person for permission to record so Narcis can listen to the conversation later. Ask this as one short standalone question, then wait. Do NOT start recording until the other person explicitly agrees. The moment they clearly agree, call the start_call_recording tool immediately before continuing with the conversation. After the tool confirms recording_started=true, continue naturally. If they refuse or do not clearly agree, continue without recording and do not ask again. "
      : "") +
    "Primary objective: " + s.objective + ". " +
    (s.context ? "Helpful context supplied by the user: " + s.context + ". " : "") +
    "You may freely obtain information. For a LOW-RISK, NON-BINDING action such as making a simple appointment, holding a reservation with no payment or penalty, confirming a callback/follow-up, or communicating a tentative non-binding preference, you MUST first call the request_user_confirmation tool and wait for Narcis to approve or refuse. Before calling that tool, briefly tell the other person you need a moment to confirm. Never assume approval. " +
    "Never perform or confirm purchases, payments, contracts, legally binding acceptance, subscriptions, cancellations with financial/legal effect, account changes, identity verification, or anything requiring CPR, MitID, bank/card data, passwords or other sensitive credentials. Those must be handled personally by Narcis even if he approves in the app. " +
    "If the other person asks for a prohibited commitment or sensitive information, say that Narcis must handle that personally. " +
    (s.mode === "natural"
      ? "When the conversation has naturally finished or the objective is complete, do not force a recap. Say a brief natural goodbye, then call the end_call tool. If they want to keep chatting and it remains relevant, continue naturally."
      : "When the objective is answered, briefly recap the key information to the other person if appropriate, thank them, say goodbye, then call the end_call tool. If they refuse or cannot help, politely end the call.");

  const ws = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(s.model || OPENAI_REALTIME_MODEL),
    { headers: { Authorization: "Bearer " + OPENAI_API_KEY } }
  );
  s.openaiWs = ws;

  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions,
        tools: [
          ...(s.recordRequested ? [{
            type: "function",
            name: "start_call_recording",
            description: "Start recording only after the other person has explicitly agreed to the recording during this call. Never call this tool before explicit consent.",
            parameters: {
              type: "object",
              properties: {
                consent_confirmed: { type: "boolean", description: "Must be true only when the other person explicitly agreed to recording." }
              },
              required: ["consent_confirmed"]
            }
          }] : []),
          {
            type: "function",
            name: "request_user_confirmation",
            description: "Ask Narcis for approval before a low-risk, non-binding action. Use only for appointment/reservation/follow-up/tentative non-binding preference. Never use this to authorize payment, purchase, contract, legal acceptance, subscription, sensitive-data disclosure, identity verification, or account changes.",
            parameters: {
              type: "object",
              properties: {
                category: {
                  type: "string",
                  enum: ["appointment", "reservation", "follow_up", "non_binding_preference"]
                },
                question_ro: {
                  type: "string",
                  description: "A short Romanian yes/no question for Narcis, including exact date, time, price or condition when relevant."
                },
                details: {
                  type: "string",
                  description: "Concise supporting details from the call, without sensitive credentials."
                }
              },
              required: ["category", "question_ro", "details"]
            }
          },
          {
            type: "function",
            name: "end_call",
            description: "End the phone call only after the objective is complete, impossible, refused, or the conversation has naturally concluded. Say a brief goodbye before using this tool.",
            parameters: {
              type: "object",
              properties: { reason: { type: "string" } },
              required: ["reason"]
            }
          }
        ],
        tool_choice: "auto",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 250,
              silence_duration_ms: 800,
              create_response: true,
              interrupt_response: true
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: s.voice
          }
        }
      }
    }));
  });

  ws.on("message", raw => {
    const ev = safeJson(raw);
    if (!ev) return;
    if (ev.type === "response.created") {
      s.responseActive = true;
      return;
    }
    if (ev.type === "session.updated") {
      s.openaiReady = true;
      agentSend(s, { type: "state", state: "ready" });
      maybeStartAgentGreeting(s);
      return;
    }
    if (ev.type === "input_audio_buffer.speech_started") {
      agentSend(s, { type: "state", state: "listening" });
      return;
    }
    if (ev.type === "input_audio_buffer.speech_stopped") {
      agentSend(s, { type: "state", state: "thinking" });
      return;
    }
    if ((ev.type === "response.output_audio.delta" || ev.type === "response.audio.delta") && ev.delta) {
      if (s.telnyxWs?.readyState === WebSocket.OPEN) {
        s.telnyxWs.send(JSON.stringify({ event: "media", media: { payload: ev.delta } }));
      }
      agentSend(s, { type: "state", state: "speaking" });
      return;
    }
    if (ev.type === "response.done") {
      s.responseActive = false;
      s.realtimeUsd = (s.realtimeUsd || 0) + estimateRealtimeResponseCost(ev.response?.usage || null, s.model);
      agentSend(s, { type: "usage", realtimeUsd: s.realtimeUsd });

      if (ev.response?.metadata?.purpose === "post_call_summary") {
        const summaryText = extractResponseText(ev.response);
        publishAgentSummary(s, summaryText, "Apel încheiat. Rezumatul automat nu a returnat text.");
        closeSocket(s.openaiWs);
        return;
      }

      const outputs = Array.isArray(ev.response?.output) ? ev.response.output : [];
      const recordingTool = outputs.find(x => x?.type === "function_call" && x?.name === "start_call_recording");
      if (recordingTool) {
        let args = {};
        try { args = JSON.parse(recordingTool.arguments || "{}"); } catch {}
        if (args.consent_confirmed === true && s.recordRequested) {
          startAgentRecording(s, recordingTool.call_id);
        } else if (s.openaiWs?.readyState === WebSocket.OPEN) {
          s.openaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: recordingTool.call_id,
              output: JSON.stringify({ ok: false, error: "Explicit recording consent was not confirmed. Continue without recording." })
            }
          }));
          s.openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
        return;
      }
      const confirmationTool = outputs.find(x => x?.type === "function_call" && x?.name === "request_user_confirmation");
      if (confirmationTool) {
        let args = {};
        try { args = JSON.parse(confirmationTool.arguments || "{}"); } catch {}
        const allowedCategories = new Set(["appointment", "reservation", "follow_up", "non_binding_preference"]);
        const category = allowedCategories.has(args.category) ? args.category : "follow_up";
        const confirmationId = crypto.randomUUID();
        s.pendingConfirmation = {
          id: confirmationId,
          callId: confirmationTool.call_id,
          category,
          question: String(args.question_ro || "Confirmi această acțiune?").slice(0, 600),
          details: String(args.details || "").slice(0, 1200),
          createdAt: Date.now()
        };
        agentSend(s, {
          type: "confirmation-request",
          id: confirmationId,
          category,
          question: s.pendingConfirmation.question,
          details: s.pendingConfirmation.details
        });
        agentSend(s, { type: "state", state: "awaiting-confirmation" });
        return;
      }
      const tool = outputs.find(x => x?.type === "function_call" && x?.name === "end_call");
      if (tool) {
        let reason = "completed";
        try { reason = JSON.parse(tool.arguments || "{}").reason || reason; } catch {}
        agentSend(s, { type: "state", state: "ending", reason });
        setTimeout(() => endAgentTelnyxCall(s), 1200).unref?.();
      } else {
        agentSend(s, { type: "state", state: "listening" });
      }
      return;
    }
    if (ev.type === "error") {
      const message = ev.error?.message || "OpenAI Realtime error";
      console.error("Agent OpenAI error:", message);
      agentSend(s, { type: "error", message });
    }
  });

  ws.on("error", e => agentSend(s, { type: "error", message: e.message }));
}

app.get("/", (_req, res) => res.sendFile(path.resolve("index.html")));
app.get("/agent", (_req, res) => {
  if (!AGENT_PRIVATE_PIN) return res.status(404).send("Not found");
  res.sendFile(path.resolve("agent.html"));
});

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


app.post("/api/agent-call", async (req, res) => {
  try {
    if (!AGENT_PRIVATE_PIN) return res.status(404).json({ error: "Agentul privat nu este activat." });
    const missing = missingConfig();
    if (missing.length) return res.status(503).json({ error: "Missing config: " + missing.join(", ") });
    if (String(req.body.pin || "") !== AGENT_PRIVATE_PIN) return res.status(401).json({ error: "PIN privat greșit" });
    const to = normalizePhone(req.body.to);
    if (!to) return res.status(400).json({ error: "Numărul trebuie scris internațional, de exemplu +45..." });
    const objective = String(req.body.objective || "").trim();
    if (objective.length < 8) return res.status(400).json({ error: "Scrie mai clar ce trebuie să afle agentul." });
    if (objective.length > 2500) return res.status(400).json({ error: "Scopul apelului este prea lung." });

    const context = String(req.body.context || "").trim().slice(0, 3000);
    const testMode = req.body.testMode === true;
    const recordRequested = req.body.recordRequested === true;
    const summaryLanguage = ["ro","en","da","es"].includes(req.body.summaryLanguage) ? req.body.summaryLanguage : "ro";
    const language = ["auto","da","en","es","ro"].includes(req.body.language) ? req.body.language : "auto";
    const personality = ["formal","normal","friendly","negotiator"].includes(req.body.personality) ? req.body.personality : "normal";
    const mode = ["information","natural"].includes(req.body.mode) ? req.body.mode : "information";
    const voice = normalizeVoice(req.body.voice);
    const model = normalizeAgentRealtimeModel(req.body.model);
    const connectionId = await resolveConnectionId();
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");

    const s = {
      id, token, to, objective, context, language, personality, voice, model, mode, testMode, recordRequested, summaryLanguage,
      created: Date.now(), answered: false, amdHuman: false, amdResult: null, ended: false,
      status: "initiated", state: "waiting",
      callControlId: null, client: null, telnyxWs: null, openaiWs: null,
      openaiReady: false, greetingStarted: false, hangupRequested: false, responseActive: false,
      summary: "", summaryData: null, summaryStarted: false, summaryPending: false, summaryTimer: null,
      pendingConfirmation: null,
      recordingActive: false, recordStopRequested: false, recordingUrl: null,
      realtimeUsd: 0
    };
    agentSessions.set(id, s);

    const result = await telnyx("/calls", {
      method: "POST",
      body: {
        connection_id: connectionId,
        to,
        from: TELNYX_FROM_NUMBER,
        webhook_url: PUBLIC_BASE_URL + "/agent-webhook?sid=" + encodeURIComponent(id),
        stream_url: wsBase() + "/agent-media?sid=" + encodeURIComponent(id) + "&token=" + encodeURIComponent(token),
        stream_track: "inbound_track",
        stream_codec: "PCMU",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: "PCMU",
        stream_bidirectional_sampling_rate: 8000,
        stream_bidirectional_target_legs: "self",
        answering_machine_detection: "premium",
        command_id: crypto.randomUUID()
      }
    });

    s.callControlId = result.data?.call_control_id || null;
    res.json({ sessionId: id, token, status: "initiated" });
  } catch (e) {
    res.status(500).json({ error: e.message || "Nu am putut porni agentul" });
  }
});

app.post("/api/agent-confirm", async (req, res) => {
  const s = agentSessions.get(String(req.body.sessionId || ""));
  if (!s || req.body.token !== s.token) return res.status(401).json({ error: "Sesiune invalidă" });
  const pending = s.pendingConfirmation;
  if (!pending || req.body.confirmationId !== pending.id) {
    return res.status(409).json({ error: "Confirmarea nu mai este activă" });
  }
  if (!s.openaiWs || s.openaiWs.readyState !== WebSocket.OPEN) {
    return res.status(409).json({ error: "Agentul nu mai este conectat" });
  }

  const approved = req.body.approved === true;
  s.pendingConfirmation = null;
  s.openaiWs.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: pending.callId,
      output: JSON.stringify({
        approved,
        message: approved
          ? "Narcis approved this specific low-risk action. Proceed only with exactly this action, and stop if payment, contract, legal acceptance, account change, identity verification or sensitive data is required."
          : "Narcis refused this action. Do not perform or confirm it."
      })
    }
  }));
  s.openaiWs.send(JSON.stringify({ type: "response.create" }));
  agentSend(s, { type: "confirmation-result", id: pending.id, approved });
  agentSend(s, { type: "state", state: "thinking" });
  res.json({ ok: true, approved });
});

app.get("/api/agent-status", (req, res) => {
  const s = agentSessions.get(String(req.query.sid || ""));
  if (!s || String(req.query.token || "") !== s.token) {
    return res.status(404).json({ error: "Sesiune invalidă sau expirată" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    status: s.status || (s.ended ? "completed" : (s.answered ? "answered" : "initiated")),
    state: s.state || "waiting",
    answered: Boolean(s.answered),
    answeredAt: s.answeredAt || null,
    ended: Boolean(s.ended),
    summaryPending: Boolean(s.summaryPending),
    summary: s.summary || "",
    summaryData: s.summaryData || null,
    recordingUrl: s.recordingUrl || null,
    recordingActive: Boolean(s.recordingActive)
  });
});

app.post("/api/agent-hangup", async (req, res) => {
  const s = agentSessions.get(String(req.body.sessionId || ""));
  if (!s || req.body.token !== s.token) return res.status(401).json({ error: "Sesiune invalidă" });
  await endAgentTelnyxCall(s);
  res.json({ ok: true });
});

app.post("/agent-webhook", async (req, res) => {
  res.sendStatus(204);
  const id = String(req.query.sid || "");
  const s = agentSessions.get(id);
  const eventType = req.body?.data?.event_type || "";
  const payload = req.body?.data?.payload || {};
  console.log("Agent Telnyx webhook:", eventType, payload.call_control_id || payload.call_leg_id || "");
  if (!s) return;
  if (payload.call_control_id) s.callControlId = payload.call_control_id;

  if (eventType === "call.initiated") {
    s.status = "initiated";
    agentSend(s, { type: "status", status: "initiated" });
  } else if (eventType === "call.ringing") {
    s.status = "ringing";
    agentSend(s, { type: "status", status: "ringing" });
  } else if (eventType === "call.answered") {
    s.answered = true;
    s.answeredAt = Date.now();
    s.status = "answered";
    s.state = "checking-human";
    agentSend(s, { type: "status", status: "answered" });
    agentSend(s, { type: "state", state: "checking-human" });
    agentSend(s, { type: "call-start", at: s.answeredAt });
  } else if (eventType === "call.machine.premium.detection.ended") {
    const result = String(payload.result || "").toLowerCase();
    s.amdResult = result || "unknown";
    const human = result === "human_residence" || result === "human_business";
    const machine = result === "machine" || result === "silence" || result === "fax_detected";
    if (machine) {
      s.status = "voicemail";
      s.state = "voicemail-detected";
      agentSend(s, { type: "status", status: "voicemail" });
      agentSend(s, { type: "state", state: "voicemail-detected" });
      setTimeout(() => endAgentTelnyxCall(s), 150).unref?.();
    } else {
      s.amdHuman = true;
      s.status = human ? "human-detected" : "amd-uncertain";
      s.state = "human-detected";
      agentSend(s, { type: "status", status: s.status });
      agentSend(s, { type: "state", state: "human-detected" });
      openAgentRealtime(s);
      maybeStartAgentGreeting(s);
    }
  } else if (eventType === "call.machine.premium.greeting.ended") {
    const result = String(payload.result || "").toLowerCase();
    if (result === "beep_detected" && !s.amdHuman) {
      s.amdResult = "machine";
      agentSend(s, { type: "status", status: "voicemail" });
      agentSend(s, { type: "state", state: "voicemail-detected" });
      setTimeout(() => endAgentTelnyxCall(s), 100).unref?.();
    }
  } else if (eventType === "call.recording.saved") {
    const url = payload.recording_urls?.mp3 || payload.public_recording_urls?.mp3 ||
      payload.recording_urls?.wav || payload.public_recording_urls?.wav || null;
    if (url) {
      s.recordingUrl = url;
      s.recordingActive = false;
      agentSend(s, { type: "recording-ready", url, temporary: !payload.public_recording_urls?.mp3 && !payload.public_recording_urls?.wav });
    }
  } else if (eventType === "call.recording.error") {
    s.recordingActive = false;
    agentSend(s, { type: "recording-status", status: "error", message: "Telnyx recording error" });
  } else if (eventType === "call.hangup") {
    if (s.mediaStopFinalizeTimer) {
      clearTimeout(s.mediaStopFinalizeTimer);
      s.mediaStopFinalizeTimer = null;
    }
    finalizeAgentSession(s, "completed");
  }
});

app.post("/api/call", async (req, res) => {
  try {
    const missing = missingConfig();
    if (missing.length) return res.status(503).json({ error: "Missing config: " + missing.join(", ") });
    if (String(req.body.pin || "") !== APP_PIN) return res.status(401).json({ error: "PIN greșit" });

    const to = normalizePhone(req.body.to);
    if (!to) return res.status(400).json({ error: "Numărul trebuie scris internațional, de exemplu +45..." });

    const language = ["ro","en","es"].includes(req.body.language) ? req.body.language : "ro";
    const direction = req.body.direction === "local-da" ? "local-da" : "local-other";
    const voice = normalizeVoice(req.body.voice);
    const connectionId = await resolveConnectionId();
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");

    const s = {
      id, token, to, language, direction, voice, created: Date.now(),
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
    res.json({ sessionId: id, token, status: "initiated", language, direction, voice });
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
const interpreter = createInterpreter(app, { apiKey: OPENAI_API_KEY, model: OPENAI_REALTIME_MODEL, pin: APP_PIN });
const clientWss = new WebSocketServer({ noServer: true });
const telnyxWss = new WebSocketServer({ noServer: true });
const agentClientWss = new WebSocketServer({ noServer: true });
const agentMediaWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/interpreter-socket") {
    return interpreter.handleUpgrade(req, socket, head);
  }
  if (u.pathname === "/client") {
    return clientWss.handleUpgrade(req, socket, head, ws => clientWss.emit("connection", ws, req));
  }
  if (u.pathname === "/telnyx-media") {
    return telnyxWss.handleUpgrade(req, socket, head, ws => telnyxWss.emit("connection", ws, req));
  }
  if (u.pathname === "/agent-client") {
    return agentClientWss.handleUpgrade(req, socket, head, ws => agentClientWss.emit("connection", ws, req));
  }
  if (u.pathname === "/agent-media") {
    return agentMediaWss.handleUpgrade(req, socket, head, ws => agentMediaWss.emit("connection", ws, req));
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


agentClientWss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("sid") || "";
  const token = u.searchParams.get("token") || "";
  const s = agentSessions.get(id);
  if (!s || token !== s.token) return ws.close(1008, "Invalid agent session");

  s.client = ws;
  agentSend(s, { type: "status", status: s.status || (s.ended ? "completed" : (s.answered ? "answered" : "app-connected")) });
  agentSend(s, { type: "state", state: s.state || "waiting" });
  if (s.answeredAt) agentSend(s, { type: "call-start", at: s.answeredAt });
  if (s.summary) agentSend(s, { type: "summary", text: s.summary, data: s.summaryData || null });
  if (s.recordingUrl) agentSend(s, { type: "recording-ready", url: s.recordingUrl, temporary: true });
  else if (s.recordingActive) agentSend(s, { type: "recording-status", status: "recording" });
  if (s.pendingConfirmation) {
    agentSend(s, {
      type: "confirmation-request",
      id: s.pendingConfirmation.id,
      category: s.pendingConfirmation.category,
      question: s.pendingConfirmation.question,
      details: s.pendingConfirmation.details
    });
  }
  agentSend(s, { type: "usage", realtimeUsd: s.realtimeUsd || 0 });

  ws.on("close", () => {
    if (s.client === ws) s.client = null;
  });
});

agentMediaWss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("sid") || "";
  const token = u.searchParams.get("token") || "";
  const s = agentSessions.get(id);
  if (!s || token !== s.token) return ws.close(1008, "Invalid agent media session");

  s.telnyxWs = ws;
  openAgentRealtime(s);
  maybeStartAgentGreeting(s);

  ws.on("message", raw => {
    const m = safeJson(raw);
    if (!m) return;
    if (m.event === "start") {
      s.state = "connected";
      agentSend(s, { type: "state", state: "connected" });
      openAgentRealtime(s);
      maybeStartAgentGreeting(s);
      return;
    }
    if (m.event === "media" && m.media?.payload && s.openaiWs?.readyState === WebSocket.OPEN) {
      s.openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: m.media.payload }));
      return;
    }
    if (m.event === "stop") {
      s.state = "ended";
      agentSend(s, { type: "state", state: "ended" });
      if (s.answered && !s.ended) {
        clearTimeout(s.mediaStopFinalizeTimer);
        s.mediaStopFinalizeTimer = setTimeout(() => {
          if (!s.ended) finalizeAgentSession(s, "completed");
        }, 1200);
        s.mediaStopFinalizeTimer.unref?.();
      }
    }
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
  for (const [id, s] of agentSessions) {
    if (now - s.created > 2 * 60 * 60 * 1000) {
      finalizeAgentSession(s, "expired");
      agentSessions.delete(id);
    }
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
