const clicksendUsername = String(process.env.CLICKSEND_USERNAME || '').trim();
const clicksendApiKey = String(process.env.CLICKSEND_API_KEY || '').trim();
const clicksendFrom = String(process.env.CLICKSEND_FROM || '').trim();
const clicksendReady = Boolean(clicksendUsername && clicksendApiKey);

// Ensure the child core server spawned by gateway.js receives the same preload.
if (clicksendReady) {
  const preloadFlag = '--import=./clicksend-fetch-shim.js';
  const currentNodeOptions = String(process.env.NODE_OPTIONS || '').trim();
  if (!currentNodeOptions.includes('clicksend-fetch-shim.js')) {
    process.env.NODE_OPTIONS = [currentNodeOptions, preloadFlag].filter(Boolean).join(' ');
  }

  // Compatibility placeholders only; real credentials remain in CLICKSEND_*.
  process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'clicksend';
  process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'clicksend';
  process.env.TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || 'ClickSend';
}

const originalFetch = globalThis.fetch.bind(globalThis);

function isLegacySmsRequest(input) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
  return url.startsWith('https://api.twilio.com/2010-04-01/Accounts/') && url.endsWith('/Messages.json');
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

if (clicksendReady) {
  globalThis.fetch = async (input, init = {}) => {
    if (!isLegacySmsRequest(input)) return originalFetch(input, init);

    const params = new URLSearchParams(typeof init.body === 'string' ? init.body : String(init.body || ''));
    const to = String(params.get('To') || '').trim();
    const body = String(params.get('Body') || '').trim();

    if (!to || !body) {
      return jsonResponse({ message: 'invalid_sms_payload', code: 'CLICKSEND_INVALID_PAYLOAD' }, 400);
    }

    const message = {
      source: 'DetectorDeCitas',
      body,
      to,
      ...(clicksendFrom ? { from: clicksendFrom } : {})
    };

    const response = await originalFetch('https://rest.clicksend.com/v3/sms/send', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clicksendUsername}:${clicksendApiKey}`).toString('base64')}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ messages: [message] })
    });

    const payload = await response.json().catch(() => ({}));
    const sentMessage = payload?.data?.messages?.[0] || null;
    const queued = Number(payload?.data?.queued_count || 0) > 0;
    const blocked = Number(payload?.data?.blocked_count || 0) > 0;
    const success = response.ok && payload?.response_code === 'SUCCESS' && queued && !blocked;

    if (!success) {
      const providerMessage = sentMessage?.status || payload?.response_msg || 'ClickSend did not queue the SMS';
      console.error('[Detector de Citas] ClickSend SMS failed:', providerMessage);
      return jsonResponse({
        message: providerMessage,
        code: sentMessage?.status || payload?.response_code || 'CLICKSEND_SEND_FAILED'
      }, response.ok ? 502 : response.status);
    }

    console.log(`[Detector de Citas] ClickSend SMS queued to ***${to.slice(-4)}`);
    return jsonResponse({
      sid: sentMessage?.message_id || null,
      status: sentMessage?.status || 'SUCCESS',
      provider: 'clicksend'
    });
  };
}
