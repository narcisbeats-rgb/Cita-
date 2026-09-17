import { chromium } from 'playwright';
import { ICP_URL } from '../src/icpplus.js';

const SESSION_TTL_MS = 5 * 60_000;
const sessions = new Map();

const HUMAN_GATE_PATTERNS = [
  /captcha/i, /recaptcha/i, /hcaptcha/i, /cl@ve/i,
  /c[oó]digo\s+(?:sms|de\s+verificaci[oó]n)/i,
  /verificaci[oó]n\s+(?:m[oó]vil|por\s+tel[eé]fono)/i,
  /confirma(?:ci[oó]n|r)\s+personal/i
];
const NO_AVAILABILITY_PATTERNS = [
  /no\s+hay\s+citas/i, /en\s+este\s+momento\s+no\s+hay\s+citas/i,
  /no\s+existen\s+citas\s+disponibles/i, /sin\s+citas\s+disponibles/i
];
const AVAILABILITY_PATTERNS = [
  /seleccione\s+(?:una\s+)?cita/i, /citas?\s+disponibles?/i,
  /seleccione\s+(?:una\s+)?fecha/i, /seleccione\s+(?:una\s+)?oficina/i
];
const IDENTITY_PATTERNS = [
  /n\.?i\.?e\.?/i, /pasaporte/i, /n[uú]mero\s+de\s+documento/i,
  /nombre\s+y\s+apellidos/i, /apellidos\s+y\s+nombre/i
];
const PROCEDURE_PATTERNS = {
  nie_new: [/ASIGNACION\s+DE\s+NIE/i, /CERTIFICADOS?.*NIE/i, /NIE.*INTERESAD/i],
  tie_fingerprint: [/TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i],
  tie_renew: [/TOMA\s+DE\s+HUELL/i, /RENOVACION\s+DE\s+TARJETA.*LARGA\s+DURACION/i, /EXPEDICION\s+DE\s+TARJETA/i],
  tie_duplicate: [/DUPLICADO.*TIE/i, /TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i],
  lost: [/DUPLICADO.*TIE/i, /TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i]
};

function nowIso() { return new Date().toISOString(); }
function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
function anyMatch(text, patterns) { return patterns.some((pattern) => pattern.test(text)); }
async function bodyText(page) {
  try { return await page.locator('body').innerText({ timeout: 7000 }); }
  catch { return ''; }
}
async function detectHumanGate(page) {
  const text = await bodyText(page);
  if (anyMatch(text, HUMAN_GATE_PATTERNS)) return true;
  return /recaptcha|hcaptcha|captcha/i.test(page.frames().map((frame) => frame.url()).join('\n'));
}

async function closeSession(ownerId) {
  const session = sessions.get(String(ownerId));
  if (!session) return;
  sessions.delete(String(ownerId));
  clearTimeout(session.timer);
  await session.context?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
}
function armExpiry(ownerId, session) {
  clearTimeout(session.timer);
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  session.timer = setTimeout(() => closeSession(ownerId).catch(() => {}), SESSION_TTL_MS);
  session.timer.unref?.();
}
function setSessionState(session, state, message, resumeStage = session.resumeStage) {
  session.state = state;
  session.message = message;
  session.resumeStage = resumeStage;
  session.updatedAt = nowIso();
}
async function parkSession(ownerId, browser, context, page, serviceKey, client, state, message, resumeStage) {
  const key = String(ownerId);
  const session = {
    browser, context, page, serviceKey, client,
    state, message, resumeStage,
    timer: null, expiresAt: 0, updatedAt: nowIso(), advancing: false
  };
  sessions.set(key, session);
  armExpiry(key, session);
  return browserHandoffStatus(key);
}

async function selectMadrid(page) {
  const selects = page.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator('option').allTextContents();
    const index = options.findIndex((value) => /^\s*MADRID\s*$/i.test(value));
    if (index < 0) continue;
    const option = select.locator('option').nth(index);
    const value = await option.getAttribute('value');
    if (value !== null) await select.selectOption(value);
    else await select.selectOption({ index });
    return { optionText: options[index].trim() };
  }
  return null;
}

