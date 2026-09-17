import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMadridTieAvailability } from './src/icpplus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const madridTimeZone = 'Europe/Madrid';
const scheduledTimes = new Set(
  (process.env.MONITOR_HOURS || '09:00,10:00,11:00')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

let running = false;
let lastResult = null;
let lastAlert = null;
const completedScheduleSlots = new Set();

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function madridDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: madridTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`
  };
}

async function sendWhatsAppAlert(result) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const recipient = process.env.WHATSAPP_ALERT_PHONE;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'hello_world';
  const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US';
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v23.0';

  if (!token || !phoneNumberId || !recipient) {
    lastAlert = {
      ok: false,
      skipped: true,
      at: new Date().toISOString(),
      message: 'WhatsApp is not configured in Render yet.'
    };
    return lastAlert;
  }

  const template = {
    name: templateName,
    language: { code: languageCode }
  };

  if (templateName !== 'hello_world') {
    template.components = [{
      type: 'body',
      parameters: [
        { type: 'text', text: result.state },
        { type: 'text', text: madridDateTime().time }
      ]
    }];
  }

  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'template',
      template
    })
  });

  const payload = await response.json().catch(() => ({}));
  lastAlert = {
    ok: response.ok,
    skipped: false,
    at: new Date().toISOString(),
    status: response.status,
    messageId: payload?.messages?.[0]?.id || null,
    error: response.ok ? null : payload?.error?.message || 'WhatsApp request failed'
  };
  return lastAlert;
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
    if (['HUMAN_GATE', 'AVAILABILITY_DETECTED'].includes(lastResult.state)) {
      try {
        await sendWhatsAppAlert(lastResult);
      } catch (error) {
        lastAlert = {
          ok: false,
          skipped: false,
          at: new Date().toISOString(),
          error: error?.message || String(error)
        };
      }
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

function injectStatusBanner(html) {
  const widget = `
    <div id="citanie-monitor-alert" role="status" aria-live="polite"></div>
    <script>
      (() => {
        const alertBox = document.getElementById('citanie-monitor-alert');
        Object.assign(alertBox.style, {
          display: 'none', position: 'fixed', left: '12px', right: '12px', bottom: '12px',
          zIndex: '99999', padding: '14px 16px', borderRadius: '14px', color: '#fff',
          fontFamily: 'system-ui, sans-serif', fontWeight: '700', boxShadow: '0 12px 36px #0008'
        });

        async function refreshMonitorStatus() {
          try {
            const response = await fetch('/api/status', { cache: 'no-store' });
            const data = await response.json();
            const state = data.lastResult?.state;
            if (!state) return;

            alertBox.style.display = 'block';
            if (state === 'AVAILABILITY_DETECTED') {
              alertBox.style.background = '#087f5b';
              alertBox.textContent = 'Cita disponibilă detectată — intervenție necesară acum.';
            } else if (state === 'HUMAN_GATE') {
              alertBox.style.background = '#b42318';
              alertBox.textContent = 'Portalul cere verificare umană — deschide fluxul de rezervare.';
            } else if (state === 'ERROR') {
              alertBox.style.background = '#9a6700';
              alertBox.textContent = 'Monitorul a întâmpinat o eroare. Verifică statusul.';
            } else {
              alertBox.style.background = '#1f2937';
              alertBox.textContent = 'Ultima verificare: ' + state;
            }
          } catch {}
        }

        refreshMonitorStatus();
        setInterval(refreshMonitorStatus, 15000);
      })();
    </script>`;
  return html.replace('</body>', `${widget}</body>`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      running,
      lastState: lastResult?.state || null,
      lastAlertOk: lastAlert?.ok ?? null
    });
  }

  if (url.pathname === '/api/status') {
    return json(res, 200, { running, lastResult, lastAlert, scheduledTimes: [...scheduledTimes], timeZone: madridTimeZone });
  }

  if (url.pathname === '/api/check/tie' && req.method === 'POST') {
    const expected = process.env.MONITOR_TEST_SECRET;
    if (expected && req.headers['x-monitor-secret'] !== expected) return json(res, 401, { error: 'unauthorized' });
    const outcome = await runMonitor('manual');
    return json(res, outcome.status, outcome.payload);
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(injectStatusBanner(html));
  }

  return json(res, 404, { error: 'not_found' });
});

setInterval(() => {
  schedulerTick().catch((error) => console.error('[CitaNIE] Scheduler error:', error));
}, 15000);

server.listen(port, '0.0.0.0', () => {
  console.log(`CitaNIE Madrid listening on :${port}`);
  console.log(`[CitaNIE] Schedule enabled for ${[...scheduledTimes].join(', ')} ${madridTimeZone}`);
});
