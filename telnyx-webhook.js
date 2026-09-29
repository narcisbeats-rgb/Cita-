import crypto from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_AGE_SECONDS = 300;

export function verifyTelnyxWebhook({ rawBody, signature, timestamp, publicKey, nowSeconds = Math.floor(Date.now() / 1000) }) {
  // Never verify a JSON.stringify() reconstruction: Telnyx signs the original bytes.
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
  if (typeof signature !== "string" || !BASE64.test(signature)) return false;
  if (typeof publicKey !== "string" || !BASE64.test(publicKey)) return false;
  if (typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp)) return false;

  const signedAt = Number(timestamp);
  if (!Number.isSafeInteger(signedAt) || Math.abs(nowSeconds - signedAt) > MAX_AGE_SECONDS) return false;

  const signatureBytes = Buffer.from(signature, "base64");
  const publicKeyBytes = Buffer.from(publicKey, "base64");
  if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) return false;

  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki"
    });
    const signedBody = Buffer.concat([Buffer.from(timestamp + "|", "utf8"), rawBody]);
    return crypto.verify(null, signedBody, key, signatureBytes);
  } catch {
    return false;
  }
}
