import assert from 'node:assert/strict';
import {
  canEditICloudObject,
  iCloudCalendarUrl,
  newICloudObject,
  parseICloudObject,
  updatedICloudObject,
} from '../icloud.js';

const calendar = { id: 'icloud-test', profile_id: 'family', name: 'Family' };
const event = {
  title: 'Family picnic',
  start: '2026-10-05',
  end: '2026-10-06',
  allDay: true,
  notes: 'Bring lunch',
};
const created = newICloudObject(event);
const object = { data: created.data, url: 'https://p45-caldav.icloud.com/calendar/picnic.ics' };
const displayed = parseICloudObject(object, calendar, '2026-10-04', '2026-10-11');
assert.equal(displayed.length, 1);
assert.equal(displayed[0].title, event.title);
assert.equal(displayed[0].end, event.end);
assert.equal(displayed[0].writable, true);
assert.equal(parseICloudObject(object, calendar, '2026-10-06', '2026-10-11').length, 0);
const revised = updatedICloudObject(created.data, { ...event, title: 'Family brunch' });
const detailed = newICloudObject({ ...event, notes: 'Family instructions '.repeat(250) });
const movedOnly = updatedICloudObject(
  detailed.data,
  {
    ...event,
    title: 'Stale title',
    notes: 'Truncated notes',
    start: '2026-10-07',
    end: '2026-10-08',
  },
  { moveOnly: true },
);
const movedEvent = parseICloudObject(
  { ...object, data: movedOnly },
  calendar,
  '2026-10-04',
  '2026-10-11',
)[0];
assert.equal(movedEvent.title, event.title);
assert.equal(movedEvent.notes, 'Family instructions '.repeat(250));
assert.equal(movedEvent.start, '2026-10-07');
assert.equal(
  parseICloudObject({ ...object, data: revised }, calendar, '2026-10-04', '2026-10-11')[0].title,
  'Family brunch',
);

const recurring = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:daily-test',
  'DTSTART;VALUE=DATE:20261005',
  'DTEND;VALUE=DATE:20261006',
  'RRULE:FREQ=DAILY;COUNT=3',
  'EXDATE;VALUE=DATE:20261006',
  'SUMMARY:Daily',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');
const occurrences = parseICloudObject(
  { ...object, data: recurring },
  calendar,
  '2026-10-04',
  '2026-10-11',
);
assert.deepEqual(
  occurrences.map((item) => item.start),
  ['2026-10-05', '2026-10-07'],
);
assert.equal(occurrences[0].writable, false);
assert.equal(canEditICloudObject(recurring), false);
assert.throws(() => iCloudCalendarUrl('https://example.com/calendar.ics'));
