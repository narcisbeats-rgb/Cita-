import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
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

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error('payload_too_large');
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

function normalizePhone(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) phone = `+34${phone.replace(/^0+/, '')}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('invalid_phone');
  return phone;
}

function maskPhone(phone) { return `${phone.slice(0, 3)}••••${phone.slice(-3)}`; }
function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) throw new Error('app_secret_not_configured');
  return secret;
}
function digest(value) { return crypto.createHmac('sha256', appSecret()).update(value).digest('hex'); }
function dbKey() { return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''; }
function dbConfigured() { return Boolean(process.env.SUPABASE_URL && dbKey()); }

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
    console.error('[CitaNIE] Database request failed:', response.status, payload?.message || 'unknown');
    throw new Error('database_request_failed');
  }
  return payload;
}

function madridDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: madridTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

async function sendWhatsAppTemplate(recipient, templateName, parameters = []) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es';
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v23.0';
  if (!token || !phoneNumberId || !templateName) throw new Error('whatsapp_not_configured');
  const template = { name: templateName, language: { code: languageCode } };
  if (parameters.length) {
    template.components = [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text: String(text) })) }];
  }
  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient.replace('+', ''), type: 'template', template })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[CitaNIE] WhatsApp request failed:', response.status, payload?.error?.message || 'unknown');
    throw new Error('whatsapp_request_failed');
  }
  return payload?.messages?.[0]?.id || null;
}

async function beginSubscription(req, res) {
  if (!dbConfigured()) return json(res, 503, { error: 'service_not_configured' });
  const body = await readJson(req);
  if (body.consent !== true) return json(res, 400, { error: 'consent_required' });
  const phone = normalizePhone(body.phone);
  const allowedServices = new Set(['nie_new', 'nie_renew', 'lost', 'tie_fingerprint', 'tie_renew', 'tie_duplicate']);
  const serviceKey = allowedServices.has(body.serviceKey) ? body.serviceKey : 'tie_fingerprint';
  if (rateLimited(`start:${clientIp(req)}:${phone}`, 3, 15 * 60_000)) return json(res, 429, { error: 'too_many_requests' });
  const code = String(crypto.randomInt(100000, 1_000_000));
  const now = new Date();
  await dbRequest('subscriptions?on_conflict=phone', {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      phone, service_key: serviceKey, consent_at: now.toISOString(),
      otp_hash: digest(`${phone}:${code}`),
      otp_expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
      otp_attempts: 0,
      subscription_expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
      active: false, updated_at: now.toISOString()
    }
  });
  try {
    await sendWhatsAppTemplate(phone, process.env.WHATSAPP_VERIFY_TEMPLATE_NAME, [code]);
  } catch (error) {
    if (error.message === 'whatsapp_not_configured') return json(res, 503, { error: 'whatsapp_not_configured' });
    throw error;
  }
  return json(res, 200, { ok: true, phone: maskPhone(phone), expiresInMinutes: 10 });
}

async function verifySubscription(req, res) {
  const body = await readJson(req);
  const phone = normalizePhone(body.phone);
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json(res, 400, { error: 'invalid_code' });
  if (rateLimited(`verify:${clientIp(req)}:${phone}`, 6, 15 * 60_000)) return json(res, 429, { error: 'too_many_requests' });
  const rows = await dbRequest(`subscriptions?phone=eq.${encodeURIComponent(phone)}&select=*`);
  const record = rows?.[0];
  if (!record || record.otp_attempts >= 6 || !record.otp_expires_at || new Date(record.otp_expires_at).getTime() < Date.now()) {
    return json(res, 400, { error: 'code_expired' });
  }
  const received = Buffer.from(record.otp_hash || '');
  const expected = Buffer.from(digest(`${phone}:${code}`));
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    await dbRequest(`subscriptions?id=eq.${record.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { otp_attempts: record.otp_attempts + 1, updated_at: new Date().toISOString() }
    });
    return json(res, 400, { error: 'invalid_code' });
  }
  const accessToken = crypto.randomBytes(32).toString('base64url');
  await dbRequest(`subscriptions?id=eq.${record.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      active: true, verified_at: new Date().toISOString(), access_token_hash: digest(accessToken),
      otp_hash: null, otp_expires_at: null, otp_attempts: 0, updated_at: new Date().toISOString()
    }
  });
  return json(res, 200, { ok: true, accessToken });
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
  return json(res, 200, {
    active: record.active && !expired, phone: maskPhone(record.phone), serviceKey: record.service_key,
    verifiedAt: record.verified_at, expiresAt: record.subscription_expires_at,
    checks: record.check_count || 0, lastAlertAt: record.last_alert_at, lastResult
  });
}
async function deleteSubscription(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  await dbRequest(`subscriptions?id=eq.${record.id}`, { method: 'DELETE', prefer: 'return=minimal' });
  return json(res, 200, { ok: true });
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
    await dbRequest(`subscriptions?id=eq.${subscriber.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { check_count: (subscriber.check_count || 0) + 1, updated_at: now }
    });
  }
}

