import assert from 'node:assert/strict';
import { expandLocalEvent, recurrenceFields } from '../recurrence.js';

const timed = {
  title: 'Practice',
  start: '2026-03-07T17:00:00.000Z',
  end: '2026-03-07T18:00:00.000Z',
  allDay: false,
};
const fields = recurrenceFields(
  {
    repeatRule: 'daily',
    timeZone: 'America/Los_Angeles',
    localStart: '2026-03-07T09:00',
    localEnd: '2026-03-07T10:00',
  },
  timed,
);
const row = {
  id: 'series',
  title: timed.title,
  start: timed.start,
  end: timed.end,
  profile_id: 'family',
  notes: '',
  all_day: 0,
  repeat_rule: fields.repeatRule,
  repeat_until: null,
  time_zone: fields.timeZone,
  local_start: fields.localStart,
  local_end: fields.localEnd,
};
const daily = expandLocalEvent(row, '2026-03-07', '2026-03-10');
assert.deepEqual(
  daily.map((item) => item.start),
  ['2026-03-07T17:00:00Z', '2026-03-08T16:00:00Z', '2026-03-09T16:00:00Z'],
);
assert.equal(daily[1].occurrenceDate, '2026-03-08');

const monthly = {
  ...row,
  start: '2026-01-31',
  end: '2026-02-01',
  all_day: 1,
  repeat_rule: 'monthly',
  local_start: '2026-01-31',
  local_end: '2026-02-01',
  time_zone: null,
};
assert.deepEqual(
  expandLocalEvent(monthly, '2026-02-01', '2026-04-02').map((item) => item.start),
  ['2026-02-28', '2026-03-31'],
);

const moved = {
  event_id: 'series',
  occurrence_date: '2026-03-08',
  deleted: 0,
  payload: JSON.stringify({
    title: 'Moved practice',
    profileId: 'family',
    notes: '',
    allDay: false,
    start: '2026-03-11T16:00:00Z',
    end: '2026-03-11T17:00:00Z',
  }),
};
assert.deepEqual(
  expandLocalEvent(row, '2026-03-11', '2026-03-12', [moved])
    .filter((item) => item.title === 'Moved practice')
    .map((item) => item.occurrenceDate),
  ['2026-03-08'],
);
assert.equal(
  expandLocalEvent(row, '2026-03-08', '2026-03-09', [
    { event_id: 'series', occurrence_date: '2026-03-08', deleted: 1, payload: null },
  ]).length,
  0,
);
