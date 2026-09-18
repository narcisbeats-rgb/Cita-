import { analyzeLocationOptions, locationMessage, readOfficeOptions } from '../lib/location-preferences.js';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ICP_URL = 'https://sede.administracionespublicas.gob.es/icpplustiej/citar?i=es';

const HUMAN_GATE_PATTERNS = [
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /cl@ve/i,
  /c[oó]digo\s+(?:sms|de\s+verificaci[oó]n)/i,
  /verificaci[oó]n\s+(?:m[oó]vil|por\s+tel[eé]fono)/i,
  /confirma(?:ci[oó]n|r)\s+personal/i
];

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
  /fecha\s+(?:y\s+)?hora/i,
  /hora\s+disponible/i
];

const IDENTITY_PATTERNS = [
  /n\.?i\.?e\.?/i,
  /pasaporte/i,
  /n[uú]mero\s+de\s+documento/i,
  /nombre\s+y\s+apellidos/i,
  /apellidos\s+y\s+nombre/i
];

const PROCEDURE_RULES = {
  nie_new: {
    label: 'Sacar NIE',
    patterns: [
      /\bASIGNACION\s+DE\s+NIE\b/,
      /\bCERTIFICADOS?.*\bNIE\b/,
      /\bNIE\b.*\bINSTANCIA\b.*\bINTERESAD/,
      /\bNIE\b.*\bINTERESAD/
    ]
  },
  tie_fingerprint: {
    label: 'Toma de huellas TIE',
    patterns: [
      /\bTOMA\s+DE\s+HUELL/,
      /\bEXPEDICION\s+DE\s+TARJETA/
    ]
  },
  tie_renew: {
    label: 'Renovar TIE',
    patterns: [
      /\bTOMA\s+DE\s+HUELL/,
      /\bRENOVACION\s+DE\s+TARJETA.*\bLARGA\s+DURACION\b/,
      /\bEXPEDICION\s+DE\s+TARJETA/
    ]
  },
  tie_duplicate: {
    label: 'Duplicado TIE',
    patterns: [
      /\bTOMA\s+DE\s+HUELL/,
      /\bDUPLICADO.*\bTIE\b/,
      /\bEXPEDICION\s+DE\s+TARJETA/
    ]
  },
  lost: {
    label: 'NIE/TIE perdido',
    patterns: [
      /\bTOMA\s+DE\s+HUELL/,
      /\bDUPLICADO.*\bTIE\b/,
      /\bEXPEDICION\s+DE\s+TARJETA/
    ]
  }
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

async function bodyText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 7000 });
  } catch {
    return '';
  }
}

function anyMatch(text, patterns) {
  return patterns.some((p) => p.test(text));
}

async function detectHumanGate(page) {
  const text = await bodyText(page);
  if (anyMatch(text, HUMAN_GATE_PATTERNS)) return true;
  const frameUrls = page.frames().map((f) => f.url()).join('\n');
  return /recaptcha|hcaptcha|captcha/i.test(frameUrls);
}

async function selectOptionContaining(page, optionRegex, labelHintRegex = null) {
  const selects = page.locator('select');
  const count = await selects.count();

  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;

    const options = await select.locator('option').allTextContents();
    const idx = options.findIndex((t) => optionRegex.test(t.trim()));
    if (idx < 0) continue;

    if (labelHintRegex) {
      const nearby = await select.evaluate((el) => {
        const labels = [...document.querySelectorAll('label')].filter((label) => label.htmlFor && label.htmlFor === el.id);
        return `${labels.map((label) => label.textContent || '').join(' ')} ${el.parentElement?.innerText || ''}`;
      }).catch(() => '');
      if (!labelHintRegex.test(nearby) && count > 1) continue;
    }

    const value = await select.locator('option').nth(idx).getAttribute('value');
    if (value !== null) await select.selectOption(value);
    else await select.selectOption({ index: idx });
    return { index: i, optionText: options[idx].trim() };
  }

  return null;
}

