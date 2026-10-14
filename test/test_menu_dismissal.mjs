import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf(
  'document.addEventListener(\n',
  source.indexOf("$('#next-week').addEventListener"),
);
const end = source.indexOf("\n$('#app').addEventListener", start);
const input = {};
const more = { open: true, contains: (element) => element === input };
const search = { open: true, contains: (element) => element === input };
const menus = [more, search];
const handlers = new Map();
const document = {
  activeElement: input,
  querySelectorAll: (selector) => {
    assert.equal(selector, '.menu-disclosure[open]');
    return menus.filter((menu) => menu.open);
  },
  addEventListener(type, handler, options) {
    assert.equal(options.capture, true, 'Dismiss before the tapped control redraws the page');
    handlers.set(type, handler);
  },
};
vm.runInNewContext(source.slice(start, end), { document });
const tap = (path) => {
  const event = { composedPath: () => path };
  handlers.get('pointerdown')(event);
  assert.equal(event.defaultPrevented, undefined, 'Outside taps must still activate their control');
};
tap([input, search, more]);
assert.equal(more.open, true);
assert.equal(search.open, true);
const keyboard = { classList: { contains: (name) => name === 'enve-keyboard' } };
tap([{}, keyboard]);
assert.equal(more.open, true, 'Typing in menu search must keep the menu open');
assert.equal(search.open, true);
tap([{}, more]);
assert.equal(more.open, true, 'Tapping inside More must keep it open');
assert.equal(search.open, false, 'Tapping outside the nested search closes that panel');
tap([{}]);
assert.equal(more.open, false, 'An outside mouse or touch press must close More');
more.open = true;
document.activeElement = {};
tap([{}, keyboard]);
assert.equal(more.open, false, 'A keyboard for an unrelated field is outside the menu');
more.open = true;
tap([{}, more]);
assert.equal(more.open, true, 'The summary keeps its native open/close toggle');
console.log('Menu dismissal tests passed');
