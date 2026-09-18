import { checkMadridTieAvailability } from '../src/icpplus.js';
import { activeSubscribers, clientFromStoredProfile, dbConfigured, dbRequest, decryptStoredProfile, madridTimeZone, monitorableServices, serviceLabel, serviceSmsLabel, unpackSmsNumber } from './app-store.js';
import { parseAlertMeta, pushConfigured, resumeLink, sendPush, sendSms, smsConfigured, unpackPushSubscription } from './messaging.js';

export const monitorIntervalMinutes = Math.max(10, Number(process.env.MONITOR_INTERVAL_MINUTES || 15));
export const cleanupRetentionDays = Math.max(0, Number(process.env.DATA_RETENTION_DAYS || 7));
let running = false;
let lastResult = null;
const lastResultsByService = {};
let lastAlert = null;
let nextMonitorAt = 0;
let monitorFailures = 0;
let lastCleanupAt = 0;

function monitoringProbe(serviceKey, rows) {
  for (const subscriber of (rows || []).filter((row) => row.service_key === serviceKey)) {
    const profile = decryptStoredProfile(subscriber.otp_hash);
    if (!profile?.monitoringAllowed || !profile.documentNumber || !profile.firstName) continue;
    return { subscriber, client: clientFromStoredProfile(profile) };
  }
  return null;
}