async function selectProcedureForService(page, serviceKey) {
  if (serviceKey === 'nie_renew') {
    return { needsClarification: true, label: 'Renovar NIE' };
  }

  const rule = PROCEDURE_RULES[serviceKey] || PROCEDURE_RULES.tie_fingerprint;
  const selects = page.locator('select');
  const selectCount = await selects.count();

  for (let priority = 0; priority < rule.patterns.length; priority++) {
    const pattern = rule.patterns[priority];
    const candidates = [];

    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      if (!(await select.isVisible().catch(() => false))) continue;
      const options = await select.locator('option').allTextContents();
      for (let j = 0; j < options.length; j++) {
        const normalized = normalizeText(options[j]);
        if (!normalized || /^SELECCIONE|^--/.test(normalized)) continue;
        if (pattern.test(normalized)) {
          candidates.push({ selectIndex: i, optionIndex: j, optionText: options[j].trim() });
        }
      }
    }

    if (candidates.length === 1) {
      const candidate = candidates[0];
      const select = selects.nth(candidate.selectIndex);
      const value = await select.locator('option').nth(candidate.optionIndex).getAttribute('value');
      if (value !== null) await select.selectOption(value);
      else await select.selectOption({ index: candidate.optionIndex });
      return { ...candidate, label: rule.label };
    }

    if (candidates.length > 1) {
      const uniqueTexts = [...new Set(candidates.map((c) => normalizeText(c.optionText)))];
      if (uniqueTexts.length === 1) {
        const candidate = candidates[0];
        const select = selects.nth(candidate.selectIndex);
        const value = await select.locator('option').nth(candidate.optionIndex).getAttribute('value');
        if (value !== null) await select.selectOption(value);
        else await select.selectOption({ index: candidate.optionIndex });
        return { ...candidate, label: rule.label };
      }
      return { ambiguous: true, label: rule.label, options: candidates.map((c) => c.optionText).slice(0, 8) };
    }
  }

  return null;
}

async function clickContinue(page) {
  const candidates = [
    page.getByRole('button', { name: /aceptar|continuar|entrar|siguiente/i }),
    page.getByRole('link', { name: /aceptar|continuar|entrar|siguiente/i }),
    page.locator('input[type="submit"]'),
    page.locator('input[type="button"][value*="Aceptar" i], input[type="button"][value*="Continuar" i]')
  ];

  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await Promise.allSettled([
          page.waitForLoadState('domcontentloaded', { timeout: 12000 }),
          el.click({ timeout: 7000 })
        ]);
        return true;
      }
    }
  }
  return false;
}

async function saveDebug(page, dir, prefix) {
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshot = path.join(dir, `${prefix}-${stamp}.png`);
  const html = path.join(dir, `${prefix}-${stamp}.html`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  await fs.writeFile(html, await page.content().catch(() => ''), 'utf8').catch(() => {});
  return { screenshot, html };
}

async function elementMeta(locator) {
  const attrs = [
    await locator.getAttribute('name'),
    await locator.getAttribute('id'),
    await locator.getAttribute('placeholder'),
    await locator.getAttribute('aria-label'),
    await locator.getAttribute('autocomplete')
  ].filter(Boolean).join(' ');
  const nearby = await locator.evaluate((el) => {
    const labels = [...document.querySelectorAll('label')].filter((label) => label.htmlFor && label.htmlFor === el.id);
    return `${labels.map((label) => label.textContent || '').join(' ')} ${el.parentElement?.innerText || ''}`;
  }).catch(() => '');
  return normalizeText(`${attrs} ${nearby}`);
}

function fullName(client) {
  return [client?.firstName, client?.surname1, client?.surname2].filter(Boolean).join(' ').trim() || client?.name || '';
}

function surnamesThenName(client) {
  const surnames = [client?.surname1, client?.surname2].filter(Boolean).join(' ').trim();
  if (surnames && client?.firstName) return `${surnames}, ${client.firstName}`;
  return fullName(client);
}

async function chooseDocumentType(page, client) {
  if (!client?.documentType) return false;
  const wanted = normalizeText(client.documentType) === 'PASSPORT' ? 'PASAPORTE' : 'NIE';
  const selects = page.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator('option').allTextContents();
    const normalized = options.map(normalizeText);
    const hasNie = normalized.some((t) => /\bNIE\b/.test(t));
    const hasPassport = normalized.some((t) => /PASAPORTE|PASSPORT/.test(t));
    if (!hasNie || !hasPassport) continue;
    const idx = normalized.findIndex((t) => wanted === 'NIE' ? /\bNIE\b/.test(t) : /PASAPORTE|PASSPORT/.test(t));
    if (idx < 0) continue;
    const value = await select.locator('option').nth(idx).getAttribute('value');
    if (value !== null) await select.selectOption(value);
    else await select.selectOption({ index: idx });
    return true;
  }
  return false;
}

