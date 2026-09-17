import crypto from 'node:crypto';
import webpush from 'web-push';
import { appSecret, dbConfigured, publicAppUrl } from './app-store.js';

const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || 'mailto:admin@detectorcitas.app').trim();
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
const TWILIO_FROM_NUMBER = String(process.env.TWILIO_FROM_NUMBER || '').trim();
const TWILIO_MESSAGING_SERVICE_SID = String(process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
const CLICKSEND_USERNAME = String(process.env.CLICKSEND_USERNAME || '').trim();
const CLICKSEND_API_KEY = String(process.env.CLICKSEND_API_KEY || '').trim();
const CLICKSEND_FROM = String(process.env.CLICKSEND_FROM || '').trim();

export function pushConfigured() { return dbConfigured() && Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY); }
export function clicksendConfigured() { return Boolean(CLICKSEND_USERNAME && CLICKSEND_API_KEY); }
function twilioConfigured() { return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && (TWILIO_FROM_NUMBER || TWILIO_MESSAGING_SERVICE_SID)); }
export function smsConfigured() { return dbConfigured() && (clicksendConfigured() || twilioConfigured()); }

export function validPushSubscription(subscription) {
  return Boolean(subscription && typeof subscription.endpoint === 'string' && subscription.endpoint.startsWith('https://') && subscription.keys && typeof subscription.keys.p256dh === 'string' && typeof subscription.keys.auth === 'string');
}
export function packPushSubscription(subscription) { return `push:${Buffer.from(JSON.stringify(subscription), 'utf8').toString('base64url')}`; }
export function unpackPushSubscription(value) {
  const stored = String(value || '');
  if (!stored.startsWith('push:')) return null;
  try { const sub = JSON.parse(Buffer.from(stored.slice(5), 'base64url').toString('utf8')); return validPushSubscription(sub) ? sub : null; } catch { return null; }
}

export async function sendPush(subscription, payload) {
  if (!pushConfigured()) throw new Error('push_not_configured');
  return webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 120, urgency: 'high' });
}

export async function sendSms(to, text) {
  if (!smsConfigured()) throw new Error('sms_not_configured');
  if (clicksendConfigured()) {
    const message = { source: 'DetectorDeCitas', body: text, to, ...(CLICKSEND_FROM ? { from: CLICKSEND_FROM } : {}) };
    const response = await fetch('https://rest.clicksend.com/v3/sms/send', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${CLICKSEND_USERNAME}:${CLICKSEND_API_KEY}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [message] })
    });
    const payload = await response.json().catch(() => ({}));
    const sent = payload?.data?.messages?.[0] || {};
    if (!response.ok || payload?.response_code !== 'SUCCESS' || Number(payload?.data?.queued_count || 0) < 1) {
      const error = new Error(sent?.status || payload?.response_msg || 'sms_send_failed');
      error.statusCode = response.status;
      error.providerCode = sent?.status || payload?.response_code;
      throw error;
    }
    return { provider: 'clicksend', messageId: sent.message_id || null, status: sent.status || 'QUEUED' };
  }
  const params = new URLSearchParams({ To: to, Body: text });
  if (TWILIO_MESSAGING_SERVICE_SID) params.set('MessagingServiceSid', TWILIO_MESSAGING_SERVICE_SID); else params.set('From', TWILIO_FROM_NUMBER);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload?.message || 'sms_send_failed'); error.statusCode = response.status; error.providerCode = payload?.code; throw error; }
  return { provider: 'twilio', messageId: payload.sid || null, status: payload.status || 'queued' };
}

export function parseAlertMeta(value) {
  const [dedupeKey = '', provider = '', messageId = '', status = ''] = String(value || '').split('|');
  return { dedupeKey, provider, messageId, status };
}
export async function getSmsDelivery(record) {
  const meta = parseAlertMeta(record.last_alert_key);
  if (!meta.messageId) return record.last_alert_at ? { status: meta.status || 'sent', provider: meta.provider || null } : null;
  if (meta.provider !== 'clicksend' || !clicksendConfigured()) return { status: meta.status || 'queued', provider: meta.provider || null };
  try {
    const response = await fetch(`https://rest.clicksend.com/v3/sms/receipts/${encodeURIComponent(meta.messageId)}`, {
      headers: { authorization: `Basic ${Buffer.from(`${CLICKSEND_USERNAME}:${CLICKSEND_API_KEY}`).toString('base64')}`, 'content-type': 'application/json' }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.response_code !== 'SUCCESS' || !payload?.data) return { status: meta.status || 'queued', provider: 'clicksend' };
    return { status: String(payload.data.status_text || payload.data.status_code || 'delivered'), provider: 'clicksend', deliveredAt: payload.data.timestamp ? new Date(Number(payload.data.timestamp) * 1000).toISOString() : null };
  } catch { return { status: meta.status || 'queued', provider: 'clicksend' }; }
}

function resumeSignature(id, exp) { return crypto.createHmac('sha256', appSecret()).update(`resume:${id}:${exp}`).digest().subarray(0, 12).toString('base64url'); }
export function resumeLink(subscriber, ttlSeconds = 20 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${publicAppUrl}/r/${subscriber.id}.${exp}.${resumeSignature(subscriber.id, exp)}`;
}
export function validResume(id, exp, sig) {
  if (!id || !/^\d+$/.test(String(exp)) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = resumeSignature(id, exp);
  try { return crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(expected)); } catch { return false; }
}
