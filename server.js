import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  authenticatedSubscription, dbRequest, digest, encryptedSeedProfile, madridTimeZone,
  maskPhone, monitorableServices, normalizePhone, packSmsNumber, publicAppUrl, unpackSmsNumber
} from './lib/app-store.js';
import {
  clicksendConfigured, getSmsDelivery, packPushSubscription, pushConfigured,
  resumeLink, sendPush, sendSms, smsConfigured, unpackPushSubscription,
  validPushSubscription, validResume
} from './lib/messaging.js';
import { cleanupRetentionDays, monitorIntervalMinutes, monitorState, resultForService, runMonitor, schedulerTick } from './lib/monitoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const paymentRequired = String(process.env.PAYMENT_REQUIRED || 'false').toLowerCase() === 'true';
const checkoutUrl = String(process.env.CHECKOUT_URL || '').trim();
const paymentWebhookSecret = String(process.env.PAYMENT_WEBHOOK_SECRET || '').trim();
const adminDashboardKey = String(process.env.ADMIN_DASHBOARD_KEY || '').trim();
const requestWindows = new Map();

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
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
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const current = requestWindows.get(key);
  if (!current || current.resetAt <= now) { requestWindows.set(key, { count: 1, resetAt: now + windowMs }); return false; }
  current.count += 1;
  return current.count > limit;
}

async function beginPushSubscription(req, res) {
  if (!pushConfigured()) return json(res, 503, { error: 'push_not_configured' });
  const body = await readJson(req);
  if (body.consent !== true) return json(res, 400, { error: 'consent_required' });
  if (!validPushSubscription(body.subscription)) return json(res, 400, { error: 'invalid_push_subscription' });
  const serviceKey = monitorableServices.has(body.serviceKey) ? body.serviceKey : 'tie_fingerprint';
  const accessToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await dbRequest('subscriptions?on_conflict=phone', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: {
    phone: packPushSubscription(body.subscription), service_key: serviceKey, consent_at: now.toISOString(), active: true,
    verified_at: now.toISOString(), access_token_hash: digest(accessToken), otp_hash: null, otp_expires_at: null,
    otp_attempts: 0, subscription_expires_at: new Date(now.getTime() + 30 * 86400000).toISOString(), updated_at: now.toISOString()
  }});
  return json(res, 200, { ok: true, accessToken, expiresInDays: 30 });
}

async function beginSmsSubscription(req, res) {
  if (!smsConfigured()) return json(res, 503, { error: 'sms_not_configured' });
  const body = await readJson(req);
  if (body.consent !== true) return json(res, 400, { error: 'consent_required' });
  const phone = normalizePhone(body.phone);
  if (!phone) return json(res, 400, { error: 'invalid_phone' });
  if (rateLimited(`sms-start:${clientIp(req)}`, 8, 15 * 60_000)) return json(res, 429, { error: 'too_many_requests' });
  if (body.serviceKey === 'nie_renew') return json(res, 409, { error: 'procedure_needs_clarification' });
  const serviceKey = monitorableServices.has(body.serviceKey) ? body.serviceKey : 'tie_fingerprint';
  const now = new Date();
  const packedPhone = packSmsNumber(phone);
  const existing = await dbRequest(`subscriptions?phone=eq.${encodeURIComponent(packedPhone)}&select=id,otp_hash`);
  const accessToken = crypto.randomBytes(32).toString('base64url');
  const active = !paymentRequired;
  const common = {
    service_key: serviceKey, consent_at: now.toISOString(), active, verified_at: null,
    access_token_hash: active ? digest(accessToken) : null, otp_expires_at: null, otp_attempts: 0,
    subscription_expires_at: new Date(now.getTime() + (active ? 30 : 1) * 86400000).toISOString(), updated_at: now.toISOString()
  };
  let row;
  if (existing?.[0]) {
    const result = await dbRequest(`subscriptions?id=eq.${existing[0].id}`, { method: 'PATCH', prefer: 'return=representation', body: common });
    row = result?.[0] || { id: existing[0].id };
  } else {
    const result = await dbRequest('subscriptions', { method: 'POST', prefer: 'return=representation', body: { ...common, phone: packedPhone, otp_hash: encryptedSeedProfile(phone) } });
    row = result?.[0];
  }
  if (paymentRequired) {
    if (!checkoutUrl) return json(res, 503, { error: 'payment_not_configured' });
    const url = new URL(checkoutUrl);
    url.searchParams.set('reference', String(row.id));
    return json(res, 402, { error: 'payment_required', checkoutUrl: url.toString(), reference: String(row.id) });
  }
  return json(res, 200, { ok: true, accessToken, expiresInDays: 30, phone: maskPhone(phone) });
}