async function fillIdentityIfAllowed(page, client) {
  if (!client?.document) return { filled: false, reason: 'missing_document', fields: [] };

  const fields = [];
  await chooseDocumentType(page, client).then((filled) => { if (filled) fields.push('documentType'); }).catch(() => {});

  const inputs = page.locator('input');
  const count = await inputs.count();
  let docFilled = false;
  let firstNameFilled = false;
  let surname1Filled = false;
  let surname2Filled = false;
  let combinedNameFilled = false;

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    if (await input.isDisabled().catch(() => false)) continue;
    const type = String(await input.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(type)) continue;

    const meta = await elementMeta(input);

    if (!docFilled && /\bNIE\b|\bNIF\b|PASAPORTE|DOCUMENTO|IDCITADO/.test(meta)) {
      await input.fill(client.document);
      docFilled = true;
      fields.push('document');
      continue;
    }

    if (!surname2Filled && client.surname2 && /(SEGUNDO\s+APELLIDO|APELLIDO\s*2|APELLIDO2)/.test(meta)) {
      await input.fill(client.surname2);
      surname2Filled = true;
      fields.push('surname2');
      continue;
    }

    if (!surname1Filled && client.surname1 && /(PRIMER\s+APELLIDO|APELLIDO\s*1|APELLIDO1)/.test(meta)) {
      await input.fill(client.surname1);
      surname1Filled = true;
      fields.push('surname1');
      continue;
    }

    if (!firstNameFilled && client.firstName && /\bNOMBRE\b/.test(meta) && !/APELLIDO/.test(meta)) {
      await input.fill(client.firstName);
      firstNameFilled = true;
      fields.push('firstName');
      continue;
    }

    if (!combinedNameFilled && fullName(client) && /(NOMBRE.*APELLIDO|APELLIDO.*NOMBRE|DESCITADO)/.test(meta)) {
      const value = /APELLIDO.*NOMBRE/.test(meta) ? surnamesThenName(client) : fullName(client);
      await input.fill(value);
      combinedNameFilled = true;
      fields.push('name');
      continue;
    }

    if (client.birthDate && /(FECHA.*NACIMIENTO|NACIMIENTO.*FECHA|BDAY)/.test(meta)) {
      const value = type === 'date' ? client.birthDate : client.birthDate.split('-').reverse().join('/');
      await input.fill(value).catch(() => {});
      fields.push('birthDate');
      continue;
    }

    if (client.birthDate && /(ANO|ANNO|AÑO).*NACIMIENTO/.test(meta)) {
      await input.fill(client.birthDate.slice(0, 4)).catch(() => {});
      fields.push('birthYear');
      continue;
    }

    if (client.email && /EMAIL|E-MAIL|CORREO/.test(meta)) {
      await input.fill(client.email).catch(() => {});
      fields.push('email');
      continue;
    }

    if (client.mobile && /TELEFONO|MOVIL|MOBILE|PHONE/.test(meta)) {
      await input.fill(client.mobile).catch(() => {});
      fields.push('mobile');
    }
  }

  return {
    filled: docFilled,
    nameFilled: firstNameFilled || combinedNameFilled,
    fields: [...new Set(fields)]
  };
}

export function assistedServiceSupported(serviceKey) {
  return Boolean(PROCEDURE_RULES[serviceKey]);
}

