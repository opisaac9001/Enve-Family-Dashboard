import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import ICAL from 'ical.js';

function publicAddress(address) {
  const parts = address.split('.').map(Number);
  const [a, b] = parts;
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    a !== 169 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 0 || b === 88 || b === 168)) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
    !(a === 203 && b === 0 && parts[2] === 113)
  );
}

export function validateFeedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid calendar URL.');
  }
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    isIP(url.hostname) ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.local')
  ) {
    throw new Error('Calendar URLs must use public HTTPS addresses.');
  }
  return url;
}

export async function fetchFeed(value, redirects = 0) {
  const url = validateFeedUrl(value);
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some((result) => !publicAddress(result.address))) {
    throw new Error('Calendar URL does not resolve to a public address.');
  }
  const address = addresses[0].address;
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { lookup: (_host, _options, callback) => callback(null, address, 4), timeout: 12000 },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          response.resume();
          if (!location || redirects >= 3)
            return reject(new Error('Calendar URL redirected too many times.'));
          fetchFeed(new URL(location, url).toString(), redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error('Calendar feed could not be loaded.'));
        }
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
          if (text.length > 2_000_000) request.destroy(new Error('Calendar feed is too large.'));
        });
        response.on('end', () => resolve(text));
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error('Calendar feed timed out.')));
    request.on('error', reject);
  });
}

export function feedEvents(text, from, to, calendar) {
  const component = new ICAL.Component(ICAL.parse(text));
  if (component.name !== 'vcalendar')
    throw new Error('Calendar URL did not return an iCalendar file.');
  const events = [];
  for (const item of component.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(item);
    if (event.isRecurrenceException() || item.getFirstPropertyValue('status') === 'CANCELLED')
      continue;
    const iterator = event.iterator();
    let count = 0;
    let occurrence;
    while (count++ < 10000 && (occurrence = iterator.next())) {
      const detail = event.getOccurrenceDetails(occurrence);
      const start = detail.startDate.isDate
        ? detail.startDate.toString().slice(0, 10)
        : detail.startDate.toJSDate().toISOString();
      const end = detail.endDate.isDate
        ? detail.endDate.toString().slice(0, 10)
        : detail.endDate.toJSDate().toISOString();
      if (start >= to) break;
      if (end <= from || detail.item.component.getFirstPropertyValue('status') === 'CANCELLED')
        continue;
      events.push({
        id: `feed:${calendar.id}:${event.uid}:${occurrence.toString()}`,
        title: detail.item.summary || '(Untitled)',
        start,
        end,
        allDay: detail.startDate.isDate,
        profileId: calendar.profile_id,
        notes: detail.item.description || '',
        source: 'feed',
        calendarName: calendar.name,
      });
      if (events.length >= 1000) break;
    }
  }
  return events;
}
