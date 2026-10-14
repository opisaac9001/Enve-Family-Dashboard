const kioskKeyboardEnabled =
  new URLSearchParams(location.search).has('kiosk') || localStorage.getItem('enve-kiosk') === '1';
if (new URLSearchParams(location.search).has('kiosk')) localStorage.setItem('enve-kiosk', '1');

if (kioskKeyboardEnabled) {
  let cursorTimer;
  const hideCursor = () => {
    clearTimeout(cursorTimer);
    document.documentElement.classList.add('cursor-idle');
  };
  const showCursor = () => {
    document.documentElement.classList.remove('cursor-idle');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(hideCursor, 2000);
  };

  hideCursor();
  if (window.PointerEvent) {
    window.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerType === 'mouse') showCursor();
        else hideCursor();
      },
      { capture: true },
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'mouse') hideCursor();
      },
      { capture: true },
    );
    window.addEventListener('touchstart', hideCursor, { capture: true, passive: true });
  } else {
    window.addEventListener('mousemove', showCursor, { capture: true });
    window.addEventListener('touchstart', hideCursor, { capture: true, passive: true });
  }

  const keyboard = document.createElement('div');
  keyboard.className = 'enve-keyboard';
  keyboard.hidden = true;
  keyboard.setAttribute('role', 'group');
  keyboard.setAttribute('aria-label', 'On-screen keyboard');
  document.body.append(keyboard);
  let target = null;
  let shifted = false;
  let symbols = false;

  function editable(element) {
    return (
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement &&
        ![
          'checkbox',
          'radio',
          'color',
          'file',
          'range',
          'date',
          'time',
          'datetime-local',
          'hidden',
          'button',
          'submit',
        ].includes(element.type) &&
        !element.readOnly &&
        !element.disabled)
    );
  }

  function key(label, value, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.setAttribute('aria-label', label === '⌫' ? 'Backspace' : label);
    let pressedByPointer = false;
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      pressedByPointer = true;
      press(value);
    });
    button.addEventListener('click', () => {
      if (!pressedByPointer) press(value);
      pressedByPointer = false;
    });
    return button;
  }

  function render() {
    const rows = symbols
      ? ['1234567890', '@#&-_/.:;!', '\'"()$%*+=?']
      : ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    keyboard.replaceChildren();
    for (let index = 0; index < rows.length; index++) {
      const row = document.createElement('div');
      row.className = 'enve-keyboard-row';
      if (index === rows.length - 1) {
        const shift = key('⇧', 'shift', 'special');
        shift.setAttribute('aria-label', 'Shift');
        shift.setAttribute('aria-pressed', String(shifted));
        row.append(shift);
      }
      for (const character of rows[index]) {
        const value = shifted ? character.toUpperCase() : character;
        row.append(key(value, value));
      }
      if (index === rows.length - 1) row.append(key('⌫', 'backspace', 'special'));
      keyboard.append(row);
    }
    const actions = document.createElement('div');
    actions.className = 'enve-keyboard-row';
    actions.append(
      key(symbols ? 'ABC' : '?123', 'symbols', 'special'),
      key(',', ','),
      key('Space', ' ', 'space'),
      key('.', '.'),
      key('Done', 'done', 'done'),
    );
    keyboard.append(actions);
  }

  function press(value) {
    if (!target || !target.isConnected) return;
    if (value === 'done') {
      keyboard.hidden = true;
      document.body.classList.remove('enve-keyboard-open');
      target.blur();
      target = null;
      return;
    }
    if (value === 'shift') {
      shifted = !shifted;
      render();
      return;
    }
    if (value === 'symbols') {
      symbols = !symbols;
      render();
      return;
    }
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const from = value === 'backspace' && start === end ? Math.max(0, start - 1) : start;
    const insertion = value === 'backspace' ? '' : value;
    if (target.selectionStart === null) {
      target.value = `${target.value.slice(0, from)}${insertion}${target.value.slice(end)}`;
    } else target.setRangeText(insertion, from, end, 'end');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    if (shifted && value.length === 1) {
      shifted = false;
      render();
    }
  }

  document.addEventListener('focusin', (event) => {
    if (!editable(event.target)) return;
    if (event.target === target && !keyboard.hidden) return;
    target = event.target;
    (target.closest('dialog') || document.body).append(keyboard);
    keyboard.hidden = false;
    document.body.classList.add('enve-keyboard-open');
    render();
    setTimeout(() => target?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  });
  document.addEventListener('pointerdown', (event) => {
    if (keyboard.hidden || event.composedPath().includes(keyboard) || event.target === target)
      return;
    if (!editable(event.target)) {
      keyboard.hidden = true;
      document.body.classList.remove('enve-keyboard-open');
      target = null;
    }
  });
}
