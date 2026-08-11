'use strict';

const ZONE = 'America/New_York';
const RESET_HOUR = 5;

function easternParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const hour = Number(map.hour === '24' ? '0' : map.hour);
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hm: `${String(hour).padStart(2, '0')}:${map.minute}`,
    hour,
    minute: Number(map.minute),
  };
}

function previousDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return [
    previous.getUTCFullYear(),
    String(previous.getUTCMonth() + 1).padStart(2, '0'),
    String(previous.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function operationalDate(now = new Date()) {
  const parts = easternParts(now);
  return parts.hour < RESET_HOUR ? previousDate(parts.date) : parts.date;
}

function resetCutoff(now = new Date()) {
  return `${operationalDate(now)} ${String(RESET_HOUR).padStart(2, '0')}:00`;
}

function pruneForDailyReset(entries, now = new Date()) {
  const cutoff = resetCutoff(now);
  return (Array.isArray(entries) ? entries : []).filter(entry => {
    return `${entry.date || ''} ${entry.hm || ''}` >= cutoff;
  });
}

function normalizeDate(input, now = new Date()) {
  const raw = String(input || '').trim();
  let year;
  let month;
  let day;
  let yearWasOmitted = false;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    [year, month, day] = raw.split('-').map(Number);
  } else if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(raw)) {
    const parts = raw.split('/').map(Number);
    [month, day] = parts;
    yearWasOmitted = !parts[2];
    year = parts[2]
      ? (parts[2] < 100 ? 2000 + parts[2] : parts[2])
      : Number(easternParts(now).date.slice(0, 4));
  } else {
    throw new Error('Date must be YYYY-MM-DD or MM/DD.');
  }

  function validDate(candidateYear) {
    const check = new Date(Date.UTC(candidateYear, month - 1, day));
    return check.getUTCFullYear() === candidateYear
      && check.getUTCMonth() === month - 1
      && check.getUTCDate() === day;
  }

  if (!validDate(year)) throw new Error('That date is not valid.');
  let result = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (yearWasOmitted && result < easternParts(now).date) {
    year += 1;
    if (!validDate(year)) throw new Error('That date is not valid next year. Include the year explicitly.');
    result = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return result;
}

function normalizeTime(input, ampm) {
  const raw = String(input || '').trim().replace(/\s+/g, '');
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) throw new Error('Time must look like 7, 7:30, 11, or 11:45.');
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = String(ampm || '').toUpperCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59 || !['AM', 'PM'].includes(period)) {
    throw new Error('Enter a valid 12-hour time and choose AM or PM.');
  }
  const display = `${hour}:${String(minute).padStart(2, '0')} ${period}`;
  if (period === 'AM') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  return { display, hm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function normalizeLink(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Stream link must be a complete http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Stream link must use http:// or https://.');
  }
  return parsed.toString();
}

module.exports = {
  ZONE,
  RESET_HOUR,
  easternParts,
  operationalDate,
  resetCutoff,
  pruneForDailyReset,
  normalizeDate,
  normalizeTime,
  normalizeLink,
};
