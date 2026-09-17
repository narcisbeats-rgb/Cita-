(() => {
  const TOKEN_KEY = 'citaNieAccessToken';
  let clarificationValue = 'tie_renew';
  let dashboardMounted = false;

  function handleSecureResume() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const access = hash.get('access');
    if (!access) return false;
    localStorage.setItem(TOKEN_KEY, access);
    history.replaceState(null, '', '/?alert=' + encodeURIComponent(hash.get('alert') || 'availability'));
    return true;
  }

  function currentService() {
    return document.querySelector('.choice.active')?.dataset?.key || '';
  }

  function ensureClarifier() {
    const section = document.getElementById('s2');
    if (!section) return;
    let box = document.getElementById('nieRenewClarifier');
    if (currentService() !== 'nie_renew') {
      if (box) box.remove();
      return;
    }
    if (box) return;
    box = document.createElement('div');
    box.id = 'nieRenewClarifier';
    box.className = 'mapping';
    box.innerHTML = `
      <strong>¿Qué documento necesitas realmente?</strong>
      <p style="margin-bottom:10px">El número NIE no caduca. Elige tu situación para que monitoricemos el trámite correcto.</p>
      <select id="nieRenewTarget" style="width:100%;padding:13px;border-radius:12px;border:1px solid #263044;background:#0d121a;color:#f7f8fb">
        <option value="tie_renew">Mi TIE caduca o ha caducado</option>
        <option value="tie_fingerprint">Tengo resolución favorable y necesito expedir la TIE</option>
        <option value="tie_duplicate">He perdido / me han robado / se ha deteriorado mi TIE</option>
        <option value="unsupported">Certificado UE, residencia u otro documento</option>
      </select>`;
    section.insertBefore(box, section.querySelector('.actions'));
    box.querySelector('#nieRenewTarget').addEventListener('change', (e) => { clarificationValue = e.target.value; });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (url.endsWith('/api/sms/subscribe') && init?.body) {
      try {
        const body = JSON.parse(init.body);
        if (body.serviceKey === 'nie_renew') {
          if (clarificationValue === 'unsupported') {
            setTimeout(() => {
              const msg = document.getElementById('smsMsg');
              if (msg) msg.textContent = 'Este documento necesita otro procedimiento. No activamos una monitorización incorrecta.';
            }, 0);
            return new Response(JSON.stringify({ error: 'procedure_needs_clarification' }), { status: 409, headers: { 'content-type': 'application/json' } });
          }
          body.serviceKey = clarificationValue;
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {}
    }
    const response = await originalFetch(input, init);
    if (url.endsWith('/api/sms/subscribe') && response.status === 402) {
      response.clone().json().then((data) => setTimeout(() => {
        const msg = document.getElementById('smsMsg');
        if (!msg || !data.checkoutUrl) return;
        msg.innerHTML = `Pago necesario para activar 30 días. <a href="${data.checkoutUrl}" style="color:#f3c94b;font-weight:700">Continuar al pago</a>`;
      }, 30)).catch(() => {});
    }
    return response;
  };

  function fmtDate(value) {
    if (!value) return 'Pendiente';
    try { return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); } catch { return 'Pendiente'; }
  }
  function deliveryLabel(delivery) {
    if (!delivery?.status) return 'Sin SMS todavía';
    const s = String(delivery.status).toLowerCase();
    if (s.includes('received on handset') || s.includes('201') || s.includes('delivered')) return 'Entregado';
    if (s.includes('fail') || s.includes('error') || s.includes('rejected')) return 'Fallido';
    return 'Enviado / en cola';
  }

  async function refreshDashboard() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    try {
      const r = await originalFetch('/api/subscription', { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const data = await r.json();
      const checked = document.getElementById('lastCheckedValue');
      const delivery = document.getElementById('smsDeliveryValue');
      const expiry = document.getElementById('expiresValue');
      if (checked) checked.textContent = fmtDate(data.lastCheckedAt);
      if (delivery) delivery.textContent = deliveryLabel(data.smsDelivery);
      if (expiry) expiry.textContent = fmtDate(data.expiresAt);
      const monitor = document.getElementById('monitorMessage');
      if (monitor && data.lastResult?.state === 'AVAILABILITY_DETECTED') monitor.textContent = '¡Disponibilidad detectada! Revisa el SMS y entra ahora para continuar.';
      else if (monitor && data.lastResult?.state === 'HUMAN_GATE') monitor.textContent = 'El portal necesita tu intervención. Entra para continuar de forma manual.';
      else if (monitor && data.lastCheckedAt) monitor.textContent = `✓ Última revisión: ${fmtDate(data.lastCheckedAt)}. Seguimos monitorizando.`;
    } catch {}
  }

  function mountDashboardExtras() {
    if (dashboardMounted) return;
    const dash = document.querySelector('#s4 .dash');
    if (!dash) return;
    dashboardMounted = true;
    const box = document.createElement('div');
    box.className = 'panel';
    box.style.gridColumn = '1 / -1';
    box.innerHTML = `
      <b>Estado en tiempo real</b>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px">
        <div class="kpi"><small>Última revisión</small><b id="lastCheckedValue" style="font-size:14px;margin-top:5px">Pendiente</b></div>
        <div class="kpi"><small>Último SMS</small><b id="smsDeliveryValue" style="font-size:14px;margin-top:5px">Sin SMS todavía</b></div>
        <div class="kpi"><small>Servicio hasta</small><b id="expiresValue" style="font-size:14px;margin-top:5px">—</b></div>
      </div>
      <button id="finishNowBtn" class="btn primary" style="width:100%;margin-top:14px">Finalizar cita ahora</button>`;
    dash.appendChild(box);
    box.querySelector('#finishNowBtn').addEventListener('click', () => {
      const target = document.getElementById('attemptAppointment');
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => target.click(), 350); }
      else alert('Completa primero tus datos personales para continuar con el portal oficial.');
    });
    refreshDashboard();
    setInterval(refreshDashboard, 30_000);
  }

  function boot() {
    handleSecureResume();
    ensureClarifier();
    mountDashboardExtras();
    if (new URLSearchParams(location.search).get('alert') === 'availability') {
      setTimeout(() => document.getElementById('s4')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 800);
    }
  }

  document.addEventListener('click', () => setTimeout(() => { ensureClarifier(); mountDashboardExtras(); }, 20));
  new MutationObserver(() => { ensureClarifier(); mountDashboardExtras(); }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