async function selectProcedure(page, serviceKey) {
  const patterns = PROCEDURE_PATTERNS[serviceKey] || PROCEDURE_PATTERNS.tie_fingerprint;
  const selects = page.locator('select');
  const count = await selects.count();
  for (const pattern of patterns) {
    const matches = [];
    for (let i = 0; i < count; i++) {
      const select = selects.nth(i);
      if (!(await select.isVisible().catch(() => false))) continue;
      const options = await select.locator('option').allTextContents();
      for (let j = 0; j < options.length; j++) {
        const text = normalize(options[j]);
        if (!text || /^SELECCIONE|^--/.test(text)) continue;
        if (pattern.test(text)) matches.push({ selectIndex: i, optionIndex: j, optionText: options[j].trim() });
      }
    }
    if (!matches.length) continue;
    const unique = [...new Set(matches.map((match) => normalize(match.optionText)))];
    if (unique.length > 1) return { ambiguous: true, options: matches.map((match) => match.optionText).slice(0, 8) };
    const match = matches[0];
    const select = selects.nth(match.selectIndex);
    const option = select.locator('option').nth(match.optionIndex);
    const value = await option.getAttribute('value');
    if (value !== null) await select.selectOption(value);
    else await select.selectOption({ index: match.optionIndex });
    return { optionText: match.optionText };
  }
  return null;
}

async function clickContinue(page) {
  const candidates = [
    page.getByRole('button', { name: /aceptar|continuar|entrar|siguiente/i }),
    page.getByRole('link', { name: /aceptar|continuar|entrar|siguiente/i }),
    page.locator('input[type="submit"]')
  ];
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 10000 }),
        item.click({ timeout: 6000 })
      ]);
      return true;
    }
  }
  return false;
}

async function fieldMeta(input) {
  const attrs = [
    await input.getAttribute('name'), await input.getAttribute('id'),
    await input.getAttribute('placeholder'), await input.getAttribute('aria-label'),
    await input.getAttribute('autocomplete')
  ].filter(Boolean).join(' ');
  const nearby = await input.evaluate((el) => `${el.parentElement?.innerText || ''}`).catch(() => '');
  return normalize(`${attrs} ${nearby}`);
}
async function chooseDocumentType(page, client) {
  if (!client?.documentType) return false;
  const wantedPassport = normalize(client.documentType) === 'PASSPORT';
  const selects = page.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator('option').allTextContents();
    const normalized = options.map(normalize);
    if (!normalized.some((t) => /\bNIE\b/.test(t)) || !normalized.some((t) => /PASAPORTE|PASSPORT/.test(t))) continue;
    const index = normalized.findIndex((t) => wantedPassport ? /PASAPORTE|PASSPORT/.test(t) : /\bNIE\b/.test(t));
    if (index < 0) continue;
    const value = await select.locator('option').nth(index).getAttribute('value');
    if (value !== null) await select.selectOption(value);
    else await select.selectOption({ index });
    return true;
  }
  return false;
}
async function fillIdentity(page, client = {}) {
  const fields = [];
  if (!client.document) return { documentFilled: false, fields };
  if (await chooseDocumentType(page, client).catch(() => false)) fields.push('documentType');
  const inputs = page.locator('input');
  const count = await inputs.count();
  let documentFilled = false, firstNameFilled = false, surname1Filled = false, surname2Filled = false, combinedFilled = false;
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false)) || await input.isDisabled().catch(() => false)) continue;
    const type = String(await input.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(type)) continue;
    const meta = await fieldMeta(input);
    if (!documentFilled && /\bNIE\b|\bNIF\b|PASAPORTE|DOCUMENTO|IDCITADO/.test(meta)) {
      await input.fill(client.document); documentFilled = true; fields.push('document');
    } else if (!surname2Filled && client.surname2 && /(SEGUNDO\s+APELLIDO|APELLIDO\s*2|APELLIDO2)/.test(meta)) {
      await input.fill(client.surname2); surname2Filled = true; fields.push('surname2');
    } else if (!surname1Filled && client.surname1 && /(PRIMER\s+APELLIDO|APELLIDO\s*1|APELLIDO1)/.test(meta)) {
      await input.fill(client.surname1); surname1Filled = true; fields.push('surname1');
    } else if (!firstNameFilled && client.firstName && /\bNOMBRE\b/.test(meta) && !/APELLIDO/.test(meta)) {
      await input.fill(client.firstName); firstNameFilled = true; fields.push('firstName');
    } else if (!combinedFilled && client.firstName && /(NOMBRE.*APELLIDO|APELLIDO.*NOMBRE|DESCITADO)/.test(meta)) {
      const fullName = [client.firstName, client.surname1, client.surname2].filter(Boolean).join(' ');
      await input.fill(fullName); combinedFilled = true; fields.push('name');
    } else if (client.birthDate && /(FECHA.*NACIMIENTO|NACIMIENTO.*FECHA|BDAY)/.test(meta)) {
      await input.fill(type === 'date' ? client.birthDate : client.birthDate.split('-').reverse().join('/')).catch(() => {}); fields.push('birthDate');
    } else if (client.email && /EMAIL|E-MAIL|CORREO/.test(meta)) {
      await input.fill(client.email).catch(() => {}); fields.push('email');
    } else if (client.mobile && /TELEFONO|MOVIL|MOBILE|PHONE/.test(meta)) {
      await input.fill(client.mobile).catch(() => {}); fields.push('mobile');
    }
  }
  return { documentFilled, fields: [...new Set(fields)] };
}

