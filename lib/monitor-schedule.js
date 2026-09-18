export const monitorHours = Object.freeze([8, 9, 10, 11, 12, 13]);
export const monitorScheduleTimeZone = 'Europe/Madrid';

const madridClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: monitorScheduleTimeZone,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function madridTime(timestamp) {
  const parts = madridClock.formatToParts(new Date(timestamp));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return { hour: Number(value('hour')), minute: Number(value('minute')), weekday: value('weekday') };
}

export function nextScheduledCheckAt(after = Date.now()) {
  const firstMinute = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < 8 * 24 * 60; offset += 1) {
    const candidate = firstMinute + offset * 60_000;
    const local = madridTime(candidate);
    const businessDay = !['Sat', 'Sun'].includes(local.weekday);
    if (businessDay && local.minute === 0 && monitorHours.includes(local.hour)) return candidate;
  }
  throw new Error('monitor_schedule_not_found');
}

export function monitorScheduleLabel() {
  return `lunes a viernes · ${monitorHours.map((hour) => `${String(hour).padStart(2, '0')}:00`).join(', ')}`;
}
