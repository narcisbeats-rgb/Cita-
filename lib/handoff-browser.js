import { chromium } from 'playwright';
import { ICP_URL } from '../src/icpplus.js';
import { analyzeLocationOptions, locationMessage, readOfficeOptions } from './location-preferences.js';

const SESSION_TTL_MS = 5 * 60_000;
const sessions = new Map();

const NO_AVAILABILITY_PATTERNS = [
  /no\s+hay\s+citas/i,
  /en\s+este\s+momento\s+no\s+hay\s+citas/i,
  /no\s+existen\s+citas\s+disponibles/i,
  /sin\s+citas\s+disponibles/i
];

const AVAILABILITY_PATTERNS = [
  /seleccione\s+(?:una\s+)?cita/i,
  /citas?\s+disponibles?/i,
  /seleccione\s+(?:una\s+)?fecha/i,
  /seleccione\s+(?:una\s+)?oficina/i
];

const IDENTITY_PATTERNS = [
  /n\.?i\.?e\.?/i,
  /pasaporte/i,
  /n[uú]mero\s+de\s+documento/i,
  /nombre\s+y\s+apellidos/i,
  /apellidos\s+y\s+nombre/i
];

const PROCEDURE_PATTERNS = {
  nie_new: [/ASIGNACION\s+DE\s+NIE/i, /CERTIFICADOS?.*NIE/i, /NIE.*INTERESAD/i],
  tie_fingerprint: [/TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i],
  tie_renew: [/RENOVACION\s+DE\s+TARJETA.*LARGA\s+DURACION/i, /TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i],
  tie_duplicate: [/DUPLICADO.*TIE/i, /TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i],
  lost: [/DUPLICADO.*TIE/i, /TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i]
};

function nowIso() { return new Date().toISOString(); }

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function anyMatch(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

async function bodyText(page) {
  try { return await page.locator('body').innerText({ timeout: 5000 }); }
  catch { return ''; }
}

async function detectHumanGate(page) {
  const frameUrls = page.frames().map((frame) => frame.url()).join('\n');
  if (/recaptcha|hcaptcha|captcha/i.test(frameUrls)) return true;

  const captchaSelectors = [
    'iframe[src*="recaptcha" i]',
    'iframe[src*="hcaptcha" i]',
    'iframe[title*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[data-sitekey]',
    'input[name*="captcha" i]',
    'input[id*="captcha" i]'
  ];
  for (const selector of captchaSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      if (await locator.nth(i).isVisible().catch(() => false)) return true;
    }
  }

  const text = normalize(await bodyText(page));
  if (/CAPTCHA|NO\s+SOY\s+UN\s+ROBOT|VERIFICACION\s+DE\s+SEGURIDAD|COMPROBACION\s+DE\s+SEGURIDAD/.test(text)) {
    return true;
  }

  const inputs = page.locator('input');
  const inputCount = await inputs.count().catch(() => 0);
  for (let i = 0; i < inputCount; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    const meta = normalize([
      await input.getAttribute('name'),
      await input.getAttribute('id'),
      await input.getAttribute('placeholder'),
      await input.getAttribute('aria-label'),
      await input.getAttribute('autocomplete')
    ].filter(Boolean).join(' '));
    if (/OTP|ONE.TIME|CODIGO.*SMS|SMS.*CODIGO|CODIGO.*VERIFICACION|VERIFICATION.*CODE/.test(meta)) return true;
  }

  const controls = page.locator('button, a, input[type="submit"], input[type="button"]');
  const controlCount = await controls.count().catch(() => 0);
  for (let i = 0; i < controlCount; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = normalize([
      await control.innerText().catch(() => ''),
      await control.getAttribute('value'),
      await control.getAttribute('aria-label'),
      await control.getAttribute('title')
    ].filter(Boolean).join(' '));
    if (/RESOLVER.*CAPTCHA|VERIFICAR.*HUMAN|INTRODUCIR.*CODIGO.*SMS|ACCEDER.*CL@VE|IDENTIFICAR.*CL@VE/.test(label)) return true;
  }

  return false;
}