async function resumeAfterHumanGate(session) {
  if (!session || session.state !== 'HUMAN_GATE' || session.advancing || session.page.isClosed()) return;
  if (await detectHumanGate(session.page)) return;

  session.advancing = true;
  const page = session.page;
  try {
    let stage = session.resumeStage || 'MANUAL';

    if (stage === 'ENTRY') {
      setSessionState(session, 'RESUMING', 'Verificación completada. Seleccionando Madrid…', 'AFTER_PROVINCE');
      const province = await selectMadrid(page);
      if (!province) {
        setSessionState(session, 'PORTAL_CHANGED', 'La verificación terminó, pero no se encontró Madrid en los desplegables.', 'MANUAL');
        return;
      }
      await page.waitForTimeout(1000);
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
      if (await detectHumanGate(page)) {
        setSessionState(session, 'HUMAN_GATE', 'El portal solicita otra verificación humana después de seleccionar Madrid.', 'AFTER_PROVINCE');
        return;
      }
      stage = 'AFTER_PROVINCE';
    }

    if (stage === 'AFTER_PROVINCE') {
      setSessionState(session, 'RESUMING', 'Verificación completada. Seleccionando tu trámite…', 'AFTER_PROCEDURE');
      const procedure = await selectProcedure(page, session.serviceKey);
      if (procedure?.ambiguous) {
        setSessionState(session, 'PROCEDURE_AMBIGUOUS', 'El portal muestra varias opciones compatibles. Revísalas manualmente para evitar elegir un trámite incorrecto.', 'MANUAL');
        return;
      }
      if (!procedure) {
        setSessionState(session, 'PROCEDURE_NOT_FOUND', 'No se encontró una opción compatible con el trámite seleccionado.', 'MANUAL');
        return;
      }
      await clickContinue(page);
      await page.waitForTimeout(900);
      if (await detectHumanGate(page)) {
        setSessionState(session, 'HUMAN_GATE', 'El portal solicita otra verificación humana. Complétala aquí.', 'AFTER_PROCEDURE');
        return;
      }
      stage = 'AFTER_PROCEDURE';
    }

    if (stage === 'AFTER_PROCEDURE') {
      setSessionState(session, 'RESUMING', 'Verificación completada. Preparando tus datos…', 'AFTER_IDENTITY');
      let text = await bodyText(page);
      const identityPage = anyMatch(text, IDENTITY_PATTERNS) || await page.locator('input').count() > 2;
      if (identityPage) {
        const fill = await fillIdentity(page, session.client);
        if (!fill.documentFilled) {
          setSessionState(session, 'IDENTITY_REQUIRED', 'El portal requiere identidad y no se pudo localizar con seguridad el campo del documento.', 'MANUAL');
          return;
        }
        const continued = await clickContinue(page);
        if (!continued) {
          setSessionState(session, 'READY_FOR_HUMAN_CONTINUE', 'Tus datos están rellenados. Continúa manualmente en esta misma sesión.', 'MANUAL');
          return;
        }
        await page.waitForTimeout(1000);
        text = await bodyText(page);
      }
      if (await detectHumanGate(page)) {
        setSessionState(session, 'HUMAN_GATE', 'El portal solicita otra verificación humana antes de comprobar disponibilidad.', 'AFTER_IDENTITY');
        return;
      }
      stage = 'AFTER_IDENTITY';
    }

    if (stage === 'AFTER_IDENTITY') {
      const text = await bodyText(page);
      if (await detectHumanGate(page)) {
        setSessionState(session, 'HUMAN_GATE', 'El portal solicita otra verificación humana.', 'AFTER_IDENTITY');
        return;
      }
      if (anyMatch(text, NO_AVAILABILITY_PATTERNS)) {
        setSessionState(session, 'NO_AVAILABILITY', 'Verificación completada. El portal indica que no hay citas disponibles ahora.', 'MANUAL');
        return;
      }
      if (anyMatch(text, AVAILABILITY_PATTERNS)) {
        setSessionState(session, 'AVAILABILITY_DETECTED', 'Verificación completada. Se detectó una pantalla compatible con disponibilidad; elige y confirma tú la cita.', 'MANUAL');
        return;
      }
      setSessionState(session, 'READY_FOR_HUMAN_CONTINUE', 'Verificación completada. La sesión sigue abierta para que revises el siguiente paso.', 'MANUAL');
      return;
    }

    setSessionState(session, 'READY_FOR_HUMAN_CONTINUE', 'Verificación completada. Continúa manualmente en esta misma sesión.', 'MANUAL');
  } catch (error) {
    setSessionState(session, 'ERROR', error?.message || String(error), 'MANUAL');
  } finally {
    session.advancing = false;
    session.updatedAt = nowIso();
  }
}

