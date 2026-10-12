import * as chrono from 'chrono-node';
import ICAL from 'ical.js';

function titleNear(text, match) {
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match.text.length);
  const line = `${before.split('\n').at(-1)} ${after.split('\n')[0]}`.replace(/\s+/g, ' ').trim();
  return (line || text.split(/\r?\n/).find((value) => value.trim()) || 'New event').slice(0, 200);
}

function calendarDrafts(text) {
  const calendar = new ICAL.Component(ICAL.parse(text));
  return calendar
    .getAllSubcomponents('vevent')
    .slice(0, 30)
    .map((component) => {
      const event = new ICAL.Event(component);
      const allDay = event.startDate.isDate;
      const start = allDay
        ? event.startDate.toString().slice(0, 10)
        : event.startDate.toJSDate().toISOString();
      const end = allDay
        ? event.endDate.toString().slice(0, 10)
        : event.endDate.toJSDate().toISOString();
      const rule = event.component.getFirstPropertyValue('rrule');
      const frequency = rule?.freq?.toLowerCase();
      const simpleRule =
        rule && !rule.parts?.BYDAY && !rule.parts?.BYMONTHDAY && !rule.parts?.BYMONTH;
      return {
        type: 'event',
        title: (event.summary || 'Untitled event').slice(0, 200),
        start,
        end,
        allDay,
        notes: (event.description || '').slice(0, 2000),
        repeatRule:
          simpleRule && ['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)
            ? frequency
            : 'none',
      };
    });
}

export function importDrafts(source, type, now = new Date()) {
  const text = String(source || '')
    .trim()
    .slice(0, 20000);
  if (!text) throw new Error('Add text or a file to import.');
  if (text.startsWith('BEGIN:VCALENDAR')) {
    if (type !== 'event') throw new Error('Calendar files contain events.');
    const drafts = calendarDrafts(text);
    if (!drafts.length) throw new Error('No events were found in the calendar file.');
    return drafts;
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (type === 'event') {
    const matches = chrono.parse(text, now, { forwardDate: true }).slice(0, 20);
    if (!matches.length) throw new Error('No date was recognized. Include a date and try again.');
    return matches.map((match) => {
      const allDay = !match.start.isCertain('hour');
      const start = match.start.date();
      const end = match.end
        ? new Date(match.end.date().getTime() + (allDay ? 86400000 : 0))
        : new Date(start.getTime() + (allDay ? 86400000 : 3600000));
      return {
        type,
        title: titleNear(text, match),
        start: allDay ? localDate(start) : start.toISOString(),
        end: allDay ? localDate(end) : end.toISOString(),
        allDay,
        notes: text.slice(0, 2000),
        repeatRule: 'none',
      };
    });
  }
  if (type === 'task') {
    const match = chrono.parse(text, now, { forwardDate: true })[0];
    return [
      {
        type,
        title: (match ? titleNear(text, match) : lines[0]).slice(0, 200),
        dueDate: match ? localDate(match.start.date()) : '',
        dueTime: match?.start.isCertain('hour') ? localTime(match.start.date()) : '',
        taskType: 'chore',
      },
    ];
  }
  if (type === 'list') {
    const items = lines
      .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
      .filter((line) => line && !/^(shopping|grocery|list|items):?$/i.test(line))
      .slice(0, 50);
    if (!items.length) throw new Error('No list items were found.');
    return items.map((title) => ({ type, title: title.slice(0, 120) }));
  }
  if (type === 'recipe') {
    const ingredientIndex = lines.findIndex((line) => /^ingredients:?$/i.test(line));
    const directionsIndex = lines.findIndex((line) =>
      /^(directions|instructions|method):?$/i.test(line),
    );
    const start = ingredientIndex >= 0 ? ingredientIndex + 1 : 1;
    const end = directionsIndex >= 0 ? directionsIndex : lines.length;
    const ingredients = lines
      .slice(start, end)
      .map((line) => line.replace(/^[-*•]\s*/, ''))
      .join('\n');
    if (!ingredients) throw new Error('No recipe ingredients were found.');
    return [
      {
        type,
        title: lines[0].slice(0, 120),
        ingredients: ingredients.slice(0, 4000),
        directions:
          directionsIndex >= 0
            ? lines
                .slice(directionsIndex + 1)
                .join('\n')
                .slice(0, 5000)
            : '',
      },
    ];
  }
  throw new Error('Choose an import type.');
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
