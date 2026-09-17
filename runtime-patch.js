import http from 'node:http';
import crypto from 'node:crypto';

const appUrl = String(process.env.PUBLIC_APP_URL || 'https://cita-fd42.onrender.com').replace(/\/$/, '');
const PAYMENT_REQUIRED = process.env.PAYMENT_REQUIRED === 'true';
const resumeLinkMinutes = Math.min(720, Math.max(15, Number(process.env.RESUME_LINK_MINUTES || 120)));
const CLICKSEND_USERNAME = String(process.env.CLICKSEND_USERNAME || '').trim();
const CLICKSEND_API_KEY = String(process.env.CLICKSEND_API_KEY || '').trim();

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function appSecret() {
  const secret = String(process.env.APP_SECRET || '');
  if (secret.length < 32) throw new Error('app_secret_not_configured');
  return secret;
}

function digest(value) {
  return crypto.createHmac('sha256', appSecret()).update(String(value)).digest('hex');
}

function dbKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function dbConfigured() {
  return Boolean(process.env.SUPABASE_URL && dbKey());
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
  if (!response.ok) throw new Error('database_request_failed');
  return payload;
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

function normalizePhone(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+') && /^\d{9}$/.test(phone)) phone = `+34${phone}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function smsCryptoKey() {
  return crypto.createHash('sha256').update(`detector-citas-sms:${appSecret()}`).digest();
}

function unpackSmsNumber(value) {
  const stored = String(value || '');
  if (!stored.startsWith('sms:v1:')) return null;
  const parts = stored.slice('sms:v1:'.length).split('.');
  if (parts.length !== 3) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', smsCryptoKey(), Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    const phone = Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'base64url')),
      decipher.final()
    ]).toString('utf8');
    return normalizePhone(phone);
  } catch {
    return null;
  }
}

function maskPhone(phone) {
  const normalized = normalizePhone(phone);
  return normalized ? `${normalized.slice(0, 3)}••••${normalized.slice(-4)}` : null;
}

