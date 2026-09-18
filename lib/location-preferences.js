
const CITY_COORDS = {
  'Madrid': [40.4168, -3.7038],
  'Parla': [40.2372, -3.7732],
  'Getafe': [40.3083, -3.7327],
  'Leganés': [40.3272, -3.7635],
  'Fuenlabrada': [40.2839, -3.7942],
  'Pinto': [40.2415, -3.6999],
  'Valdemoro': [40.1908, -3.6789],
  'Alcorcón': [40.3458, -3.8249],
  'Móstoles': [40.3223, -3.8650],
  'Pozuelo de Alarcón': [40.4350, -3.8134],
  'Boadilla del Monte': [40.4050, -3.8783],
  'Rivas-Vaciamadrid': [40.3260, -3.5170],
  'Coslada': [40.4238, -3.5613],
  'San Fernando de Henares': [40.4239, -3.5326],
  'Torrejón de Ardoz': [40.4554, -3.4697],
  'Alcalá de Henares': [40.4818, -3.3643],
  'Alcobendas': [40.5475, -3.6419],
  'San Sebastián de los Reyes': [40.5471, -3.6264],
  'Tres Cantos': [40.6009, -3.7081],
  'Colmenar Viejo': [40.6591, -3.7676],
  'Collado Villalba': [40.6330, -4.0049],
  'Majadahonda': [40.4735, -3.8718],
  'Las Rozas de Madrid': [40.4929, -3.8737],
  'Aranjuez': [40.0311, -3.6025],
  'Arganda del Rey': [40.3008, -3.4381]
};

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function cleanCityPreferences(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;\n]/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const city = String(item || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!city) continue;
    const key = norm(city);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(city);
    if (out.length >= 6) break;
  }
  return out;
}

function municipalityFromText(value) {
  const text = norm(value);
  if (!text) return null;
  for (const city of Object.keys(CITY_COORDS)) {
    if (text.includes(norm(city))) return city;
  }
  return null;
}

function distanceKm(a, b) {
  const toRad = (v) => v * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function uniqueLabels(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const value = String(raw || '').trim().replace(/\s+/g, ' ');
    if (value.length < 3 || value.length > 180) continue;
    if (/^SELECCIONE|^--|PROVINCIA|TRAMITE|TRÁMITE/i.test(value)) continue;
    const key = norm(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function containsKnownCity(text, preferredCities) {
  const normalized = norm(text);
  const names = [...Object.keys(CITY_COORDS), ...cleanCityPreferences(preferredCities)];
  return names.some((name) => normalized.includes(norm(name)));
}

export async function readOfficeOptions(page, preferredCities = []) {
  const found = [];
  const selects = page.locator('select');
  const count = await selects.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const nearby = norm(await select.evaluate((el) => {
      const labels = [...document.querySelectorAll('label')].filter((label) => label.htmlFor && label.htmlFor === el.id);
      return labels.map((label) => label.textContent || '').join(' ') + ' ' + (el.parentElement?.innerText || '');
    }).catch(() => ''));
    const options = await select.locator('option').allTextContents().catch(() => []);
    const looksLikeOffice = /OFICINA|LOCALIDAD|DEPENDENCIA|COMISARIA|COMISARÍA|UBICACION|UBICACIÓN|CENTRO/.test(nearby);
    for (const option of options) {
      if (looksLikeOffice || containsKnownCity(option, preferredCities)) found.push(option);
    }
  }

  const controls = page.locator('label, [role="radio"], button, a');
  const controlCount = Math.min(await controls.count().catch(() => 0), 250);
  for (let i = 0; i < controlCount; i++) {
    const el = controls.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = String(await el.innerText().catch(() => '') || '').trim();
    if (text && containsKnownCity(text, preferredCities)) found.push(text);
  }

  return uniqueLabels(found);
}

export function analyzeLocationOptions(options, preferredCities = [], allowNearby = true) {
  const availableLocations = uniqueLabels(options).slice(0, 12);
  const preferences = cleanCityPreferences(preferredCities);

  for (const city of preferences) {
    const direct = availableLocations.find((label) => norm(label).includes(norm(city)));
    if (direct) {
      return {
        preferredCities: preferences,
        locationMatchType: 'preferred',
        matchedLocation: direct,
        matchedCity: city,
        availableLocations,
        alternativeLocations: []
      };
    }
  }

  let alternatives = [...availableLocations];
  if (allowNearby && preferences.length && alternatives.length) {
    const originName = Object.keys(CITY_COORDS).find((city) => norm(city) === norm(preferences[0]));
    const origin = originName ? CITY_COORDS[originName] : null;
    if (origin) {
      alternatives.sort((a, b) => {
        const cityA = municipalityFromText(a);
        const cityB = municipalityFromText(b);
        const da = cityA ? distanceKm(origin, CITY_COORDS[cityA]) : Number.POSITIVE_INFINITY;
        const db = cityB ? distanceKm(origin, CITY_COORDS[cityB]) : Number.POSITIVE_INFINITY;
        return da - db;
      });
    }
  }

  return {
    preferredCities: preferences,
    locationMatchType: allowNearby && alternatives.length ? 'alternative' : 'none',
    matchedLocation: null,
    matchedCity: null,
    availableLocations,
    alternativeLocations: allowNearby ? alternatives.slice(0, 3) : []
  };
}

export function locationMessage(location) {
  if (!location) return '';
  if (location.locationMatchType === 'preferred' && location.matchedLocation) {
    return ' Hay disponibilidad compatible con tu preferencia: ' + location.matchedLocation + '.';
  }
  if (location.locationMatchType === 'alternative' && location.alternativeLocations?.length) {
    const wanted = location.preferredCities?.length ? location.preferredCities.join(', ') : 'tu ciudad';
    return ' No aparece una opción en ' + wanted + ', pero el portal muestra alternativas: ' + location.alternativeLocations.join(' · ') + '.';
  }
  return '';
}
