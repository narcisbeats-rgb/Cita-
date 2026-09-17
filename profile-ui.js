(() => {
  const tokenKey = 'citaNieAccessToken';
  const token = () => localStorage.getItem(tokenKey) || '';
  const authHeaders = () => ({ ...(token() ? { authorization: `Bearer ${token()}` } : {}), 'content-type': 'application/json' });
  let mounted = false;
  let saveTimer = null;
  let loading = false;

  const css = document.createElement('style');
  css.textContent = `
    .profile-card{margin:14px 0 0;background:#101620;border:1px solid #263044;border-radius:20px;padding:18px}
    .profile-card h3{margin:0 0 6px;font-size:19px}.profile-card .lead{margin:0 0 16px;color:#9ca7b8;font-size:14px;line-height:1.5}
    .profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.profile-field{display:flex;flex-direction:column;gap:7px}
    .profile-field label{font-size:12px;color:#c8d0dc}.profile-field input,.profile-field select{width:100%;padding:13px;border-radius:13px;border:1px solid #263044;background:#0d121a;color:#f7f8fb;outline:none}
    .profile-wide{grid-column:1/-1}.profile-consent{display:flex;gap:10px;align-items:flex-start;margin:14px 0;color:#9ca7b8;font-size:12px;line-height:1.5}
    .profile-consent input{margin-top:3px}.profile-status{min-height:20px;font-size:12px;color:#9be7bd;margin-top:8px}.profile-status.err{color:#fca5a5}
    .profile-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.profile-btn{border:0;border-radius:13px;padding:12px 15px;font-weight:700;cursor:pointer;background:#f3c94b;color:#16130b}.profile-btn.secondary{background:#1b2230;color:#dce2ea}.profile-btn:disabled{opacity:.55;cursor:not-allowed}
    .profile-result{margin-top:12px;padding:12px 14px;border-radius:13px;background:#111824;border:1px solid #263044;color:#c9d2df;font-size:13px;line-height:1.5}
    .profile-note{margin-top:12px;color:#7f8a9a;font-size:11px;line-height:1.45}
    @media(max-width:700px){.profile-grid{grid-template-columns:1fr}.profile-wide{grid-column:auto}.profile-actions .profile-btn{flex:1;min-width:140px}}
  `;
  document.head.appendChild(css);

  const field = (id) => document.getElementById(id);

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

  function setStatus(text, error = false) {
    const el = field('profileStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', error);
  }

  function profileFromForm() {
    return {
      documentType: field('pDocumentType')?.value || 'NIE',
      documentNumber: field('pDocumentNumber')?.value || '',
      firstName: field('pFirstName')?.value || '',
      surname1: field('pSurname1')?.value || '',
      surname2: field('pSurname2')?.value || '',
      birthDate: field('pBirthDate')?.value || '',
      nationality: field('pNationality')?.value || '',
      email: field('pEmail')?.value || '',
      mobile: field('pMobile')?.value || ''
    };
  }

  function fillForm(profile = {}) {
    loading = true;
    if (field('pDocumentType')) field('pDocumentType').value = profile.documentType || 'NIE';
    if (field('pDocumentNumber')) field('pDocumentNumber').value = profile.documentNumber || '';
    if (field('pFirstName')) field('pFirstName').value = profile.firstName || '';
    if (field('pSurname1')) field('pSurname1').value = profile.surname1 || '';
    if (field('pSurname2')) field('pSurname2').value = profile.surname2 || '';
    if (field('pBirthDate')) field('pBirthDate').value = profile.birthDate || '';
    if (field('pNationality')) field('pNationality').value = profile.nationality || '';
    if (field('pEmail')) field('pEmail').value = profile.email || '';
    if (field('pMobile')) field('pMobile').value = profile.mobile || '';
    loading = false;
  }

  async function saveProfile() {
    if (loading || !field('profileConsent')?.checked) return;
    setStatus('Guardando...');
    try {
      await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ consent: true, profile: profileFromForm() }) });
      setStatus('Datos cifrados y guardados');
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
    try {
      const data = await api('/api/profile');
      fillForm(data.profile || {});
      if (data.saved) {
        field('profileConsent').checked = true;
        setStatus('Datos cifrados y guardados');
      }
    } catch (error) {
      if (error.code !== 'unauthorized') setStatus('No pudimos cargar tus datos guardados.', true);
    }
  }

  async function deleteProfile() {
    if (!confirm('¿Borrar los datos personales guardados?')) return;
    try {
      await api('/api/profile', { method: 'DELETE' });
      fillForm({});
      field('profileConsent').checked = false;
      setStatus('Datos personales borrados.');
    } catch {
      setStatus('No se pudieron borrar los datos.', true);
    }
  }

  async function attemptAppointment() {
    const button = field('attemptAppointment');
    const resultBox = field('profileResult');
    if (!field('profileConsent')?.checked) {
      setStatus('Acepta el guardado cifrado de tus datos primero.', true);
      return;
    }
    await saveProfile();
    button.disabled = true;
    button.textContent = 'Abriendo portal...';
    resultBox.textContent = 'Abrimos el portal oficial, elegimos el tramite compatible y rellenamos los campos seguros. Si aparece una verificacion humana, nos detenemos.';
    try {
      const data = await api('/api/attempt', { method: 'POST', body: '{}' });
      const filled = Array.isArray(data.filledFields) && data.filledFields.length ? ` Campos rellenados: ${data.filledFields.join(', ')}.` : '';
      if (data.state === 'HUMAN_GATE') resultBox.textContent = `El portal pide CAPTCHA, SMS, Cl@ve o una comprobacion humana. Continua tu desde ese punto.${filled}`;
      else if (data.state === 'AVAILABILITY_DETECTED') resultBox.textContent = `Hay una pantalla compatible con disponibilidad. Continua cuanto antes; Detector de Citas no confirma la cita sin tu intervencion.${filled}`;
      else if (data.state === 'NO_AVAILABILITY') resultBox.textContent = `No hay citas disponibles ahora. Tus datos quedan guardados para el siguiente aviso.${filled}`;
      else if (data.state === 'READY_FOR_HUMAN_CONTINUE') resultBox.textContent = `Tus datos se han rellenado. El portal necesita una accion manual para seguir.${filled}`;
      else if (data.state === 'PROCEDURE_AMBIGUOUS') resultBox.textContent = 'El portal muestra varias opciones parecidas y no hemos elegido ninguna para evitar una cita incorrecta.';
      else resultBox.textContent = data.message || `Estado del portal: ${data.state || 'desconocido'}`;
    } catch (error) {
      if (error.code === 'profile_incomplete') resultBox.textContent = 'Completa al menos documento/NIE y nombre.';
      else if (error.code === 'attempt_too_soon') resultBox.textContent = 'Espera un minuto antes de volver a intentarlo.';
      else if (error.code === 'subscription_inactive') resultBox.textContent = 'La monitorizacion no esta activa.';
      else if (error.code === 'procedure_automation_not_ready') resultBox.textContent = 'Este tramite concreto todavia necesita configuracion antes de rellenarlo automaticamente.';
      else resultBox.textContent = 'No se pudo iniciar el intento ahora. Tus datos no se han perdido.';
    } finally {
      button.disabled = false;
      button.textContent = new URLSearchParams(location.search).get('resume') === '1' ? 'Finalizar cita' : 'Intentar cita con mis datos';
    }
  }

  function mount() {
    if (mounted) return;
    const section = document.querySelector('#s4');
    const dash = section?.querySelector('.dash');
    if (!section || !dash) return;
    mounted = true;

    const card = document.createElement('div');
    card.className = 'profile-card';
    card.innerHTML = `
      <h3>Tus datos para la cita</h3>
      <p class="lead">Guardalos una vez. Se almacenan cifrados y solo se reutilizan para intentar completar el tramite que has elegido.</p>
      <div class="profile-grid">
        <div class="profile-field"><label>Documento</label><select id="pDocumentType"><option value="NIE">NIE</option><option value="PASSPORT">Pasaporte</option></select></div>
        <div class="profile-field"><label>Numero de documento / NIE</label><input id="pDocumentNumber" autocomplete="off" placeholder="X1234567A"></div>
        <div class="profile-field"><label>Nombre</label><input id="pFirstName" autocomplete="given-name"></div>
        <div class="profile-field"><label>Primer apellido</label><input id="pSurname1" autocomplete="family-name"></div>
        <div class="profile-field"><label>Segundo apellido</label><input id="pSurname2"></div>
        <div class="profile-field"><label>Fecha de nacimiento</label><input id="pBirthDate" type="date" autocomplete="bday"></div>
        <div class="profile-field"><label>Nacionalidad</label><input id="pNationality"></div>
        <div class="profile-field"><label>Telefono</label><input id="pMobile" inputmode="tel" autocomplete="tel"></div>
        <div class="profile-field profile-wide"><label>Email (solo si el formulario oficial lo necesita)</label><input id="pEmail" type="email" autocomplete="email"></div>
      </div>
      <label class="profile-consent"><input id="profileConsent" type="checkbox"> <span>Acepto que Detector de Citas guarde estos datos cifrados durante la vigencia del servicio. No guardamos contrasenas, PIN de Cl@ve ni codigos SMS.</span></label>
      <div id="profileStatus" class="profile-status"></div>
      <div class="profile-actions">
        <button id="attemptAppointment" class="profile-btn">${new URLSearchParams(location.search).get('resume') === '1' ? 'Finalizar cita' : 'Intentar cita con mis datos'}</button>
        <button id="deleteProfile" class="profile-btn secondary">Borrar mis datos</button>
      </div>
      <div id="profileResult" class="profile-result">Detector de Citas rellena solo campos compatibles. Si aparece CAPTCHA, Cl@ve, SMS oficial, una opcion ambigua o una confirmacion personal, se detiene para que continues tu.</div>
      <div class="profile-note">Los datos viajan por HTTPS y se almacenan cifrados. La suscripcion completa se elimina automaticamente al expirar el servicio.</div>
    `;
    section.insertBefore(card, dash);

    card.querySelectorAll('input,select').forEach((el) => {
      if (el.id !== 'profileConsent') {
        el.addEventListener('input', queueSave);
        el.addEventListener('change', queueSave);
      }
    });
    field('profileConsent').addEventListener('change', () => {
      if (field('profileConsent').checked) queueSave();
      else setStatus('Marca la casilla para guardar automaticamente.');
    });
    field('deleteProfile').addEventListener('click', deleteProfile);
    field('attemptAppointment').addEventListener('click', attemptAppointment);
    loadProfile();

    if (new URLSearchParams(location.search).get('resume') === '1') {
      setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
    }
  }

  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  setInterval(mount, 900);
  mount();
})();