function parseMeta(value) {
  const raw = String(value || '');
  if (!raw.startsWith('v2;')) return { alertKey: raw || null, resumeCode: null, messageId: null, status: null };
  const parts = Object.fromEntries(raw.slice(3).split(';').map((entry) => {
    const index = entry.indexOf('=');
    return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
  let alertKey = null;
  try { alertKey = parts.a ? Buffer.from(parts.a, 'base64url').toString('utf8') : null; } catch {}
  return { alertKey, resumeCode: parts.r || null, messageId: parts.m || null, status: parts.s || null };
}

function encodeMeta({ alertKey, resumeCode, messageId, status }) {
  const a = Buffer.from(String(alertKey || ''), 'utf8').toString('base64url');
  return `v2;a=${a};r=${resumeCode || ''};m=${messageId || ''};s=${status || ''}`;
}

function serviceLabel(key) {
  const labels = {
    nie_new: 'Sacar NIE',
    lost: 'NIE/TIE perdido',
    tie_fingerprint: 'Toma de huellas TIE',
    tie_renew: 'Renovar TIE',
    tie_duplicate: 'Duplicado TIE'
  };
  return labels[key] || 'Tramite NIE/TIE';
}

function alertState(alertKey) {
  const text = String(alertKey || '');
  if (text.includes(':AVAILABILITY_DETECTED:')) return 'AVAILABILITY_DETECTED';
  if (text.includes(':HUMAN_GATE:')) return 'HUMAN_GATE';
  return null;
}

async function clicksendReceipt(messageId) {
  if (!CLICKSEND_USERNAME || !CLICKSEND_API_KEY || !messageId) return null;
  const response = await fetch(`https://rest.clicksend.com/v3/sms/receipts/${encodeURIComponent(messageId)}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${CLICKSEND_USERNAME}:${CLICKSEND_API_KEY}`).toString('base64')}`,
      'content-type': 'application/json'
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.response_code !== 'SUCCESS') return null;
  let row = payload?.data;
  if (row && Array.isArray(row.data)) row = row.data[0] || null;
  if (Array.isArray(row)) row = row[0] || null;
  if (!row) return null;
  return {
    status: row.status || row.status_code || null,
    statusCode: row.status_code || null,
    statusText: row.status_text || row.error_text || null
  };
}

async function handleSubscription(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) { json(res, 401, { error: 'unauthorized' }); return true; }
  const expired = new Date(record.subscription_expires_at).getTime() <= Date.now();
  const phone = unpackSmsNumber(record.phone);
  const meta = parseMeta(record.last_alert_key);
  const receipt = meta.messageId ? await clicksendReceipt(meta.messageId).catch(() => null) : null;
  json(res, 200, {
    active: Boolean(record.active) && !expired,
    pendingPayment: !record.active && !expired && PAYMENT_REQUIRED,
    paymentRequired: PAYMENT_REQUIRED,
    channel: phone ? 'sms' : null,
    phone: phone ? maskPhone(phone) : null,
    serviceKey: record.service_key,
    serviceLabel: serviceLabel(record.service_key),
    verifiedAt: record.verified_at,
    expiresAt: record.subscription_expires_at,
    checks: record.check_count || 0,
    lastAlertAt: record.last_alert_at,
    lastCheckAt: record.updated_at || null,
    lastState: alertState(meta.alertKey),
    smsStatus: receipt?.status || meta.status || null,
    smsStatusText: receipt?.statusText || null
  });
  return true;
}

async function handleResume(req, res, code) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(code || '')) {
    res.writeHead(302, { location: '/?resume=invalid' }); res.end(); return true;
  }
  const nowIso = new Date().toISOString();
  const rows = await dbRequest(`subscriptions?active=eq.true&subscription_expires_at=gt.${encodeURIComponent(nowIso)}&select=*`);
  const record = (rows || []).find((row) => parseMeta(row.last_alert_key).resumeCode === code);
  if (!record?.last_alert_at) {
    res.writeHead(302, { location: '/?resume=expired' }); res.end(); return true;
  }
  const ageMs = Date.now() - new Date(record.last_alert_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > resumeLinkMinutes * 60_000) {
    res.writeHead(302, { location: '/?resume=expired' }); res.end(); return true;
  }

  const accessToken = crypto.randomBytes(32).toString('base64url');
  const meta = parseMeta(record.last_alert_key);
  await dbRequest(`subscriptions?id=eq.${encodeURIComponent(record.id)}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      access_token_hash: digest(accessToken),
      last_alert_key: encodeMeta({ ...meta, resumeCode: '' }),
      updated_at: new Date().toISOString()
    }
  });

  const safeToken = JSON.stringify(accessToken).replace(/</g, '\\u003c');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Detector de Citas</title><body style="background:#0b0d12;color:#fff;font-family:system-ui;padding:30px"><p>Abriendo Detector de Citas...</p><script>localStorage.setItem('citaNieAccessToken',${safeToken});location.replace('/?resume=1');<\/script></body>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
  });
  res.end(html);
  return true;
}

async function maybeHandle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/r/') && req.method === 'GET') return await handleResume(req, res, url.pathname.slice(3));
    if (url.pathname === '/api/subscription' && req.method === 'GET') return await handleSubscription(req, res);
    if (url.pathname === '/api/attempt' && req.method === 'POST' && PAYMENT_REQUIRED) {
      const record = await authenticatedSubscription(req);
      if (!record) { json(res, 401, { error: 'unauthorized' }); return true; }
      const expired = new Date(record.subscription_expires_at).getTime() <= Date.now();
      if (!record.active || expired) { json(res, 402, { error: 'subscription_inactive' }); return true; }
    }
    return false;
  } catch (error) {
    console.error('[Detector Patch] Request error:', error.message);
    if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    else if (!res.writableEnded) res.end();
    return true;
  }
}

const previousCreateServer = http.createServer.bind(http);
http.createServer = function detectorPatchedCreateServer(listener, ...rest) {
  if (typeof listener !== 'function') return previousCreateServer(listener, ...rest);
  const wrapped = (req, res) => {
    Promise.resolve(maybeHandle(req, res))
      .then((handled) => { if (!handled && !res.writableEnded) listener(req, res); })
      .catch((error) => {
        console.error('[Detector Patch] Wrapper error:', error.message);
        if (!res.headersSent) json(res, 500, { error: 'internal_error' });
        else if (!res.writableEnded) res.end();
      });
  };
  return previousCreateServer(wrapped, ...rest);
};

console.log(`[Detector Patch] Loaded. One-time resume links=${resumeLinkMinutes}m, payment guard=${PAYMENT_REQUIRED ? 'on' : 'off'}, app=${appUrl}`);
