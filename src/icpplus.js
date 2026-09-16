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
  /seleccione\s+(?:una\s+)?oficina/i
];

const IDENTITY_PATTERNS = [
  /n\.?i\.?e\.?/i,
  /pasaporte/i,
  /n[uú]mero\s+de\s+documento/i,
  /nombre\s+y\s+apellidos/i
];

function nowIso() {
  return new Date().toISOString();
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
      const id = await select.getAttribute('id');
      let nearby = '';
      if (id) {
        nearby += await page.locator(`label[for="${id}"]`).allTextContents().then(x => x.join(' ')).catch(() => '');
      }
      nearby += ' ' + (await select.evaluate((el) => el.parentElement?.innerText || '').catch(() => ''));
      if (!labelHintRegex.test(nearby) && count > 1) {
        // Keep looking for a better semantic match, but accept later if no alternative.
      }
    }

    const value = await select.locator('option').nth(idx).getAttribute('value');
    if (value !== null) {
      await select.selectOption(value);
    } else {
      await select.selectOption({ index: idx });
    }
    return { index: i, optionText: options[idx].trim() };
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

async function fillIdentityIfAllowed(page, client) {
  if (!client?.document) return { filled: false, reason: 'missing_document' };

  const inputs = page.locator('input');
  const count = await inputs.count();
  let docFilled = false;
  let nameFilled = false;

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    const meta = [
      await input.getAttribute('name'),
      await input.getAttribute('id'),
      await input.getAttribute('placeholder'),
      await input.getAttribute('aria-label')
    ].filter(Boolean).join(' ');

    if (!docFilled && /nie|nif|pasaporte|documento/i.test(meta)) {
      await input.fill(client.document);
      docFilled = true;
      continue;
    }
    if (!nameFilled && client.name && /nombre|apellidos/i.test(meta)) {
      await input.fill(client.name);
      nameFilled = true;
    }
  }

  return { filled: docFilled, nameFilled };
}

export async function checkMadridTieAvailability(options = {}) {
  const startedAt = nowIso();
  const debugDir = options.debugDir || path.resolve('logs');
  const safeMode = options.safeMode !== false;
  const client = options.client || null;
  const timeoutMs = options.timeoutMs || 45000;

  const result = {
    ok: false,
    state: 'STARTING',
    startedAt,
    finishedAt: null,
    province: null,
    procedure: null,
    url: null,
    message: null,
    debug: null
  };

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

  try {
    await page.goto(ICP_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    result.url = page.url();

    if (await detectHumanGate(page)) {
      result.state = 'HUMAN_GATE';
      result.message = 'El portal solicita una verificación humana. La automatización se detuvo.';
      result.debug = await saveDebug(page, debugDir, 'human-gate-entry');
      return result;
    }

    const province = await selectOptionContaining(page, /^\s*MADRID\s*$/i, /provincia/i);
    if (!province) {
      result.state = 'PORTAL_CHANGED';
      result.message = 'No se encontró Madrid en los desplegables del portal.';
      result.debug = await saveDebug(page, debugDir, 'province-not-found');
      return result;
    }
    result.province = province.optionText;

    await page.waitForTimeout(1200);
    await page.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => {});

    if (await detectHumanGate(page)) {
      result.state = 'HUMAN_GATE';
      result.message = 'El portal solicita verificación humana después de seleccionar Madrid.';
      result.debug = await saveDebug(page, debugDir, 'human-gate-after-province');
      return result;
    }

    const procedure = await selectOptionContaining(
      page,
      /TOMA\s+DE\s+HUELLA|EXPEDICI[ÓO]N\s+DE\s+TARJETA|TIE/i,
      /tr[aá]mite|procedimiento/i
    );

    if (!procedure) {
      result.state = 'PROCEDURE_NOT_FOUND';
      result.message = 'Madrid cargó, pero no se encontró un trámite TIE/toma de huellas compatible.';
      result.debug = await saveDebug(page, debugDir, 'procedure-not-found');
      return result;
    }
    result.procedure = procedure.optionText;

    await clickContinue(page);
    await page.waitForTimeout(900);
    result.url = page.url();

    if (await detectHumanGate(page)) {
      result.state = 'HUMAN_GATE';
      result.message = 'Se detectó CAPTCHA/Cl@ve/SMS/verificación. Requiere intervención humana.';
      result.debug = await saveDebug(page, debugDir, 'human-gate');
      return result;
    }

    let text = await bodyText(page);
    const identityPage = anyMatch(text, IDENTITY_PATTERNS) || await page.locator('input').count() > 2;

    if (identityPage && safeMode) {
      result.ok = true;
      result.state = 'READY_FOR_IDENTITY';
      result.message = 'Navegación OK hasta el formulario de identidad. SAFE_MODE impide enviar datos personales.';
      result.debug = await saveDebug(page, debugDir, 'ready-for-identity');
      return result;
    }

    if (identityPage && !safeMode) {
      const fill = await fillIdentityIfAllowed(page, client);
      if (!fill.filled) {
        result.state = 'IDENTITY_REQUIRED';
        result.message = 'El portal requiere identidad y no se proporcionó CLIENT_DOCUMENT.';
        result.debug = await saveDebug(page, debugDir, 'identity-required');
        return result;
      }
      await clickContinue(page);
      await page.waitForTimeout(1000);
      text = await bodyText(page);
    }

    if (await detectHumanGate(page)) {
      result.state = 'HUMAN_GATE';
      result.message = 'Verificación humana detectada antes de comprobar disponibilidad.';
      result.debug = await saveDebug(page, debugDir, 'human-gate-before-availability');
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
      result.message = 'Se detectó disponibilidad o una pantalla de selección de cita. No se reserva automáticamente.';
      result.debug = await saveDebug(page, debugDir, 'availability-detected');
      return result;
    }

    result.state = 'UNKNOWN_PAGE';
    result.message = 'Se llegó a una pantalla no clasificada; revisar captura/HTML.';
    result.debug = await saveDebug(page, debugDir, 'unknown-page');
    return result;
  } catch (error) {
    result.state = 'ERROR';
    result.message = error?.message || String(error);
    result.debug = await saveDebug(page, debugDir, 'error').catch(() => null);
    return result;
  } finally {
    result.finishedAt = nowIso();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
