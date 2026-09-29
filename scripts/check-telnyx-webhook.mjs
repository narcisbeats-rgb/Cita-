import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { verifyTelnyxWebhook } from "../telnyx-webhook.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const key = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const nowSeconds = 1_799_000_000;
const timestamp = String(nowSeconds);
const body = Buffer.from('{"data": { "event_type":"call.answered","payload":{} }}');
const signature = crypto.sign(null, Buffer.concat([Buffer.from(timestamp + "|"), body]), privateKey).toString("base64");
const good = { rawBody: body, signature, timestamp, publicKey: key, nowSeconds };

assert.equal(verifyTelnyxWebhook(good), true, "accept a valid signed raw payload");
assert.equal(verifyTelnyxWebhook({ ...good, rawBody: Buffer.from(JSON.stringify(JSON.parse(body.toString()))) }), false, "reject reserialized JSON");
assert.equal(verifyTelnyxWebhook({ ...good, rawBody: Buffer.from(body.toString().replace("answered", "hangup")) }), false, "reject tampering");
assert.equal(verifyTelnyxWebhook({ ...good, signature: "" }), false, "reject missing signature");
assert.equal(verifyTelnyxWebhook({ ...good, signature: "bad" }), false, "reject malformed signature");
assert.equal(verifyTelnyxWebhook({ ...good, publicKey: "" }), false, "reject missing public key");
assert.equal(verifyTelnyxWebhook({ ...good, publicKey: "bad" }), false, "reject malformed public key");
assert.equal(verifyTelnyxWebhook({ ...good, timestamp: "invalid" }), false, "reject invalid timestamp");
assert.equal(verifyTelnyxWebhook({ ...good, nowSeconds: nowSeconds + 301 }), false, "reject old replay");
assert.equal(verifyTelnyxWebhook({ ...good, nowSeconds: nowSeconds - 301 }), false, "reject future timestamp");
assert.equal(verifyTelnyxWebhook({ ...good, rawBody: undefined }), false, "reject missing raw body");

const server = fs.readFileSync("server.js", "utf8");
assert.match(server, /req\.rawBody\s*=\s*Buffer\.from\(body\)/, "capture original JSON bytes");
assert.match(server, /app\.post\("\/agent-webhook",\s*requireTelnyxWebhookRequest,/, "verify agent webhook");
assert.match(server, /app\.post\("\/telnyx-webhook",\s*requireTelnyxWebhookRequest,/, "verify translation webhook");
console.log("Telnyx signature and anti-replay checks passed.");
