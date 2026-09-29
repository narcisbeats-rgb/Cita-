import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const html = read("index.html");
const beta = read("public/phone-beta.html");
const server = read("server.js");
const activity = read("android/app/src/main/java/com/traducerelive/mobile/MainActivity.java");
const script = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(script, "Call page script exists");
new Script(script[1], { filename: "index.html" });
const betaScript=beta.split("<script>")[1]?.split("</script>")[0];
assert.ok(betaScript,"Beta entry script exists");
new Script(betaScript,{filename:"public/phone-beta.html"});
assert.match(beta,/data\.enabled===true&&data\.callerId==="provider-configured"/,"Entry is fail closed");
for (const id of ["call", "providerConsent", "callAvailability", "phone", "pin", "hang"]) {
  assert.match(html, new RegExp('id="' + id + '"'), "Missing call control: " + id);
}
assert.match(html, /href="\/interpreter\.html"/, "Public navigation returns to interpreter");
assert.doesNotMatch(html, /href="\/agent"/, "Private agent is not linked in public phone UI");
assert.match(server, /PHONE_TRANSLATION_ENABLED = process\.env\.PHONE_TRANSLATION_ENABLED === "true"/, "Paid calls default off");
assert.match(server, /if \(!PHONE_TRANSLATION_ENABLED\) return res\.status\(503\)/, "Server rejects disabled calls");
assert.match(server, /req\.body\?\.providerConsent !== true/, "Server requires explicit per-call consent");
assert.match(server, /const PHONE_BETA_MAX_SESSIONS = 1/, "Single call beta guard");
assert.match(server, /const PHONE_BETA_MAX_MS = 10 \* 60 \* 1000/, "Paid call timeout guard");
assert.match(server, /from: TELNYX_FROM_NUMBER/, "Provider number is configured by server");
assert.match(activity, /"Apel tradus", "⇄", "\/phone-beta\.html", true/, "Translated calls start at the guarded beta entry");
assert.match(activity, /webView\.loadUrl\(ORIGIN \+ "\/phone-beta\.html"\)/, "Android opens the fail-closed translated-call entry");
assert.match(activity, /"Sună cu SIM", "☎", "sim:", false/, "Native SIM tab remains distinct");
assert.match(beta, /location\.assign\("\/"\)/, "Beta entry controls navigation to the calling form");
assert.doesNotMatch(activity, /addNav\([^\n]*"\/agent"/, "Private agent absent in Android public navigation");
console.log("Translated-call beta UI and safety smoke checks passed.");