async function closeSession(ownerId) {
  const key = String(ownerId);
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
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

function createSession(ownerId, browser, context, page, serviceKey, client) {
  const key = String(ownerId);
  const session = {
    browser,
    context,
    page,
    serviceKey,
    client,
    state: 'STARTING',
    message: 'Abriendo el portal oficial…',
    resumeStage: 'START',
    province: null,
    procedure: null,
    filledFields: [],
    preferredCities: Array.isArray(client?.preferredCities) ? client.preferredCities : [],
    locationMatchType: null,
    matchedLocation: null,
    availableLocations: [],
    alternativeLocations: [],
    timer: null,
    expiresAt: 0,
    updatedAt: nowIso(),
    advancing: false
  };
  sessions.set(key, session);
  armExpiry(key, session);
  return session;
}

async function selectMadrid(page) {
  const selects = page.locator('select');
  const count = await selects.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator('option').allTextContents().catch(() => []);
    const index = options.findIndex((value) => /^\s*MADRID\s*$/i.test(value));
    if (index < 0) continue;
    const option = select.locator('option').nth(index);
    const value = await option.getAttribute('value');
    if (value !== null) await select.selectOption(value);
    else await select.selectOption({ index });
    await page.waitForTimeout(700);
    return { optionText: options[index].trim() };
  }
  return null;
}

async function findProcedure(page, serviceKey, selectIt = true) {
  const patterns = PROCEDURE_PATTERNS[serviceKey] || PROCEDURE_PATTERNS.tie_fingerprint;
  const selects = page.locator('select');
  const count = await selects.count().catch(() => 0);

  for (const pattern of patterns) {
    const matches = [];
    for (let i = 0; i < count; i++) {
      const select = selects.nth(i);
      if (!(await select.isVisible().catch(() => false))) continue;
      const options = await select.locator('option').allTextContents().catch(() => []);
      for (let j = 0; j < options.length; j++) {
        const text = normalize(options[j]);
        if (!text || /^SELECCIONE|^--/.test(text)) continue;
        if (pattern.test(text)) matches.push({ selectIndex: i, optionIndex: j, optionText: options[j].trim() });
      }
    }
    if (!matches.length) continue;
    const unique = [...new Set(matches.map((match) => normalize(match.optionText)))];
    if (unique.length > 1) {
      return { ambiguous: true, options: matches.map((match) => match.optionText).slice(0, 8) };
    }
    const match = matches[0];
    if (selectIt) {
      const select = selects.nth(match.selectIndex);
      const option = select.locator('option').nth(match.optionIndex);
      const value = await option.getAttribute('value');
      if (value !== null) await select.selectOption(value);
      else await select.selectOption({ index: match.optionIndex });
      await page.waitForTimeout(450);
    }
    return { optionText: match.optionText };
  }
  return null;
}

async function waitAndSelectProcedure(page, serviceKey, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await findProcedure(page, serviceKey, true);
    if (result) return result;
    await page.waitForTimeout(400);
  }
  return null;
}

async function clickContinue(page) {
  const controls = page.locator('button, a, input[type="submit"], input[type="button"]');
  const count = await controls.count().catch(() => 0);
  const fallback = [];

  for (let i = 0; i < count; i++) {
    const item = controls.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    if (!(await item.isEnabled().catch(() => true))) continue;
    const type = String(await item.getAttribute('type') || '').toLowerCase();
    const label = normalize([
      await item.innerText().catch(() => ''),
      await item.getAttribute('value'),
      await item.getAttribute('aria-label'),
      await item.getAttribute('title'),
      await item.getAttribute('name'),
      await item.getAttribute('id')
    ].filter(Boolean).join(' '));

    if (/VOLVER|ATRAS|CANCELAR|SALIR/.test(label)) continue;
    if (/ACEPTAR|CONTINUAR|ENTRAR|SIGUIENTE|SOLICITAR|CONFIRMAR/.test(label)) {
      await item.click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(550);
      return true;
    }
    if (type === 'submit') fallback.push(item);
  }

  if (fallback.length === 1) {
    await fallback[0].click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(550);
    return true;
  }
  return false;
}

