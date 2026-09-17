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
    active: Boolean(record.active) && !expired,
    channel: 'push',
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
      tag: 'citanie-test',
      url: '/'
    });
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('[CitaNIE] Test push failed:', error.statusCode || '', error.message);
    return json(res, 502, { error: 'push_send_failed' });
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
    if (!unpackPushSubscription(subscriber.phone)) continue;
    await dbRequest(`subscriptions?id=eq.${subscriber.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { check_count: (subscriber.check_count || 0) + 1, updated_at: now }
    });
  }
}

async function notifySubscribers(result) {
  if (!pushConfigured()) {
    lastAlert = { ok: false, skipped: true, at: new Date().toISOString(), error: 'push_not_configured' };
    return;
  }

  const now = new Date();
  const alertKey = `${madridDateTime(now).date}:${result.state}`;
  const rows = await activeSubscribers();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const seenEndpoints = new Set();

  for (const subscriber of rows || []) {
    const subscription = unpackPushSubscription(subscriber.phone);
    if (!subscription || seenEndpoints.has(subscription.endpoint) || subscriber.last_alert_key === alertKey) {
      skipped += 1;
      continue;
    }
    seenEndpoints.add(subscription.endpoint);

    const label = serviceLabel(subscriber.service_key);
    const isAvailable = result.state === 'AVAILABILITY_DETECTED';
    const payload = isAvailable
      ? {
          title: '¡Posible cita disponible!',
          body: `Hemos detectado un cambio relevante para ${label}. Entra ahora para revisar el portal oficial.`,
          tag: `citanie-${alertKey}`,
          url: '/?alert=availability'
        }
      : {
          title: 'CitaNIE necesita tu atención',
          body: `El portal requiere intervención humana para ${label}. Abre la app para continuar.`,
          tag: `citanie-${alertKey}`,
          url: '/?alert=human'
        };

    try {
      await sendPush(subscription, payload);
      sent += 1;
      await dbRequest(`subscriptions?id=eq.${subscriber.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { last_alert_at: now.toISOString(), last_alert_key: alertKey, updated_at: now.toISOString() }
      });
    } catch (error) {
      failed += 1;
      console.error('[CitaNIE] Push failed:', error.statusCode || '', error.message);
      if ([404, 410].includes(Number(error.statusCode))) {
        await dbRequest(`subscriptions?id=eq.${subscriber.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { active: false, updated_at: now.toISOString() }
        }).catch(() => {});
      }
    }
  }

  lastAlert = {
    ok: failed === 0,
    skipped: false,
    at: now.toISOString(),
    recipients: rows?.length || 0,
    sent,
    failed,
    ignored: skipped
  };
}

async function runMonitor(trigger = 'manual') {
  if (running) return { status: 409, payload: { error: 'check_already_running' } };
  running = true;
  try {
    try {
      lastResult = await checkMadridTieAvailability({ safeMode: true });
    } catch (error) {
      lastResult = {
        ok: false,
        state: 'ERROR',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: error?.message || String(error)
      };
    }
    lastResult.trigger = trigger;
    try {
      await recordChecks();
      if (['HUMAN_GATE', 'AVAILABILITY_DETECTED'].includes(lastResult.state)) {
        await notifySubscribers(lastResult);
      }
    } catch (error) {
      lastAlert = { ok: false, skipped: false, at: new Date().toISOString(), error: error?.message || String(error) };
    }
    return { status: 200, payload: { ...lastResult, alert: lastAlert } };
  } finally {
    running = false;
  }
}

async function schedulerTick() {
  if (process.env.MONITOR_ENABLED === 'false') return;
  const now = madridDateTime();
  const slot = `${now.date}T${now.time}`;
  if (!scheduledTimes.has(now.time) || completedScheduleSlots.has(slot)) return;
  completedScheduleSlots.add(slot);
  for (const completed of completedScheduleSlots) {
    if (!completed.startsWith(now.date)) completedScheduleSlots.delete(completed);
  }
  console.log(`[CitaNIE] Scheduled check started for ${slot} ${madridTimeZone}`);
  const outcome = await runMonitor(`schedule:${slot}`);
  console.log(`[CitaNIE] Scheduled check finished with ${outcome.payload.state || outcome.payload.error}`);
}

function publicConfig() {
  return {
    subscriptionsReady: pushConfigured(),
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
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      return res.end(html);
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    const known = new Set([
      'invalid_json', 'payload_too_large', 'invalid_push_subscription',
      'consent_required', 'too_many_requests'
    ]);
    const status = known.has(error.message) ? 400 : 500;
    console.error('[CitaNIE] Request error:', error.message);
    return json(res, status, { error: status === 500 ? 'internal_error' : error.message });
  }
});

setInterval(() => schedulerTick().catch((error) => console.error('[CitaNIE] Scheduler error:', error)), 15_000);
server.listen(port, '0.0.0.0', () => {
  console.log(`CitaNIE Madrid listening on :${port}`);
  console.log(`[CitaNIE] Push notifications: ${pushConfigured() ? 'ready' : 'not configured'}`);
  console.log(`[CitaNIE] Schedule enabled for ${[...scheduledTimes].join(', ')} ${madridTimeZone}`);
});
