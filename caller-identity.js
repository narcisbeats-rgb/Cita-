// Own-number identity guard for provider-routed translated calls.
// Provider verification is necessary but never replaces binding the number to an authenticated user.
export const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizeE164(input) {
  if (typeof input !== "string" || input.length > 40) return null;
  const number = input.replace(/[\s().-]/g, "");
  return E164.test(number) ? number : null;
}

export function providerHasVerifiedNumber(response, exactNumber) {
  const data = response?.data;
  return Boolean(
    data?.record_type === "verified_number" &&
    data.phone_number === exactNumber &&
    typeof data.verified_at === "string" &&
    Number.isFinite(Date.parse(data.verified_at))
  );
}

export async function requireOwnerVerifiedCaller({ ownerId, numberRecord, providerLookup }) {
  if (!ownerId || !numberRecord || numberRecord.user_id !== ownerId) return null;
  if (numberRecord.status !== "verified" || !normalizeE164(numberRecord.phone_number)) return null;
  // No fallback to a global Telnyx number and no caller-supplied "from" value.
  const provider = await providerLookup(numberRecord.phone_number);
  return providerHasVerifiedNumber(provider, numberRecord.phone_number) ? numberRecord.phone_number : null;
}

export function createTelnyxVerifiedNumbers({ apiKey, fetchImpl = fetch, baseUrl = "https://api.telnyx.com/v2" }) {
  if (typeof apiKey !== "string" || !apiKey) throw Error("Telnyx API key missing");
  async function request(method, resource, body) {
    const response = await fetchImpl(baseUrl + "/verified_numbers" + resource, {
      method,
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(7000)
    });
    let data = null;
    try { data = await response.json(); } catch { /* Do not trust an empty response. */ }
    if (!response.ok) {
      const error = new Error("Telnyx verification request was not accepted");
      error.providerStatus = response.status;
      throw error;
    }
    return data;
  }
  return Object.freeze({
    start(number, method = "sms") {
      if (!normalizeE164(number) || !["sms", "call"].includes(method)) throw Error("Invalid verification request");
      // A verification message/call may incur a charge; only call following user's explicit action.
      return request("POST", "", { phone_number: number, verification_method: method });
    },
    submit(number, code) {
      if (!normalizeE164(number) || typeof code !== "string" || !/^\d{4,8}$/.test(code)) throw Error("Invalid verification code");
      return request("POST", "/" + encodeURIComponent(number) + "/actions/verify", { verification_code: code });
    },
    lookup(number) {
      if (!normalizeE164(number)) throw Error("Invalid number");
      return request("GET", "/" + encodeURIComponent(number));
    }
  });
}
