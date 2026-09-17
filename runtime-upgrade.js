import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkMadridTieAvailability } from './src/icpplus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entryName = path.basename(process.argv[1] || '');
const isCoreProcess = entryName === 'server.js';
const appUrl = String(process.env.PUBLIC_APP_URL || 'https://cita-fd42.onrender.com').replace(/\/$/, '');
const madridTimeZone = 'Europe/Madrid';

const monitorIntervalMinutes = Math.min(60, Math.max(5, Number(process.env.MONITOR_INTERVAL_MINUTES || 10)));
const monitorIntervalMs = monitorIntervalMinutes * 60_000;
const errorBackoffMs = Math.min(60, Math.max(10, Number(process.env.MONITOR_ERROR_BACKOFF_MINUTES || 20))) * 60_000;
const resumeLinkMinutes = Math.min(720, Math.max(15, Number(process.env.RESUME_LINK_MINUTES || 120)));
const pendingPaymentHours = Math.min(72, Math.max(1, Number(process.env.PENDING_PAYMENT_HOURS || 24)));
const monitorableServices = new Set(['nie_new', 'lost', 'tie_fingerprint', 'tie_renew', 'tie_duplicate']);
const allowedServices = new Set([...monitorableServices, 'nie_renew']);

const CLICKSEND_USERNAME = String(process.env.CLICKSEND_USERNAME || '').trim();
const CLICKSEND_API_KEY = String(process.env.CLICKSEND_API_KEY || '').trim();
const CLICKSEND_FROM = String(process.env.CLICKSEND_FROM || '').trim();

const PAYMENT_REQUIRED = process.env.PAYMENT_REQUIRED === 'true';
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || '').trim();
const STRIPE_PRICE_ID = String(process.env.STRIPE_PRICE_ID || '').trim();
const STRIPE_WEBHOOK_SECRET = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();

let runtimeRunning = false;
let nextSweepAt = Date.now() + 30_000;
let lastCleanupAt = 0;
let runtimeLastResult = null;
const lastResultsByService = {};
let runtimeLastAlert = null;
const requestWindows = new Map();
const smsStatusCache = new Map();

// Ensure the child core process receives this preload too.
if (!isCoreProcess) {
  const preloadFlag = '--import=./runtime-upgrade.js';
  const currentNodeOptions = String(process.env.NODE_OPTIONS || '').trim();
  if (!currentNodeOptions.includes('runtime-upgrade.js')) {
    process.env.NODE_OPTIONS = [currentNodeOptions, preloadFlag].filter(Boolean).join(' ');
  }
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

async function readRaw(req, maxBytes = 64_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) throw new Error('payload_too_large');
  }
  return body;
}

async function readJson(req) {
  const raw = await readRaw(req, 32_768);
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('invalid_json'); }
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
  const secret = String(process.env.APP_SECRET || '');
  if (secret.length < 32) throw new Error('app_secret_not_configured');
  return secret;
}

function digest(value) {
  return crypto.createHmac('sha256', appSecret()).update(String(value)).digest('hex');
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function dbKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function dbConfigured() {
  return Boolean(process.env.SUPABASE_URL && dbKey());
}

function smsConfigured() {
  return dbConfigured() && Boolean(CLICKSEND_USERNAME && CLICKSEND_API_KEY);
}

function paymentConfigured() {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_ID && STRIPE_WEBHOOK_SECRET);
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
    console.error('[Detector Runtime] Database error:', response.status, payload?.message || 'unknown');
    throw new Error('database_request_failed');
  }
  return payload;
}

function madridDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: madridTimeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    seconds: `${values.hour}:${values.minute}:${values.second}`
  };
}

function normalizePhone(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
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
  // Keep compatibility with existing database uniqueness behavior.
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
    nie_renew: 'Renovar documentacion NIE/TIE',
    lost: 'NIE/TIE perdido',
    tie_fingerprint: 'Toma de huellas TIE',
    tie_renew: 'Renovar TIE',
    tie_duplicate: 'Duplicado TIE'
  };
  return labels[serviceKey] || 'tu tramite NIE/TIE';
}