async function fieldMeta(input) {
  const attrs = [
    await input.getAttribute('name'),
    await input.getAttribute('id'),
    await input.getAttribute('placeholder'),
    await input.getAttribute('aria-label'),
    await input.getAttribute('autocomplete')
  ].filter(Boolean).join(' ');
  const nearby = await input.evaluate((el) => `${el.parentElement?.innerText || ''}`).catch(() => '');
  return normalize(`${attrs} ${nearby}`);
}

async function chooseDocumentType(page, client) {
  if (!client?.documentType) return false;
  const wantedPassport = normalize(client.documentType) === 'PASSPORT';
  const selects = page.locator('select');
  const count = await selects.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator('option').allTextContents().catch(() => []);
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

function nationalityNames(value) {
  const raw = String(value || '').split('||')[0].trim();
  const names = new Set([normalize(raw)]);
  if (/^[A-Z]{2}$/i.test(raw)) {
    try {
      names.add(normalize(new Intl.DisplayNames(['es'], { type: 'region' }).of(raw.toUpperCase())));
    } catch {}
  }
  return [...names].filter(Boolean);
}

async function chooseNationality(page, nationality) {
  const wanted = nationalityNames(nationality);
  if (!wanted.length) return false;
  const selects = page.locator('select');
  const count = await selects.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator('option').allTextContents().catch(() => []);
    const index = options.findIndex((text) => {
      const normalized = normalize(text);
      return wanted.some((candidate) => normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized));
    });
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
  if (await chooseNationality(page, client.nationality).catch(() => false)) fields.push('nationality');

  const inputs = page.locator('input');
  const count = await inputs.count().catch(() => 0);
  let documentFilled = false;
  let firstNameFilled = false;
  let surname1Filled = false;
  let surname2Filled = false;
  let combinedFilled = false;

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false)) || await input.isDisabled().catch(() => false)) continue;
    const type = String(await input.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(type)) continue;
    const meta = await fieldMeta(input);

    if (!documentFilled && /\bNIE\b|\bNIF\b|PASAPORTE|DOCUMENTO|IDCITADO/.test(meta)) {
      await input.fill(client.document);
      documentFilled = true;
      fields.push('document');
    } else if (!surname2Filled && client.surname2 && /(SEGUNDO\s+APELLIDO|APELLIDO\s*2|APELLIDO2)/.test(meta)) {
      await input.fill(client.surname2);
      surname2Filled = true;
      fields.push('surname2');
    } else if (!surname1Filled && client.surname1 && /(PRIMER\s+APELLIDO|APELLIDO\s*1|APELLIDO1)/.test(meta)) {
      await input.fill(client.surname1);
      surname1Filled = true;
      fields.push('surname1');
    } else if (!firstNameFilled && client.firstName && /\bNOMBRE\b/.test(meta) && !/APELLIDO/.test(meta)) {
      await input.fill(client.firstName);
      firstNameFilled = true;
      fields.push('firstName');
    } else if (!combinedFilled && client.firstName && /(NOMBRE.*APELLIDO|APELLIDO.*NOMBRE|DESCITADO)/.test(meta)) {
      const fullName = [client.firstName, client.surname1, client.surname2].filter(Boolean).join(' ');
      await input.fill(fullName);
      combinedFilled = true;
      fields.push('name');
    } else if (client.birthDate && /(FECHA.*NACIMIENTO|NACIMIENTO.*FECHA|BDAY)/.test(meta)) {
      const dateValue = type === 'date' ? client.birthDate : client.birthDate.split('-').reverse().join('/');
      await input.fill(dateValue).catch(() => {});
      fields.push('birthDate');
    } else if (client.email && /EMAIL|E-MAIL|CORREO/.test(meta)) {
      await input.fill(client.email).catch(() => {});
      fields.push('email');
    } else if (client.mobile && /TELEFONO|MOVIL|MOBILE|PHONE/.test(meta)) {
      await input.fill(client.mobile).catch(() => {});
      fields.push('mobile');
    }
  }

  return { documentFilled, fields: [...new Set(fields)] };
}