async function recordChecks(serviceKey, rows) {
  const now = new Date().toISOString();
  for (const s of (rows || []).filter((r) => r.service_key === serviceKey)) {
    if (!unpackPushSubscription(s.phone) && !unpackSmsNumber(s.phone)) continue;
    await dbRequest(`subscriptions?id=eq.${s.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { check_count: (s.check_count || 0) + 1, updated_at: now } });
  }
}
async function notifySubscribers(result, serviceKey, rows) {
  if (!pushConfigured() && !smsConfigured()) return;
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: madridTimeZone }).format(now);
  const dedupe = `${date}:${serviceKey}:${result.state}`;
  const matching = (rows || []).filter((s) => s.service_key === serviceKey);
  let sent = 0, failed = 0, skipped = 0;
  for (const subscriber of matching) {
    if (parseAlertMeta(subscriber.last_alert_key).dedupeKey === dedupe) { skipped++; continue; }
    const phone = unpackSmsNumber(subscriber.phone);
    const push = unpackPushSubscription(subscriber.phone);
    try {
      let meta = { provider: '', messageId: '', status: '' };
      if (phone) {
        const link = resumeLink(subscriber);
        const preferred = Array.isArray(result.preferredCities) && result.preferredCities.length ? result.preferredCities.join(', ') : '';
        const alternative = result.locationMatchType === 'alternative' && result.alternativeLocations?.[0] ? result.alternativeLocations[0] : '';
        const preferredMatch = result.locationMatchType === 'preferred' && result.matchedLocation ? result.matchedLocation : '';
        const locationText = preferredMatch
          ? ` en ${preferredMatch}`
          : (alternative ? `. No aparece en ${preferred || 'tu ciudad'}, pero hay opción en ${alternative}` : '');
        const text = result.state === 'AVAILABILITY_DETECTED'
          ? `Detector de Citas: cita detectada para ${serviceSmsLabel(serviceKey)}${locationText}. Entra ahora: ${link}`
          : `Detector de Citas: el portal necesita tu intervencion para ${serviceSmsLabel(serviceKey)}. Entra: ${link}`;
        meta = await sendSms(phone, text);
      } else if (push) {
        await sendPush(push, { title: result.state === 'AVAILABILITY_DETECTED' ? 'Posible cita disponible' : 'Intervención necesaria', body: `${serviceLabel(serviceKey)} · abre Detector de Citas`, tag: `detector-${dedupe}`, url: '/' });
        meta = { provider: 'push', messageId: '', status: 'sent' };
      } else { skipped++; continue; }
      sent++;
      await dbRequest(`subscriptions?id=eq.${subscriber.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { last_alert_at: now.toISOString(), last_alert_key: `${dedupe}|${meta.provider || ''}|${meta.messageId || ''}|${meta.status || 'sent'}`, updated_at: now.toISOString() } });
    } catch (error) { failed++; console.error('[Detector de Citas] Notification failed:', serviceKey, error.message); }
  }
  lastAlert = { ok: failed === 0, at: now.toISOString(), serviceKey, recipients: matching.length, sent, failed, ignored: skipped };
}
async function runServiceMonitor(serviceKey, trigger, rows) {
  let result;
  const probe = monitoringProbe(serviceKey, rows);
  if (!probe) {
    const now = new Date().toISOString();
    result = {
      ok: true,
      state: 'PROFILE_REQUIRED',
      startedAt: now,
      finishedAt: now,
      message: 'Hace falta un perfil con monitorización automática autorizada para comprobar disponibilidad real.'
    };
  } else {
    try {
      result = await checkMadridTieAvailability({
        safeMode: false,
        serviceKey,
        client: probe.client,
        captureDebug: false
      });
    } catch (error) {
      result = { ok: false, state: 'ERROR', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), message: error?.message || String(error) };
    }
  }
  result.trigger = trigger;
  result.serviceKey = serviceKey;
  lastResult = result;
  lastResultsByService[serviceKey] = result;
  if (result.state !== 'PROFILE_REQUIRED') await recordChecks(serviceKey, rows).catch(() => {});
  if (result.state === 'AVAILABILITY_DETECTED') {
    await notifySubscribers(result, serviceKey, rows).catch(() => {});
  } else if (result.state === 'HUMAN_GATE' && probe?.subscriber) {
    await notifySubscribers(result, serviceKey, [probe.subscriber]).catch(() => {});
  }
  return result;
}
export async function runMonitor(trigger = 'manual', forcedServiceKey = null) {
  if (running) return { status: 409, payload: { error: 'check_already_running' } };
  running = true;
  try {
    const rows = dbConfigured() ? await activeSubscribers() : [];
    const services = forcedServiceKey ? [forcedServiceKey] : [...new Set((rows || []).map((s) => s.service_key).filter((k) => monitorableServices.has(k)))];
    if (forcedServiceKey && !monitorableServices.has(forcedServiceKey)) return { status: 400, payload: { error: 'procedure_not_monitorable', serviceKey: forcedServiceKey } };
    if (!services.length) return { status: 200, payload: { ok: true, state: 'NO_MONITORABLE_SUBSCRIPTIONS', trigger, checkedServices: [] } };
    const results = [];
    for (const key of services) { console.log(`[Detector de Citas] Checking ${key}`); results.push(await runServiceMonitor(key, trigger, rows)); }
    const errors = results.filter((r) => r.state === 'ERROR').length;
    monitorFailures = errors ? Math.min(monitorFailures + 1, 4) : 0;
    const delay = monitorIntervalMinutes * 60_000 * (errors ? 2 ** monitorFailures : 1);
    nextMonitorAt = Date.now() + Math.min(delay, 120 * 60_000);
    return { status: 200, payload: { ok: errors === 0, state: 'MULTI_SERVICE_CHECK_COMPLETE', trigger, checkedServices: services, results, nextCheckAt: new Date(nextMonitorAt).toISOString(), alert: lastAlert } };
  } finally { running = false; }
}
async function cleanupExpired() {
  if (!dbConfigured() || Date.now() - lastCleanupAt < 6 * 60 * 60_000) return;
  lastCleanupAt = Date.now();
  const cutoff = new Date(Date.now() - cleanupRetentionDays * 86400000).toISOString();
  await dbRequest(`subscriptions?subscription_expires_at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE', prefer: 'return=minimal' });
  console.log(`[Detector de Citas] Expired data cleanup completed (${cleanupRetentionDays}d grace).`);
}
export async function schedulerTick() {
  if (process.env.MONITOR_ENABLED === 'false') return;
  await cleanupExpired().catch((e) => console.error('[Detector de Citas] Cleanup error:', e.message));
  if (running || Date.now() < nextMonitorAt) return;
  const outcome = await runMonitor('interval');
  if (outcome.payload.state === 'NO_MONITORABLE_SUBSCRIPTIONS') nextMonitorAt = Date.now() + monitorIntervalMinutes * 60_000;
}
export function monitorState() {
  return { running, lastResult, lastResultsByService, lastAlert, nextCheckAt: nextMonitorAt ? new Date(nextMonitorAt).toISOString() : null };
}
export function resultForService(serviceKey) { return lastResultsByService[serviceKey] || null; }
