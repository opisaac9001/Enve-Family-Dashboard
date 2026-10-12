import { Temporal } from '@js-temporal/polyfill';

const increments = {
  daily: (index) => ({ days: index }),
  weekly: (index) => ({ days: index * 7 }),
  monthly: (index) => ({ months: index }),
  yearly: (index) => ({ years: index }),
};

export function recurrenceFields(input, event) {
  const rule = input.repeatRule || 'none';
  if (!['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(rule))
    throw new Error('Choose a repeat schedule.');
  if (rule === 'none')
    return {
      repeatRule: 'none',
      repeatUntil: null,
      timeZone: null,
      localStart: null,
      localEnd: null,
    };

  const repeatUntil = input.repeatUntil || null;
  const localStart = event.allDay ? event.start : String(input.localStart || '');
  const localEnd = event.allDay ? event.end : String(input.localEnd || '');
  const startDate = Temporal.PlainDate.from(localStart.slice(0, 10));
  if (
    repeatUntil &&
    Temporal.PlainDate.compare(Temporal.PlainDate.from(repeatUntil), startDate) < 0
  ) {
    throw new Error('Repeat end must be on or after the first event.');
  }
  const timeZone = event.allDay ? null : String(input.timeZone || '');
  if (
    event.allDay &&
    Temporal.PlainDate.from(localStart).until(Temporal.PlainDate.from(localEnd), {
      largestUnit: 'days',
    }).days > 31
  ) {
    throw new Error('A repeating event can span at most 31 days.');
  }
  if (!event.allDay) {
    const first = Temporal.PlainDateTime.from(localStart);
    const last = Temporal.PlainDateTime.from(localEnd);
    if (Temporal.PlainDateTime.compare(last, first) <= 0) throw new Error('End must follow start.');
    if (first.until(last, { largestUnit: 'days' }).days > 31)
      throw new Error('A repeating event can span at most 31 days.');
    const zonedStart = first.toZonedDateTime(timeZone);
    const zonedEnd = last.toZonedDateTime(timeZone);
    if (
      zonedStart.epochMilliseconds !== Date.parse(event.start) ||
      zonedEnd.epochMilliseconds !== Date.parse(event.end)
    ) {
      throw new Error('Event time zone does not match the entered time.');
    }
  }
  return { repeatRule: rule, repeatUntil, timeZone, localStart, localEnd };
}

function firstIndex(rule, startDate, fromDate, spanDays) {
  if (Temporal.PlainDate.compare(fromDate, startDate) <= 0) return 0;
  const lookback = fromDate.subtract({ days: spanDays + 2 });
  const days = startDate.until(lookback, { largestUnit: 'days' }).days;
  if (rule === 'daily') return Math.max(0, days);
  if (rule === 'weekly') return Math.max(0, Math.floor(days / 7));
  if (rule === 'monthly')
    return Math.max(0, (lookback.year - startDate.year) * 12 + lookback.month - startDate.month);
  return Math.max(0, lookback.year - startDate.year);
}

export function expandLocalEvent(row, from, to, exceptions = []) {
  const base = {
    title: row.title,
    profileId: row.profile_id,
    notes: row.notes,
    allDay: Boolean(row.all_day),
    source: 'local',
  };
  if (row.repeat_rule === 'none') {
    return row.start < to && row.end > from
      ? [{ id: row.id, ...base, start: row.start, end: row.end }]
      : [];
  }
  const startPlain = base.allDay
    ? Temporal.PlainDate.from(row.local_start)
    : Temporal.PlainDateTime.from(row.local_start);
  const endPlain = base.allDay
    ? Temporal.PlainDate.from(row.local_end)
    : Temporal.PlainDateTime.from(row.local_end);
  const duration = startPlain.until(endPlain, { largestUnit: 'days' });
  const startDate = Temporal.PlainDate.from(row.local_start.slice(0, 10));
  const fromDate = Temporal.PlainDate.from(from);
  const toDate = Temporal.PlainDate.from(to);
  const untilDate = row.repeat_until ? Temporal.PlainDate.from(row.repeat_until) : null;
  const byDate = new Map(exceptions.map((item) => [item.occurrence_date, item]));
  const events = [];
  const processed = new Set();
  let index = firstIndex(row.repeat_rule, startDate, fromDate, duration.days);
  for (let checked = 0; checked < 100; checked++, index++) {
    const occurrenceStart = startPlain.add(increments[row.repeat_rule](index));
    const date = base.allDay ? occurrenceStart : occurrenceStart.toPlainDate();
    if (
      Temporal.PlainDate.compare(date, toDate) >= 0 ||
      (untilDate && Temporal.PlainDate.compare(date, untilDate) > 0)
    )
      break;
    const occurrenceEnd = occurrenceStart.add(duration);
    const start = base.allDay
      ? date.toString()
      : occurrenceStart.toZonedDateTime(row.time_zone).toInstant().toString();
    const end = base.allDay
      ? occurrenceEnd.toString()
      : occurrenceEnd.toZonedDateTime(row.time_zone).toInstant().toString();
    const exception = byDate.get(date.toString());
    processed.add(date.toString());
    if (exception?.deleted) continue;
    const item = exception?.payload ? JSON.parse(exception.payload) : { ...base, start, end };
    if (item.start < to && item.end > from) {
      events.push({
        ...item,
        id: `${row.id}:${date}`,
        source: 'local',
        seriesId: row.id,
        occurrenceDate: date.toString(),
        repeatRule: row.repeat_rule,
        repeatUntil: row.repeat_until,
        seriesStart: row.start,
        seriesEnd: row.end,
        timeZone: row.time_zone,
        localStart: row.local_start,
        localEnd: row.local_end,
      });
    }
  }
  for (const exception of exceptions) {
    if (processed.has(exception.occurrence_date) || exception.deleted || !exception.payload)
      continue;
    const item = JSON.parse(exception.payload);
    if (item.start < to && item.end > from) {
      events.push({
        ...item,
        id: `${row.id}:${exception.occurrence_date}`,
        source: 'local',
        seriesId: row.id,
        occurrenceDate: exception.occurrence_date,
        repeatRule: row.repeat_rule,
        repeatUntil: row.repeat_until,
        seriesStart: row.start,
        seriesEnd: row.end,
        timeZone: row.time_zone,
        localStart: row.local_start,
        localEnd: row.local_end,
      });
    }
  }
  return events;
}