async function classifyAvailability(page, session) {
  const text = await bodyText(page);
  if (await detectHumanGate(page)) {
    setSessionState(session, 'HUMAN_GATE', 'Solo falta la verificación humana. Complétala aquí.', 'AVAILABILITY');
  } else if (anyMatch(text, NO_AVAILABILITY_PATTERNS)) {
    setSessionState(session, 'NO_AVAILABILITY', 'Ahora mismo el portal indica que no hay citas disponibles.', 'MANUAL');
  } else {
    const officeOptions = await readOfficeOptions(page, session.client?.preferredCities || []).catch(() => []);
    if (anyMatch(text, AVAILABILITY_PATTERNS) || officeOptions.length) {
      const location = analyzeLocationOptions(officeOptions, session.client?.preferredCities || [], session.client?.allowNearby !== false);
      session.preferredCities = location.preferredCities;
      session.locationMatchType = location.locationMatchType;
      session.matchedLocation = location.matchedLocation;
      session.availableLocations = location.availableLocations;
      session.alternativeLocations = location.alternativeLocations;
      setSessionState(session, 'AVAILABILITY_DETECTED', `Se detectó una pantalla de disponibilidad. Revisa y confirma la cita.${locationMessage(location)}`, 'MANUAL');
    } else {
      setSessionState(session, 'READY_FOR_HUMAN_CONTINUE', 'El portal llegó a un paso que necesita revisión manual.', 'MANUAL');
    }
  }
}

async function resumePipeline(session) {
  if (!session || session.advancing || session.page.isClosed()) return;
  if (session.state === 'HUMAN_GATE' && await detectHumanGate(session.page)) return;

  session.advancing = true;
  const page = session.page;
  try {
    let stage = session.resumeStage || 'MANUAL';
    if (stage === 'AFTER_PROVINCE_GATE') stage = 'PROCEDURE';

    if (stage === 'PROCEDURE') {
      setSessionState(session, 'SELECTING_PROCEDURE', 'Verificación completada. Selectăm trámite-ul…', 'PROCEDURE');
      const procedure = await waitAndSelectProcedure(page, session.serviceKey, 9000);
      if (procedure?.ambiguous) {
        setSessionState(session, 'PROCEDURE_AMBIGUOUS', 'Portalul arată mai multe trámites asemănătoare.', 'MANUAL');
        return;
      }
      if (!procedure) {
        setSessionState(session, 'READY_FOR_HUMAN_CONTINUE', 'Madrid este selectat, dar portalul cere o alegere manuală a trámite-ului.', 'MANUAL');
        return;
      }
      session.procedure = procedure.optionText;
      const continued = await clickContinue(page);
      if (!continued) {
        setSessionState(session, 'READY_FOR_HUMAN_CONTINUE', 'Trámite selectat. Portalul cere următorul pas manual.', 'IDENTITY');
        return;
      }
      if (await detectHumanGate(page)) {
        setSessionState(session, 'HUMAN_GATE', 'Solo falta la verificación humana. Complétala aquí.', 'IDENTITY');
        return;
      }
      stage = 'IDENTITY';
    }

    if (stage === 'IDENTITY') {
      setSessionState(session, 'FILLING_IDENTITY', 'Completăm datele tale în portal…', 'IDENTITY');
      const text = await bodyText(page);
      const identityPage = anyMatch(text, IDENTITY_PATTERNS) || await page.locator('input').count().catch(() => 0) > 2;
      if (identityPage) {
        const fill = await fillIdentity(page, session.client);
        session.filledFields = fill.fields;
        if (!fill.documentFilled) {
          setSessionState(session, 'READY_FOR_HUMAN_CONTINUE', 'Portalul cere datele, dar câmpurile s-au schimbat. Continuă manual.', 'MANUAL');
          return;
        }
        const continued = await clickContinue(page);
        if (!continued) {
          setSessionState(session, 'READY_FOR_HUMAN_CONTINUE', 'Datele sunt completate. Portalul cere următorul pas manual.', 'MANUAL');
          return;
        }
      }
      if (await detectHumanGate(page)) {
        setSessionState(session, 'HUMAN_GATE', 'Solo falta la verificación humana. Complétala aquí.', 'AVAILABILITY');
        return;
      }
      stage = 'AVAILABILITY';
    }

    if (stage === 'AVAILABILITY') await classifyAvailability(page, session);
  } catch {
    setSessionState(session, 'ERROR', 'Portalul oficial nu a răspuns corect. Poți încerca din nou.', 'MANUAL');
  } finally {
    session.advancing = false;
    session.updatedAt = nowIso();
  }
}

