import crypto from 'node:crypto';

export const madridTimeZone = 'Europe/Madrid';
export const publicAppUrl = String(process.env.PUBLIC_APP_URL || 'https://cita-fd42.onrender.com').replace(/\/$/, '');
export const monitorableServices = new Set(['nie_new', 'lost', 'tie_fingerprint', 'tie_renew', 'tie_duplicate']);

export function appSecret() {
  const secret = String(process.env.APP_SECRET || '');
  if (secret.length < 32) throw new Error('app_secret_not_configured');
  return secret;
}
export function digest(value) { return crypto.createHmac('sha256', appSecret()).update(String(value)).digest('hex'); }
function dbKey() { return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''; }
export function dbConfigured() { return Boolean(process.env.SUPABASE_URL && dbKey()); }

export async function dbRequest(resource, { method = 'GET', body, prefer } = {}) {
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

export function normalizePhone(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+') && /^\d{9}$/.test(phone)) phone = `+34${phone}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
function smsCryptoKey() { return crypto.createHash('sha256').update(`detector-citas-sms:${appSecret()}`).digest(); }
export function packSmsNumber(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('invalid_phone');
  const iv = crypto.createHmac('sha256', appSecret()).update(`sms-iv:${normalized}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', smsCryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  return `sms:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
export function unpackSmsNumber(value) {
  const stored = String(value || '');
  if (!stored.startsWith('sms:v1:')) return null;
  const parts = stored.slice(7).split('.');
  if (parts.length !== 3) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', smsCryptoKey(), Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return normalizePhone(Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8'));
  } catch { return null; }
}
export function maskPhone(phone) { const p = normalizePhone(phone); return p ? `${p.slice(0, 3)}••••${p.slice(-4)}` : null; }

function profileEncryptionKey() {
  const raw = String(process.env.PROFILE_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64url');
  return key.length === 32 ? key : null;
}
export function encryptedSeedProfile(phone) {
  const key = profileEncryptionKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ mobile: phone }), 'utf8')), cipher.final()]);
  return `encprofile:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptStoredProfile(value) {
  const stored = String(value || '');
  if (!stored.startsWith('encprofile:v1:')) return null;
  const key = profileEncryptionKey();
  if (!key) return null;
  const parts = stored.slice('encprofile:v1:'.length).split('.');
  if (parts.length !== 3) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'base64url')),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

export function clientFromStoredProfile(profile = {}) {
  return {
    documentType: profile.documentType || 'NIE',
    document: profile.documentNumber || '',
    firstName: profile.firstName || '',
    surname1: profile.surname1 || '',
    surname2: profile.surname2 || '',
    birthDate: profile.birthDate || '',
    nationality: profile.nationality || '',
    email: profile.email || '',
    mobile: profile.mobile || '',
    name: [profile.firstName, profile.surname1, profile.surname2].filter(Boolean).join(' ')
  };
}

export function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}
export async function authenticatedSubscription(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const rows = await dbRequest(`subscriptions?access_token_hash=eq.${digest(token)}&select=*`);
  return rows?.[0] || null;
}
export async function activeSubscribers() {
  const now = new Date().toISOString();
  return dbRequest(`subscriptions?active=eq.true&subscription_expires_at=gt.${encodeURIComponent(now)}&select=*`);
}
export function serviceLabel(key) {
  return ({ nie_new: 'Sacar NIE', nie_renew: 'Renovar documentación NIE/TIE', lost: 'NIE/TIE perdido', tie_fingerprint: 'Toma de huellas TIE', tie_renew: 'Renovar TIE', tie_duplicate: 'Duplicado TIE' })[key] || 'tu trámite NIE/TIE';
}
export function serviceSmsLabel(key) {
  return ({ nie_new: 'NIE', lost: 'NIE/TIE perdido', tie_fingerprint: 'huellas TIE', tie_renew: 'renovar TIE', tie_duplicate: 'duplicado TIE' })[key] || 'NIE/TIE';
}
