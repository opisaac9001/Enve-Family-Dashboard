import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

process.env.TZ = 'America/Los_Angeles';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
let now = '2026-10-14T02:00:00Z';
class Clock extends Date {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
}
const nodes = new Map();
const dateButtons = ['all', 'today', 'overdue', 'upcoming', 'undated'].map((taskDate) => ({
  dataset: { taskDate },
  active: false,
  attributes: {},
  classList: {
    toggle(name, active) {
      dateButtons.find((button) => button.classList === this).active = active;
    },
  },
  setAttribute(name, value) {
    this.attributes[name] = value;
  },
}));
const $ = (selector) => {
  if (!nodes.has(selector)) {
    nodes.set(selector, {
      innerHTML: '',
      value: '',
      listeners: {},
      querySelectorAll: () => dateButtons,
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
    });
  }
  return nodes.get(selector);
};
const task = (id, dueDate, completed = false, profileId = 'alex', taskType = 'chore') => ({
  id,
  title: id,
  dueDate,
  completed,
  profileId,
  taskType,
});
const state = {
  taskDate: 'all',
  taskStatus: 'open',
  taskPerson: 'all',
  taskType: 'all',
  data: {
    profiles: [
      { id: 'alex', name: 'Alex' },
      { id: 'sam', name: 'Sam' },
    ],
    tasks: [
      task('yesterday', '2026-10-12'),
      task('today-alex', '2026-10-13'),
      task('today-sam-habit', '2026-10-13', false, 'sam', 'habit'),
      task('tomorrow', '2026-10-14'),
      task('undated', null),
      task('old-done', '2026-10-12', true),
      task('today-done', '2026-10-13', true),
    ],
  },
};
const context = vm.createContext({
  Date: Clock,
  state,
  $,
  escapeHtml: (value) => value,
  renderTaskRow: (task, context) => {
    assert.equal(context, 'page');
    return `[${task.id}]`;
  },
});
vm.runInContext(
  source.slice(source.indexOf('function dateKey('), source.indexOf('\nfunction addDays(')),
  context,
);
vm.runInContext(
  source.slice(source.indexOf('function renderTasksPage('), source.indexOf('\nfunction render()')),
  context,
);
vm.runInContext(
  source.slice(
    source.indexOf("$('#tasks-date-tabs').addEventListener"),
    source.indexOf("document.querySelector('.view-picker').addEventListener"),
  ),
  context,
);
const ids = () => {
  context.renderTasksPage();
  return [...$('#all-task-list').innerHTML.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
};
assert.deepEqual(ids(), ['yesterday', 'today-alex', 'today-sam-habit', 'tomorrow', 'undated']);
assert.equal($('#tasks-open-count').textContent, 5);
assert.equal($('#tasks-due-count').textContent, 3);
assert.equal($('#tasks-done-count').textContent, 2);
const chooseDate = (value) => {
  const button = dateButtons.find((button) => button.dataset.taskDate === value);
  $('#tasks-date-tabs').listeners.click({ target: { closest: () => button } });
  assert.equal(button.active, true);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(dateButtons.filter((button) => button.active).length, 1);
};
chooseDate('today');
assert.deepEqual(
  ids(),
  ['today-alex', 'today-sam-habit'],
  'Today must use the local date, not UTC',
);
$('#tasks-person-filter').listeners.change({ target: { value: 'sam' } });
$('#tasks-type-filter').listeners.change({ target: { value: 'habit' } });
assert.deepEqual(ids(), ['today-sam-habit']);
$('#tasks-type-filter').listeners.change({ target: { value: 'chore' } });
assert.deepEqual(ids(), []);
assert.match($('#all-task-list').innerHTML, /No tasks match/);
state.taskPerson = state.taskType = 'all';
chooseDate('overdue');
assert.deepEqual(ids(), ['yesterday'], 'Completed tasks and undated tasks cannot be overdue');
$('#tasks-status-filter').listeners.change({ target: { value: 'done' } });
assert.deepEqual(ids(), []);
assert.match($('#all-task-list').innerHTML, /Completed tasks aren’t overdue/);
$('#tasks-status-filter').listeners.change({ target: { value: 'all' } });
assert.deepEqual(ids(), ['yesterday']);
chooseDate('today');
assert.deepEqual(ids(), ['today-alex', 'today-sam-habit', 'today-done']);
chooseDate('upcoming');
assert.deepEqual(ids(), ['tomorrow']);
chooseDate('undated');
assert.deepEqual(ids(), ['undated']);
chooseDate('all');
$('#tasks-status-filter').listeners.change({ target: { value: 'done' } });
assert.deepEqual(ids(), ['old-done', 'today-done']);
state.taskStatus = 'open';
chooseDate('today');
now = '2026-10-14T08:00:00Z';
assert.deepEqual(ids(), ['tomorrow'], 'The date filter must advance at local midnight');
chooseDate('overdue');
assert.deepEqual(ids(), ['yesterday', 'today-alex', 'today-sam-habit']);
console.log('Tasks page filter tests passed');