export async function attemptWithBrowserHandoff({ ownerId, serviceKey, client, timeoutMs = 20000 }) {
  const key = String(ownerId);
  await closeSession(key);

  const result = {
    ok: false,
    state: 'STARTING',
    serviceKey,
    startedAt: nowIso(),
    finishedAt: null,
    province: null,
    procedure: null,
    url: null,
    message: null,
    filledFields: [],
    preferredCities: Array.isArray(client?.preferredCities) ? client.preferredCities : [],
    locationMatchType: null,
    matchedLocation: null,
    availableLocations: [],
    alternativeLocations: [],
    handoff: null
  };

  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(9000);
  const session = createSession(key, browser, context, page, serviceKey, client);
  session.advancing = true;

  const finish = async (state, message, resumeStage = 'MANUAL') => {
    setSessionState(session, state, message, resumeStage);
    result.state = state;
    result.message = message;
    result.url = page.url();
    result.province = session.province;
    result.procedure = session.procedure;
    result.filledFields = session.filledFields || [];
    result.preferredCities = session.preferredCities || [];
    result.locationMatchType = session.locationMatchType || null;
    result.matchedLocation = session.matchedLocation || null;
    result.availableLocations = session.availableLocations || [];
    result.alternativeLocations = session.alternativeLocations || [];
    result.handoff = await browserHandoffStatus(key);
    return result;
  };

  try {
    setSessionState(session, 'OPENING_PORTAL', 'Deschidem portalul oficial…', 'START');
    try {
      await page.goto(ICP_URL, { waitUntil: 'commit', timeout: Math.min(timeoutMs, 15000) });
    } catch (error) {
      const hasContent = (await page.locator('select').count().catch(() => 0)) > 0 || (await bodyText(page)).length > 80;
      if (!hasContent) throw error;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => {});
    result.url = page.url();

    setSessionState(session, 'SELECTING_PROVINCE', 'Selectăm Madrid…', 'PROCEDURE');
    const province = await selectMadrid(page);
    if (!province) {
      if (await detectHumanGate(page)) {
        return await finish('HUMAN_GATE', 'Portalul cere o verificare înainte de Madrid. Completeaz-o aici.', 'PROCEDURE');
      }
      return await finish('READY_FOR_HUMAN_CONTINUE', 'Nu am putut selecta Madrid automat. Continuă manual în sesiunea deschisă.', 'PROCEDURE');
    }
    session.province = province.optionText;

    setSessionState(session, 'SELECTING_PROCEDURE', 'Madrid selectat. Căutăm trámite-ul corect…', 'PROCEDURE');
    let procedure = await waitAndSelectProcedure(page, serviceKey, 10000);
    if (!procedure) {
      const legacyContinue = await clickContinue(page);
      if (legacyContinue) procedure = await waitAndSelectProcedure(page, serviceKey, 8000);
    }

    if (procedure?.ambiguous) {
      return await finish('READY_FOR_HUMAN_CONTINUE', 'Portalul arată mai multe trámites compatibile. Alege-l manual ca să evităm o cita greșită.', 'MANUAL');
    }
    if (!procedure) {
      return await finish('READY_FOR_HUMAN_CONTINUE', 'Madrid este selectat, dar portalul nu a încărcat automat trámite-ul. Continuă manual.', 'MANUAL');
    }
    session.procedure = procedure.optionText;

    setSessionState(session, 'CONTINUING', 'Trámite selectat. Trecem la datele tale…', 'IDENTITY');
    const continued = await clickContinue(page);
    if (!continued) {
      return await finish('READY_FOR_HUMAN_CONTINUE', 'Madrid și trámite-ul sunt pregătite. Portalul cere următorul pas manual.', 'IDENTITY');
    }

    if (await detectHumanGate(page)) {
      return await finish('HUMAN_GATE', 'Madrid și trámite-ul sunt pregătite. Completează doar verificarea umană.', 'IDENTITY');
    }

    setSessionState(session, 'FILLING_IDENTITY', 'Completăm datele tale…', 'IDENTITY');
    let text = await bodyText(page);
    const identityPage = anyMatch(text, IDENTITY_PATTERNS) || await page.locator('input').count().catch(() => 0) > 2;
    if (identityPage) {
      const fill = await fillIdentity(page, client);
      session.filledFields = fill.fields;
      if (!fill.documentFilled) {
        return await finish('READY_FOR_HUMAN_CONTINUE', 'Portalul cere datele, dar câmpurile s-au schimbat. Continuă manual în aceeași sesiune.', 'MANUAL');
      }

      const identityContinued = await clickContinue(page);
      if (!identityContinued) {
        return await finish('READY_FOR_HUMAN_CONTINUE', 'Datele sunt completate. Portalul cere următorul pas manual.', 'MANUAL');
      }
      text = await bodyText(page);
    }

    if (await detectHumanGate(page)) {
      return await finish('HUMAN_GATE', 'Datele sunt completate. Completează doar CAPTCHA/verificarea umană.', 'AVAILABILITY');
    }

    await classifyAvailability(page, session);
    if (session.state === 'AVAILABILITY_DETECTED' || session.state === 'NO_AVAILABILITY') result.ok = true;
    return await finish(session.state, session.message, session.resumeStage || 'MANUAL');
  } catch {
    return await finish('ERROR', 'Portalul oficial nu a răspuns corect. Poți încerca din nou.', 'MANUAL');
  } finally {
    session.advancing = false;
    session.updatedAt = nowIso();
    result.finishedAt = nowIso();
  }
}