async function notifySubscribers(result) {
  if (!dbConfigured()) {
    lastAlert = { ok: false, skipped: true, at: new Date().toISOString(), error: 'database_not_configured' };
    return;
  }
  const now = new Date();
  const alertKey = `${madridDateTime(now).date}:${result.state}`;
  const rows = await activeSubscribers();
  let sent = 0;
  let failed = 0;
  for (const subscriber of rows || []) {
    if (subscriber.last_alert_key === alertKey) continue;
    try {
      await sendWhatsAppTemplate(subscriber.phone, process.env.WHATSAPP_ALERT_TEMPLATE_NAME, [subscriber.service_key, result.state]);
      sent += 1;
      await dbRequest(`subscriptions?id=eq.${subscriber.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { last_alert_at: now.toISOString(), last_alert_key: alertKey, updated_at: now.toISOString() }
      });
    } catch { failed += 1; }
  }
  lastAlert = { ok: failed === 0, skipped: false, at: now.toISOString(), recipients: rows?.length || 0, sent, failed };
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
  console.log(`[CitaNIE] Scheduled check started for ${slot} ${madridTimeZone}`);
  const outcome = await runMonitor(`schedule:${slot}`);
  console.log(`[CitaNIE] Scheduled check finished with ${outcome.payload.state || outcome.payload.error}`);
}

function publicConfig() {
  return {
    subscriptionsReady: dbConfigured() && Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_VERIFY_TEMPLATE_NAME),
    scheduledTimes: [...scheduledTimes], timeZone: madridTimeZone
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, running, lastState: lastResult?.state || null, ...publicConfig() });
    if (url.pathname === '/api/config') return json(res, 200, publicConfig());
    if (url.pathname === '/api/status') return json(res, 200, { running, lastResult, lastAlert, ...publicConfig() });
    if (url.pathname === '/api/subscriptions/start' && req.method === 'POST') return await beginSubscription(req, res);
    if (url.pathname === '/api/subscriptions/verify' && req.method === 'POST') return await verifySubscription(req, res);
    if (url.pathname === '/api/subscription' && req.method === 'GET') return await getSubscription(req, res);
    if (url.pathname === '/api/subscription' && req.method === 'DELETE') return await deleteSubscription(req, res);
    if (url.pathname === '/api/check/tie' && req.method === 'POST') {
      const expected = process.env.MONITOR_TEST_SECRET;
      if (expected && req.headers['x-monitor-secret'] !== expected) return json(res, 401, { error: 'unauthorized' });
      const outcome = await runMonitor('manual');
      return json(res, outcome.status, outcome.payload);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    const known = new Set(['invalid_json', 'payload_too_large', 'invalid_phone']);
    const status = known.has(error.message) ? 400 : 500;
    console.error('[CitaNIE] Request error:', error.message);
    return json(res, status, { error: status === 500 ? 'internal_error' : error.message });
  }
});

setInterval(() => schedulerTick().catch((error) => console.error('[CitaNIE] Scheduler error:', error)), 15_000);
server.listen(port, '0.0.0.0', () => {
  console.log(`CitaNIE Madrid listening on :${port}`);
  console.log(`[CitaNIE] Schedule enabled for ${[...scheduledTimes].join(', ')} ${madridTimeZone}`);
});
