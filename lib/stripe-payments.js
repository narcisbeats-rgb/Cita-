import crypto from 'node:crypto';

const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
const stripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const amountCents = Number(process.env.STRIPE_AMOUNT_CENTS || 2000);
const currency = String(process.env.STRIPE_CURRENCY || 'eur').trim().toLowerCase();

export function stripeConfigured() {
  return Boolean(stripeSecretKey && stripeWebhookSecret && Number.isInteger(amountCents) && amountCents > 0);
}

function stripeHeaders() {
  if (!stripeSecretKey) throw new Error('stripe_not_configured');
  return {
    authorization: `Bearer ${stripeSecretKey}`,
    'content-type': 'application/x-www-form-urlencoded'
  };
}

export async function createStripeCheckout({ reference, appUrl }) {
  if (!stripeSecretKey) throw new Error('stripe_not_configured');
  const base = String(appUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('app_url_not_configured');

  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('client_reference_id', String(reference));
  body.set('metadata[subscription_reference]', String(reference));
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', currency);
  body.set('line_items[0][price_data][unit_amount]', String(amountCents));
  body.set('line_items[0][price_data][product_data][name]', 'Monitorización de citas NIE/TIE · 30 días');
  body.set('line_items[0][price_data][product_data][description]', 'Monitorización y alertas durante 30 días. La cita oficial no está incluida y sigue siendo gratuita.');
  body.append('payment_method_types[]', 'card');
  body.set('locale', 'es');
  body.set('success_url', `${base}/?payment=success&session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url', `${base}/?payment=cancelled`);

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: stripeHeaders(),
    body
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.url) {
    console.error('[Stripe] Checkout creation failed:', response.status, payload?.error?.message || 'unknown');
    throw new Error('stripe_checkout_failed');
  }
  return payload;
}

export async function retrieveStripeCheckout(sessionId) {
  if (!stripeSecretKey) throw new Error('stripe_not_configured');
  const safeId = String(sessionId || '').trim();
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(safeId)) throw new Error('invalid_stripe_session');
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(safeId)}`, {
    headers: { authorization: `Bearer ${stripeSecretKey}` }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('[Stripe] Checkout retrieval failed:', response.status, payload?.error?.message || 'unknown');
    throw new Error('stripe_session_lookup_failed');
  }
  return payload;
}

export function verifyStripeWebhook(rawBody, signatureHeader, toleranceSeconds = 300) {
  if (!stripeWebhookSecret) return false;
  const parts = String(signatureHeader || '').split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', stripeWebhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  return signatures.some((signature) => {
    try {
      const a = Buffer.from(signature, 'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}
