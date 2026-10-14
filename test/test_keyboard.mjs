import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.attributes = new Map();
    this.classList = new Set();
    this.classList.remove = this.classList.delete.bind(this.classList);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append(...children) {
    for (const child of children) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren() {
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  contains(element) {
    return element === this || this.children.some((child) => child.contains(element));
  }
  closest(tagName) {
    return this.tagName === tagName ? this : this.parent?.closest(tagName);
  }
  dispatchEvent(event) {
    const path = [];
    for (let element = this; element; element = element.parent) path.push(element);
    event.target = this;
    event.composedPath = () => path;
    event.preventDefault = () => {};
    for (const element of path) {
      for (const listener of element.listeners.get(event.type) || []) listener(event);
    }
  }
}
class Input extends Element {
  constructor() {
    super('input');
    this.type = 'text';
    this.value = '';
    this.selectionStart = this.selectionEnd = 0;
    this.isConnected = true;
  }
  setRangeText(value, start, end) {
    this.value = this.value.slice(0, start) + value + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + value.length;
  }
  focus() {
    this.dispatchEvent({ type: 'focusin' });
  }
  blur() {}
  scrollIntoView() {}
}
const document = new Element('document');
document.body = new Element('body');
document.documentElement = new Element('html');
document.createElement = (tagName) => new Element(tagName);
document.append(document.body);
const context = vm.createContext({
  document,
  window: { PointerEvent: class {}, addEventListener() {} },
  location: { search: '?kiosk=1' },
  localStorage: { getItem: () => null, setItem() {} },
  URLSearchParams,
  HTMLInputElement: Input,
  HTMLTextAreaElement: class extends Input {},
  Event: class {
    constructor(type) {
      this.type = type;
    }
  },
  setTimeout() {},
  clearTimeout() {},
});
vm.runInContext(
  await readFile(new URL('../public/onscreen-keyboard.js', import.meta.url), 'utf8'),
  context,
);
const keyboard = document.body.children[0];
const dialog = new Element('dialog');
const input = new Input();
document.body.append(dialog);
dialog.append(input);
let inputEvents = 0;
input.addEventListener('input', () => inputEvents++);
input.focus();
assert.equal(keyboard.parent, dialog);
const findKey = (label) =>
  keyboard.children.flatMap((row) => row.children).find((key) => key.textContent === label);
const tap = (label) => {
  const button = findKey(label);
  assert.ok(button, `Missing key ${label}`);
  button.dispatchEvent({ type: 'pointerdown' });
  button.dispatchEvent({ type: 'click' });
};
tap('q');
assert.equal(input.value, 'q');
assert.equal(inputEvents, 1, 'A pointer tap must insert only once');
assert.equal(keyboard.hidden, false);
const firstRow = keyboard.children[0];
input.focus();
assert.equal(
  keyboard.children[0],
  firstRow,
  'Refocusing the same input must not redraw the keyboard',
);
tap('⇧');
assert.equal(keyboard.hidden, false, 'Shift must remain open after replacing the pressed button');
assert.equal(findKey('⇧').attributes.get('aria-pressed'), 'true');
tap('A');
assert.equal(input.value, 'qA');
assert.equal(keyboard.hidden, false, 'Resetting Shift must not dismiss the keyboard');
assert.equal(findKey('⇧').attributes.get('aria-pressed'), 'false');
tap('?123');
assert.equal(keyboard.hidden, false, 'Switching to symbols must not dismiss the keyboard');
tap('@');
tap('ABC');
assert.equal(keyboard.hidden, false);
tap('z');
tap('⌫');
assert.equal(input.value, 'qA@');
findKey('a').dispatchEvent({ type: 'click' });
assert.equal(input.value, 'qA@a', 'Keyboard activation without a pointer must work');
const second = new Input();
dialog.append(second);
second.focus();
tap('w');
assert.equal(second.value, 'w');
assert.equal(input.value, 'qA@a');
tap('Done');
assert.equal(keyboard.hidden, true);
assert.equal(document.body.classList.has('enve-keyboard-open'), false);
input.focus();
const outside = new Element('button');
dialog.append(outside);
outside.dispatchEvent({ type: 'pointerdown' });
assert.equal(keyboard.hidden, true, 'An outside tap must still dismiss the keyboard');
console.log('On-screen keyboard interaction tests passed');