async function getSubscription(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  const expired = new Date(record.subscription_expires_at).getTime() <= Date.now();
  const smsPhone = unpackSmsNumber(record.phone);
  const serviceResult = resultForService(record.service_key);
  const delivery = smsPhone ? await getSmsDelivery(record) : null;
  return json(res, 200, {
    active: Boolean(record.active) && !expired,
    channel: smsPhone ? 'sms' : 'push',
    phone: smsPhone ? maskPhone(smsPhone) : null,
    serviceKey: record.service_key,
    verifiedAt: record.verified_at,
    expiresAt: record.subscription_expires_at,
    checks: record.check_count || 0,
    lastAlertAt: record.last_alert_at,
    lastCheckedAt: serviceResult?.finishedAt || null,
    lastResult: serviceResult,
    smsDelivery: delivery
  });
}
async function deleteSubscription(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  await dbRequest(`subscriptions?id=eq.${record.id}`, { method: 'DELETE', prefer: 'return=minimal' });
  return json(res, 200, { ok: true });
}
async function testSms(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  if (!record.active) return json(res, 402, { error: 'payment_required' });
  const phone = unpackSmsNumber(record.phone);
  if (!phone) return json(res, 400, { error: 'sms_number_missing' });
  try {
    const result = await sendSms(phone, 'Detector de Citas activado. Te avisaremos por SMS cuando detectemos disponibilidad.');
    const now = new Date().toISOString();
    const key = `test:${now}|${result.provider || ''}|${result.messageId || ''}|${result.status || 'queued'}`;
    await dbRequest(`subscriptions?id=eq.${record.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { verified_at: now, last_alert_at: now, last_alert_key: key, updated_at: now } });
    return json(res, 200, { ok: true, phone: maskPhone(phone), delivery: result.status || 'queued' });
  } catch (error) {
    console.error('[Detector de Citas] Test SMS failed:', error.message);
    return json(res, 502, { error: 'sms_send_failed' });
  }
}
async function testPush(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  const subscription = unpackPushSubscription(record.phone);
  if (!subscription) return json(res, 400, { error: 'push_subscription_missing' });
  try {
    await sendPush(subscription, { title: 'Detector de Citas activado', body: 'Alertas listas.', tag: 'detector-test', url: '/' });
    return json(res, 200, { ok: true });
  } catch { return json(res, 502, { error: 'push_send_failed' }); }
}

async function handleResume(url, res) {
  const raw = url.pathname.slice(3);
  const [id, exp, sig] = raw.split('.');
  if (!validResume(id, exp, sig)) {
    res.writeHead(302, { location: '/?resume=expired', 'cache-control': 'no-store' });
    return res.end();
  }
  const rows = await dbRequest(`subscriptions?id=eq.${encodeURIComponent(id)}&select=*`);
  const record = rows?.[0];
  if (!record || !record.active || new Date(record.subscription_expires_at).getTime() <= Date.now()) {
    res.writeHead(302, { location: '/?resume=inactive', 'cache-control': 'no-store' });
    return res.end();
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await dbRequest(`subscriptions?id=eq.${record.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { access_token_hash: digest(token), updated_at: new Date().toISOString() } });
  res.writeHead(302, { location: `/#access=${encodeURIComponent(token)}&alert=availability`, 'cache-control': 'no-store' });
  res.end();
}

async function handlePaymentActivation(req, res) {
  if (!paymentWebhookSecret) return json(res, 503, { error: 'payment_not_configured' });
  if (String(req.headers['x-payment-secret'] || '') !== paymentWebhookSecret) return json(res, 401, { error: 'unauthorized' });
  const body = await readJson(req);
  if (body.paid !== true || !body.reference) return json(res, 400, { error: 'invalid_payment_event' });
  const rows = await dbRequest(`subscriptions?id=eq.${encodeURIComponent(body.reference)}&select=*`);
  const record = rows?.[0];
  if (!record) return json(res, 404, { error: 'subscription_not_found' });
  const now = new Date();
  await dbRequest(`subscriptions?id=eq.${record.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { active: true, subscription_expires_at: new Date(now.getTime() + 30 * 86400000).toISOString(), updated_at: now.toISOString() } });
  const phone = unpackSmsNumber(record.phone);
  if (phone && smsConfigured()) await sendSms(phone, `Detector de Citas: servicio activado 30 dias. Entra aqui: ${resumeLink({ ...record, active: true })}`).catch(() => {});
  return json(res, 200, { ok: true });
}

function adminAuthorized(req) { return Boolean(adminDashboardKey) && String(req.headers['x-admin-key'] || '') === adminDashboardKey; }
async function adminSummary(req, res) {
  if (!adminAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
  const rows = await dbRequest('subscriptions?select=id,service_key,active,verified_at,subscription_expires_at,check_count,last_alert_at,last_alert_key,updated_at');
  const now = Date.now();
  const byService = {};
  let active = 0, expired = 0, smsAlerts = 0;
  for (const r of rows || []) {
    const isExpired = new Date(r.subscription_expires_at).getTime() <= now;
    if (r.active && !isExpired) active++;
    if (isExpired) expired++;
    byService[r.service_key] = (byService[r.service_key] || 0) + (r.active && !isExpired ? 1 : 0);
    if (r.last_alert_at) smsAlerts++;
  }
  return json(res, 200, { total: rows?.length || 0, active, expired, smsAlerts, byService, monitorIntervalMinutes, ...monitorState() });
}

function publicConfig() {
  return {
    subscriptionsReady: smsConfigured() || pushConfigured(),
    smsReady: smsConfigured(),
    pushReady: pushConfigured(),
    smsProvider: clicksendConfigured() ? 'clicksend' : (smsConfigured() ? 'twilio' : null),
    monitorableServices: [...monitorableServices],
    monitorIntervalMinutes,
    dataRetentionDays: cleanupRetentionDays,
    paymentRequired,
    paymentReady: !paymentRequired || Boolean(checkoutUrl && paymentWebhookSecret),
    timeZone: madridTimeZone,
    appUrl: publicAppUrl
  };
}

const staticFiles = new Map([
  ['/manifest.webmanifest', { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' }],
  ['/sw.js', { file: 'sw.js', type: 'application/javascript; charset=utf-8' }],
  ['/icon.svg', { file: 'icon.svg', type: 'image/svg+xml; charset=utf-8' }],
  ['/enhancements-ui.js', { file: 'enhancements-ui.js', type: 'application/javascript; charset=utf-8' }],
  ['/admin.html', { file: 'admin.html', type: 'text/html; charset=utf-8' }]
]);
async function serveStatic(urlPath, res) {
  const item = staticFiles.get(urlPath);
  if (!item) return false;
  const content = await fs.readFile(path.join(__dirname, item.file));
  res.writeHead(200, {
    'content-type': item.type,
    'cache-control': urlPath.endsWith('.html') || urlPath.endsWith('.js') ? 'no-store' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    ...(urlPath === '/sw.js' ? { 'service-worker-allowed': '/' } : {})
  });
  res.end(content);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/r/') && req.method === 'GET') return await handleResume(url, res);
    if (url.pathname === '/health') return json(res, 200, { ok: true, ...monitorState(), ...publicConfig() });
    if (url.pathname === '/api/config') return json(res, 200, publicConfig());
    if (url.pathname === '/api/status') return json(res, 200, { ...monitorState(), ...publicConfig() });
    if (url.pathname === '/api/sms/subscribe' && req.method === 'POST') return await beginSmsSubscription(req, res);
    if (url.pathname === '/api/sms/test' && req.method === 'POST') return await testSms(req, res);
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') return await beginPushSubscription(req, res);
    if (url.pathname === '/api/push/test' && req.method === 'POST') return await testPush(req, res);
    if (url.pathname === '/api/subscription' && req.method === 'GET') return await getSubscription(req, res);
    if (url.pathname === '/api/subscription' && req.method === 'DELETE') return await deleteSubscription(req, res);
    if (url.pathname === '/api/payment/activate' && req.method === 'POST') return await handlePaymentActivation(req, res);
    if (url.pathname === '/api/admin/summary' && req.method === 'GET') return await adminSummary(req, res);
    if (url.pathname === '/api/check/tie' && req.method === 'POST') {
      const expected = process.env.MONITOR_TEST_SECRET;
      if (expected && req.headers['x-monitor-secret'] !== expected) return json(res, 401, { error: 'unauthorized' });
      const body = await readJson(req).catch(() => ({}));
      const outcome = await runMonitor('manual', body.serviceKey || null);
      return json(res, outcome.status, outcome.payload);
    }
    if (url.pathname === '/admin' && req.method === 'GET') {
      const content = await fs.readFile(path.join(__dirname, 'admin.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(content);
    }
    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
      if (!html.includes('/enhancements-ui.js')) html = html.replace('</body>', '<script src="/enhancements-ui.js" defer></script>\n</body>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(html);
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    const known = new Set(['invalid_json', 'payload_too_large', 'consent_required', 'too_many_requests', 'invalid_phone', 'procedure_needs_clarification']);
    const status = known.has(error.message) ? 400 : 500;
    console.error('[Detector de Citas] Request error:', error.message);
    return json(res, status, { error: status === 500 ? 'internal_error' : error.message });
  }
});

setInterval(() => schedulerTick().catch((e) => console.error('[Detector de Citas] Scheduler error:', e.message)), 15_000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Detector de Citas Madrid listening on :${port}`);
  console.log(`[Detector de Citas] SMS: ${smsConfigured() ? (clicksendConfigured() ? 'ClickSend ready' : 'Twilio ready') : 'not configured'}`);
  console.log(`[Detector de Citas] Monitor interval: ${monitorIntervalMinutes} minutes; cleanup grace: ${cleanupRetentionDays} days.`);
});
