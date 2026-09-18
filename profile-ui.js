(() => {
  const token = () => localStorage.getItem('citaNieAccessToken') || '';
  const authHeaders = () => ({ authorization: `Bearer ${token()}`, 'content-type': 'application/json' });
  let mounted = false;
  let saveTimer = null;
  let loading = false;
  let handoffTimer = null;
  let handoffFrameBusy = false;
  let handoffObjectUrl = null;
  let handoffStatusTick = 0;
  let handoffPointerStart = null;
  let handoffSuppressClickUntil = 0;

  const COUNTRY_CODES = `AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW`.split(' ');
  const COMMUNITIES = [
    'Andalucía', 'Aragón', 'Principado de Asturias', 'Illes Balears', 'Canarias', 'Cantabria',
    'Castilla-La Mancha', 'Castilla y León', 'Cataluña', 'Comunitat Valenciana', 'Extremadura',
    'Galicia', 'Comunidad de Madrid', 'Región de Murcia', 'Comunidad Foral de Navarra',
    'País Vasco', 'La Rioja', 'Ceuta', 'Melilla'
  ];
  const GEO_SEPARATOR = '||';

  function countryDisplayName(code) {
    try { return new Intl.DisplayNames(['es'], { type: 'region' }).of(code) || code; }
    catch { return code; }
  }

  function encodeGeo(nationality, community) {
    return `${String(nationality || '').trim()}${GEO_SEPARATOR}${String(community || 'Comunidad de Madrid').trim()}`.slice(0, 80);
  }

  function decodeGeo(stored) {
    const value = String(stored || '').trim();
    if (value.includes(GEO_SEPARATOR)) {
      const [nationality = '', community = 'Comunidad de Madrid'] = value.split(GEO_SEPARATOR);
      return { nationality, community: community || 'Comunidad de Madrid' };
    }
    if (!value) return { nationality: '', community: 'Comunidad de Madrid' };
    const normalized = value.toLocaleLowerCase('es');
    const match = COUNTRY_CODES.find((code) => countryDisplayName(code).toLocaleLowerCase('es') === normalized);
    return { nationality: match || value, community: 'Comunidad de Madrid' };
  }

  function populateLocationSelects() {
    const nationality = field('pNationality');
    const community = field('pCommunity');
    if (nationality && !nationality.dataset.ready) {
      const current = nationality.value;
      const countries = COUNTRY_CODES
        .map((code) => ({ code, name: countryDisplayName(code) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
      nationality.innerHTML = '<option value="">Selecciona nacionalidad</option>' + countries
        .map(({ code, name }) => `<option value="${code}">${name}</option>`).join('');
      nationality.dataset.ready = '1';
      if (current) nationality.value = current;
    }
    if (community && !community.dataset.ready) {
      community.innerHTML = COMMUNITIES.map((name) => `<option value="${name}">${name}</option>`).join('');
      community.dataset.ready = '1';
      community.value = 'Comunidad de Madrid';
    }
  }

  function updateBranding() {
    const brand = document.querySelector('.brand');
    const eyebrow = document.querySelector('.eyebrow');
    const heroTitle = document.querySelector('.hero h1');
    const heroText = document.querySelector('.hero p');
    if (brand) brand.innerHTML = 'Detector de <span>Citas</span>';
    if (eyebrow) eyebrow.innerHTML = '<span class="dot"></span> CitaNIE Madrid · Monitorización de citas';
    if (heroTitle) heroTitle.textContent = 'Detectamos citas disponibles por ti.';
    if (heroText) heroText.textContent = 'Monitorizamos el portal oficial de cita previa para trámites NIE/TIE en Madrid. Eliges tu trámite y guardas tus datos una sola vez; cuando detectamos disponibilidad, recibes una alerta inmediata en iPhone o Android y puedes intentar continuar con tus datos ya preparados. Las verificaciones CAPTCHA, Cl@ve o SMS las completa siempre una persona.';
  }

  const css = document.createElement('style');
  css.textContent = `
    .profile-card{margin:0 0 14px;background:#101620;border:1px solid #263044;border-radius:20px;padding:18px}
    .profile-card h3{margin:0 0 6px;font-size:19px}.profile-card .lead{margin:0 0 16px;color:#9ca7b8;font-size:14px;line-height:1.5}
    .profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.profile-field{display:flex;flex-direction:column;gap:7px}
    .profile-field label{font-size:12px;color:#c8d0dc}.profile-field input,.profile-field select{width:100%;padding:13px;border-radius:13px;border:1px solid #263044;background:#0d121a;color:#f7f8fb;outline:none}
    .profile-field input:focus,.profile-field select:focus{border-color:#725f22}.profile-wide{grid-column:1/-1}.profile-consent{display:flex;gap:10px;align-items:flex-start;margin:14px 0;color:#9ca7b8;font-size:12px;line-height:1.5}
    .profile-consent input{margin-top:3px}.profile-status{min-height:20px;font-size:12px;color:#9be7bd;margin-top:8px}.profile-status.err{color:#fca5a5}
    .profile-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.profile-btn{border:0;border-radius:13px;padding:12px 15px;font-weight:700;cursor:pointer;background:#f3c94b;color:#16130b}.profile-btn.secondary{background:#1b2230;color:#dce2ea}.profile-btn:disabled{opacity:.55;cursor:not-allowed}
    .profile-result{margin-top:12px;padding:12px 14px;border-radius:13px;background:#111824;border:1px solid #263044;color:#c9d2df;font-size:13px;line-height:1.5}.profile-result.searching{border-color:#756322;background:linear-gradient(135deg,#17191c,#25210f)}.profile-result.monitoring{border-color:#285f49;background:#10231c;color:#d8f9e9}.search-live{display:flex;align-items:center;gap:12px}.search-spinner{width:24px;height:24px;border:3px solid #f3c94b3d;border-top-color:#f3c94b;border-radius:50%;animation:cita-spin .8s linear infinite;flex:0 0 auto}.search-live b{display:block;color:#fff;font-size:15px}.search-live small{display:block;color:#b9c3d2;margin-top:2px}.search-schedule{display:block;margin-top:8px;color:#9be7bd;font-weight:700}@keyframes cita-spin{to{transform:rotate(360deg)}}.profile-note{margin-top:12px;color:#7f8a9a;font-size:11px;line-height:1.45}
    html.handoff-active,html.handoff-active body{overflow:hidden;overscroll-behavior:none}
    .handoff{display:none;position:fixed;inset:0;z-index:10000;background:#080c12;color:#f7f8fb;padding:max(10px,env(safe-area-inset-top)) max(10px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));flex-direction:column}.handoff.open{display:flex}.handoff-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex:0 0 auto;padding:2px 2px 10px}.handoff-head b{display:block;font-size:17px}.handoff-head p{margin:3px 0 0;color:#aeb8c7;font-size:12px;line-height:1.35}.handoff-close{border:0;border-radius:12px;background:#1b2230;color:#f7f8fb;padding:10px 13px;font-weight:800;flex:0 0 auto}
    .handoff-browser{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;background:#111722;border:1px solid #344057;border-radius:16px;padding:8px;-webkit-overflow-scrolling:touch}.handoff-browser-label{display:flex;align-items:center;gap:7px;max-width:var(--handoff-viewport-width,1280px);margin:0 auto 7px;color:#b9c3d2;font-size:11px}.handoff-live-dot{width:8px;height:8px;border-radius:50%;background:#32d583;box-shadow:0 0 0 4px #32d5831f}.handoff-screen{position:relative;width:min(100%,var(--handoff-viewport-width,1280px));margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #39445a;min-height:220px;box-shadow:0 10px 40px #0008}.handoff-screen img{display:block;width:100%;height:auto;user-select:none;-webkit-user-select:none;touch-action:pan-x;cursor:pointer}.handoff-loading{position:absolute;inset:0;display:grid;place-items:center;color:#1d2735;background:#f8fafced;font-weight:800;font-size:14px}.handoff-loading.hidden{display:none}
    .handoff-footer{flex:0 0 auto;padding:10px 2px 0;background:#080c12}.handoff-primary{width:100%;min-height:55px;border:0;border-radius:15px;background:#f3c94b;color:#16130b;font-size:16px;font-weight:900;padding:13px 16px;box-shadow:0 8px 24px #0007}.handoff-primary:disabled{opacity:.58}.handoff-state{margin:8px 4px 0;color:#b5bfce;font-size:11px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.handoff-keyboard{margin-top:8px;border:1px solid #263044;border-radius:12px;background:#101620}.handoff-keyboard summary{cursor:pointer;padding:10px 12px;color:#dce2ea;font-size:12px;font-weight:700}.handoff-keyboard-inner{padding:0 10px 10px}.handoff-help{margin:0 0 8px;color:#9ca7b8;font-size:11px;line-height:1.4}.handoff-tools{display:grid;grid-template-columns:1fr auto;gap:8px}.handoff-tools input{min-width:0;width:100%;padding:12px;border-radius:11px;border:1px solid #334059;background:#0b1018;color:#f7f8fb;font-size:16px}.handoff-tools button,.handoff-keys button{border:0;border-radius:11px;background:#1b2230;color:#dce2ea;padding:11px 12px;font-weight:800}.handoff-tools button.primary{background:#f3c94b;color:#16130b}.handoff-keys{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}
    @media(max-width:700px){.profile-grid{grid-template-columns:1fr}.profile-wide{grid-column:auto}.profile-actions .profile-btn{flex:1;min-width:140px}.handoff{padding:max(7px,env(safe-area-inset-top)) 7px max(7px,env(safe-area-inset-bottom))}.handoff-head{padding:1px 2px 7px}.handoff-head p{max-width:265px}.handoff-browser{border-radius:12px;padding:5px}.handoff-screen{border-radius:8px;min-height:240px}.handoff-footer{padding-top:8px}.handoff-primary{min-height:58px}.handoff-tools{grid-template-columns:1fr auto}}
  `;
  document.head.appendChild(css);

  function field(id) { return document.getElementById(id); }
  function setStatus(text, error = false) {
    const el = field('profileStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', error);
  }

  function cityPreferencesFromForm() {
    return String(field('pCities')?.value || '')
      .split(/[,;\n]/)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  function profileFromForm() {
    return {
      documentType: field('pDocumentType')?.value || 'NIE',
      documentNumber: field('pDocumentNumber')?.value || '',
      firstName: field('pFirstName')?.value || '',
      surname1: field('pSurname1')?.value || '',
      surname2: field('pSurname2')?.value || '',
      birthDate: field('pBirthDate')?.value || '',
      nationality: encodeGeo(field('pNationality')?.value || '', field('pCommunity')?.value || 'Comunidad de Madrid'),
      email: field('pEmail')?.value || '',
      mobile: field('pMobile')?.value || '',
      preferredCities: cityPreferencesFromForm(),
      allowNearby: field('pNearby')?.checked !== false,
      monitoringAllowed: field('profileConsent')?.checked === true
    };
  }

  function fillForm(profile = {}) {
    loading = true;
    populateLocationSelects();
    const geo = decodeGeo(profile.nationality || '');
    if (field('pDocumentType')) field('pDocumentType').value = profile.documentType || 'NIE';
    if (field('pDocumentNumber')) field('pDocumentNumber').value = profile.documentNumber || '';
    if (field('pFirstName')) field('pFirstName').value = profile.firstName || '';
    if (field('pSurname1')) field('pSurname1').value = profile.surname1 || '';
    if (field('pSurname2')) field('pSurname2').value = profile.surname2 || '';
    if (field('pBirthDate')) field('pBirthDate').value = profile.birthDate || '';
    if (field('pNationality')) field('pNationality').value = COUNTRY_CODES.includes(geo.nationality) ? geo.nationality : '';
    if (field('pCommunity')) field('pCommunity').value = COMMUNITIES.includes(geo.community) ? geo.community : 'Comunidad de Madrid';
    if (field('pEmail')) field('pEmail').value = profile.email || '';
    if (field('pMobile')) field('pMobile').value = profile.mobile || '';
    if (field('pCities')) field('pCities').value = Array.isArray(profile.preferredCities) ? profile.preferredCities.join(', ') : '';
    if (field('pNearby')) field('pNearby').checked = profile.allowNearby !== false;
    loading = false;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'internal_error');
      error.code = data.error || 'internal_error';
      error.data = data;
      throw error;
    }
    return data;
  }

  async function saveProfile() {
    if (!token() || loading || !field('profileConsent')?.checked) return;
    setStatus('Guardando…');
    try {
      await api('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ consent: true, profile: profileFromForm() })
      });
      setStatus('Datos cifrados y monitorización automática activada ✓');
    } catch (error) {
      setStatus(error.code === 'invalid_email' ? 'Revisa el email.' : 'No se pudieron guardar los datos.', true);
    }
  }

  function queueSave() {
    if (loading || !field('profileConsent')?.checked) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProfile, 650);
  }

  async function loadProfile() {
    if (!token()) return;
    try {
      const data = await api('/api/profile');
      fillForm(data.profile || {});
      if (data.saved) {
        const allowed = data.profile?.monitoringAllowed === true;
        field('profileConsent').checked = allowed;
        setStatus(allowed
          ? 'Datos cifrados y monitorización automática activada ✓'
          : 'Datos guardados. Activa la casilla para permitir la monitorización automática.');
      }
    } catch (error) {
      if (error.code !== 'unauthorized') setStatus('No pudimos cargar tus datos guardados.', true);
    }
  }

  async function deleteProfile() {
    if (!confirm('¿Borrar los datos personales guardados para la cita?')) return;
    try {
      await closeHandoff(true);
      await api('/api/profile', { method: 'DELETE' });
      fillForm({});
      field('profileConsent').checked = false;
      setStatus('Datos personales borrados.');
    } catch {
      setStatus('No se pudieron borrar los datos.', true);
    }
  }

  function handoffPanel(open) {
    const panel = field('handoffPanel');
    if (panel) panel.classList.toggle('open', Boolean(open));
    document.documentElement.classList.toggle('handoff-active', Boolean(open));
  }

  function setHandoffState(text) {
    const el = field('handoffState');
    if (el) el.textContent = text || '';
  }

  function requestedViewport() {
    return {
      width: Math.round(Math.min(window.innerWidth || 1280, 1280)),
      height: Math.round(Math.min(window.innerHeight || 900, 1000))
    };
  }

  function activeViewport() {
    const panel = field('handoffPanel');
    const width = Number(panel?.dataset.viewportWidth) || 1280;
    const height = Number(panel?.dataset.viewportHeight) || 900;
    return { width, height };
  }

  function handoffActionText(state) {
    if (state === 'HUMAN_GATE') return 'Ya completé el CAPTCHA · Continuar';
    if (state === 'AVAILABILITY_DETECTED') return 'Me quedo con esta cita';
    if (state === 'APPOINTMENT_CONFIRMED') return 'Cita confirmada · Cerrar';
    if (state === 'READY_FOR_HUMAN_CONTINUE') return 'Continuar con esta cita';
    if (state === 'NO_AVAILABILITY') return 'No hay citas ahora · Cerrar';
    return 'Continuar';
  }

  function handoffHeading(state) {
    if (state === 'AVAILABILITY_DETECTED') return ['¡Cita disponible!', 'Selecciona la opción que prefieras en el portal y pulsa el botón amarillo.'];
    if (state === 'APPOINTMENT_CONFIRMED') return ['Cita confirmada', 'Guarda el justificante del portal oficial antes de cerrar.'];
    if (state === 'NO_AVAILABILITY') return ['Sin citas disponibles ahora', 'Puedes cerrar; la monitorización seguirá activa.'];
    if (state === 'READY_FOR_HUMAN_CONTINUE') return ['Continúa en el portal oficial', 'Revisa este paso y pulsa el botón amarillo cuando estés listo.'];
    return ['Portal oficial · Completa la verificación', 'Resuelve el CAPTCHA aquí. Al terminar, pulsa el botón amarillo de abajo.'];
  }

  function rememberHandoffStatus(status = {}) {
    const panel = field('handoffPanel');
    if (!panel) return;
    if (status.viewport?.width) {
      panel.dataset.viewportWidth = String(status.viewport.width);
      panel.dataset.viewportHeight = String(status.viewport.height || 900);
      panel.style.setProperty('--handoff-viewport-width', `${status.viewport.width}px`);
    }
    if (status.state) panel.dataset.state = status.state;
    const [title, instruction] = handoffHeading(status.state || panel.dataset.state);
    if (field('handoffTitle')) field('handoffTitle').textContent = title;
    if (field('handoffInstruction')) field('handoffInstruction').textContent = instruction;
    const action = field('handoffPrimaryAction');
    if (action) {
      action.textContent = handoffActionText(status.state || panel.dataset.state);
      action.disabled = Boolean(status.advancing);
    }
    if (status.message) setHandoffState(status.message);
    const resultBox = field('profileResult');
    if (status.state === 'APPOINTMENT_CONFIRMED' && resultBox) {
      resultBox.textContent = 'Tu cita aparece confirmada. Guarda el justificante que ves en el portal oficial antes de cerrar.';
    } else if (status.state === 'NO_AVAILABILITY' && resultBox) {
      resultBox.textContent = 'En este momento no hay citas disponibles. CitaNIE seguirá buscando automáticamente por ti, de lunes a viernes, a las 08:00, 09:00, 10:00, 11:00, 12:00 y 13:00 (Madrid), y te avisará inmediatamente por SMS.';
    }
  }

  async function refreshHandoffStatus() {
    try {
      const status = await api('/api/handoff/status');
      if (!status?.active) {
        await closeHandoff(false);
        return null;
      }
      rememberHandoffStatus(status);
      return status;
    } catch {
      return null;
    }
  }

  async function refreshHandoffFrame() {
    if (handoffFrameBusy || !field('handoffPanel')?.classList.contains('open') || !token()) return;
    handoffFrameBusy = true;
    try {
      const response = await fetch(`/api/handoff/frame?t=${Date.now()}`, {
        headers: { authorization: `Bearer ${token()}` },
        cache: 'no-store'
      });
      if (response.status === 410 || response.status === 401) {
        await closeHandoff(false);
        setHandoffState('La sesión ha caducado. Vuelve a intentar la cita.');
        return;
      }
      if (!response.ok) return;
      const blob = await response.blob();
      if (handoffObjectUrl) URL.revokeObjectURL(handoffObjectUrl);
      handoffObjectUrl = URL.createObjectURL(blob);
      const image = field('handoffImage');
      if (image) image.src = handoffObjectUrl;
      field('handoffLoading')?.classList.add('hidden');
      handoffStatusTick += 1;
      if (handoffStatusTick % 2 === 0) await refreshHandoffStatus();
    } catch {}
    finally { handoffFrameBusy = false; }
  }

  function startHandoffPolling() {
    clearInterval(handoffTimer);
    refreshHandoffFrame();
    handoffTimer = setInterval(refreshHandoffFrame, 900);
  }

  async function sendHandoffInput(payload) {
    try {
      const status = await api('/api/handoff/input', { method: 'POST', body: JSON.stringify(payload) });
      rememberHandoffStatus(status);
      setTimeout(refreshHandoffFrame, 150);
      return status;
    } catch (error) {
      if (error.code === 'handoff_expired') await closeHandoff(false);
      setHandoffState(error.code === 'handoff_expired' ? 'La sesión ha caducado.' : 'No se pudo enviar esa acción.');
      return null;
    }
  }

  async function openHandoff(status = null) {
    try {
      const current = status?.active ? status : await api('/api/handoff/status');
      if (!current?.active) {
        setHandoffState('No hay una sesión humana activa.');
        return;
      }
      rememberHandoffStatus(current);
      handoffPanel(true);
      field('handoffLoading')?.classList.remove('hidden');
      setHandoffState(current.message || (current.url ? `Portal oficial · ${current.url}` : 'Sesión interactiva activa'));
      startHandoffPolling();
    } catch {
      setHandoffState('No pudimos abrir la sesión interactiva.');
    }
  }

  async function closeHandoff(send = true) {
    clearInterval(handoffTimer);
    handoffTimer = null;
    if (handoffObjectUrl) {
      URL.revokeObjectURL(handoffObjectUrl);
      handoffObjectUrl = null;
    }
    if (send && token()) await api('/api/handoff/close', { method: 'POST', body: '{}' }).catch(() => {});
    handoffPanel(false);
  }

  async function attemptAppointment() {
    const button = field('attemptAppointment');
    const resultBox = field('profileResult');
    if (!field('profileConsent')?.checked) {
      setStatus('Acepta el guardado cifrado de tus datos primero.', true);
      return;
    }
    await saveProfile();
    await closeHandoff(true);
    button.disabled = true;
    button.textContent = 'Intentando…';
    resultBox.textContent = 'Abriendo el portal oficial, seleccionando tu trámite y rellenando tus datos cuando sea seguro…';
    try {
      const data = await api('/api/attempt', {
        method: 'POST',
        body: JSON.stringify({ viewport: requestedViewport() })
      });
      const filled = Array.isArray(data.filledFields) && data.filledFields.length
        ? ` Campos rellenados: ${data.filledFields.join(', ')}.`
        : '';
      if (data.state === 'HUMAN_GATE') {
        resultBox.textContent = `El portal ha pedido CAPTCHA, SMS, Cl@ve o una comprobación humana.${filled} Abriendo una sesión para que la completes tú dentro de CitaNIE.`;
        if (data.handoff?.active) await openHandoff(data.handoff);
      } else if (data.state === 'AVAILABILITY_DETECTED') {
        const wanted = Array.isArray(data.preferredCities) && data.preferredCities.length ? data.preferredCities.join(', ') : 'tu zona preferida';
        if (data.locationMatchType === 'preferred' && data.matchedLocation) {
          resultBox.textContent = `Hay una opción disponible compatible con tu preferencia: ${data.matchedLocation}. Continúa cuanto antes; CitaNIE no confirma la cita automáticamente.${filled}`;
        } else if (data.locationMatchType === 'alternative' && data.alternativeLocations?.length) {
          resultBox.textContent = `No aparece una opción en ${wanted}, pero sí encontramos alternativas: ${data.alternativeLocations.join(' · ')}. Puedes elegir una de ellas y continuar.${filled}`;
        } else {
          resultBox.textContent = `Se ha detectado una pantalla compatible con disponibilidad. Continúa cuanto antes; CitaNIE no confirma la cita automáticamente.${filled}`;
        }
        if (data.handoff?.active) await openHandoff(data.handoff);
      } else if (data.state === 'APPOINTMENT_CONFIRMED') {
        resultBox.textContent = 'Tu cita aparece confirmada. Guarda el justificante del portal oficial antes de cerrar.';
        if (data.handoff?.active) await openHandoff(data.handoff);
      } else if (data.state === 'NO_AVAILABILITY') {
        resultBox.textContent = `En este momento no hay citas disponibles. CitaNIE seguirá buscando automáticamente por ti, de lunes a viernes, a las 08:00, 09:00, 10:00, 11:00, 12:00 y 13:00 (Madrid), y te avisará inmediatamente por SMS.${filled}`;
      } else if (data.state === 'READY_FOR_IDENTITY') {
        resultBox.textContent = 'El portal está listo para los datos de identidad. Tus datos ya están guardados para acelerar el siguiente paso.';
      } else if (data.state === 'READY_FOR_HUMAN_CONTINUE') {
        resultBox.textContent = `Tus datos se han rellenado y el portal pide una acción manual.${filled} Puedes continuar dentro de CitaNIE.`;
        if (data.handoff?.active) await openHandoff(data.handoff);
      } else if (data.state === 'PROCEDURE_AMBIGUOUS') {
        resultBox.textContent = 'El portal muestra varias opciones parecidas. Para evitar pedir una cita incorrecta, CitaNIE no ha elegido ninguna automáticamente.';
      } else {
        resultBox.textContent = data.message || `Estado del portal: ${data.state || 'desconocido'}`;
      }
    } catch (error) {
      if (error.code === 'profile_incomplete') resultBox.textContent = 'Completa al menos documento/NIE y nombre antes de intentar.';
      else if (error.code === 'attempt_too_soon') resultBox.textContent = 'Espera un minuto antes de volver a intentarlo.';
      else if (error.code === 'procedure_needs_clarification') resultBox.textContent = 'El número NIE no caduca. Para “Renovar NIE” primero hay que indicar si realmente necesitas renovar TIE, residencia o un certificado; así evitamos seleccionar un trámite equivocado.';
      else if (error.code === 'procedure_automation_not_ready') resultBox.textContent = 'Tus datos están guardados, pero este trámite concreto todavía necesita configuración antes de poder rellenarlo automáticamente.';
      else resultBox.textContent = 'No se pudo iniciar el intento ahora. Tus datos guardados no se han perdido.';
    } finally {
      button.disabled = false;
      button.textContent = 'Buscar cita ahora';
    }
  }

  function mount() {
    updateBranding();
    if (mounted || !token()) return;
    const section = document.querySelector('#s4');
    const dash = section?.querySelector('.dash');
    if (!section || !dash) return;
    mounted = true;

    const card = document.createElement('div');
    card.className = 'profile-card';
    card.innerHTML = `
      <h3>Tus datos para la cita</h3>
      <p class="lead">Escríbelos una sola vez. CitaNIE los guarda cifrados y puede reutilizarlos para Sacar NIE, Toma de huellas TIE, Renovar TIE, Duplicado TIE y pérdida/robo, siempre que el portal muestre una opción compatible.</p>
      <div class="profile-grid">
        <div class="profile-field"><label>Documento</label><select id="pDocumentType"><option value="NIE">NIE</option><option value="PASSPORT">Pasaporte</option></select></div>
        <div class="profile-field"><label>Número de documento / NIE</label><input id="pDocumentNumber" autocomplete="off" placeholder="X1234567A"></div>
        <div class="profile-field"><label>Nombre</label><input id="pFirstName" autocomplete="given-name"></div>
        <div class="profile-field"><label>Primer apellido</label><input id="pSurname1" autocomplete="family-name"></div>
        <div class="profile-field"><label>Segundo apellido</label><input id="pSurname2" autocomplete="additional-name"></div>
        <div class="profile-field"><label>Fecha de nacimiento</label><input id="pBirthDate" type="date" autocomplete="bday"></div>
        <div class="profile-field"><label>Nacionalidad</label><select id="pNationality" autocomplete="country-name"><option value="">Selecciona nacionalidad</option></select></div>
        <div class="profile-field"><label>Comunidad autónoma</label><select id="pCommunity"><option value="Comunidad de Madrid">Comunidad de Madrid</option></select></div>
        <div class="profile-field profile-wide"><label>Ciudad(es) preferidas</label><input id="pCities" autocomplete="address-level2" placeholder="Ej.: Parla, Getafe"></div>
        <label class="profile-consent profile-wide" style="margin:0"><input id="pNearby" type="checkbox" checked> <span>Si no hay opción en mis ciudades, mostrarme también oficinas disponibles en otras ciudades cercanas.</span></label>
        <div class="profile-field"><label>Teléfono</label><input id="pMobile" inputmode="tel" autocomplete="tel"></div>
        <div class="profile-field profile-wide"><label>Email</label><input id="pEmail" type="email" autocomplete="email"></div>
      </div>
      <label class="profile-consent"><input id="profileConsent" type="checkbox"> <span>Acepto que CitaNIE guarde estos datos cifrados y los use durante la vigencia del servicio para comprobar automáticamente la disponibilidad de mi trámite. CitaNIE no confirma ni reserva citas por sí solo; CAPTCHA, Cl@ve y códigos SMS los completa siempre una persona.</span></label>
      <div id="profileStatus" class="profile-status"></div>
      <div class="profile-actions">
        <button id="attemptAppointment" class="profile-btn">Buscar cita ahora</button>
        <button id="deleteProfile" class="profile-btn secondary">Borrar mis datos</button>
      </div>
      <div id="profileResult" class="profile-result">Pulsa “Buscar cita ahora”. Si todavía no hay disponibilidad, CitaNIE seguirá buscando automáticamente y te avisará por SMS.</div>
      <div id="handoffPanel" class="handoff" role="dialog" aria-modal="true" aria-label="Portal oficial de cita previa">
        <div class="handoff-head"><div><b id="handoffTitle">Portal oficial · Completa la verificación</b><p id="handoffInstruction">Resuelve el CAPTCHA aquí. Al terminar, pulsa el botón amarillo de abajo.</p></div><button id="handoffClose" class="handoff-close" aria-label="Cerrar navegador">Cerrar</button></div>
        <div class="handoff-browser">
          <div class="handoff-browser-label"><span class="handoff-live-dot"></span><span>Sesión oficial segura y en directo</span></div>
          <div class="handoff-screen"><img id="handoffImage" alt="Portal oficial interactivo" draggable="false"><div id="handoffLoading" class="handoff-loading">Abriendo el portal oficial…</div></div>
        </div>
        <div class="handoff-footer">
          <button id="handoffPrimaryAction" class="handoff-primary">Ya completé el CAPTCHA · Continuar</button>
          <div id="handoffState" class="handoff-state" aria-live="polite"></div>
          <details class="handoff-keyboard">
            <summary>Necesito escribir o mover la página</summary>
            <div class="handoff-keyboard-inner">
              <div class="handoff-help">Toca primero el campo dentro del portal y después escribe aquí.</div>
              <div class="handoff-tools"><input id="handoffText" autocomplete="off" placeholder="Escribir en el campo seleccionado"><button id="handoffSendText" class="primary">Escribir</button></div>
              <div class="handoff-keys"><button data-hkey="Tab">Siguiente campo</button><button data-hkey="Enter">Aceptar</button><button data-hkey="Backspace">⌫ Borrar</button><button data-scroll="-600">↑ Subir</button><button data-scroll="600">↓ Bajar</button></div>
            </div>
          </details>
        </div>
      </div>
      <div class="profile-note">La comunidad seleccionada se guarda junto con el perfil. La monitorización automática actual sigue disponible en Madrid; iremos activando más comunidades progresivamente. Los datos personales viajan por HTTPS y se almacenan cifrados en el servidor.</div>
    `;
    section.insertBefore(card, dash);
    populateLocationSelects();

    card.querySelectorAll('input,select').forEach((el) => {
      if (el.id !== 'profileConsent' && !el.id.startsWith('handoff')) {
        el.addEventListener('input', queueSave);
        el.addEventListener('change', queueSave);
      }
    });
    field('profileConsent').addEventListener('change', () => {
      if (field('profileConsent').checked) queueSave();
      else setStatus('Activa la casilla si quieres que CitaNIE use tus datos para monitorizar automáticamente.');
    });
    field('deleteProfile').addEventListener('click', deleteProfile);
    field('attemptAppointment').addEventListener('click', attemptAppointment);
    field('handoffClose').addEventListener('click', () => closeHandoff(true));
    field('handoffImage').addEventListener('click', (event) => {
      if (Date.now() < handoffSuppressClickUntil) return;
      const img = event.currentTarget;
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const viewport = activeViewport();
      const x = ((event.clientX - rect.left) / rect.width) * viewport.width;
      const y = ((event.clientY - rect.top) / rect.height) * viewport.height;
      sendHandoffInput({ type: 'click', x, y });
    });
    field('handoffImage').addEventListener('pointerdown', (event) => {
      handoffPointerStart = { x: event.clientX, y: event.clientY };
    });
    field('handoffImage').addEventListener('pointerup', (event) => {
      if (!handoffPointerStart) return;
      const dy = handoffPointerStart.y - event.clientY;
      const dx = handoffPointerStart.x - event.clientX;
      handoffPointerStart = null;
      if (Math.abs(dy) < 35 || Math.abs(dy) < Math.abs(dx)) return;
      handoffSuppressClickUntil = Date.now() + 450;
      sendHandoffInput({ type: 'scroll', dy: Math.max(-1200, Math.min(1200, dy * 3)) });
    });
    field('handoffImage').addEventListener('pointercancel', () => { handoffPointerStart = null; });
    field('handoffPrimaryAction').addEventListener('click', async () => {
      const state = field('handoffPanel')?.dataset.state || '';
      if (state === 'APPOINTMENT_CONFIRMED' || state === 'NO_AVAILABILITY') {
        await closeHandoff(true);
        return;
      }
      const action = field('handoffPrimaryAction');
      action.disabled = true;
      const status = await sendHandoffInput({ type: 'continue' });
      if (!status) action.disabled = false;
    });
    field('handoffSendText').addEventListener('click', async () => {
      const input = field('handoffText');
      const text = input.value;
      if (!text) return;
      await sendHandoffInput({ type: 'text', text });
      input.value = '';
    });
    field('handoffText').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        field('handoffSendText').click();
      }
    });
    card.querySelectorAll('[data-hkey]').forEach((button) => button.addEventListener('click', () => sendHandoffInput({ type: 'key', key: button.dataset.hkey })));
    card.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => sendHandoffInput({ type: 'scroll', dy: Number(button.dataset.scroll) })));
    loadProfile();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateBranding, { once: true });
  else updateBranding();

  const observer = new MutationObserver(() => mount());
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('storage', mount);
  window.addEventListener('beforeunload', () => clearInterval(handoffTimer));
  window.CitaNieHandoff = {
    open: openHandoff,
    close: closeHandoff,
    applyStatus: rememberHandoffStatus,
    requestedViewport
  };
  setInterval(mount, 1000);
  mount();
})();