export async function browserHandoffStatus(ownerId) {
  const key = String(ownerId);
  const session = sessions.get(key);
  if (!session || Date.now() >= session.expiresAt || session.page.isClosed()) {
    await closeSession(key).catch(() => {});
    return { active: false };
  }
  return {
    active: true,
    expiresAt: new Date(session.expiresAt).toISOString(),
    url: session.page.url(),
    title: await session.page.title().catch(() => 'Portal oficial'),
    viewport: { width: 1280, height: 900 },
    state: session.state || 'STARTING',
    message: session.message || null,
    humanGateActive: session.state === 'HUMAN_GATE',
    advancing: Boolean(session.advancing),
    province: session.province || null,
    procedure: session.procedure || null,
    filledFields: session.filledFields || [],
    preferredCities: session.preferredCities || [],
    locationMatchType: session.locationMatchType || null,
    matchedLocation: session.matchedLocation || null,
    availableLocations: session.availableLocations || [],
    alternativeLocations: session.alternativeLocations || [],
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
  await resumePipeline(session);
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
  await resumePipeline(session);
  return browserHandoffStatus(key);
}

export async function stopBrowserHandoff(ownerId) {
  await closeSession(String(ownerId));
  return { ok: true };
}

export async function stopAllBrowserHandoffs() {
  await Promise.all([...sessions.keys()].map((key) => closeSession(key).catch(() => {})));
}
