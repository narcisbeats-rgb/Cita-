import { chromium } from 'playwright';
import { ICP_URL } from '../src/icpplus.js';

const SESSION_TTL_MS = 5 * 60_000;
const sessions = new Map();

const PROCEDURE_PATTERNS = {
  nie_new: [/ASIGNACION\s+DE\s+NIE/i, /CERTIFICADOS?.*NIE/i, /NIE.*INTERESAD/i],
  tie_fingerprint: [/TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i],
  tie_renew: [/TOMA\s+DE\s+HUELL/i, /RENOVACION\s+DE\s+TARJETA.*LARGA\s+DURACION/i, /EXPEDICION\s+DE\s+TARJETA/i],
  tie_duplicate: [/DUPLICADO.*TIE/i, /TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i],
  lost: [/DUPLICADO.*TIE/i, /TOMA\s+DE\s+HUELL/i, /EXPEDICION\s+DE\s+TARJETA/i]
};

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
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
    return true;
  }
  return false;
}

async function selectProcedure(page, serviceKey) {
  const patterns = PROCEDURE_PATTERNS[serviceKey] || PROCEDURE_PATTERNS.tie_fingerprint;
  const selects = page.locator('select');
  const count = await selects.count();
  for (const pattern of patterns) {
    for (let i = 0; i < count; i++) {
      const select = selects.nth(i);
      if (!(await select.isVisible().catch(() => false))) continue;
      const options = await select.locator('option').allTextContents();
      const index = options.findIndex((value) => pattern.test(normalize(value)));
      if (index < 0) continue;
      const option = select.locator('option').nth(index);
      const value = await option.getAttribute('value');
      if (value !== null) await select.selectOption(value);
      else await select.selectOption({ index });
      return true;
    }
  }
  return false;
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
      await item.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(700);
      return true;
    }
  }
  return false;
}

async function fieldMeta(input) {
  const attrs = [
    await input.getAttribute('name'),
    await input.getAttribute('id'),
    await input.getAttribute('placeholder'),
    await input.getAttribute('aria-label')
  ].filter(Boolean).join(' ');
  const nearby = await input.evaluate((el) => `${el.parentElement?.innerText || ''}`).catch(() => '');
  return normalize(`${attrs} ${nearby}`);
}

async function fillIdentity(page, client = {}) {
  if (!client.document) return;
  const inputs = page.locator('input');
  const count = await inputs.count();
  let documentFilled = false;
  let nameFilled = false;
  let surname1Filled = false;
  let surname2Filled = false;
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false)) || await input.isDisabled().catch(() => false)) continue;
    const type = String(await input.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(type)) continue;
    const meta = await fieldMeta(input);
    if (!documentFilled && /\bNIE\b|\bNIF\b|PASAPORTE|DOCUMENTO|IDCITADO/.test(meta)) {
      await input.fill(client.document).catch(() => {});
      documentFilled = true;
    } else if (!surname2Filled && client.surname2 && /(SEGUNDO\s+APELLIDO|APELLIDO\s*2|APELLIDO2)/.test(meta)) {
      await input.fill(client.surname2).catch(() => {});
      surname2Filled = true;
    } else if (!surname1Filled && client.surname1 && /(PRIMER\s+APELLIDO|APELLIDO\s*1|APELLIDO1)/.test(meta)) {
      await input.fill(client.surname1).catch(() => {});
      surname1Filled = true;
    } else if (!nameFilled && client.firstName && /\bNOMBRE\b/.test(meta) && !/APELLIDO/.test(meta)) {
      await input.fill(client.firstName).catch(() => {});
      nameFilled = true;
    } else if (client.birthDate && /(FECHA.*NACIMIENTO|NACIMIENTO.*FECHA|BDAY)/.test(meta)) {
      await input.fill(type === 'date' ? client.birthDate : client.birthDate.split('-').reverse().join('/')).catch(() => {});
    } else if (client.email && /EMAIL|E-MAIL|CORREO/.test(meta)) {
      await input.fill(client.email).catch(() => {});
    } else if (client.mobile && /TELEFONO|MOVIL|MOBILE|PHONE/.test(meta)) {
      await input.fill(client.mobile).catch(() => {});
    }
  }
}

async function preparePage(page, serviceKey, client) {
  await page.goto(ICP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(700);
  if (await selectMadrid(page)) {
    await page.waitForTimeout(900);
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  }
  if (await selectProcedure(page, serviceKey)) {
    await clickContinue(page);
    await page.waitForTimeout(800);
  }
  await fillIdentity(page, client).catch(() => {});
}

export async function startBrowserHandoff({ ownerId, serviceKey, client }) {
  const key = String(ownerId);
  await closeSession(key);
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await preparePage(page, serviceKey, client);
  } catch (error) {
    console.error('[CitaNIE Handoff] Prepare warning:', error.message);
  }
  const session = { browser, context, page, serviceKey, timer: null, expiresAt: 0 };
  sessions.set(key, session);
  armExpiry(key, session);
  return browserHandoffStatus(key);
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
    viewport: { width: 1280, height: 900 }
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
  return browserHandoffStatus(key);
}

export async function stopBrowserHandoff(ownerId) {
  await closeSession(String(ownerId));
  return { ok: true };
}

export async function stopAllBrowserHandoffs() {
  await Promise.all([...sessions.keys()].map((key) => closeSession(key).catch(() => {})));
}
