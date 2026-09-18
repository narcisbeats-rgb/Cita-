import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assistedServiceSupported } from './src/icpplus.js';
import {
  attemptWithBrowserHandoff, browserHandoffStatus, browserHandoffFrame,
  browserHandoffInput, stopBrowserHandoff, stopAllBrowserHandoffs
} from './lib/handoff-browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicPort = Number(process.env.PORT || 10000);
const internalPort = Number(process.env.CITANIE_INTERNAL_PORT || 3100);
const profileUiPath = path.join(__dirname, 'profile-ui.js');
const attemptWindows = new Map();

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

function appSecret() {
  const secret = String(process.env.APP_SECRET || '');
  if (secret.length < 32) throw new Error('app_secret_not_configured');
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
    console.error('[CitaNIE Profile] Database request failed:', response.status, payload?.message || 'unknown');
    throw new Error('database_request_failed');
  }
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

function encryptionKey() {
  const raw = String(process.env.PROFILE_ENCRYPTION_KEY || '').trim();
  if (!raw) throw new Error('profile_encryption_not_configured');
  const key = Buffer.from(raw, 'base64url');
  if (key.length !== 32) throw new Error('profile_encryption_not_configured');
  return key;
}

function encryptProfile(profile) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(profile), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `encprofile:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptProfile(value) {
  const stored = String(value || '');
  if (!stored.startsWith('encprofile:v1:')) return null;
  const parts = stored.slice('encprofile:v1:'.length).split('.');
  if (parts.length !== 3) return null;
  try {
    const [ivRaw, tagRaw, cipherRaw] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(cipherRaw, 'base64url')),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch (error) {
    console.error('[CitaNIE Profile] Decrypt failed:', error.message);
    return null;
  }
}

function cleanText(value, max = 120) {
  return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function sanitizeProfile(input = {}) {
  const documentType = ['NIE', 'PASSPORT'].includes(String(input.documentType || '').toUpperCase())
    ? String(input.documentType).toUpperCase()
    : 'NIE';
  const profile = {
    documentType,
    documentNumber: cleanText(input.documentNumber, 32).toUpperCase(),
    firstName: cleanText(input.firstName, 80),
    surname1: cleanText(input.surname1, 80),
    surname2: cleanText(input.surname2, 80),
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(String(input.birthDate || '')) ? String(input.birthDate) : '',
    nationality: cleanText(input.nationality, 80),
    email: cleanText(input.email, 120).toLowerCase(),
    mobile: cleanText(input.mobile, 32),
    monitoringAllowed: input.monitoringAllowed === true
  };
  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) throw new Error('invalid_email');
  return profile;
}

function profileSummary(profile) {
  return {
    documentType: profile?.documentType || 'NIE',
    documentNumber: profile?.documentNumber || '',
    firstName: profile?.firstName || '',
    surname1: profile?.surname1 || '',
    surname2: profile?.surname2 || '',
    birthDate: profile?.birthDate || '',
    nationality: profile?.nationality || '',
    email: profile?.email || '',
    mobile: profile?.mobile || '',
    monitoringAllowed: profile?.monitoringAllowed === true
  };
}

async function handleProfile(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET') {
    const profile = decryptProfile(record.otp_hash);
    return json(res, 200, { profile: profileSummary(profile), saved: Boolean(profile) });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (body.consent !== true) return json(res, 400, { error: 'profile_consent_required' });
    const profile = sanitizeProfile(body.profile || {});
    const now = new Date().toISOString();
    await dbRequest(`subscriptions?id=eq.${record.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { otp_hash: encryptProfile(profile), updated_at: now }
    });
    return json(res, 200, { ok: true, savedAt: now });
  }

  if (req.method === 'DELETE') {
    await stopBrowserHandoff(record.id).catch(() => {});
    await dbRequest(`subscriptions?id=eq.${record.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { otp_hash: null, updated_at: new Date().toISOString() }
    });
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'method_not_allowed' });
}

function attemptRateLimited(id) {
  const now = Date.now();
  const last = attemptWindows.get(id) || 0;
  if (now - last < 60_000) return true;
  attemptWindows.set(id, now);
  return false;
}

function clientFromProfile(profile) {
  return {
    documentType: profile.documentType,
    document: profile.documentNumber,
    firstName: profile.firstName,
    surname1: profile.surname1,
    surname2: profile.surname2,
    birthDate: profile.birthDate,
    nationality: profile.nationality,
    email: profile.email,
    mobile: profile.mobile,
    name: [profile.firstName, profile.surname1, profile.surname2].filter(Boolean).join(' ')
  };
}

async function handleAttempt(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const record = await authenticatedSubscription(req);
  if (!record) return json(res, 401, { error: 'unauthorized' });
  if (attemptRateLimited(record.id)) return json(res, 429, { error: 'attempt_too_soon' });

  const profile = decryptProfile(record.otp_hash);
  if (!profile?.documentNumber || !profile?.firstName) {
    return json(res, 400, { error: 'profile_incomplete' });
  }

  if (record.service_key === 'nie_renew') {
    return json(res, 409, {
      error: 'procedure_needs_clarification',
      serviceKey: record.service_key,
      message: 'El número NIE no caduca. Primero hay que identificar si necesitas renovar TIE, residencia o un certificado.'
    });
  }

  if (!assistedServiceSupported(record.service_key)) {
    return json(res, 409, { error: 'procedure_automation_not_ready', serviceKey: record.service_key });
  }

  const client = clientFromProfile(profile);
  const result = await attemptWithBrowserHandoff({
    ownerId: record.id,
    serviceKey: record.service_key,
    client,
    timeoutMs: 45_000
  });

  return json(res, 200, {
    ok: result.ok,
    state: result.state,
    serviceKey: record.service_key,
    message: result.message,
    province: result.province,
    procedure: result.procedure,
    url: result.url,
    filledFields: result.filledFields || [],
    handoff: result.handoff || null
  });
}

async function handoffOwner(req, res) {
  const record = await authenticatedSubscription(req);
  if (!record) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  return record;
}

async function handleHandoffStatus(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  const record = await handoffOwner(req, res);
  if (!record) return;
  return json(res, 200, await browserHandoffStatus(record.id));
}

async function handleHandoffFrame(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  const record = await handoffOwner(req, res);
  if (!record) return;
  const frame = await browserHandoffFrame(record.id);
  if (!frame) return json(res, 410, { error: 'handoff_expired' });
  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': frame.length,
    'cache-control': 'no-store, no-cache, must-revalidate',
    'x-content-type-options': 'nosniff'
  });
  res.end(frame);
}

async function handleHandoffInput(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const record = await handoffOwner(req, res);
  if (!record) return;
  const body = await readJson(req);
  const status = await browserHandoffInput(record.id, body);
  return json(res, 200, status);
}

async function handleHandoffClose(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const record = await handoffOwner(req, res);
  if (!record) return;
  return json(res, 200, await stopBrowserHandoff(record.id));
}

async function serveProfileUi(res) {
  const content = await fs.readFile(profileUiPath, 'utf8');
  res.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff'
  });
  res.end(content);
}

function proxyRequest(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port: internalPort,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${internalPort}` }
  };

  const upstream = http.request(options, (upstreamRes) => {
    const contentType = String(upstreamRes.headers['content-type'] || '');
    const shouldInject = req.method === 'GET' &&
      (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') &&
      contentType.includes('text/html');

    if (!shouldInject) {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on('data', (chunk) => chunks.push(chunk));
    upstreamRes.on('end', () => {
      let html = Buffer.concat(chunks).toString('utf8');
      if (!html.includes('/profile-ui.js')) {
        html = html.replace('</body>', '<script src="/profile-ui.js" defer></script>\n</body>');
      }
      const headers = { ...upstreamRes.headers };
      delete headers['content-length'];
      headers['cache-control'] = 'no-store';
      res.writeHead(upstreamRes.statusCode || 200, headers);
      res.end(html);
    });
  });

  upstream.on('error', (error) => {
    console.error('[CitaNIE Gateway] Proxy error:', error.message);
    if (!res.headersSent) json(res, 503, { error: 'service_starting' });
    else res.end();
  });
  req.pipe(upstream);
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(internalPort) },
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  console.error(`[CitaNIE Gateway] Core server exited (${code ?? signal}).`);
  process.exit(code || 1);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/profile-ui.js' && req.method === 'GET') return await serveProfileUi(res);
    if (url.pathname === '/api/profile') return await handleProfile(req, res);
    if (url.pathname === '/api/attempt') return await handleAttempt(req, res);
    if (url.pathname === '/api/handoff/status') return await handleHandoffStatus(req, res);
    if (url.pathname === '/api/handoff/frame') return await handleHandoffFrame(req, res);
    if (url.pathname === '/api/handoff/input') return await handleHandoffInput(req, res);
    if (url.pathname === '/api/handoff/close') return await handleHandoffClose(req, res);
    return proxyRequest(req, res);
  } catch (error) {
    const known = new Set([
      'invalid_json', 'payload_too_large', 'invalid_email', 'profile_encryption_not_configured',
      'handoff_expired', 'invalid_handoff_key', 'invalid_handoff_input'
    ]);
    const status = error.message === 'handoff_expired' ? 410 : (known.has(error.message) ? 400 : 500);
    console.error('[CitaNIE Gateway] Request error:', error.message);
    return json(res, status, { error: status === 500 ? 'internal_error' : error.message });
  }
});

async function shutdown() {
  await stopAllBrowserHandoffs().catch(() => {});
  child.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(publicPort, '0.0.0.0', () => {
  console.log(`CitaNIE gateway listening on :${publicPort}; core on :${internalPort}`);
  console.log(`[CitaNIE Gateway] Encrypted profiles: ${process.env.PROFILE_ENCRYPTION_KEY ? 'ready' : 'not configured'}`);
});