function shortServiceLabel(serviceKey) {
  const labels = {
    nie_new: 'Sacar NIE',
    lost: 'NIE/TIE perdido',
    tie_fingerprint: 'Huellas TIE',
    tie_renew: 'Renovar TIE',
    tie_duplicate: 'Duplicado TIE'
  };
  return labels[serviceKey] || 'tu tramite';
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

function clicksendAuthHeader() {
  return `Basic ${Buffer.from(`${CLICKSEND_USERNAME}:${CLICKSEND_API_KEY}`).toString('base64')}`;
}

async function sendSms(to, text, { customString = '' } = {}) {
  if (!smsConfigured()) throw new Error('sms_not_configured');
  const message = {
    source: 'DetectorDeCitas',
    body: String(text),
    to,
    ...(customString ? { custom_string: String(customString) } : {}),
    ...(CLICKSEND_FROM ? { from: CLICKSEND_FROM } : {})
  };
  const response = await fetch('https://rest.clicksend.com/v3/sms/send', {
    method: 'POST',
    headers: {
      authorization: clicksendAuthHeader(),
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
    const error = new Error(sentMessage?.status || payload?.response_msg || 'sms_send_failed');
    error.statusCode = response.status;
    error.providerCode = sentMessage?.status || payload?.response_code;
    throw error;
  }
  return { messageId: sentMessage?.message_id || null, status: sentMessage?.status || 'Queued' };
}

async function clicksendMessageStatus(messageId) {
  if (!smsConfigured() || !messageId) return null;
  const cached = smsStatusCache.get(messageId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const q = encodeURIComponent(`message_id:${messageId}`);
  const response = await fetch(`https://rest.clicksend.com/v3/sms/history?limit=15&q=${q}`, {
    headers: { authorization: clicksendAuthHeader(), 'content-type': 'application/json' }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.response_code !== 'SUCCESS') return null;
  let rows = payload?.data;
  if (rows && !Array.isArray(rows) && Array.isArray(rows.data)) rows = rows.data;
  if (!Array.isArray(rows)) rows = [];
  const row = rows.find((item) => String(item?.message_id || '') === String(messageId)) || rows[0] || null;
  if (!row) return null;
  const value = {
    status: row.status || null,
    statusCode: row.status_code || null,
    statusText: row.status_text || row.error_text || null,
    messageId
  };
  smsStatusCache.set(messageId, { value, expiresAt: Date.now() + 30_000 });
  return value;
}

function encodeAlertMeta({ alertKey, resumeCode, messageId, status }) {
  const a = Buffer.from(String(alertKey), 'utf8').toString('base64url');
  return `v2;a=${a};r=${resumeCode || ''};m=${messageId || ''};s=${status || ''}`;
}

function parseAlertMeta(value) {
  const raw = String(value || '');
  if (!raw.startsWith('v2;')) return { alertKey: raw || null, resumeCode: null, messageId: null, status: null };
  const parts = Object.fromEntries(raw.slice(3).split(';').map((entry) => {
    const idx = entry.indexOf('=');
    return idx < 0 ? [entry, ''] : [entry.slice(0, idx), entry.slice(idx + 1)];
  }));
  let alertKey = null;
  try { alertKey = parts.a ? Buffer.from(parts.a, 'base64url').toString('utf8') : null; } catch {}
  return { alertKey, resumeCode: parts.r || null, messageId: parts.m || null, status: parts.s || null };
}

async function activeSubscribers() {
  const now = new Date().toISOString();
  return dbRequest(`subscriptions?active=eq.true&subscription_expires_at=gt.${encodeURIComponent(now)}&select=*`);
}

async function beginSmsSubscription(req, res) {
  if (!smsConfigured()) { json(res, 503, { error: 'sms_not_configured' }); return true; }
  if (PAYMENT_REQUIRED && !paymentConfigured()) { json(res, 503, { error: 'payment_not_configured' }); return true; }

  const body = await readJson(req);
  if (body.consent !== true) { json(res, 400, { error: 'consent_required' }); return true; }
  const phone = normalizePhone(body.phone);
  if (!phone) { json(res, 400, { error: 'invalid_phone' }); return true; }
  if (rateLimited(`sms-start:${clientIp(req)}`, 8, 15 * 60_000)) { json(res, 429, { error: 'too_many_requests' }); return true; }

  let serviceKey = allowedServices.has(body.serviceKey) ? body.serviceKey : 'tie_fingerprint';
  if (serviceKey === 'nie_renew') {
    const mapping = {
      tie_renew: 'tie_renew',
      tie_duplicate: 'tie_duplicate',
      tie_fingerprint: 'tie_fingerprint'
    };
    serviceKey = mapping[String(body.renewalKind || '')];
    if (!serviceKey) {
      json(res, 409, { error: 'procedure_needs_clarification' });
      return true;
    }
  }

  const accessToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const packedPhone = packSmsNumber(phone);
  const existing = await dbRequest(`subscriptions?phone=eq.${encodeURIComponent(packedPhone)}&select=*`);
  const requiresPayment = PAYMENT_REQUIRED && paymentConfigured();
  const common = {
    service_key: serviceKey,
    consent_at: now.toISOString(),
    active: !requiresPayment,
    verified_at: null,
    access_token_hash: digest(accessToken),
    otp_expires_at: null,
    otp_attempts: 0,
    subscription_expires_at: new Date(now.getTime() + (requiresPayment ? pendingPaymentHours * 60 * 60_000 : 30 * 24 * 60 * 60_000)).toISOString(),
    updated_at: now.toISOString()
  };

  let recordId;
  if (existing?.[0]?.id) {
    recordId = existing[0].id;
    await dbRequest(`subscriptions?id=eq.${encodeURIComponent(recordId)}`, {
      method: 'PATCH', prefer: 'return=minimal', body: common
    });
  } else {
    const inserted = await dbRequest('subscriptions', {
      method: 'POST', prefer: 'return=representation',
      body: { ...common, phone: packedPhone, otp_hash: encryptedSeedProfile(phone) }
    });
    recordId = inserted?.[0]?.id;
  }
  if (!recordId) throw new Error('subscription_create_failed');

  if (!requiresPayment) {
    try {
      const activation = await sendSms(phone, 'Detector de Citas activado. La monitorizacion esta lista y te avisaremos si detectamos una cita.', { customString: recordId });
      await dbRequest(`subscriptions?id=eq.${encodeURIComponent(recordId)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { verified_at: now.toISOString(), updated_at: now.toISOString(), last_alert_key: encodeAlertMeta({ alertKey: 'activation', resumeCode: '', messageId: activation.messageId, status: activation.status }) }
      });
    } catch (error) {
      console.error('[Detector Runtime] Activation SMS failed:', error.providerCode || '', error.message);
    }
  }

  json(res, 200, {
    ok: true,
    accessToken,
    expiresInDays: requiresPayment ? 0 : 30,
    phone: maskPhone(phone),
    serviceKey,
    active: !requiresPayment,
    paymentRequired: requiresPayment
  });
  return true;
}

async function getSubscription(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) { json(res, 401, { error: 'unauthorized' }); return true; }
  const expired = new Date(record.subscription_expires_at).getTime() <= Date.now();
  const phone = unpackSmsNumber(record.phone);
  const result = lastResultsByService[record.service_key] || null;
  const meta = parseAlertMeta(record.last_alert_key);
  const liveStatus = meta.messageId ? await clicksendMessageStatus(meta.messageId).catch(() => null) : null;
  json(res, 200, {
    active: Boolean(record.active) && !expired,
    pendingPayment: !record.active && !expired && PAYMENT_REQUIRED,
    paymentRequired: PAYMENT_REQUIRED,
    paymentReady: paymentConfigured(),
    channel: phone ? 'sms' : null,
    phone: phone ? maskPhone(phone) : null,
    serviceKey: record.service_key,
    serviceLabel: serviceLabel(record.service_key),
    verifiedAt: record.verified_at,
    expiresAt: record.subscription_expires_at,
    checks: record.check_count || 0,
    lastAlertAt: record.last_alert_at,
    lastCheckAt: result?.finishedAt || result?.startedAt || null,
    lastState: result?.state || null,
    smsStatus: liveStatus?.status || meta.status || null,
    smsStatusText: liveStatus?.statusText || null,
    lastResult: result
  });
  return true;
}

async function deleteSubscription(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) { json(res, 401, { error: 'unauthorized' }); return true; }
  await dbRequest(`subscriptions?id=eq.${encodeURIComponent(record.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  json(res, 200, { ok: true });
  return true;
}

async function testSms(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) { json(res, 401, { error: 'unauthorized' }); return true; }
  if (!record.active) { json(res, 402, { error: 'payment_required' }); return true; }
  const phone = unpackSmsNumber(record.phone);
  if (!phone) { json(res, 400, { error: 'sms_number_missing' }); return true; }
  try {
    const result = await sendSms(phone, 'Detector de Citas: SMS de prueba correcto. Tu monitorizacion esta activa.', { customString: record.id });
    json(res, 200, { ok: true, phone: maskPhone(phone), status: result.status });
  } catch (error) {
    console.error('[Detector Runtime] Test SMS failed:', error.providerCode || '', error.message);
    json(res, 502, { error: 'sms_send_failed' });
  }
  return true;
}

async function recordChecks(serviceKey, rows) {
  const now = new Date().toISOString();
  for (const subscriber of (rows || []).filter((row) => row.service_key === serviceKey)) {
    await dbRequest(`subscriptions?id=eq.${encodeURIComponent(subscriber.id)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { check_count: (subscriber.check_count || 0) + 1, updated_at: now }
    });
  }
}

async function notifySubscribers(result, serviceKey, rows) {
  if (!smsConfigured()) return;
  const now = new Date();
  const hourBucket = Math.floor(now.getTime() / (2 * 60 * 60_000));
  const alertKey = `${serviceKey}:${result.state}:${hourBucket}`;
  const matchingRows = (rows || []).filter((row) => row.service_key === serviceKey);
  let sent = 0, failed = 0, skipped = 0;

  for (const subscriber of matchingRows) {
    const previous = parseAlertMeta(subscriber.last_alert_key);
    if (previous.alertKey === alertKey) { skipped += 1; continue; }
    const phone = unpackSmsNumber(subscriber.phone);
    if (!phone) { skipped += 1; continue; }

    const resumeCode = crypto.randomBytes(6).toString('base64url');
    const resumeUrl = `${appUrl}/r/${resumeCode}`;
    const isAvailable = result.state === 'AVAILABILITY_DETECTED';
    const text = isAvailable
      ? `Detector de Citas: hemos localizado una cita para ${shortServiceLabel(serviceKey)}. Entra ahora y finaliza: ${resumeUrl}`
      : `Detector de Citas: el portal necesita tu intervencion para ${shortServiceLabel(serviceKey)}. Entra ahora: ${resumeUrl}`;

    try {
      const sentResult = await sendSms(phone, text, { customString: subscriber.id });
      sent += 1;
      await dbRequest(`subscriptions?id=eq.${encodeURIComponent(subscriber.id)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          last_alert_at: now.toISOString(),
          last_alert_key: encodeAlertMeta({
            alertKey,
            resumeCode,
            messageId: sentResult.messageId,
            status: sentResult.status
          }),
          updated_at: now.toISOString()
        }
      });
    } catch (error) {
      failed += 1;
      console.error('[Detector Runtime] SMS alert failed:', serviceKey, error.providerCode || '', error.message);
    }
  }

  runtimeLastAlert = { ok: failed === 0, at: now.toISOString(), serviceKey, recipients: matchingRows.length, sent, failed, ignored: skipped };
}

async function runServiceMonitor(serviceKey, trigger, rows) {
  let result;
  try {
    result = await checkMadridTieAvailability({ safeMode: true, serviceKey });
  } catch (error) {
    result = {
      ok: false,
      state: 'ERROR',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: error?.message || String(error)
    };
  }
  result.trigger = trigger;
  result.serviceKey = serviceKey;
  runtimeLastResult = result;
  lastResultsByService[serviceKey] = result;

  try {
    await recordChecks(serviceKey, rows);
    if (['HUMAN_GATE', 'AVAILABILITY_DETECTED'].includes(result.state)) {
      await notifySubscribers(result, serviceKey, rows);
    }
  } catch (error) {
    runtimeLastAlert = { ok: false, at: new Date().toISOString(), serviceKey, error: error?.message || String(error) };
  }
  return result;
}

async function runMonitor(trigger = 'runtime', forcedServiceKey = null) {
  if (runtimeRunning) return { status: 409, payload: { error: 'check_already_running' } };
  runtimeRunning = true;
  try {
    const rows = await activeSubscribers();
    if (forcedServiceKey) {
      if (!monitorableServices.has(forcedServiceKey)) return { status: 400, payload: { error: 'procedure_not_monitorable' } };
      const result = await runServiceMonitor(forcedServiceKey, trigger, rows);
      return { status: 200, payload: { ...result, alert: runtimeLastAlert } };
    }

    const services = [...new Set((rows || []).map((row) => row.service_key).filter((key) => monitorableServices.has(key)))];
    if (!services.length) {
      runtimeLastResult = { ok: true, state: 'NO_MONITORABLE_SUBSCRIPTIONS', trigger, checkedServices: [] };
      return { status: 200, payload: runtimeLastResult };
    }

    const results = [];
    for (const serviceKey of services) {
      console.log(`[Detector Runtime] Checking subscribed procedure ${serviceKey}`);
      results.push(await runServiceMonitor(serviceKey, trigger, rows));
    }
    return {
      status: 200,
      payload: {
        ok: results.every((r) => r.state !== 'ERROR'),
        state: 'MULTI_SERVICE_CHECK_COMPLETE',
        trigger,
        checkedServices: services,
        results,
        alert: runtimeLastAlert
      }
    };
  } finally {
    runtimeRunning = false;
  }
}

async function cleanupExpired() {
  if (!dbConfigured()) return;
  const now = new Date().toISOString();
  await dbRequest(`subscriptions?subscription_expires_at=lt.${encodeURIComponent(now)}`, {
    method: 'DELETE',
    prefer: 'return=minimal'
  });
  lastCleanupAt = Date.now();
}

async function intervalTick() {
  if (process.env.DETECTOR_MONITOR_ENABLED === 'false' || runtimeRunning) return;
  const now = Date.now();
  if (now - lastCleanupAt > 60 * 60_000) {
    await cleanupExpired().catch((error) => console.error('[Detector Runtime] Cleanup failed:', error.message));
  }
  if (now < nextSweepAt) return;
  const outcome = await runMonitor('interval');
  const results = outcome.payload?.results || [outcome.payload];
  const allErrored = results.length > 0 && results.every((item) => item?.state === 'ERROR');
  nextSweepAt = Date.now() + (allErrored ? errorBackoffMs : monitorIntervalMs);
  console.log(`[Detector Runtime] Next sweep in ${Math.round((nextSweepAt - Date.now()) / 60_000)} min`);
}

async function handleResume(res, code) {
  if (!code || !/^[A-Za-z0-9_-]{6,20}$/.test(code)) {
    res.writeHead(302, { location: '/?resume=invalid' }); res.end(); return true;
  }
  const rows = await activeSubscribers();
  const record = (rows || []).find((row) => parseAlertMeta(row.last_alert_key).resumeCode === code);
  if (!record?.last_alert_at) {
    res.writeHead(302, { location: '/?resume=expired' }); res.end(); return true;
  }
  const ageMs = Date.now() - new Date(record.last_alert_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > resumeLinkMinutes * 60_000) {
    res.writeHead(302, { location: '/?resume=expired' }); res.end(); return true;
  }

  const accessToken = crypto.randomBytes(32).toString('base64url');
  await dbRequest(`subscriptions?id=eq.${encodeURIComponent(record.id)}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { access_token_hash: digest(accessToken), updated_at: new Date().toISOString() }
  });

  const tokenJson = JSON.stringify(accessToken).replace(/</g, '\\u003c');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Detector de Citas</title><body style="background:#0b0d12;color:#fff;font-family:system-ui;padding:30px"><p>Abriendo Detector de Citas...</p><script>localStorage.setItem('citaNieAccessToken',${tokenJson});location.replace('/?resume=1');<\/script></body>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
  });
  res.end(html);
  return true;
}

function verifyStripeSignature(rawBody, signatureHeader) {
  if (!STRIPE_WEBHOOK_SECRET) return false;
  const parts = String(signatureHeader || '').split(',').map((v) => v.trim());
  const timestamp = parts.find((v) => v.startsWith('t='))?.slice(2);
  const signatures = parts.filter((v) => v.startsWith('v1=')).map((v) => v.slice(3));
  if (!timestamp || !signatures.length) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  return signatures.some((sig) => timingSafeEqualText(sig, expected));
}

async function createCheckoutSession(record) {
  if (!paymentConfigured()) throw new Error('payment_not_configured');
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('line_items[0][price]', STRIPE_PRICE_ID);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', `${appUrl}/?payment=success`);
  params.set('cancel_url', `${appUrl}/?payment=cancelled`);
  params.set('client_reference_id', String(record.id));
  params.set('metadata[subscription_id]', String(record.id));
  params.set('metadata[service_key]', String(record.service_key || ''));

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.url) throw new Error('checkout_create_failed');
  return payload;
}

async function handlePaymentCheckout(req, res) {
  if (!PAYMENT_REQUIRED) { json(res, 409, { error: 'payment_not_required' }); return true; }
  if (!paymentConfigured()) { json(res, 503, { error: 'payment_not_configured' }); return true; }
  const record = await authenticatedSubscription(req);
  if (!record) { json(res, 401, { error: 'unauthorized' }); return true; }
  if (record.active) { json(res, 200, { ok: true, alreadyActive: true, url: `${appUrl}/?payment=success` }); return true; }
  const session = await createCheckoutSession(record);
  json(res, 200, { ok: true, url: session.url });
  return true;
}

async function handleStripeWebhook(req, res) {
  if (!paymentConfigured()) { json(res, 503, { error: 'payment_not_configured' }); return true; }
  const raw = await readRaw(req, 128_000);
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'])) { json(res, 400, { error: 'invalid_signature' }); return true; }
  let event;
  try { event = JSON.parse(raw); } catch { json(res, 400, { error: 'invalid_json' }); return true; }

  if (event?.type === 'checkout.session.completed' && event?.data?.object?.payment_status === 'paid') {
    const recordId = event.data.object?.metadata?.subscription_id || event.data.object?.client_reference_id;
    if (recordId) {
      const rows = await dbRequest(`subscriptions?id=eq.${encodeURIComponent(recordId)}&select=*`);
      const record = rows?.[0];
      if (record) {
        const now = new Date();
        await dbRequest(`subscriptions?id=eq.${encodeURIComponent(record.id)}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            active: true,
            verified_at: now.toISOString(),
            subscription_expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
            updated_at: now.toISOString()
          }
        });
        const phone = unpackSmsNumber(record.phone);
        if (phone) {
          sendSms(phone, 'Detector de Citas: pago confirmado. Tu monitorizacion de 30 dias ya esta activa.', { customString: record.id })
            .catch((error) => console.error('[Detector Runtime] Confirmation SMS failed:', error.message));
        }
      }
    }
  }
  json(res, 200, { received: true });
  return true;
}

function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  return timingSafeEqualText(String(req.headers['x-admin-token'] || ''), ADMIN_TOKEN);
}

async function adminSummary(req, res) {
  if (!ADMIN_TOKEN) { json(res, 503, { error: 'admin_not_configured' }); return true; }
  if (!adminAuthorized(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
  const rows = await dbRequest('subscriptions?select=*');
  const now = Date.now();
  const byService = {};
  let active = 0, pending = 0, expired = 0, totalChecks = 0;
  const records = [];

  for (const row of rows || []) {
    const exp = new Date(row.subscription_expires_at).getTime();
    const isExpired = Number.isFinite(exp) && exp <= now;
    if (isExpired) expired += 1;
    else if (row.active) active += 1;
    else pending += 1;
    if (!isExpired && row.active) byService[row.service_key] = (byService[row.service_key] || 0) + 1;
    totalChecks += Number(row.check_count || 0);
    const phone = unpackSmsNumber(row.phone);
    const meta = parseAlertMeta(row.last_alert_key);
    records.push({
      id: row.id,
      serviceKey: row.service_key,
      serviceLabel: serviceLabel(row.service_key),
      phone: phone ? maskPhone(phone) : null,
      active: Boolean(row.active) && !isExpired,
      pending: !row.active && !isExpired,
      checks: row.check_count || 0,
      expiresAt: row.subscription_expires_at,
      lastAlertAt: row.last_alert_at,
      smsStatus: meta.status || null
    });
  }

  json(res, 200, {
    active, pending, expired,
    total: rows?.length || 0,
    totalChecks,
    byService,
    running: runtimeRunning,
    nextSweepAt: new Date(nextSweepAt).toISOString(),
    monitorIntervalMinutes,
    lastAlert: runtimeLastAlert,
    lastResultsByService,
    records: records.slice(0, 200)
  });
  return true;
}

async function serveAdmin(res) {
  const html = await fs.readFile(path.join(__dirname, 'admin.html'), 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(html);
  return true;
}

function publicConfig() {
  return {
    subscriptionsReady: smsConfigured(),
    smsReady: smsConfigured(),
    paymentRequired: PAYMENT_REQUIRED,
    paymentReady: paymentConfigured(),
    monitorIntervalMinutes,
    nextSweepAt: new Date(nextSweepAt).toISOString(),
    monitorableServices: [...monitorableServices],
    timeZone: madridTimeZone
  };
}

async function maybeHandle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/r/') && req.method === 'GET') return await handleResume(res, url.pathname.slice(3));
    if (url.pathname === '/api/payment/webhook' && req.method === 'POST') return await handleStripeWebhook(req, res);
    if (url.pathname === '/api/config' && req.method === 'GET') { json(res, 200, publicConfig()); return true; }
    if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { ok: true, runtime: true, ...publicConfig() }); return true; }
    if (url.pathname === '/api/sms/subscribe' && req.method === 'POST') return await beginSmsSubscription(req, res);
    if (url.pathname === '/api/sms/test' && req.method === 'POST') return await testSms(req, res);
    if (url.pathname === '/api/subscription' && req.method === 'GET') return await getSubscription(req, res);
    if (url.pathname === '/api/subscription' && req.method === 'DELETE') return await deleteSubscription(req, res);
    if (url.pathname === '/api/payment/checkout' && req.method === 'POST') return await handlePaymentCheckout(req, res);
    if (url.pathname === '/admin' && req.method === 'GET') return await serveAdmin(res);
    if (url.pathname === '/api/admin/summary' && req.method === 'GET') return await adminSummary(req, res);
    if (url.pathname === '/api/admin/check' && req.method === 'POST') {
      if (!adminAuthorized(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
      const outcome = await runMonitor('admin');
      json(res, outcome.status, outcome.payload);
      return true;
    }
    if (url.pathname === '/api/check/tie' && req.method === 'POST') {
      const expected = String(process.env.MONITOR_TEST_SECRET || '');
      if (expected && req.headers['x-monitor-secret'] !== expected) { json(res, 401, { error: 'unauthorized' }); return true; }
      const body = await readJson(req).catch(() => ({}));
      const forced = monitorableServices.has(body.serviceKey) ? body.serviceKey : null;
      const outcome = await runMonitor('manual', forced);
      json(res, outcome.status, outcome.payload);
      return true;
    }
    return false;
  } catch (error) {
    const known = new Set(['invalid_json', 'payload_too_large', 'invalid_phone', 'subscription_create_failed']);
    const status = known.has(error.message) ? 400 : 500;
    console.error('[Detector Runtime] Request error:', error.message);
    json(res, status, { error: status === 500 ? 'internal_error' : error.message });
    return true;
  }
}

// Wrap every HTTP server created after preload. Relevant routes are handled here;
// everything else falls through to the existing gateway/core unchanged.
const originalCreateServer = http.createServer.bind(http);
http.createServer = function detectorCreateServer(listener, ...rest) {
  if (typeof listener !== 'function') return originalCreateServer(listener, ...rest);
  const wrapped = (req, res) => {
    Promise.resolve(maybeHandle(req, res))
      .then((handled) => { if (!handled && !res.writableEnded) listener(req, res); })
      .catch((error) => {
        console.error('[Detector Runtime] Wrapper error:', error.message);
        if (!res.headersSent) json(res, 500, { error: 'internal_error' });
        else if (!res.writableEnded) res.end();
      });
  };
  return originalCreateServer(wrapped, ...rest);
};

if (isCoreProcess) {
  setInterval(() => intervalTick().catch((error) => console.error('[Detector Runtime] Interval error:', error.message)), 30_000);
  console.log(`[Detector Runtime] Loaded in core. SMS=${smsConfigured() ? 'ready' : 'not configured'}, interval=${monitorIntervalMinutes}m, admin=${ADMIN_TOKEN ? 'ready' : 'off'}, payment=${PAYMENT_REQUIRED ? (paymentConfigured() ? 'ready' : 'not configured') : 'off'}`);
} else {
  console.log('[Detector Runtime] Loaded in gateway.');
}
