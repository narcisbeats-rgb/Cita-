import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html = readFileSync(new URL("../public/interpreter.html", import.meta.url), "utf8");
const inline = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(inline, "Interpreter inline script must exist");
new Script(inline[1], { filename: "public/interpreter.html" });

for (const id of [
  "startSession", "endSession", "from", "to", "uiLanguage", "voice", "pin",
  "local", "other", "status", "error", "swapLanguages", "replayTranslation",
  "sessionClock", "sessionState", "localOriginal", "localTranslation",
  "otherOriginal", "otherTranslation"
]) {
  assert.match(html, new RegExp('id="' + id + '"'), "Missing UI element: " + id);
}
for (const lang of ["ro", "en", "da", "es"]) {
  assert.match(html, new RegExp("\\b" + lang + ":\\{badge:"), "Missing UI translation: " + lang);
}
assert.match(html, /recordTimer=setTimeout\(/, "Missing turn timeout");
assert.match(html, /serverReady=true;ready=true;busy=playing\.size>0\|\|replaying/, "Playback must block next turn");
assert.doesNotMatch(html, /AGENT_PRIVATE_PIN|\/api\/agent-call/, "Public interpreter must not expose private agent access");
console.log("Interpreter HTML syntax and UI smoke checks passed.");
