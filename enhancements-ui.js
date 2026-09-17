(() => {
  const TOKEN_KEY = 'citaNieAccessToken';
  let clarificationValue = 'tie_renew';
  let dashboardMounted = false;
  let stylesMounted = false;

  function injectProfessionalStyles() {
    if (stylesMounted || document.getElementById('citanieProfessionalStyles')) return;
    stylesMounted = true;
    const style = document.createElement('style');
    style.id = 'citanieProfessionalStyles';
    style.textContent = `
      :root{--accent:#f5c84c;--bg:#090c11;--card:#111722;--card2:#151c28;--line:#273247;--muted:#98a4b5}
      body{background:radial-gradient(circle at 50% -10%,#1b2638 0,#0c1119 35%,#090c11 72%)!important}
      .wrap{max-width:860px!important;padding-top:18px!important}.nav{margin-bottom:16px!important}.brand{font-size:21px!important;letter-spacing:-.7px!important}.pill{font-size:12px!important;background:#111722!important}
      .hero{padding:12px 0 22px!important;text-align:left!important}.hero .eyebrow{font-size:12px!important;padding:7px 10px!important}.hero h1{max-width:720px!important;margin:15px 0 12px!important;font-size:clamp(36px,7vw,58px)!important;line-height:1.02!important;letter-spacing:-2.2px!important}.hero p{max-width:700px!important;margin:0!important;font-size:16px!important;line-height:1.55!important}
      .how{max-width:none!important;margin:18px 0 0!important;grid-template-columns:repeat(3,1fr)!important}.how div{padding:14px!important;background:#101620!important}.how b{font-size:13px!important}.how span{font-size:12px!important}
      .shell{padding:20px!important;border-radius:24px!important;border-color:#2b3548!important;box-shadow:0 24px 70px #0008!important}.stephead{margin-bottom:13px!important}.stephead b{font-size:19px!important}.stephead small{font-size:12px!important}.progress{margin-bottom:20px!important;height:5px!important}
      .grid{gap:10px!important}.choice{min-height:88px!important;padding:16px!important;border-radius:16px!important;background:#141b27!important}.choice:hover,.choice.active{transform:none!important;border-color:#8a7020!important;background:#1a2130!important}.choice .ico{display:none!important}.choice b{font-size:16px!important;margin-bottom:5px!important}.choice span{font-size:12px!important;line-height:1.4!important}
      #s2 .row,#s2>.field{display:none!important}#s2 .mapping{margin-top:2px!important;padding:18px!important;background:#101620!important}.tag{display:none!important}
      .smsbox{grid-template-columns:52px 1fr!important;padding:15px!important}.smsicon{width:52px!important;height:52px!important;border-radius:14px!important;font-size:24px!important}.smsbox h3{font-size:17px!important}.smsbox p{font-size:13px!important}.phonebox input{font-size:17px!important}.notice{background:#101620!important;border-color:#273247!important;color:#aeb8c7!important}
      .btn{border-radius:13px!important;min-height:46px!important}.btn.primary{box-shadow:0 8px 24px #f3c94b18!important}.actions{margin-top:16px!important}
      .dash{grid-template-columns:1fr!important}.panel{border-radius:18px!important}.big{font-size:25px!important}.kpis{gap:8px!important}.kpi{padding:12px!important}.human{background:#151a22!important;border-color:#303b4f!important;color:#c6cfdb!important}.footer{max-width:680px!important;margin-left:auto!important;margin-right:auto!important;color:#778395!important}
      .profile-card{border-radius:22px!important;padding:20px!important;background:linear-gradient(180deg,#111824,#0f151f)!important;border-color:#2c374b!important}.profile-card h3{font-size:22px!important;letter-spacing:-.4px!important}.profile-card .lead{font-size:13px!important;max-width:680px!important}.profile-field label{font-size:12px!important;font-weight:600!important}.profile-field input,.profile-field select{min-height:48px!important;background:#0b1018!important}.profile-actions{display:grid!important;grid-template-columns:1fr auto!important;align-items:center!important}.profile-btn{min-height:50px!important;font-size:15px!important}.profile-btn:not(.secondary){font-size:16px!important}.profile-btn.secondary{background:transparent!important;border:1px solid #303b4f!important;color:#aeb8c7!important}.profile-result{background:#0d141d!important;border-color:#2a3549!important}.profile-note{font-size:11px!important}.handoff{border-radius:18px!important;border-color:#4a5872!important}.handoff-head b{font-size:18px!important}.handoff-screen{border-radius:14px!important}.handoff-tools button.primary{background:var(--accent)!important}.handoff-keys button{font-size:12px!important;padding:9px 10px!important}
      #reassuranceBar{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0}#reassuranceBar span{font-size:11px;color:#aeb8c7;border:1px solid #293449;background:#101620;border-radius:999px;padding:7px 10px}
      @media(max-width:700px){.wrap{padding:12px 12px 46px!important}.hero{padding-top:4px!important}.hero h1{font-size:39px!important;letter-spacing:-1.7px!important}.hero p{font-size:15px!important}.how{grid-template-columns:1fr!important;gap:7px!important}.how div{padding:11px 12px!important}.shell{padding:14px!important;border-radius:20px!important}.grid{grid-template-columns:1fr!important}.choice{min-height:76px!important}.profile-grid{grid-template-columns:1fr!important}.profile-actions{grid-template-columns:1fr!important}.profile-btn.secondary{min-height:42px!important}.kpis{grid-template-columns:repeat(3,1fr)!important}.kpi b{font-size:15px!important}.nav{margin-bottom:10px!important}}
    `;
    document.head.appendChild(style);
  }

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

  function setText(selector, value) {
    const el = document.querySelector(selector);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function polishStaticUi() {
    document.title = 'CitaNIE · Encuentra tu cita NIE/TIE';
    const brand = document.querySelector('.brand');
    if (brand) brand.innerHTML = 'Cita<span>NIE</span>';
    setText('.nav .pill', 'Madrid · 30 días · Avisos SMS');
    const eyebrow = document.querySelector('.eyebrow');
    if (eyebrow) eyebrow.innerHTML = '<span class="dot"></span> Cita previa NIE / TIE';
    setText('.hero h1', 'Tu cita NIE/TIE, sin revisar la web todo el día.');
    setText('.hero p', 'Elige lo que necesitas y activa la búsqueda. CitaNIE revisa el portal por ti, prepara tus datos y te pide intervenir solo cuando aparece una verificación humana.');

    const how = document.querySelector('.how');
    if (how && !how.dataset.simple) {
      how.dataset.simple = '1';
      how.innerHTML = `
        <div><b>1. Elige tu trámite</b><span>Te lo explicamos con palabras sencillas.</span></div>
        <div><b>2. Nosotros buscamos</b><span>Revisamos el portal automáticamente.</span></div>
        <div><b>3. Tú confirmas</b><span>Solo intervienes si aparece CAPTCHA u otra verificación.</span></div>`;
      const bar = document.createElement('div');
      bar.id = 'reassuranceBar';
      bar.innerHTML = '<span>✓ Sin contraseñas</span><span>✓ Datos cifrados</span><span>✓ Puedes detenerlo cuando quieras</span>';
      how.insertAdjacentElement('afterend', bar);
    }

    const choices = {
      nie_new: ['Necesito NIE por primera vez', 'Primera asignación de NIE o certificado correspondiente.'],
      nie_renew: ['No sé qué debo renovar', 'Te ayudamos a distinguir entre NIE, TIE y otros documentos.'],
      lost: ['He perdido mi NIE/TIE', 'Pérdida, robo o documento inutilizable.'],
      tie_fingerprint: ['Necesito toma de huellas', 'Para expedir tu TIE cuando ya puedes solicitar la tarjeta.'],
      tie_renew: ['Quiero renovar mi TIE', 'Renovación de la tarjeta cuando corresponda.'],
      tie_duplicate: ['Necesito un duplicado TIE', 'Duplicado por pérdida, robo o deterioro.']
    };
    document.querySelectorAll('.choice').forEach((button) => {
      const copy = choices[button.dataset.key];
      if (!copy) return;
      const b = button.querySelector('b');
      const span = [...button.querySelectorAll('span')].find((x) => !x.classList.contains('ico'));
      if (b) b.textContent = copy[0];
      if (span) span.textContent = copy[1];
    });

    const visible = [1,2,3,4].find((n) => !document.getElementById(`s${n}`)?.classList.contains('hidden')) || 1;
    const titles = {1:'Elige qué necesitas',2:'Revisamos el trámite',3:'¿Dónde te avisamos?',4:'Tu búsqueda'};
    setText('#stepTitle', titles[visible]);
    setText('#stepCounter', `${visible} de 4`);

    const mapping = document.getElementById('mapping');
    if (mapping) mapping.setAttribute('aria-live', 'polite');

    const smsH = document.querySelector('#s3 .smsbox h3');
    if (smsH) smsH.textContent = 'Activa tus avisos';
    const smsP = document.querySelector('#s3 .smsbox p');
    if (smsP) smsP.textContent = 'Te escribimos cuando encontremos disponibilidad o necesitemos que hagas una verificación.';
    const phoneLabel = document.querySelector('#s3 .phonebox label');
    if (phoneLabel) phoneLabel.textContent = 'Tu número de móvil';
    const consent = document.querySelector('#s3 .consent span');
    if (consent && !consent.dataset.simple) {
      consent.dataset.simple = '1';
      consent.textContent = 'Acepto recibir avisos relacionados con esta búsqueda durante 30 días.';
    }
    const notice = document.querySelector('#s3 .notice');
    if (notice) notice.textContent = 'La cita oficial es gratuita. No guardamos contraseñas, PIN de Cl@ve ni códigos SMS.';
    const enable = document.getElementById('enableSms');
    if (enable && !enable.disabled && /Empezar monitorización|Configurar|Activar búsqueda/.test(enable.textContent)) enable.textContent = 'Activar búsqueda';

    const statusTitle = document.querySelector('#s4 .statusline b');
    if (statusTitle) statusTitle.textContent = 'Buscando tu cita';
    const mainPanelText = document.querySelector('#s4 .panel > p.muted');
    if (mainPanelText) mainPanelText.textContent = 'Revisamos el portal automáticamente. No tienes que dejar esta página abierta.';
    const human = document.querySelector('#s4 .human');
    if (human) human.innerHTML = '<b>Si aparece una verificación:</b> te mostraremos el CAPTCHA, Cl@ve o el paso manual aquí para que lo completes.';
    const refresh = document.getElementById('refreshStatus');
    if (refresh && !refresh.disabled) refresh.textContent = 'Actualizar';
    const unsub = document.getElementById('unsubscribe');
    if (unsub) unsub.textContent = 'Detener búsqueda y borrar datos';
    const footer = document.querySelector('.footer');
    if (footer) footer.textContent = 'CitaNIE ayuda a buscar y preparar tu cita. La disponibilidad y la confirmación final dependen del portal oficial.';
  }

  function polishProfileUi() {
    const card = document.querySelector('.profile-card');
    if (!card) return;
    const h3 = card.querySelector('h3');
    if (h3) h3.textContent = 'Completa tus datos una sola vez';
    const lead = card.querySelector('.lead');
    if (lead) lead.textContent = 'Los usamos para rellenar el portal por ti. Tú solo tendrás que intervenir si aparece una verificación personal.';

    const labelMap = [
      ['pDocumentType','Documento'],['pDocumentNumber','Número de documento / NIE'],['pFirstName','Nombre'],
      ['pSurname1','Primer apellido'],['pSurname2','Segundo apellido (opcional)'],['pBirthDate','Fecha de nacimiento'],
      ['pNationality','Nacionalidad'],['pCommunity','Comunidad autónoma'],['pMobile','Móvil'],['pEmail','Email']
    ];
    labelMap.forEach(([id,text]) => {
      const input = document.getElementById(id);
      const label = input?.closest('.profile-field')?.querySelector('label');
      if (label) label.textContent = text;
    });

    const consent = document.querySelector('.profile-consent span');
    if (consent && !consent.dataset.simple) {
      consent.dataset.simple = '1';
      consent.textContent = 'Acepto que CitaNIE guarde estos datos cifrados durante la búsqueda. No guardamos contraseñas ni códigos de verificación.';
    }
    const attempt = document.getElementById('attemptAppointment');
    if (attempt) {
      if (/Intentar cita con mis datos/.test(attempt.textContent)) attempt.textContent = 'Buscar cita ahora';
      if (/Intentando/.test(attempt.textContent)) attempt.textContent = 'Buscando…';
    }
    const del = document.getElementById('deleteProfile');
    if (del) del.textContent = 'Borrar datos';
    const result = document.getElementById('profileResult');
    if (result && /rellena únicamente campos compatibles/.test(result.textContent)) {
      result.textContent = 'Pulsa “Buscar cita ahora”. CitaNIE seleccionará Madrid, tu trámite y rellenará tus datos. Si aparece una verificación, te la mostraremos aquí.';
    }
    const note = document.querySelector('.profile-note');
    if (note && !note.dataset.simple) {
      note.dataset.simple = '1';
      note.textContent = 'Tus datos se guardan cifrados. La búsqueda automática está activa actualmente en Madrid.';
    }
    const handoffTitle = document.querySelector('.handoff-head b');
    if (handoffTitle) handoffTitle.textContent = 'Solo falta esta verificación';
    const handoffP = document.querySelector('.handoff-head p');
    if (handoffP) handoffP.textContent = 'Completa el CAPTCHA, Cl@ve o el código que pida el portal. Después continuamos en la misma sesión.';
    const help = document.querySelector('.handoff-help');
    if (help) help.textContent = 'Toca primero el campo en la pantalla. Si necesitas escribir, usa el cuadro de abajo.';
    const textInput = document.getElementById('handoffText');
    if (textInput) textInput.placeholder = 'Escribe aquí si el portal lo pide';
    const send = document.getElementById('handoffSendText');
    if (send) send.textContent = 'Enviar';
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
      <strong>¿Qué necesitas renovar?</strong>
      <p style="margin-bottom:10px">El número NIE no caduca. Elige tu situación y nosotros usamos el trámite correcto.</p>
      <select id="nieRenewTarget" style="width:100%;padding:13px;border-radius:12px;border:1px solid #263044;background:#0d121a;color:#f7f8fb">
        <option value="tie_renew">Mi TIE caduca o ha caducado</option>
        <option value="tie_fingerprint">Tengo resolución favorable y necesito mi TIE</option>
        <option value="tie_duplicate">He perdido / me han robado / se ha deteriorado mi TIE</option>
        <option value="unsupported">Otro documento o certificado</option>
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
              if (msg) msg.textContent = 'Ese documento necesita otro procedimiento. No activaremos una búsqueda incorrecta.';
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
      if (monitor && data.lastResult?.state === 'AVAILABILITY_DETECTED') monitor.textContent = '¡Posible cita detectada! Entra ahora para continuar.';
      else if (monitor && data.lastResult?.state === 'HUMAN_GATE') monitor.textContent = 'Necesitamos que completes una verificación para continuar.';
      else if (monitor && data.lastCheckedAt) monitor.textContent = `✓ Última revisión: ${fmtDate(data.lastCheckedAt)}. Seguimos buscando.`;
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
      <b>Detalles de la búsqueda</b>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px">
        <div class="kpi"><small>Última revisión</small><b id="lastCheckedValue" style="font-size:13px;margin-top:5px">Pendiente</b></div>
        <div class="kpi"><small>Último SMS</small><b id="smsDeliveryValue" style="font-size:13px;margin-top:5px">Sin SMS todavía</b></div>
        <div class="kpi"><small>Servicio hasta</small><b id="expiresValue" style="font-size:13px;margin-top:5px">—</b></div>
      </div>
      <button id="finishNowBtn" class="btn primary" style="width:100%;margin-top:14px">Buscar cita ahora</button>`;
    dash.appendChild(box);
    box.querySelector('#finishNowBtn').addEventListener('click', () => {
      const target = document.getElementById('attemptAppointment');
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => target.click(), 300); }
      else alert('Completa primero tus datos para que podamos avanzar por ti.');
    });
    refreshDashboard();
    setInterval(refreshDashboard, 30_000);
  }

  function polishAll() {
    injectProfessionalStyles();
    polishStaticUi();
    ensureClarifier();
    mountDashboardExtras();
    polishProfileUi();
  }

  function boot() {
    handleSecureResume();
    polishAll();
    if (new URLSearchParams(location.search).get('alert') === 'availability') {
      setTimeout(() => document.getElementById('s4')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 800);
    }
  }

  document.addEventListener('click', () => setTimeout(polishAll, 25));
  new MutationObserver(() => polishAll()).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  setInterval(polishAll, 1200);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();