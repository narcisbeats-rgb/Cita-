export const ICP_MADRID_URL = 'https://icp.administracionelectronica.gob.es/icpplustiem/citar?p=28&locale=es';

const fingerprintPatterns = [
  /^POLICIA\s*-\s*TOMA\s+DE\s+HUELLAS\s*\(EXPEDICION\s+DE\s+TARJETA\)\s+INICIAL,?\s+RENOVACION,?\s+DUPLICADO\s+Y\s+LEY\s+14\/2013$/,
  /\bTOMA\s+DE\s+HUELLAS\b.*\bLEY\s+14\/2013\b/
];

export const PROCEDURES = Object.freeze({
  asylum_first: Object.freeze({
    label: 'Primera cita de asilo',
    smsLabel: 'primera cita de asilo',
    official: 'ASILO - PRIMERA CITA - provincia de Madrid',
    description: 'Para pedir por primera vez protección internacional o asilo en Madrid.',
    patterns: [/^ASILO\s*-\s*PRIMERA\s+CITA\s*-?\s*PROVINCIA\s+DE\s+MADRID$/]
  }),
  return_authorization: Object.freeze({
    label: 'Autorización de regreso',
    smsLabel: 'autorización de regreso',
    official: 'AUTORIZACIÓN DE REGRESO',
    description: 'Para salir de España y poder volver mientras tu residencia o TIE está en renovación.',
    patterns: [/^AUTORIZACION\s+DE\s+REGRESO$/]
  }),
  tie_pickup: Object.freeze({
    label: 'Recoger mi tarjeta TIE',
    smsLabel: 'recogida de tarjeta TIE',
    official: 'POLICIA - RECOGIDA DE TARJETA DE IDENTIDAD DE EXTRANJERO (TIE)',
    description: 'Para recoger una TIE que ya está fabricada, cuando la comisaría exige cita previa.',
    patterns: [/^POLICIA\s*-\s*RECOGIDA\s+DE\s+TARJETA\s+DE\s+IDENTIDAD\s+DE\s+EXTRANJERO\s*\(TIE\)$/]
  }),
  nie_new: Object.freeze({
    label: 'Sacar el NIE por primera vez',
    smsLabel: 'asignación de NIE',
    official: 'POLICIA-ASIGNACIÓN DE N.I.E.',
    description: 'Para solicitar la asignación inicial de un número NIE. No sirve para renovar la TIE.',
    patterns: [
      /^POLICIA\s*-\s*ASIGNACION\s+DE\s+N\.?\s*I\.?\s*E\.?$/,
      /\bASIGNACION\s+DE\s+N\.?\s*I\.?\s*E\.?\b/
    ]
  }),
  invitation_letter: Object.freeze({
    label: 'Carta de invitación',
    smsLabel: 'carta de invitación',
    official: 'POLICIA-CARTA DE INVITACIÓN',
    description: 'Para invitar a España a un familiar o amigo extranjero que se alojará en tu domicilio.',
    patterns: [/^POLICIA\s*-\s*CARTA\s+DE\s+INVITACION$/]
  }),
  eu_registration: Object.freeze({
    label: 'Certificado UE (papel verde)',
    smsLabel: 'certificado de ciudadano UE',
    official: 'POLICIA-CERTIFICADO DE REGISTRO DE CIUDADANO DE LA U.E.',
    description: 'Para ciudadanos de la Unión Europea que van a residir en España.',
    patterns: [/^POLICIA\s*-\s*CERTIFICADO\s+DE\s+REGISTRO\s+DE\s+CIUDADANO\s+DE\s+LA\s+U\.?\s*E\.?$/]
  }),
  police_certificates: Object.freeze({
    label: 'Certificados de residencia o concordancia',
    smsLabel: 'certificados de residencia o concordancia',
    official: 'POLICIA-CERTIFICADOS (DE RESIDENCIA, DE NO RESIDENCIA Y DE CONCORDANCIA)',
    description: 'Para pedir un certificado de residencia, no residencia o concordancia de datos.',
    patterns: [/^POLICIA\s*-\s*CERTIFICADOS?\s*\(DE\s+RESIDENCIA,?\s+DE\s+NO\s+RESIDENCIA\s+Y\s+DE\s+CONCORDANCIA\)$/]
  }),
  registration_card: Object.freeze({
    label: 'Cédula de inscripción',
    smsLabel: 'cédula de inscripción',
    official: 'POLICIA - CÉDULA DE INSCRIPCIÓN',
    description: 'Para extranjeros que no pueden ser documentados por las autoridades de su país.',
    patterns: [/^POLICIA\s*-\s*CEDULA\s+DE\s+INSCRIPCION$/]
  }),
  ukraine_card: Object.freeze({
    label: 'Tarjeta de protección temporal — Ucrania',
    smsLabel: 'tarjeta de protección temporal de Ucrania',
    official: 'POLICIA TARJETA CONFLICTO UCRANIA–ПОЛІЦІЯ -КАРТКА ДЛЯ ПЕРЕМІЩЕНИХ ОСІБ',
    description: 'Para personas desplazadas por la guerra de Ucrania que tienen protección temporal.',
    patterns: [/^POLICIA\s+(?:-\s*)?TARJETA\s+CONFLICTO\s+UCRANIA\b/]
  }),
  brexit_card: Object.freeze({
    label: 'Tarjeta Brexit para británicos y familiares',
    smsLabel: 'tarjeta Brexit',
    official: 'POLICÍA-EXP.TARJETA ASOCIADA AL ACUERDO DE RETIRADA CIUDADANOS BRITÁNICOS Y SUS FAMILIARES (BREXIT)',
    description: 'Para ciudadanos británicos y familiares incluidos en el Acuerdo de Retirada (Brexit).',
    patterns: [/^POLICIA\s*-\s*EXP\.?\s*TARJETA\s+ASOCIADA\s+AL\s+ACUERDO\s+DE\s+RETIRADA\b.*\bBREXIT\b/]
  }),
  migration_card_issue: Object.freeze({
    label: 'Expedir tarjeta autorizada por Migraciones',
    smsLabel: 'expedición de tarjeta autorizada por Migraciones',
    official: 'POLICÍA-EXPEDICIÓN DE TARJETAS CUYA AUTORIZACIÓN RESUELVE LA DIRECCIÓN GENERAL DE GESTIÓN MIGRATORIA',
    description: 'Solo si tu resolución dice que la autorización la concede la Dirección General de Gestión Migratoria.',
    patterns: [/^POLICIA\s*-\s*EXPEDICION\s+DE\s+TARJETAS?\s+CUYA\s+AUTORIZACION\s+RESUELVE\s+LA\s+DIRECCION\s+GENERAL\s+DE\s+GESTION\s+MIGRATORIA$/]
  }),
  stay_extension: Object.freeze({
    label: 'Prórroga de estancia',
    smsLabel: 'prórroga de estancia',
    official: 'POLICÍA-PRÓRROGA DE ESTANCIA',
    description: 'Para solicitar más tiempo de estancia de corta duración cuando la normativa lo permite.',
    patterns: [/^POLICIA\s*-\s*PRORROGA\s+DE\s+ESTANCIA$/]
  }),
  migration_card_pickup: Object.freeze({
    label: 'Recoger tarjeta autorizada por Migraciones',
    smsLabel: 'recogida de tarjeta autorizada por Migraciones',
    official: 'POLICÍA-RECOGIDA DE LA TIE CUYA AUTORIZACIÓN RESUELVE LA DIRECCIÓN GENERAL DE GESTIÓN MIGRATORIA',
    description: 'Para recoger una TIE cuya autorización resolvió la Dirección General de Gestión Migratoria.',
    patterns: [/^POLICIA\s*-\s*RECOGIDA\s+DE\s+LA\s+TIE\s+CUYA\s+AUTORIZACION\s+RESUELVE\s+LA\s+DIRECCION\s+GENERAL\s+DE\s+GESTION\s+MIGRATORIA$/]
  }),
  tie_fingerprint: Object.freeze({
    label: 'Huellas para TIE: inicial, renovación o duplicado',
    smsLabel: 'huellas para TIE',
    official: 'POLICÍA-TOMA DE HUELLAS (EXPEDICIÓN DE TARJETA) INICIAL, RENOVACIÓN, DUPLICADO Y LEY 14/2013',
    description: 'Para poner huellas y expedir la TIE por primera vez, renovarla o pedir un duplicado.',
    patterns: fingerprintPatterns
  }),

  // Claves antiguas que pueden seguir existiendo en suscripciones ya creadas.
  lost: Object.freeze({
    label: 'TIE perdida, robada o deteriorada',
    smsLabel: 'duplicado de TIE',
    official: 'POLICÍA-TOMA DE HUELLAS (EXPEDICIÓN DE TARJETA) INICIAL, RENOVACIÓN, DUPLICADO Y LEY 14/2013',
    description: 'La opción oficial para el duplicado de una TIE perdida, robada o deteriorada.',
    patterns: fingerprintPatterns
  }),
  tie_renew: Object.freeze({
    label: 'Renovar TIE',
    smsLabel: 'renovación de TIE',
    official: 'POLICÍA-TOMA DE HUELLAS (EXPEDICIÓN DE TARJETA) INICIAL, RENOVACIÓN, DUPLICADO Y LEY 14/2013',
    description: 'La opción oficial para poner huellas durante la renovación de la TIE.',
    patterns: fingerprintPatterns
  }),
  tie_duplicate: Object.freeze({
    label: 'Duplicado TIE',
    smsLabel: 'duplicado de TIE',
    official: 'POLICÍA-TOMA DE HUELLAS (EXPEDICIÓN DE TARJETA) INICIAL, RENOVACIÓN, DUPLICADO Y LEY 14/2013',
    description: 'La opción oficial para poner huellas y solicitar un duplicado de la TIE.',
    patterns: fingerprintPatterns
  })
});

export const PUBLIC_PROCEDURE_KEYS = Object.freeze([
  'nie_new',
  'tie_fingerprint',
  'tie_pickup',
  'eu_registration',
  'return_authorization',
  'invitation_letter',
  'police_certificates',
  'stay_extension',
  'asylum_first',
  'registration_card',
  'ukraine_card',
  'brexit_card',
  'migration_card_issue',
  'migration_card_pickup'
]);

export const MONITORABLE_PROCEDURE_KEYS = Object.freeze([
  ...PUBLIC_PROCEDURE_KEYS,
  'lost',
  'tie_renew',
  'tie_duplicate'
]);

export function normalizeProcedureText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function procedureDefinition(serviceKey) {
  return PROCEDURES[serviceKey] || null;
}

export function procedureMatches(serviceKey, optionText) {
  const definition = procedureDefinition(serviceKey);
  if (!definition) return false;
  const normalized = normalizeProcedureText(optionText);
  return definition.patterns.some((pattern) => pattern.test(normalized));
}
