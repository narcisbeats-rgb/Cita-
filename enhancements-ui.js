(() => {
  const TOKEN_KEY = 'citaNieAccessToken';
  let clarificationValue = 'tie_renew';
  let dashboardMounted = false;
  let attemptPollTimer = null;
  let liveFrameTimer = null;
  let liveFrameBusy = false;
  let liveFrameUrl = null;
  let attemptRequestRunning = false;

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

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  async function authJson(url, options = {}) {
    const response = await originalFetch(url, {
      ...options,
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
        ...(options.headers || {})
      },
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'internal_error');
      error.code = data.error || 'internal_error';
      error.data = data;
      throw error;
    }
    return data;
  }

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
    if (!token()) return;
    try {
      const r = await originalFetch('/api/subscription', { headers: { authorization: `Bearer ${token()}` }, cache: 'no-store' });
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

  function profilePayload() {
    const get = (id) => document.getElementById(id)?.value || '';
    return {
      documentType: get('pDocumentType') || 'NIE',
      documentNumber: get('pDocumentNumber'),
      firstName: get('pFirstName'),
      surname1: get('pSurname1'),
      surname2: get('pSurname2'),
      birthDate: get('pBirthDate'),
      nationality: `${get('pNationality')}||${get('pCommunity') || 'Comunidad de Madrid'}`,
      mobile: get('pMobile'),
      email: get('pEmail')
    };
  }

  function clearAttemptPolling() {
    clearInterval(attemptPollTimer);
    attemptPollTimer = null;
  }

  function clearLiveFramePolling() {
    clearInterval(liveFrameTimer);
    liveFrameTimer = null;
    if (liveFrameUrl) {
      URL.revokeObjectURL(liveFrameUrl);
      liveFrameUrl = null;
    }
  }

  async function refreshLiveFrame() {
    const panel = document.getElementById('handoffPanel');
    if (!panel?.classList.contains('open') || liveFrameBusy || !token()) {
      if (panel && !panel.classList.contains('open')) clearLiveFramePolling();
      return;
    }
    liveFrameBusy = true;
    try {
      const response = await originalFetch(`/api/handoff/frame?t=${Date.now()}`, {
        headers: { authorization: `Bearer ${token()}` },
        cache: 'no-store'
      });
      if (response.status === 410 || response.status === 401) {
        panel.classList.remove('open');
        clearLiveFramePolling();
        return;
      }
      if (!response.ok) return;
      const blob = await response.blob();
      if (liveFrameUrl) URL.revokeObjectURL(liveFrameUrl);
      liveFrameUrl = URL.createObjectURL(blob);
      const image = document.getElementById('handoffImage');
      if (image) image.src = liveFrameUrl;
      document.getElementById('handoffLoading')?.classList.add('hidden');
    } catch {}
    finally { liveFrameBusy = false; }
  }

  function openLiveHandoff(status) {
    const panel = document.getElementById('handoffPanel');
    if (!panel) return;
    panel.classList.add('open');
    document.getElementById('handoffLoading')?.classList.remove('hidden');
    const state = document.getElementById('handoffState');
    if (state) state.textContent = status?.message || (status?.url ? `Portal oficial · ${status.url}` : 'Sesión interactiva activa');
    clearLiveFramePolling();
    refreshLiveFrame();
    liveFrameTimer = setInterval(refreshLiveFrame, 900);
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function progressButtonText(state) {
    if (state === 'OPENING_PORTAL') return 'Abriendo portal…';
    if (state === 'SELECTING_PROVINCE') return 'Seleccionando Madrid…';
    if (state === 'SELECTING_PROCEDURE') return 'Seleccionando trámite…';
    if (state === 'CONTINUING') return 'Continuando…';
    if (state === 'FILLING_IDENTITY') return 'Rellenando datos…';
    return 'Preparando cita…';
  }

  function resetAttemptButton() {
    const button = document.getElementById('attemptAppointment');
    if (!button) return;
    button.disabled = false;
    button.textContent = 'Intentar cita con mis datos';
  }

  function applyStatus(status) {
    const box = document.getElementById('profileResult');
    const button = document.getElementById('attemptAppointment');
    if (!status?.active) return false;

    if (box && status.message) box.textContent = status.message;
    if (button) button.textContent = progressButtonText(status.state);

    if (status.state === 'HUMAN_GATE') {
      clearAttemptPolling();
      resetAttemptButton();
      if (box) box.textContent = status.message || 'El portal pide una verificación humana. Complétala dentro de CitaNIE.';
      openLiveHandoff(status);
      return true;
    }

    if (status.state === 'READY_FOR_HUMAN_CONTINUE' || status.state === 'AVAILABILITY_DETECTED') {
      clearAttemptPolling();
      resetAttemptButton();
      openLiveHandoff(status);
      return true;
    }

    if (status.state === 'NO_AVAILABILITY') {
      clearAttemptPolling();
      resetAttemptButton();
      if (box) box.textContent = status.message || 'No hay citas disponibles ahora.';
      return true;
    }

    if (status.state === 'ERROR') {
      clearAttemptPolling();
      resetAttemptButton();
      if (box) box.textContent = status.message || 'El portal no respondió correctamente.';
      return true;
    }

    return false;
  }

  async function pollAttemptStatus() {
    if (!token()) return;
    try {
      const status = await authJson('/api/handoff/status');
      applyStatus(status);
    } catch {}
  }

  function startAttemptPolling() {
    clearAttemptPolling();
    setTimeout(pollAttemptStatus, 250);
    attemptPollTimer = setInterval(pollAttemptStatus, 750);
  }

  async function startLiveAttempt(button) {
    if (attemptRequestRunning || button.disabled) return;
    const consent = document.getElementById('profileConsent');
    const result = document.getElementById('profileResult');
    const status = document.getElementById('profileStatus');
    if (!consent?.checked) {
      if (status) {
        status.textContent = 'Acepta el guardado cifrado de tus datos primero.';
        status.classList.add('err');
      }
      return;
    }

    attemptRequestRunning = true;
    button.disabled = true;
    button.textContent = 'Preparando cita…';
    if (result) result.textContent = 'Iniciando una sesión segura con el portal oficial…';
    clearAttemptPolling();
    clearLiveFramePolling();

    try {
      await authJson('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ consent: true, profile: profilePayload() })
      });
      await authJson('/api/handoff/close', { method: 'POST', body: '{}' }).catch(() => {});
      startAttemptPolling();

      authJson('/api/attempt', { method: 'POST', body: '{}' })
        .then((data) => {
          attemptRequestRunning = false;
          if (data?.handoff?.active) applyStatus(data.handoff);
          else if (data?.state === 'NO_AVAILABILITY') {
            clearAttemptPolling();
            resetAttemptButton();
            if (result) result.textContent = data.message || 'No hay citas disponibles ahora.';
          } else if (data?.state === 'HUMAN_GATE' || data?.state === 'READY_FOR_HUMAN_CONTINUE' || data?.state === 'AVAILABILITY_DETECTED') {
            clearAttemptPolling();
            resetAttemptButton();
            if (data.handoff?.active) openLiveHandoff(data.handoff);
          } else if (data?.message && result) {
            result.textContent = data.message;
            resetAttemptButton();
          }
        })
        .catch((error) => {
          attemptRequestRunning = false;
          clearAttemptPolling();
          resetAttemptButton();
          if (!result) return;
          if (error.code === 'attempt_too_soon') result.textContent = 'Espera un minuto antes de volver a intentarlo.';
          else if (error.code === 'profile_incomplete') result.textContent = 'Completa documento/NIE y nombre antes de intentar.';
          else result.textContent = 'No se pudo iniciar el intento ahora. Tus datos guardados no se han perdido.';
        });
    } catch (error) {
      attemptRequestRunning = false;
      clearAttemptPolling();
      resetAttemptButton();
      if (result) result.textContent = error.code === 'invalid_email' ? 'Revisa el email antes de continuar.' : 'No se pudieron preparar tus datos para la cita.';
    }
  }

  function boot() {
    handleSecureResume();
    ensureClarifier();
    mountDashboardExtras();
    if (new URLSearchParams(location.search).get('alert') === 'availability') {
      setTimeout(() => document.getElementById('s4')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 800);
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('#attemptAppointment');
    if (button) {
      event.preventDefault();
      event.stopImmediatePropagation();
      startLiveAttempt(button);
      return;
    }
    if (event.target?.closest?.('#handoffClose')) clearLiveFramePolling();
    setTimeout(() => { ensureClarifier(); mountDashboardExtras(); }, 20);
  }, true);

  new MutationObserver(() => { ensureClarifier(); mountDashboardExtras(); }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('beforeunload', () => {
    clearAttemptPolling();
    clearLiveFramePolling();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
