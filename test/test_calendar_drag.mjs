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

const navigationCalls = [];
const navigation = vm.createContext({
  loadedRange: { from: '2026-10-11', to: '2026-10-18' },
  state: { section: 'calendar', view: 'day', cursor: new Date('2026-10-13T12:00:00'), data: {} },
  renderedContext: '',
  range: { from: new Date('2026-10-13T12:00:00'), to: new Date('2026-10-14T12:00:00') },
  dateKey: key,
  render: () => navigationCalls.push('render'),
  load: () => navigationCalls.push('load'),
});
navigation.viewRange = () => navigation.range;
vm.runInContext(
  source.slice(
    source.indexOf('function navigateCalendar()'),
    source.indexOf('function weatherLabel('),
  ),
  navigation,
);
navigation.navigateCalendar();
assert.deepEqual(navigationCalls, ['render']);
assert.equal(navigation.renderedContext, JSON.stringify(['calendar', 'day', '2026-10-13']));
navigationCalls.length = 0;
navigation.range.to = new Date('2026-11-01T12:00:00');
navigation.navigateCalendar();
assert.deepEqual(navigationCalls, ['load']);
navigationCalls.length = 0;
navigation.loadedRange = null;
navigation.navigateCalendar();
assert.deepEqual(navigationCalls, ['load']);

let displayWrites = 0;
let displayTime = new Date('2026-10-13T12:00:00').getTime();
let idleTime = 0;
const tracked = (target = {}) =>
  new Proxy(target, {
    set(object, property, value) {
      displayWrites++;
      object[property] = value;
      return true;
    },
  });
const displayNodes = new Map();
const display = vm.createContext({
  Date: class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [displayTime]));
    }
  },
  performance: { now: () => idleTime },
  timeFormat: context.timeFormat,
  displayState: '',
  state: {
    data: {
      settings: {
        theme: 'dark',
        night_dim: 'true',
        light_at: '07:00',
        dark_at: '19:00',
        dim_after_minutes: '1',
        dim_amount: '75',
        sleep_enabled: 'false',
      },
    },
    idleAt: 0,
    photos: [],
    photoIndex: 0,
  },
  document: {
    documentElement: {
      style: {
        setProperty() {
          displayWrites++;
        },
      },
    },
    body: { dataset: tracked() },
  },
  $: (selector) => {
    if (!displayNodes.has(selector))
      displayNodes.set(
        selector,
        tracked({
          style: tracked(),
          dataset: tracked(),
          removeAttribute() {
            displayWrites++;
          },
        }),
      );
    return displayNodes.get(selector);
  },
  scheduleDisplay: () => {},
  updatePhoto: () => {},
});
vm.runInContext(
  source.slice(
    source.indexOf('function applyDisplay()'),
    source.indexOf('function scheduleDisplay()'),
  ),
  display,
);
display.applyDisplay();
const initialWrites = displayWrites;
display.applyDisplay();
assert.equal(displayWrites, initialWrites);
assert.equal(display.document.body.dataset.nightTint, 'true');
idleTime = 61000;
display.applyDisplay();
assert.equal(displayNodes.get('#dim-layer').hidden, false);
display.state.idleAt = idleTime;
display.applyDisplay();
assert.equal(displayNodes.get('#dim-layer').hidden, true);
const wakeWrites = displayWrites;
display.applyDisplay();
assert.equal(displayWrites, wakeWrites);
displayTime += 60000;
display.applyDisplay();
assert.ok(displayWrites > wakeWrites);
display.state.data.settings.theme = 'light';
display.applyDisplay();
assert.equal(display.document.body.dataset.nightTint, 'false');

vm.runInContext(
  source.slice(source.indexOf('const eventTimes ='), source.indexOf('function eventTime(')),
  context,
);
const springDay = new Date('2026-03-08T12:00:00');
assert.equal(
  context.eventOnDay(
    { start: '2026-03-08T05:00:00Z', end: '2026-03-09T04:00:00Z', allDay: false },
    springDay,
  ),
  true,
);
assert.equal(
  context.eventOnDay(
    { start: '2026-03-09T04:00:00Z', end: '2026-03-09T05:00:00Z', allDay: false },
    springDay,
  ),
  false,
);
assert.equal(
  context.eventOnDay(
    { start: '2026-03-07T23:00:00Z', end: '2026-03-08T05:00:00Z', allDay: false },
    springDay,
  ),
  false,
);
assert.equal(
  context.eventOnDay({ start: '2026-03-07', end: '2026-03-09', allDay: true }, springDay),
  true,
);
assert.equal(
  context.eventOnDay({ start: '2026-03-07', end: '2026-03-08', allDay: true }, springDay),
  false,
);

const pointerHandlers = new Map();
const touchHandlers = new Map();
grid.addEventListener = (name, handler) => touchHandlers.set(name, handler);
context.window = {
  PointerEvent: true,
  addEventListener: (name, handler) => pointerHandlers.set(name, handler),
};
context.document.addEventListener = () => {};
context.showToast = () => {};
vm.runInContext(
  source.slice(
    source.indexOf('if (window.PointerEvent)'),
    source.indexOf("$('#edit-event').addEventListener"),
  ),
  context,
);
const finger = { identifier: 7, clientX: 100, clientY: 783 };
touchHandlers.get('pointerdown')({
  target: element,
  pointerType: 'mouse',
  isPrimary: true,
  button: 0,
  clientX: 100,
  clientY: 783,
  pointerId: 7,
});
touchHandlers.get('touchstart')({ target: element, touches: [finger] });
timer();
pointerHandlers.get('pointercancel')({ pointerId: 7 });
assert.equal(vm.runInContext('calendarDrag.input', context), 'touch');
let blockedScroll = false;
const movedFinger = { ...finger, clientX: 200, clientY: 847 };
touchHandlers.get('touchmove')({
  changedTouches: [movedFinger],
  cancelable: true,
  preventDefault() {
    blockedScroll = true;
  },
});
assert.equal(blockedScroll, true);
const savedMoves = calls.length;
touchHandlers.get('touchend')({ changedTouches: [movedFinger] });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.length, savedMoves + 1);
assert.equal(calls.at(-1).payload.start, '2026-03-09T17:00:00.000Z');
assert.equal(vm.runInContext('calendarDrag', context), null);
touchHandlers.get('touchstart')({ target: element, touches: [finger] });
timer();
touchHandlers.get('touchcancel')({ changedTouches: [finger] });
assert.equal(vm.runInContext('calendarDrag', context), null);
assert.equal(calls.length, savedMoves + 1);
