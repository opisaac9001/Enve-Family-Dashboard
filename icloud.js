import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';

export async function iCloudClient(email, password) {
  const { DAVClient } = await import('tsdav');
  const client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com/',
    credentials: { username: email, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    fetchOptions: { signal: AbortSignal.timeout(15000) },
  });
  await client.login({ loadCollections: false });
  return client;
}

export function iCloudCalendarUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/(^|\.)icloud\.com$/.test(url.hostname)) {
    throw new Error('Unexpected iCloud calendar link.');
  }
  return url.href;
}

function eventDates(start, end) {
  return start.isDate
    ? { start: start.toString().slice(0, 10), end: end.toString().slice(0, 10), allDay: true }
    : { start: start.toJSDate().toISOString(), end: end.toJSDate().toISOString(), allDay: false };
}

export function parseICloudObject(object, calendar, from, to) {
  if (!object.data) return [];
  const component = new ICAL.Component(ICAL.parse(object.data));
  const writable = canEditICloudObject(object.data);
  const after = Date.parse(`${from}T00:00:00Z`);
  const before = Date.parse(`${to}T00:00:00Z`);
  const events = [];
  for (const part of component.getAllSubcomponents('vevent')) {
    if (part.getFirstProperty('recurrence-id')) continue;
    const event = new ICAL.Event(part);
    const occurrenceTimes = [];
    if (event.isRecurring()) {
      const iterator = event.iterator();
      let next;
      let count = 0;
      while ((next = iterator.next()) && count++ < 10000) {
        if (next.toJSDate().getTime() >= before) break;
        occurrenceTimes.push(next);
      }
      if (count >= 10000) throw new Error('iCloud event repeats too many times to display.');
    } else occurrenceTimes.push(event.startDate);
    for (const occurrence of occurrenceTimes) {
      const details = event.getOccurrenceDetails(occurrence);
      const dates = eventDates(details.startDate, details.endDate);
      const startMs = dates.allDay
        ? Date.parse(`${dates.start}T00:00:00Z`)
        : Date.parse(dates.start);
      const endMs = dates.allDay ? Date.parse(`${dates.end}T00:00:00Z`) : Date.parse(dates.end);
      if (startMs >= before || endMs <= after) continue;
      events.push({
        id: `icloud:${calendar.id}:${event.uid}:${dates.start}`,
        title: details.item.summary || '(Untitled)',
        ...dates,
        profileId: calendar.profile_id,
        calendarId: calendar.id,
        calendarName: calendar.name,
        objectUrl: object.url,
        notes: details.item.description || '',
        source: 'icloud',
        writable,
      });
    }
  }
  return events;
}

export async function iCloudEvents(client, calendar, from, to) {
  const objects = await client.fetchCalendarObjects({
    calendar: { url: iCloudCalendarUrl(calendar.url) },
    timeRange: { start: `${from}T00:00:00Z`, end: `${to}T00:00:00Z` },
  });
  return objects.flatMap((object) => parseICloudObject(object, calendar, from, to));
}

function icsDate(value, allDay) {
  return allDay
    ? value.replaceAll('-', '')
    : new Date(value)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
}

function icsText(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

export function newICloudObject(event) {
  const uid = `${randomUUID()}@enve-family.local`;
  const start = icsDate(event.start, event.allDay);
  const end = icsDate(event.end, event.allDay);
  const dateType = event.allDay ? ';VALUE=DATE' : '';
  return {
    uid,
    data: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Enve Family//Calendar//EN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${icsDate(new Date().toISOString(), false)}`,
      `DTSTART${dateType}:${start}`,
      `DTEND${dateType}:${end}`,
      `SUMMARY:${icsText(event.title)}`,
      `DESCRIPTION:${icsText(event.notes)}`,
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  };
}

export function canEditICloudObject(data) {
  const component = new ICAL.Component(ICAL.parse(data));
  const parts = component.getAllSubcomponents('vevent');
  if (
    parts.length !== 1 ||
    parts[0].getFirstProperty('rrule') ||
    parts[0].getFirstProperty('recurrence-id')
  )
    return false;
  return !new ICAL.Event(parts[0]).attendees.length;
}

export function updatedICloudObject(data, event) {
  if (!canEditICloudObject(data))
    throw new Error('Edit recurring events and invitations in Apple Calendar.');
  const component = new ICAL.Component(ICAL.parse(data));
  const item = new ICAL.Event(component.getFirstSubcomponent('vevent'));
  item.summary = event.title;
  item.description = event.notes;
  item.startDate = event.allDay
    ? ICAL.Time.fromDateString(event.start)
    : ICAL.Time.fromJSDate(new Date(event.start), true);
  item.endDate = event.allDay
    ? ICAL.Time.fromDateString(event.end)
    : ICAL.Time.fromJSDate(new Date(event.end), true);
  return component.toString();
}
