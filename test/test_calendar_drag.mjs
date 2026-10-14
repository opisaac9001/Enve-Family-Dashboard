import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

process.env.TZ = 'America/New_York';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const dragHoldMs =');
const end = source.indexOf('\nif (window.PointerEvent)', start);
const calls = [];
const key = (day) =>
  `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
const context = vm.createContext({
  Date,
  Intl,
  Math,
  Number,
  String,
  Object,
  performance,
  dateKey: key,
  addDays: (day, amount) => {
    const next = new Date(day);
    next.setDate(next.getDate() + amount);
    return next;
  },
  dayFormat: new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }),
  timeFormat: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }),
  timelineHourHeight: 64,
  api: async (path, options) => calls.push({ path, payload: JSON.parse(options.body) }),
  load: async () => {},
  showToast: () => {},
  showError: (message) => {
    throw new Error(message);
  },
  chooseSeriesScope: async () => 'occurrence',
  askToDelete: async () => true,
  importDateValue: (day) =>
    `${key(day)}T${String(day.getHours()).padStart(2, '0')}:${String(day.getMinutes()).padStart(2, '0')}`,
});
vm.runInContext(`let calendarDrag = null;\n${source.slice(start, end)}`, context);
const event = {
  source: 'local',
  id: 'event',
  title: 'Lunch',
  profileId: 'alex',
  start: '2026-03-07T17:00:00Z',
  end: '2026-03-07T18:30:00Z',
  allDay: false,
};
const moved = context.movedTimes(event, '2026-03-07', '2026-03-08', null);
assert.equal(moved.start.getHours(), 12);
assert.equal(moved.end - moved.start, 90 * 60000);
const timed = context.movedTimes(event, '2026-03-07', '2026-03-09', 555);
assert.equal(timed.start.getHours(), 9);
assert.equal(timed.start.getMinutes(), 15);
assert.equal(timed.end - timed.start, 90 * 60000);
const allDay = context.movedTimes(
  { allDay: true, start: '2026-03-07', end: '2026-03-10' },
  '2026-03-08',
  '2026-03-10',
  null,
);
assert.equal(allDay.start, '2026-03-09');
assert.equal(allDay.end, '2026-03-12');
assert.match(context.moveBlockReason({ source: 'outlook' }), /read-only/);
assert.match(context.moveBlockReason({ source: 'task', completed: true }), /Finished/);
await context.moveCalendarEvent({ ...event, source: 'task', id: 'task' }, timed);
assert.equal(calls[0].path, '/api/tasks/task');
assert.deepEqual(calls[0].payload, { dueDate: '2026-03-09', dueTime: '09:15' });
await context.moveCalendarEvent(
  {
    ...event,
    id: 'series:2026-03-07',
    seriesId: 'series',
    occurrenceDate: '2026-03-07',
    seriesStart: event.start,
    seriesEnd: event.end,
    timeZone: 'America/New_York',
    repeatRule: 'weekly',
  },
  timed,
);
assert.equal(calls[1].path, '/api/events/series?occurrence=2026-03-07');
assert.equal(calls[1].payload.start, timed.start.toISOString());
assert.equal(calls[1].payload.end, timed.end.toISOString());

const classes = () => ({ add() {}, remove() {}, contains: () => false });
const node = () => ({
  classList: classes(),
  style: { setProperty() {} },
  setAttribute() {},
  remove() {
    this.removed = true;
  },
  querySelector: () => ({ textContent: '' }),
  append() {},
  dataset: {},
});
const origin = {
  ...node(),
  dataset: { timelineDay: '2026-03-07' },
  getBoundingClientRect: () => ({ top: 0 }),
};
const destination = {
  ...node(),
  dataset: { timelineDay: '2026-03-09' },
  getBoundingClientRect: () => ({ top: 0 }),
};
const element = {
  ...node(),
  dataset: { event: 'event' },
  closest: (selector) => (selector.includes('timeline-day') ? origin : element),
};
const grid = { ...node(), contains: () => true, hasPointerCapture: () => false };
let timer;
Object.assign(context, {
  state: {
    section: 'calendar',
    view: 'week',
    data: { events: [event], tasks: [] },
    offline: false,
  },
  document: {
    elementFromPoint: () => ({ closest: () => destination }),
    createElement: node,
    body: { append() {} },
  },
  $: (selector) => (selector === '#week-grid' ? grid : null),
  setTimeout: (callback) => {
    timer = callback;
    return 1;
  },
  clearTimeout: () => {
    timer = null;
  },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  navigator: {},
  eventColor: () => '#F5921A',
  escapeHtml: (text) => text,
  timelineScroller: () => null,
});
vm.runInContext('let dragReloadPending = false;', context);
context.beginCalendarPress(element, 100, 783, 1);
context.moveCalendarPress(115, 783);
assert.equal(timer, null, 'Moving before the hold cancels the gesture');
assert.equal(vm.runInContext('calendarDrag', context), null);
context.beginCalendarPress(element, 100, 783, 1);
timer();
context.moveCalendarPress(200, 847);
context.endCalendarPress(200, 847);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.at(-1).path, '/api/events/event');
assert.equal(calls.at(-1).payload.start, '2026-03-09T17:00:00.000Z');
assert.equal(calls.at(-1).payload.end, '2026-03-09T18:30:00.000Z');
assert.equal(vm.runInContext('calendarDrag', context), null);
assert.ok(vm.runInContext('suppressClickUntil', context) > performance.now());