export async function checkMadridTieAvailability(options = {}) {
  const startedAt = nowIso();
  const debugDir = options.debugDir || path.resolve('logs');
  const safeMode = options.safeMode !== false;
  const captureDebug = options.captureDebug !== false;
  const client = options.client || null;
  const timeoutMs = options.timeoutMs || 45000;
  const serviceKey = options.serviceKey || 'tie_fingerprint';

  const result = {
    ok: false,
    state: 'STARTING',
    serviceKey,
    startedAt,
    finishedAt: null,
    province: null,
    procedure: null,
    url: null,
    message: null,
    debug: null,
    filledFields: [],
    preferredCities: Array.isArray(client?.preferredCities) ? client.preferredCities : [],
    locationMatchType: null,
    matchedLocation: null,
    availableLocations: [],
    alternativeLocations: []
  };

  if (serviceKey === 'nie_renew') {
    result.state = 'PROCEDURE_NEEDS_CLARIFICATION';
    result.message = 'El número NIE no caduca. Antes de automatizar hay que identificar si necesitas renovar TIE, residencia o un certificado concreto.';
    result.finishedAt = nowIso();
    return result;
  }

  const browser = await chromium.launch({
    headless: options.headless !== false,
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  });

  const context = await browser.newContext({
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const capture = (prefix) => captureDebug ? saveDebug(page, debugDir, prefix) : Promise.resolve(null);

  try {
    await page.goto(ICP_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    result.url = page.url();

    if (await detectHumanGate(page)) {
      result.state = 'HUMAN_GATE';
      result.message = 'El portal solicita una verificación humana. La automatización se detuvo.';
      result.debug = await capture('human-gate-entry');
      return result;
    }

    const province = await selectOptionContaining(page, /^\s*MADRID\s*$/i, /provincia/i);
    if (!province) {
      result.state = 'PORTAL_CHANGED';
      result.message = 'No se encontró Madrid en los desplegables del portal.';
      result.debug = await capture('province-not-found');
      return result;
    }
    result.province = province.optionText;

    await page.waitForTimeout(1200);
    await page.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => {});

    if (await detectHumanGate(page)) {
      result.state = 'HUMAN_GATE';
      result.message = 'El portal solicita verificación humana después de seleccionar Madrid.';
      result.debug = await capture('human-gate-after-province');
      return result;
    }

    const procedure = await selectProcedureForService(page, serviceKey);
    if (procedure?.needsClarification) {
      result.state = 'PROCEDURE_NEEDS_CLARIFICATION';
      result.message = 'Este trámite necesita una clasificación previa para no seleccionar una cita incorrecta.';
      return result;
    }
    if (procedure?.ambiguous) {
      result.state = 'PROCEDURE_AMBIGUOUS';
      result.message = 'El portal muestra varias opciones compatibles y CitaNIE no seleccionará una automáticamente sin estar seguro.';
      result.debug = await capture('procedure-ambiguous');
      return result;
    }
    if (!procedure) {
      result.state = 'PROCEDURE_NOT_FOUND';
      result.message = `Madrid cargó, pero no se encontró una opción compatible con ${PROCEDURE_RULES[serviceKey]?.label || 'el trámite seleccionado'}.`;
      result.debug = await capture('procedure-not-found');
      return result;
    }
    result.procedure = procedure.optionText;

    await clickContinue(page);
    await page.waitForTimeout(900);
    result.url = page.url();

    if (await detectHumanGate(page)) {
      result.state = 'HUMAN_GATE';
      result.message = 'Se detectó CAPTCHA/Cl@ve/SMS/verificación. Requiere intervención humana.';
      result.debug = await capture('human-gate');
      return result;
    }

    let text = await bodyText(page);
    const identityPage = anyMatch(text, IDENTITY_PATTERNS) || await page.locator('input').count() > 2;

    if (identityPage && safeMode) {
      result.ok = true;
      result.state = 'READY_FOR_IDENTITY';
      result.message = 'Navegación OK hasta el formulario de identidad. SAFE_MODE impide enviar datos personales.';
      result.debug = await capture('ready-for-identity');
      return result;
    }

    if (identityPage && !safeMode) {
      const fill = await fillIdentityIfAllowed(page, client);
      result.filledFields = fill.fields || [];
      if (!fill.filled) {
        result.state = 'IDENTITY_REQUIRED';
        result.message = 'El portal requiere identidad y no se pudo localizar con seguridad el campo del documento.';
        result.debug = await capture('identity-required');
        return result;
      }
      const continued = await clickContinue(page);
      if (!continued) {
        result.state = 'READY_FOR_HUMAN_CONTINUE';
        result.message = 'Los datos se rellenaron, pero el portal requiere una acción manual para continuar.';
        result.debug = await capture('ready-for-human-continue');
        return result;
      }
      await page.waitForTimeout(1000);
      result.url = page.url();
      text = await bodyText(page);
    }

    if (await detectHumanGate(page)) {
      result.state = 'HUMAN_GATE';
      result.message = 'Verificación humana detectada antes de comprobar disponibilidad.';
      result.debug = await capture('human-gate-before-availability');
      return result;
    }

    if (anyMatch(text, NO_AVAILABILITY_PATTERNS)) {
      result.ok = true;
      result.state = 'NO_AVAILABILITY';
      result.message = 'El portal indica que no hay citas disponibles.';
      return result;
    }

    const officeOptions = await readOfficeOptions(page, client?.preferredCities || []).catch(() => []);
    if (anyMatch(text, AVAILABILITY_PATTERNS)) {
      const location = analyzeLocationOptions(officeOptions, client?.preferredCities || [], client?.allowNearby !== false);
      Object.assign(result, location);
      result.ok = true;
      result.state = 'AVAILABILITY_DETECTED';
      result.message = `Se detectó disponibilidad o una pantalla de selección de cita. No se reserva automáticamente.${locationMessage(location)}`;
      result.debug = await capture('availability-detected');
      return result;
    }

    result.state = 'UNKNOWN_PAGE';
    result.message = 'Se llegó a una pantalla no clasificada; revisar captura/HTML.';
    result.debug = await capture('unknown-page');
    return result;
  } catch (error) {
    result.state = 'ERROR';
    result.message = error?.message || String(error);
    result.debug = await capture('error').catch(() => null);
    return result;
  } finally {
    result.finishedAt = nowIso();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
