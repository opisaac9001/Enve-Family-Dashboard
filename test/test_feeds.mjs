import assert from 'node:assert/strict';
import { feedEvents, validateFeedUrl } from '../feeds.js';

const calendar = { id: 'school', name: 'School', profile_id: 'daughter' };
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:weekly
DTSTART;VALUE=DATE:20261005
DTEND;VALUE=DATE:20261006
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Practice
END:VEVENT
END:VCALENDAR`;
assert.deepEqual(
  feedEvents(ics, '2026-10-10', '2026-10-20', calendar).map((event) => event.start),
  ['2026-10-12', '2026-10-19'],
);
assert.throws(() => validateFeedUrl('http://example.com/calendar.ics'));
assert.throws(() => validateFeedUrl('https://127.0.0.1/calendar.ics'));
assert.throws(() => validateFeedUrl('https://user:password@example.com/calendar.ics'));
assert.equal(validateFeedUrl('https://example.com/calendar.ics').hostname, 'example.com');