export async function attemptWithBrowserHandoff({ ownerId, serviceKey, client, timeoutMs = 45000 }) {
  const key = String(ownerId);
  await closeSession(key);
  const startedAt = nowIso();
  const result = {
    ok: false, state: 'STARTING', serviceKey, startedAt, finishedAt: null,
    province: null, procedure: null, url: null, message: null, filledFields: [], handoff: null
  };
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
  const context = await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  let parked = false;
  const park = async (state, message, resumeStage = 'MANUAL') => {
    result.state = state;
    result.message = message;
    result.url = page.url();
    result.handoff = await parkSession(key, browser, context, page, serviceKey, client, state, message, resumeStage);
    parked = true;
  };
  try {
    await page.goto(ICP_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    result.url = page.url();
    if (await detectHumanGate(page)) {
      await park('HUMAN_GATE', 'El portal solicita una verificación humana. Complétala dentro de CitaNIE.', 'ENTRY');
      return result;
    }
    const province = await selectMadrid(page);
    if (!province) {
      result.state = 'PORTAL_CHANGED';
      result.message = 'No se encontró Madrid en los desplegables del portal.';
      return result;
    }
    result.province = province.optionText;
    await page.waitForTimeout(1000);
    await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
    if (await detectHumanGate(page)) {
      await park('HUMAN_GATE', 'El portal solicita verificación humana después de seleccionar Madrid.', 'AFTER_PROVINCE');
      return result;
    }
    const procedure = await selectProcedure(page, serviceKey);
    if (procedure?.ambiguous) {
      result.state = 'PROCEDURE_AMBIGUOUS';
      result.message = 'El portal muestra varias opciones compatibles y no se seleccionará una automáticamente.';
      return result;
    }
    if (!procedure) {
      result.state = 'PROCEDURE_NOT_FOUND';
      result.message = 'Madrid cargó, pero no se encontró una opción compatible con el trámite seleccionado.';
      return result;
    }
    result.procedure = procedure.optionText;
    await clickContinue(page);
    await page.waitForTimeout(900);
    result.url = page.url();
    if (await detectHumanGate(page)) {
      await park('HUMAN_GATE', 'Se detectó CAPTCHA/Cl@ve/SMS/verificación. Complétala dentro de CitaNIE.', 'AFTER_PROCEDURE');
      return result;
    }
    let text = await bodyText(page);
    const identityPage = anyMatch(text, IDENTITY_PATTERNS) || await page.locator('input').count() > 2;
    if (identityPage) {
      const fill = await fillIdentity(page, client);
      result.filledFields = fill.fields;
      if (!fill.documentFilled) {
        result.state = 'IDENTITY_REQUIRED';
        result.message = 'El portal requiere identidad y no se pudo localizar con seguridad el campo del documento.';
        return result;
      }
      const continued = await clickContinue(page);
      if (!continued) {
        await park('READY_FOR_HUMAN_CONTINUE', 'Tus datos están rellenados. Continúa manualmente dentro de CitaNIE.', 'MANUAL');
        return result;
      }
      await page.waitForTimeout(1000);
      result.url = page.url();
      text = await bodyText(page);
    }
    if (await detectHumanGate(page)) {
      await park('HUMAN_GATE', 'Verificación humana detectada. La misma sesión queda abierta dentro de CitaNIE.', 'AFTER_IDENTITY');
      return result;
    }
    if (anyMatch(text, NO_AVAILABILITY_PATTERNS)) {
      result.ok = true;
      result.state = 'NO_AVAILABILITY';
      result.message = 'El portal indica que no hay citas disponibles.';
      return result;
    }
    if (anyMatch(text, AVAILABILITY_PATTERNS)) {
      result.ok = true;
      result.state = 'AVAILABILITY_DETECTED';
      result.message = 'Se detectó disponibilidad o una pantalla de selección de cita.';
      return result;
    }
    await park('READY_FOR_HUMAN_CONTINUE', 'Se llegó a una pantalla que requiere revisión humana. Continúa dentro de CitaNIE.', 'MANUAL');
    return result;
  } catch (error) {
    result.state = 'ERROR';
    result.message = error?.message || String(error);
    return result;
  } finally {
    result.finishedAt = nowIso();
    if (!parked) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

export async function browserHandoffStatus(ownerId) {
  const key = String(ownerId);
  const session = sessions.get(key);
  if (!session || Date.now() >= session.expiresAt || session.page.isClosed()) {
    await closeSession(key).catch(() => {});
    return { active: false };
  }
  armExpiry(key, session);
  return {
    active: true,
    expiresAt: new Date(session.expiresAt).toISOString(),
    url: session.page.url(),
    title: await session.page.title().catch(() => 'Portal oficial'),
    viewport: { width: 1280, height: 900 },
    state: session.state || 'READY_FOR_HUMAN_CONTINUE',
    message: session.message || null,
    humanGateActive: session.state === 'HUMAN_GATE',
    advancing: Boolean(session.advancing),
    updatedAt: session.updatedAt || null
  };
}
export async function browserHandoffFrame(ownerId) {
  const key = String(ownerId);
  const session = sessions.get(key);
  if (!session || Date.now() >= session.expiresAt || session.page.isClosed()) {
    await closeSession(key).catch(() => {});
    return null;
  }
  armExpiry(key, session);
  await resumeAfterHumanGate(session);
  return session.page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
}
export async function browserHandoffInput(ownerId, input = {}) {
  const key = String(ownerId);
  const session = sessions.get(key);
  if (!session || Date.now() >= session.expiresAt || session.page.isClosed()) {
    await closeSession(key).catch(() => {});
    throw new Error('handoff_expired');
  }
  const page = session.page;
  armExpiry(key, session);
  if (input.type === 'click') {
    const x = Math.max(0, Math.min(1280, Number(input.x) || 0));
    const y = Math.max(0, Math.min(900, Number(input.y) || 0));
    await page.mouse.click(x, y);
  } else if (input.type === 'text') {
    const text = String(input.text || '').slice(0, 500);
    if (text) await page.keyboard.type(text, { delay: 20 });
  } else if (input.type === 'key') {
    const allowed = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
    const keyName = String(input.key || '');
    if (!allowed.has(keyName)) throw new Error('invalid_handoff_key');
    await page.keyboard.press(keyName);
  } else if (input.type === 'scroll') {
    const dy = Math.max(-1200, Math.min(1200, Number(input.dy) || 0));
    await page.mouse.wheel(0, dy);
  } else {
    throw new Error('invalid_handoff_input');
  }
  await page.waitForTimeout(220);
  await resumeAfterHumanGate(session);
  return browserHandoffStatus(key);
}
export async function stopBrowserHandoff(ownerId) {
  await closeSession(String(ownerId));
  return { ok: true };
}
export async function stopAllBrowserHandoffs() {
  await Promise.all([...sessions.keys()].map((key) => closeSession(key).catch(() => {})));
}
