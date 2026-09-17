import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { checkMadridTieAvailability } from './src/icpplus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const madridTimeZone = 'Europe/Madrid';
const scheduledTimes = new Set((process.env.MONITOR_HOURS || '09:00,10:00,11:00').split(',').map((v) => v.trim()).filter(Boolean));
let running = false;
let lastResult = null;
let lastAlert = null;
const completedScheduleSlots = new Set();
const requestWindows = new Map();

const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || 'mailto:admin@citanie.app').trim();
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
const TWILIO_FROM_NUMBER = String(process.env.TWILIO_FROM_NUMBER || '').trim();
const TWILIO_MESSAGING_SERVICE_SID = String(process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim();

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32_768) throw new Error('payload_too_large');
  }
  try { return JSON.parse(body || '{}'); } catch { throw new Error('invalid_json'); }
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const current = requestWindows.get(key);
  if (!current || current.resetAt <= now) {
    requestWindows.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > limit;
}

function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) throw new Error('app_secret_not_configured');
  return secret;
}

function digest(value) {
  return crypto.createHmac('sha256', appSecret()).update(value).digest('hex');
}

function dbKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function dbConfigured() {
  return Boolean(process.env.SUPABASE_URL && dbKey());
}

function pushConfigured() {
  return dbConfigured() && Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

function smsConfigured() {
  return dbConfigured() && Boolean(
    TWILIO_ACCOUNT_SID &&
    TWILIO_AUTH_TOKEN &&
    (TWILIO_FROM_NUMBER || TWILIO_MESSAGING_SERVICE_SID)
  );
}

async function dbRequest(resource, { method = 'GET', body, prefer } = {}) {
  if (!dbConfigured()) throw new Error('database_not_configured');
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = dbKey();
  const response = await fetch(`${base}/rest/v1/${resource}`, {
    method,
    headers: {
      apikey: key,
      ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('[Detector de Citas] Database request failed:', response.status, payload?.message || 'unknown');
    throw new Error('database_request_failed');
  }
  return payload;
}

function madridDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: madridTimeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function validPushSubscription(subscription) {
  return Boolean(
    subscription &&
    typeof subscription.endpoint === 'string' &&
    subscription.endpoint.startsWith('https://') &&
    subscription.keys &&
    typeof subscription.keys.p256dh === 'string' &&
    typeof subscription.keys.auth === 'string'
  );
}

function packPushSubscription(subscription) {
  return `push:${Buffer.from(JSON.stringify(subscription), 'utf8').toString('base64url')}`;
}

function unpackPushSubscription(value) {
  const stored = String(value || '');
  if (!stored.startsWith('push:')) return null;
  try {
    const subscription = JSON.parse(Buffer.from(stored.slice(5), 'base64url').toString('utf8'));
    return validPushSubscription(subscription) ? subscription : null;
  } catch {
    return null;
  }
}

function normalizePhone(value) {
  let phone = String(value || '').trim();
  phone = phone.replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+') && /^\d{9}$/.test(phone)) phone = `+34${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return null;
  return phone;
}

function smsCryptoKey() {
  return crypto.createHash('sha256').update(`detector-citas-sms:${appSecret()}`).digest();
}

function packSmsNumber(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('invalid_phone');
  const iv = crypto.createHmac('sha256', appSecret()).update(`sms-iv:${normalized}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', smsCryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `sms:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function unpackSmsNumber(value) {
  const stored = String(value || '');
  if (!stored.startsWith('sms:v1:')) return null;
  const parts = stored.slice('sms:v1:'.length).split('.');
  if (parts.length !== 3) return null;
  try {
    const [ivRaw, tagRaw, cipherRaw] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', smsCryptoKey(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const phone = Buffer.concat([
      decipher.update(Buffer.from(cipherRaw, 'base64url')),
      decipher.final()
    ]).toString('utf8');
    return normalizePhone(phone);
  } catch {
    return null;
  }
}

function maskPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return `${normalized.slice(0, 3)}••••${normalized.slice(-4)}`;
}

function profileEncryptionKey() {
  const raw = String(process.env.PROFILE_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64url');
  return key.length === 32 ? key : null;
}

function encryptedSeedProfile(phone) {
  const key = profileEncryptionKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({ mobile: phone }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `encprofile:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function serviceLabel(serviceKey) {
  const labels = {
    nie_new: 'Sacar NIE',
    nie_renew: 'Renovar documentación NIE/TIE',
    lost: 'NIE/TIE perdido',
    tie_fingerprint: 'Toma de huellas TIE',
    tie_renew: 'Renovar TIE',
    tie_duplicate: 'Duplicado TIE'
  };
  return labels[serviceKey] || 'tu trámite NIE/TIE';
}

async function sendPush(subscription, payload) {
  if (!pushConfigured()) throw new Error('push_not_configured');
  return webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 120,
    urgency: 'high'
  });
}

async function sendSms(to, text) {
  if (!smsConfigured()) throw new Error('sms_not_configured');
  const params = new URLSearchParams({ To: to, Body: text });
  if (TWILIO_MESSAGING_SERVICE_SID) params.set('MessagingServiceSid', TWILIO_MESSAGING_SERVICE_SID);
  else params.set('From', TWILIO_FROM_NUMBER);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || 'sms_send_failed');
    error.statusCode = response.status;
    error.providerCode = payload?.code;
    throw error;
  }
  return payload;
}

async function beginPushSubscription(req, res) {
  if (!pushConfigured()) return json(res, 503, { error: 'push_not_configured' });
  const body = await readJson(req);
  if (body.consent !== true) return json(res, 400, { error: 'consent_required' });
  if (!validPushSubscription(body.subscription)) return json(res, 400, { error: 'invalid_push_subscription' });
  if (rateLimited(`push-start:${clientIp(req)}`, 8, 15 * 60_000)) return json(res, 429, { error: 'too_many_requests' });
  const allowedServices = new Set(['nie_new', 'nie_renew', 'lost', 'tie_fingerprint', 'tie_renew', 'tie_duplicate']);
  const serviceKey = allowedServices.has(body.serviceKey) ? body.serviceKey : 'tie_fingerprint';
  const accessToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const packedSubscription = packPushSubscription(body.subscription);
  await dbRequest('subscriptions?on_conflict=phone', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      phone: packedSubscription,
      service_key: serviceKey,
      consent_at: now.toISOString(),
      active: true,
      verified_at: now.toISOString(),
      access_token_hash: digest(accessToken),
      otp_hash: null,
      otp_expires_at: null,
      otp_attempts: 0,
      subscription_expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
      updated_at: now.toISOString()
    }
  });
  return json(res, 200, { ok: true, accessToken, expiresInDays: 30 });
}

async function beginSmsSubscription(req, res) {
  if (!smsConfigured()) return json(res, 503, { error: 'sms_not_configured' });
  const body = await readJson(req);
  if (body.consent !== true) return json(res, 400, { error: 'consent_required' });
  const phone = normalizePhone(body.phone);
  if (!phone) return json(res, 400, { error: 'invalid_phone' });
  if (rateLimited(`sms-start:${clientIp(req)}`, 8, 15 * 60_000)) return json(res, 429, { error: 'too_many_requests' });
  const allowedServices = new Set(['nie_new', 'nie_renew', 'lost', 'tie_fingerprint', 'tie_renew', 'tie_duplicate']);
  const serviceKey = allowedServices.has(body.serviceKey) ? body.serviceKey : 'tie_fingerprint';
  const accessToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const packedPhone = packSmsNumber(phone);
  const existing = await dbRequest(`subscriptions?phone=eq.${encodeURIComponent(packedPhone)}&select=id,otp_hash`);
  const common = {
    service_key: serviceKey,
    consent_at: now.toISOString(),
    active: true,
    verified_at: null,
    access_token_hash: digest(accessToken),
    otp_expires_at: null,
    otp_attempts: 0,
    subscription_expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
    updated_at: now.toISOString()
  };
  if (existing?.[0]) {
    await dbRequest(`subscriptions?id=eq.${existing[0].id}`, { method: 'PATCH', prefer: 'return=minimal', body: common });
  } else {
    await dbRequest('subscriptions', {
      method: 'POST', prefer: 'return=minimal',
      body: { ...common, phone: packedPhone, otp_hash: encryptedSeedProfile(phone) }
    });
  }
  return json(res, 200, { ok: true, accessToken, expiresInDays: 30, phone: maskPhone(phone) });
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

async function authenticatedSubscription(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const rows = await dbRequest(`subscriptions?access_token_hash=eq.${digest(token)}&select=*`);
  return rows?.[0] || null;
}

async function getSubscription(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  const expired = new Date(record.subscription_expires_at).getTime() <= Date.now();
  const smsPhone = unpackSmsNumber(record.phone);
  return json(res, 200, {
    active: Boolean(record.active) && !expired,
    channel: smsPhone ? 'sms' : 'push',
    phone: smsPhone ? maskPhone(smsPhone) : null,
    serviceKey: record.service_key,
    verifiedAt: record.verified_at,
    expiresAt: record.subscription_expires_at,
    checks: record.check_count || 0,
    lastAlertAt: record.last_alert_at,
    lastResult
  });
}

async function deleteSubscription(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  await dbRequest(`subscriptions?id=eq.${record.id}`, { method: 'DELETE', prefer: 'return=minimal' });
  return json(res, 200, { ok: true });
}

async function testPush(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  const subscription = unpackPushSubscription(record.phone);
  if (!subscription) return json(res, 400, { error: 'push_subscription_missing' });
  try {
    await sendPush(subscription, {
      title: 'CitaNIE activado ✓',
      body: 'Las alertas push están listas. Te avisaremos cuando detectemos un cambio relevante.',
      tag: 'citanie-test', url: '/'
    });
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('[Detector de Citas] Test push failed:', error.statusCode || '', error.message);
    return json(res, 502, { error: 'push_send_failed' });
  }
}

async function testSms(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  const phone = unpackSmsNumber(record.phone);
  if (!phone) return json(res, 400, { error: 'sms_number_missing' });
  try {
    await sendSms(phone, 'Detector de Citas activado. Te enviaremos un SMS cuando detectemos disponibilidad o cuando el portal necesite tu intervención.');
    const now = new Date().toISOString();
    await dbRequest(`subscriptions?id=eq.${record.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { verified_at: now, updated_at: now } });
    return json(res, 200, { ok: true, phone: maskPhone(phone) });
  } catch (error) {
    console.error('[Detector de Citas] Test SMS failed:', error.statusCode || '', error.providerCode || '', error.message);
    return json(res, 502, { error: 'sms_send_failed' });
  }
}

async function activeSubscribers() {
  const now = new Date().toISOString();
  return dbRequest(`subscriptions?active=eq.true&subscription_expires_at=gt.${encodeURIComponent(now)}&select=*`);
}

async function recordChecks() {
  if (!dbConfigured()) return;
  const rows = await activeSubscribers();
  const now = new Date().toISOString();
  for (const subscriber of rows || []) {
    if (!unpackPushSubscription(subscriber.phone) && !unpackSmsNumber(subscriber.phone)) continue;
    await dbRequest(`subscriptions?id=eq.${subscriber.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { check_count: (subscriber.check_count || 0) + 1, updated_at: now }
    });
  }
}

async function notifySubscribers(result) {
  if (!pushConfigured() && !smsConfigured()) {
    lastAlert = { ok: false, skipped: true, at: new Date().toISOString(), error: 'notifications_not_configured' };
    return;
  }
  const now = new Date();
  const alertKey = `${madridDateTime(now).date}:${result.state}`;
  const rows = await activeSubscribers();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const seenRecipients = new Set();
  for (const subscriber of rows || []) {
    if (subscriber.last_alert_key === alertKey) { skipped += 1; continue; }
    const label = serviceLabel(subscriber.service_key);
    const isAvailable = result.state === 'AVAILABILITY_DETECTED';
    const smsPhone = unpackSmsNumber(subscriber.phone);
    const pushSubscription = unpackPushSubscription(subscriber.phone);
    try {
      if (smsPhone) {
        if (!smsConfigured() || seenRecipients.has(`sms:${smsPhone}`)) { skipped += 1; continue; }
        seenRecipients.add(`sms:${smsPhone}`);
        const text = isAvailable
          ? `Detector de Citas: posible cita disponible para ${label}. Entra ahora en el servicio para revisar el portal oficial.`
          : `Detector de Citas: el portal necesita tu intervención para ${label}. Abre el servicio para continuar.`;
        await sendSms(smsPhone, text);
      } else if (pushSubscription) {
        if (!pushConfigured() || seenRecipients.has(`push:${pushSubscription.endpoint}`)) { skipped += 1; continue; }
        seenRecipients.add(`push:${pushSubscription.endpoint}`);
        const payload = isAvailable
          ? { title: '¡Posible cita disponible!', body: `Hemos detectado un cambio relevante para ${label}. Entra ahora para revisar el portal oficial.`, tag: `citanie-${alertKey}`, url: '/?alert=availability' }
          : { title: 'Detector de Citas necesita tu atención', body: `El portal requiere intervención humana para ${label}. Abre el servicio para continuar.`, tag: `citanie-${alertKey}`, url: '/?alert=human' };
        await sendPush(pushSubscription, payload);
      } else { skipped += 1; continue; }
      sent += 1;
      await dbRequest(`subscriptions?id=eq.${subscriber.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { last_alert_at: now.toISOString(), last_alert_key: alertKey, updated_at: now.toISOString() }
      });
    } catch (error) {
      failed += 1;
      console.error('[Detector de Citas] Notification failed:', error.statusCode || '', error.message);
      if (pushSubscription && [404, 410].includes(Number(error.statusCode))) {
        await dbRequest(`subscriptions?id=eq.${subscriber.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { active: false, updated_at: now.toISOString() } }).catch(() => {});
      }
    }
  }
  lastAlert = { ok: failed === 0, skipped: false, at: now.toISOString(), recipients: rows?.length || 0, sent, failed, ignored: skipped };
}

async function runMonitor(trigger = 'manual') {
  if (running) return { status: 409, payload: { error: 'check_already_running' } };
  running = true;
  try {
    try { lastResult = await checkMadridTieAvailability({ safeMode: true }); }
    catch (error) {
      lastResult = { ok: false, state: 'ERROR', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), message: error?.message || String(error) };
    }
    lastResult.trigger = trigger;
    try {
      await recordChecks();
      if (['HUMAN_GATE', 'AVAILABILITY_DETECTED'].includes(lastResult.state)) await notifySubscribers(lastResult);
    } catch (error) {
      lastAlert = { ok: false, skipped: false, at: new Date().toISOString(), error: error?.message || String(error) };
    }
    return { status: 200, payload: { ...lastResult, alert: lastAlert } };
  } finally { running = false; }
}

async function schedulerTick() {
  if (process.env.MONITOR_ENABLED === 'false') return;
  const now = madridDateTime();
  const slot = `${now.date}T${now.time}`;
  if (!scheduledTimes.has(now.time) || completedScheduleSlots.has(slot)) return;
  completedScheduleSlots.add(slot);
  for (const completed of completedScheduleSlots) if (!completed.startsWith(now.date)) completedScheduleSlots.delete(completed);
  console.log(`[Detector de Citas] Scheduled check started for ${slot} ${madridTimeZone}`);
  const outcome = await runMonitor(`schedule:${slot}`);
  console.log(`[Detector de Citas] Scheduled check finished with ${outcome.payload.state || outcome.payload.error}`);
}

function publicConfig() {
  return {
    subscriptionsReady: smsConfigured() || pushConfigured(),
    smsReady: smsConfigured(),
    pushReady: pushConfigured(),
    vapidPublicKey: VAPID_PUBLIC_KEY || null,
    scheduledTimes: [...scheduledTimes],
    timeZone: madridTimeZone
  };
}

const staticFiles = new Map([
  ['/manifest.webmanifest', { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8', cache: 'public, max-age=3600' }],
  ['/sw.js', { file: 'sw.js', type: 'application/javascript; charset=utf-8', cache: 'no-cache' }],
  ['/icon.svg', { file: 'icon.svg', type: 'image/svg+xml; charset=utf-8', cache: 'public, max-age=86400' }]
]);

async function serveStatic(urlPath, res) {
  const item = staticFiles.get(urlPath);
  if (!item) return false;
  const content = await fs.readFile(path.join(__dirname, item.file));
  res.writeHead(200, {
    'content-type': item.type,
    'cache-control': item.cache,
    'x-content-type-options': 'nosniff',
    ...(urlPath === '/sw.js' ? { 'service-worker-allowed': '/' } : {})
  });
  res.end(content);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, running, lastState: lastResult?.state || null, ...publicConfig() });
    if (url.pathname === '/api/config') return json(res, 200, publicConfig());
    if (url.pathname === '/api/status') return json(res, 200, { running, lastResult, lastAlert, ...publicConfig() });
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') return await beginPushSubscription(req, res);
    if (url.pathname === '/api/push/test' && req.method === 'POST') return await testPush(req, res);
    if (url.pathname === '/api/sms/subscribe' && req.method === 'POST') return await beginSmsSubscription(req, res);
    if (url.pathname === '/api/sms/test' && req.method === 'POST') return await testSms(req, res);
    if (url.pathname === '/api/subscription' && req.method === 'GET') return await getSubscription(req, res);
    if (url.pathname === '/api/subscription' && req.method === 'DELETE') return await deleteSubscription(req, res);
    if (url.pathname === '/api/check/tie' && req.method === 'POST') {
      const expected = process.env.MONITOR_TEST_SECRET;
      if (expected && req.headers['x-monitor-secret'] !== expected) return json(res, 401, { error: 'unauthorized' });
      const outcome = await runMonitor('manual');
      return json(res, outcome.status, outcome.payload);
    }
    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(html);
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    const known = new Set(['invalid_json', 'payload_too_large', 'invalid_push_subscription', 'consent_required', 'too_many_requests', 'invalid_phone']);
    const status = known.has(error.message) ? 400 : 500;
    console.error('[Detector de Citas] Request error:', error.message);
    return json(res, status, { error: status === 500 ? 'internal_error' : error.message });
  }
});

setInterval(() => schedulerTick().catch((error) => console.error('[Detector de Citas] Scheduler error:', error)), 15_000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Detector de Citas Madrid listening on :${port}`);
  console.log(`[Detector de Citas] SMS notifications: ${smsConfigured() ? 'ready' : 'not configured'}`);
  console.log(`[Detector de Citas] Push notifications (legacy): ${pushConfigured() ? 'ready' : 'not configured'}`);
  console.log(`[Detector de Citas] Schedule enabled for ${[...scheduledTimes].join(', ')} ${madridTimeZone}`);
});
