const $ = (selector) => document.querySelector(selector);
const state = {
  data: null,
  cursor: new Date(),
  view: 'week',
  section: 'calendar',
  settingsGroup: 'calendars',
  taskStatus: 'open',
  taskPerson: 'all',
  taskType: 'all',
  hiddenProfiles: new Set(),
  entryType: 'event',
  editingEvent: null,
  editingScope: 'series',
  editingRecipe: null,
  recipeServings: new Map(),
  recipeScaled: new Map(),
  mealSuggestions: [],
  importDrafts: [],
  idleAt: Date.now(),
  sleepOverrideUntil: 0,
  todayKey: dateKey(new Date()),
  selectedEvent: null,
  searchResults: [],
  searchRequest: 0,
  reminderData: null,
  reminderQueue: [],
  shownReminders: new Set(
    (sessionStorage.getItem('enve-reminders') || '').split('|').filter(Boolean),
  ),
  photos: [],
  photoIndex: 0,
  photoPreview: false,
  dimPreview: null,
  editingMeal: null,
  offline: false,
  updatedAt: 0,
  flushing: false,
  timelineKey: null,
};
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
let unlockPromise = null;
let changeStream = null;
let celebrationTimeout = null;
let selectedWifi = null;
const pendingRequests = new Set();
const snapshotKey = 'enve-offline-state';
const outboxKey = 'enve-outbox';

function connectChanges() {
  if (changeStream || !window.EventSource) return;
  changeStream = new EventSource('/api/changes');
  changeStream.onmessage = () => {
    if (!document.hidden) load();
  };
}

async function loadWifiSettings() {
  const section = $('#wifi-settings');
  const list = $('#wifi-settings-networks');
  const message = $('#wifi-settings-message');
  const scan = $('#wifi-settings-scan');
  scan.disabled = true;
  list.replaceChildren();
  selectedWifi = null;
  $('#wifi-settings-password-field').hidden = true;
  message.textContent = 'Looking for nearby networks…';
  try {
    const response = await fetch('/api/wifi/networks');
    if (response.status === 403) {
      section.hidden = true;
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not scan Wi-Fi.');
    section.hidden = !result.available;
    if (!result.available) return;
    message.textContent = result.networks.length
      ? 'Choose a network.'
      : 'No networks found. Try scanning again.';
    for (const network of result.networks) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wifi-network';
      button.disabled = network.security === 'unsupported';
      const name = document.createElement('strong');
      name.textContent = network.ssid;
      const detail = document.createElement('span');
      detail.textContent = network.connected
        ? 'Connected'
        : network.security === 'unsupported'
          ? 'Unsupported security'
          : `${network.security === 'open' ? 'Open' : 'Password needed'} · ${network.signal}% signal`;
      button.append(name, detail);
      button.addEventListener('click', () => {
        list.querySelectorAll('button').forEach((item) => item.classList.remove('selected'));
        button.classList.add('selected');
        selectedWifi = network;
        const field = $('#wifi-settings-password-field');
        field.hidden = network.connected;
        const password = $('#wifi-settings-password');
        password.value = '';
        password.required = network.security === 'personal';
        password.closest('label').hidden = network.security === 'open';
        if (network.connected) message.textContent = `Already connected to ${network.ssid}.`;
        else if (network.security === 'personal') password.focus();
      });
      list.append(button);
    }
  } catch (cause) {
    section.hidden = false;
    message.textContent = cause.message;
  } finally {
    scan.disabled = false;
  }
}

$('#wifi-settings-scan').addEventListener('click', loadWifiSettings);
$('#wifi-settings-connect').addEventListener('click', async () => {
  if (!selectedWifi) return;
  const password = $('#wifi-settings-password');
  if (selectedWifi.security === 'personal' && !password.reportValidity()) return;
  const connect = $('#wifi-settings-connect');
  connect.disabled = true;
  $('#wifi-settings-message').textContent = `Connecting to ${selectedWifi.ssid}…`;
  try {
    const response = await fetch('/api/wifi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: selectedWifi.ssid, password: password.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not connect to Wi-Fi.');
    password.value = '';
    await loadWifiSettings();
    $('#wifi-settings-message').textContent = `Connected to ${result.ssid}.`;
  } catch (cause) {
    $('#wifi-settings-message').textContent = cause.message;
  } finally {
    connect.disabled = false;
  }
});

let tailscaleRefreshTimer;

function renderTailscaleSettings(status) {
  const message = $('#tailscale-message');
  $('#tailscale-setup').hidden = false;
  $('#tailscale-install').hidden = status.installed;
  $('#tailscale-operator-command').textContent = status.operatorCommand || '';
  $('#tailscale-login').hidden =
    !status.installed || status.connected || status.state === 'Unavailable';
  $('#tailscale-serve').hidden = !status.connected || status.serving || status.conflict;
  $('#tailscale-https-help').hidden = !status.connected || status.serving;
  $('#tailscale-conflict').hidden = !status.conflict || !!status.message;
  $('#tailscale-address').hidden = !status.serving || !status.url;
  $('#tailscale-auth').hidden = !status.loginUrl || status.connected;
  $('#tailscale-qr').hidden = !status.loginQr || status.connected;
  $('#tailscale-permission').hidden = true;
  if (status.loginUrl && !status.connected) {
    $('#tailscale-auth-link').href = status.loginUrl;
    $('#tailscale-auth-link').textContent = status.loginUrl;
    if (status.loginQr) $('#tailscale-qr').src = status.loginQr;
  }
  if (status.url) {
    $('#tailscale-address-link').href = status.url;
    $('#tailscale-address-link').textContent = status.url;
  }
  message.textContent =
    status.message ||
    (status.serving
      ? 'Enve is available privately through Tailscale.'
      : status.connected
        ? 'This device is connected to Tailscale. Enable private access to get an Enve address.'
        : status.loginUrl
          ? 'Waiting for you to approve this device in Tailscale.'
          : status.installed
            ? 'Tailscale is installed. Connect this device to continue.'
            : 'Tailscale is not installed on this device.');
  clearTimeout(tailscaleRefreshTimer);
  if (status.loginUrl && !status.connected && $('#settings-dialog').open)
    tailscaleRefreshTimer = setTimeout(loadTailscaleSettings, 4000);
}

async function loadTailscaleSettings() {
  try {
    const response = await fetch('/api/tailscale/status');
    if (response.status === 403) {
      $('#tailscale-settings').hidden = true;
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check Tailscale.');
    $('#tailscale-settings').hidden = false;
    renderTailscaleSettings(result);
  } catch (cause) {
    $('#tailscale-message').textContent = cause.message;
  }
}

async function changeTailscale(path, method, button) {
  button.disabled = true;
  $('#tailscale-message').textContent = 'Updating private access…';
  try {
    const result = await api(path, { method });
    renderTailscaleSettings(result);
  } catch (cause) {
    $('#tailscale-message').textContent = cause.message;
    if (cause.message.includes('operator permission')) $('#tailscale-permission').hidden = false;
  } finally {
    button.disabled = false;
  }
}

$('#tailscale-refresh').addEventListener('click', loadTailscaleSettings);
$('#tailscale-login').addEventListener('click', (event) =>
  changeTailscale('/api/tailscale/login', 'POST', event.currentTarget),
);
$('#tailscale-serve').addEventListener('click', (event) =>
  changeTailscale('/api/tailscale/serve', 'POST', event.currentTarget),
);
$('#tailscale-disable').addEventListener('click', (event) =>
  changeTailscale('/api/tailscale/serve', 'DELETE', event.currentTarget),
);
$('#tailscale-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#tailscale-address-link').href);
    $('#tailscale-message').textContent = 'Address copied. Paste it into the Enve iPhone app.';
  } catch {
    $('#tailscale-message').textContent =
      'Select the address above to copy it into the Enve iPhone app.';
  }
});

function promptUnlock() {
  if (unlockPromise) return unlockPromise;
  $('#pin-error').textContent = '';
  $('#pin-entry').value = '';
  $('#pin-dialog').showModal();
  $('#pin-entry').focus();
  unlockPromise = new Promise((resolve) => {
    $('#pin-dialog').onclose = () => {
      unlockPromise = null;
      resolve(false);
    };
    $('#pin-form').onsubmit = async (event) => {
      event.preventDefault();
      const response = await fetch('/api/pin/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: $('#pin-entry').value }),
      });
      const result = await response.json();
      if (!response.ok) {
        $('#pin-error').textContent = result.error;
        return;
      }
      $('#pin-dialog').onclose = null;
      $('#pin-dialog').close();
      unlockPromise = null;
      resolve(true);
      loadPinStatus();
    };
  });
  return unlockPromise;
}

async function loadPinStatus() {
  try {
    const status = await api('/api/pin');
    $('#pin-status').textContent = status.enabled
      ? status.unlocked
        ? 'PIN is on · edits unlocked for 15 minutes'
        : 'PIN is on · edits locked'
      : 'PIN is off';
    $('#pin-remove').hidden = !status.enabled;
    $('#pin-save').textContent = status.enabled ? 'Change PIN' : 'Set PIN';
  } catch (error) {
    $('#pin-status').textContent = error.offline ? 'PIN status unavailable offline' : error.message;
  }
}

function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(date, count) {
  const result = new Date(date);
  result.setDate(result.getDate() + count);
  return result;
}

function startOfWeek(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function eventColor(event) {
  return /^#[0-9a-fA-F]{6}$/.test(event.color || '')
    ? event.color
    : profile(event.profileId)?.color || '#F5921A';
}

const wallDisplay = new URLSearchParams(location.search).get('kiosk') === '1';
if (wallDisplay) document.body.dataset.kiosk = '1';

async function openWallDisplay() {
  if (!wallDisplay) return false;
  try {
    return (await fetch('/api/kiosk/session', { method: 'POST' })).ok;
  } catch {
    return false;
  }
}

async function api(path, options = {}, retryWallDisplay = true) {
  const method = options.method || 'GET';
  const key = method === 'GET' ? null : `${method} ${path} ${options.body || ''}`;
  if (key && pendingRequests.has(key)) throw new Error('That change is already being saved.');
  if (key) pendingRequests.add(key);
  let response;
  try {
    response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  } catch {
    setConnection(false);
    throw Object.assign(
      new Error(
        method === 'GET'
          ? 'Can’t reach the Enve Family server.'
          : 'Lost the connection while saving. Check whether the change saved before trying again.',
      ),
      { offline: true },
    );
  } finally {
    if (key) pendingRequests.delete(key);
  }
  setConnection(true);
  const data = await response.json();
  if (response.status === 423) {
    if (await promptUnlock()) return api(path, options);
    throw Object.assign(new Error('Edits remain locked.'), { status: 423 });
  }
  if (response.status === 401) {
    if (retryWallDisplay && (await openWallDisplay())) return api(path, options, false);
    localStorage.removeItem(snapshotKey);
    $('#login-dialog').showModal();
    throw Object.assign(new Error('Sign in to continue.'), { status: 401 });
  }
  if (!response.ok)
    throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status });
  return data;
}

function setConnection(online) {
  if (state.offline === !online) return;
  state.offline = !online;
  renderConnection();
  if (online) {
    connectChanges();
    flushOutbox();
  }
}

function saveSnapshot(data) {
  const copy = { ...data, accounts: [], outlookAccounts: [], icloudAccounts: [], syncFailures: [] };
  try {
    localStorage.setItem(snapshotKey, JSON.stringify({ savedAt: Date.now(), data: copy }));
  } catch {
    localStorage.removeItem(snapshotKey);
  }
}

function readOutbox() {
  return JSON.parse(localStorage.getItem(outboxKey) || '[]');
}

function writeOutbox(items) {
  localStorage.setItem(outboxKey, JSON.stringify(items));
  renderConnection();
}

// Server IDs are assigned on insert, so only requests that were never sent are queued; anything sent without a reply needs a person to confirm.
async function createOrQueue(path, payload, label) {
  const body = JSON.stringify(payload);
  if (!state.offline && navigator.onLine) {
    await api(path, { method: 'POST', body });
    return true;
  }
  const items = readOutbox();
  if (items.some((item) => item.path === path && item.body === body))
    throw new Error('That change is already waiting to sync.');
  writeOutbox([
    ...items,
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      path,
      body,
      label,
      createdAt: Date.now(),
      attempted: false,
    },
  ]);
  showToast(`Saved on this device · ${label} will sync when the server is back`);
  return false;
}

function updateOutboxItem(id, changes) {
  writeOutbox(
    readOutbox().flatMap((item) =>
      item.id !== id ? [item] : changes ? [{ ...item, ...changes }] : [],
    ),
  );
}

async function flushOutbox() {
  if (state.flushing || state.offline) return;
  state.flushing = true;
  let saved = 0;
  const problems = [];
  try {
    for (
      let item = readOutbox().find((row) => !row.attempted);
      item;
      item = readOutbox().find((row) => !row.attempted)
    ) {
      updateOutboxItem(item.id, { attempted: true });
      try {
        await api(item.path, { method: 'POST', body: item.body });
        updateOutboxItem(item.id, null);
        saved++;
      } catch (error) {
        if (error.offline) break;
        if ([401, 423].includes(error.status) || error.status >= 500) {
          updateOutboxItem(item.id, { attempted: false });
          break;
        }
        updateOutboxItem(item.id, null);
        problems.push(`${item.label}: ${error.message}`);
      }
    }
  } finally {
    state.flushing = false;
    renderConnection();
  }
  if (problems.length) showError(`Couldn’t save waiting changes · ${problems.join(' · ')}`);
  if (saved) {
    showToast(`${saved} waiting change${saved === 1 ? '' : 's'} synced`);
    load();
  }
}

function savedTime(time) {
  const date = new Date(time);
  return dateKey(date) === dateKey(new Date())
    ? timeFormat.format(date)
    : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${timeFormat.format(date)}`;
}

function renderConnection() {
  const items = readOutbox();
  const review = state.flushing ? 0 : items.filter((item) => item.attempted).length;
  const waiting = items.length - review;
  const parts = [];
  if (state.offline)
    parts.push(state.updatedAt ? `Offline · showing ${savedTime(state.updatedAt)}` : 'Offline');
  if (waiting) parts.push(`${waiting} waiting to sync`);
  if (review) parts.push(`${review} to check`);
  const button = $('#connection-status');
  button.hidden = !parts.length;
  button.textContent = parts.join(' · ');
  button.classList.toggle('offline', state.offline);
  $('#outbox-title').textContent = state.offline ? 'Offline' : 'Back online';
  $('#outbox-summary').textContent = state.offline
    ? `Showing the copy saved ${state.updatedAt ? savedTime(state.updatedAt) : 'earlier'}. Nothing new can be loaded right now.`
    : 'The server is reachable again.';
  $('#outbox-list').innerHTML =
    items
      .map(
        (item) =>
          `<div class="outbox-row"><div><strong>${escapeHtml(item.label)}</strong><small>${item.attempted && !state.flushing ? 'Sent without a reply · it may already be saved. Check before sending again.' : 'Waiting to sync'} · ${escapeHtml(savedTime(item.createdAt))}</small></div><div>${item.attempted && !state.flushing && !state.offline ? `<button class="secondary-button" data-resend="${item.id}">Send again</button>` : ''}<button class="secondary-button" data-discard="${item.id}">Discard</button></div></div>`,
      )
      .join('') || '<p class="empty-copy">No changes waiting.</p>';
}

function showToast(message) {
  const toast = $('#task-celebration');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(celebrationTimeout);
  celebrationTimeout = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

function showError(message) {
  const banner = $('#banner');
  banner.textContent = message;
  banner.hidden = false;
}

function clearError() {
  $('#banner').hidden = true;
}

function celebrateTask(task) {
  const message = task.starValue > 0 ? `★ ${task.starValue} earned · Nice work!` : 'Nice work!';
  const today = dateKey(new Date());
  const routines = state.data.tasks.filter(
    (item) =>
      item.taskType === 'routine' && item.profileId === task.profileId && item.dueDate === today,
  );
  const complete = routines.length && routines.every((item) => item.completed && !item.skipped);
  showToast(complete && task.taskType === 'routine' ? `All routines done! ${message}` : message);
}

function askToDelete(title, description, action = 'Delete') {
  $('#confirm-title').textContent = title;
  $('#confirm-copy').textContent = description;
  $('#confirm-yes').textContent = action;
  $('#confirm-dialog').showModal();
  return new Promise((resolve) => {
    const finish = (value) => {
      $('#confirm-dialog').close();
      resolve(value);
    };
    $('#confirm-cancel').onclick = () => finish(false);
    $('#confirm-yes').onclick = () => finish(true);
    $('#confirm-dialog').onclose = () => resolve(false);
  });
}

function chooseSeriesScope(action, noun = 'event') {
  $('#series-eyebrow').textContent = `REPEATING ${noun.toUpperCase()}`;
  $('#series-title').textContent = `${action} repeating ${noun}`;
  $('#series-once').textContent = `Only this ${noun}`;
  $('#series-dialog').showModal();
  return new Promise((resolve) => {
    const finish = (value) => {
      $('#series-dialog').close();
      resolve(value);
    };
    $('#series-cancel').onclick = () => finish(null);
    $('#series-once').onclick = () => finish('occurrence');
    $('#series-all').onclick = () => finish('series');
    $('#series-dialog').onclose = () => resolve(null);
  });
}

async function load() {
  const range = viewRange();
  const mealWeek = startOfWeek(state.cursor);
  const from = range.from < mealWeek ? range.from : mealWeek;
  const to = range.to > addDays(mealWeek, 7) ? range.to : addDays(mealWeek, 7);
  try {
    const data = await api(`/api/state?from=${dateKey(from)}&to=${dateKey(to)}`);
    state.data = data;
    state.updatedAt = Date.now();
    saveSnapshot(data);
    renderConnection();
    flushOutbox();
    data.syncFailures.length
      ? showError(data.syncFailures.map((item) => `${item.calendar}: ${item.message}`).join(' · '))
      : clearError();
    render();
    if ($('#search-events').value.trim().length >= 2) searchEvents();
  } catch (error) {
    if (error.offline) {
      const snapshot = state.data ? null : JSON.parse(localStorage.getItem(snapshotKey) || 'null');
      if (snapshot) {
        state.data = snapshot.data;
        state.updatedAt = snapshot.savedAt;
        renderConnection();
      }
      if (state.data) {
        clearError();
        render();
      } else
        showError('Can’t reach the Enve Family server, and no saved copy is on this device yet.');
    } else if (error.status !== 401) showError(error.message);
  }
}
function weatherLabel(code) {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow';
  return 'Storms';
}

async function loadWeather() {
  const card = $('#weather-card');
  try {
    const data = await api('/api/weather');
    if (!data.configured) {
      card.hidden = true;
      return;
    }
    card.innerHTML = `<span class="eyebrow">LOCAL WEATHER</span><h2>${escapeHtml(data.city)}</h2><div class="weather-now"><strong>${Math.round(data.current.temperature_2m)}${data.unit}</strong><span>${weatherLabel(data.current.weather_code)}</span></div><div class="weather-days">${data.days
      .slice(0, 4)
      .map(
        (day) =>
          `<div><span>${new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>${Math.round(day.high)}°</strong><small>${Math.round(day.low)}°</small></div>`,
      )
      .join('')}</div>`;
    card.hidden = false;
  } catch (error) {
    card.innerHTML =
      '<span class="eyebrow">LOCAL WEATHER</span><p>Forecast unavailable right now.</p>';
    card.hidden = false;
  }
}
async function loadPhotos() {
  try {
    state.photos = await api('/api/photos');
    $('#photo-list').innerHTML =
      state.photos
        .map(
          (photo) =>
            `<div class="account-row"><span>${escapeHtml(photo.name)}</span><button data-delete-photo="${photo.id}">Remove</button></div>`,
        )
        .join('') || '<p class="hint">No photos added yet.</p>';
    state.photoIndex %= Math.max(state.photos.length, 1);
    updatePhoto();
  } catch (error) {
    if (!error.offline) showError(error.message);
  }
}

function updatePhoto() {
  const photo = state.photos[state.photoIndex];
  if (!photo) return;
  $('#photo-image').src = `/api/photos/${photo.id}`;
  $('#photo-name').textContent = photo.name;
}

function viewRange() {
  if (state.section === 'meals') {
    const from = startOfWeek(state.cursor);
    return { from, to: addDays(from, 7), days: 7 };
  }
  if (state.view === 'day')
    return { from: new Date(state.cursor), to: addDays(state.cursor, 1), days: 1 };
  if (state.view === 'month') {
    const first = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
    const last = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 0);
    const days = Math.ceil((first.getDay() + last.getDate()) / 7) * 7;
    const from = startOfWeek(first);
    return { from, to: addDays(from, days), days };
  }
  const from = startOfWeek(state.cursor);
  return { from, to: addDays(from, 7), days: 7 };
}

function moveCursor(direction) {
  if (state.section === 'meals') state.cursor = addDays(state.cursor, direction * 7);
  else if (state.view === 'month')
    state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + direction, 1);
  else state.cursor = addDays(state.cursor, direction * (state.view === 'day' ? 1 : 7));
  load();
}

function profile(id) {
  return state.data.profiles.find((item) => item.id === id);
}

function visible(item) {
  return !state.hiddenProfiles.has(item.profileId);
}

function eventOnDay(event, day) {
  const next = dateKey(addDays(day, 1));
  const current = dateKey(day);
  if (event.allDay) return event.start < next && event.end > current;
  return (
    Date.parse(event.start) < new Date(`${next}T00:00:00`).getTime() &&
    Date.parse(event.end) > new Date(`${current}T00:00:00`).getTime()
  );
}

function eventTime(event) {
  return event.allDay ? 'All day' : timeFormat.format(new Date(event.start));
}

const timelineHourHeight = 64;
const timelineMinItemHeight = 44;
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

function timelineEntries(day) {
  const key = dateKey(day);
  const dayStart = new Date(`${key}T00:00:00`).getTime();
  const dayEnd = new Date(`${dateKey(addDays(day, 1))}T00:00:00`).getTime();
  const minuteOf = (time) => {
    if (time <= dayStart) return 0;
    if (time >= dayEnd) return 1440;
    const date = new Date(time);
    return date.getHours() * 60 + date.getMinutes();
  };
  const events = state.data.events
    .filter((event) => visible(event) && !event.allDay && eventOnDay(event, day))
    .map((event) => {
      const startTime = Date.parse(event.start);
      const endTime = Date.parse(event.end);
      const start = minuteOf(startTime);
      const end = minuteOf(endTime);
      return {
        event,
        start,
        end: end <= start ? Math.min(1440, start + (endTime - startTime) / 60000) : end,
      };
    });
  const tasks = state.data.tasks
    .filter((task) => visible(task) && task.dueDate === key && task.dueTime)
    .map((task) => {
      const [hours, minutes] = task.dueTime.split(':').map(Number);
      const start = hours * 60 + minutes;
      return { task, start, end: Math.min(start + 30, 1440) };
    });
  return layoutTimeline([...events, ...tasks]);
}

function layoutTimeline(entries) {
  const sorted = entries
    .map((entry) => ({
      ...entry,
      visualEnd: entry.start + (timelineItemHeight(entry) / timelineHourHeight) * 60,
    }))
    .sort((a, b) => a.start - b.start || b.visualEnd - a.visualEnd);
  let cluster = [];
  let columns = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    for (const entry of cluster) entry.columns = columns.length;
    cluster = [];
    columns = [];
  };
  for (const entry of sorted) {
    if (entry.start >= clusterEnd) closeCluster();
    let column = columns.findIndex((end) => end <= entry.start);
    if (column < 0) column = columns.push(0) - 1;
    columns[column] = entry.visualEnd;
    entry.column = column;
    cluster.push(entry);
    clusterEnd = Math.max(clusterEnd, entry.visualEnd);
  }
  closeCluster();
  return sorted;
}

function timelineMinimumHeight() {
  return state.data.settings.text_size === 'large' ? 56 : timelineMinItemHeight;
}

function timelineItemHeight(entry) {
  return Math.max(((entry.end - entry.start) * timelineHourHeight) / 60, timelineMinimumHeight());
}

function renderTimelineEntry(entry) {
  const pxPerMinute = timelineHourHeight / 60;
  const height = timelineItemHeight(entry);
  const top = entry.start * pxPerMinute;
  const compact = height < (state.data.settings.text_size === 'large' ? 80 : 56) ? ' compact' : '';
  const position = `top:${top}px;height:${height}px;--column:${entry.column};--columns:${entry.columns}`;
  if (entry.event) {
    const { event } = entry;
    const startDate = new Date(event.start);
    const endDate = new Date(event.end);
    const formatter =
      startDate.getTimezoneOffset() === endDate.getTimezoneOffset()
        ? timeFormat
        : new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          });
    const time = `${formatter.format(startDate)} – ${formatter.format(endDate)}`;
    return `<button type="button" class="timeline-item timeline-event${compact}" style="${position};--event-color:${eventColor(event)}" data-event="${escapeHtml(event.id)}" title="${escapeHtml(`${event.title} · ${time}`)}"><strong>${escapeHtml(event.title)}</strong><span>${time} · ${escapeHtml(profile(event.profileId)?.name || '')}</span></button>`;
  }
  const { task } = entry;
  const person = profile(task.profileId);
  const time = timeFormat.format(new Date(`${task.dueDate}T${task.dueTime}`));
  const claim = task.claimable && !task.claimedBy && !task.completed;
  const copy = `<span class="timeline-task-copy"><strong>${escapeHtml(task.title)}</strong><span>${time} · ${escapeHtml(person?.name || 'Anyone')}${task.starValue ? ` · ★ ${task.starValue}` : ''}${task.skipped ? ' · skipped' : ''}</span></span>`;
  const attributes = `class="timeline-item timeline-task${compact}${task.completed ? ' completed' : ''}" style="${position};--event-color:${person?.color || '#F5921A'}" title="${escapeHtml(task.title)}"`;
  return claim
    ? `<div ${attributes}><span class="claim-dot" aria-label="Unclaimed">☆</span>${copy}</div>`
    : `<label ${attributes}><input class="task-check" type="checkbox" data-task="${task.id}" aria-label="Complete ${escapeHtml(task.title)}" ${task.completed ? 'checked' : ''}>${copy}</label>`;
}

function renderTimeline(days) {
  const today = dateKey(new Date());
  const keys = days.map((day) => dateKey(day));
  const hours = Array.from(
    { length: 25 },
    (_, hour) =>
      `<span class="timeline-hour" data-hour="${hour}" style="top:${hour * timelineHourHeight}px">${hourFormat.format(new Date(2000, 0, 1, hour))}</span>`,
  ).join('');
  const columns = days
    .map(
      (day, index) =>
        `<div class="timeline-day ${keys[index] === today ? 'today' : ''}" data-timeline-day="${keys[index]}">${timelineEntries(day).map(renderTimelineEntry).join('')}${keys[index] === today ? '<div class="timeline-now" data-now aria-hidden="true"></div>' : ''}</div>`,
    )
    .join('');
  const nowLabel = keys.includes(today)
    ? '<span class="timeline-now-label" data-now-label role="img"></span>'
    : '';
  return `<div class="timeline-body"><div class="timeline-hours" aria-hidden="true">${hours}${nowLabel}</div>${columns}</div>`;
}

function renderWeekTimeline(from) {
  const today = dateKey(new Date());
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  const dayEvents = days.map((day) =>
    state.data.events.filter((event) => visible(event) && eventOnDay(event, day)),
  );
  const headers = days
    .map((day, index) => {
      const key = dateKey(day);
      return `<button type="button" class="day-header ${key === today ? 'today' : ''}" data-day="${key}" aria-label="Show ${escapeHtml(dayFormat.format(day))}, ${dayEvents[index].length} events"><span class="day-name">${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}</span><span class="day-number">${day.getDate()}</span></button>`;
    })
    .join('');
  const allDay = dayEvents.map((events) => events.filter((event) => event.allDay));
  const allDayRow = allDay.some((events) => events.length)
    ? `<span class="timeline-allday-label">All day</span>${allDay
        .map(
          (events) =>
            `<div class="timeline-allday">${events.map((event) => `<button type="button" class="timeline-allday-event" style="--event-color:${eventColor(event)}" data-event="${escapeHtml(event.id)}" title="${escapeHtml(event.title)}">${escapeHtml(event.title)}</button>`).join('')}</div>`,
        )
        .join('')}`
    : '';
  return `<div class="timeline timeline-week" style="--timeline-days:7;--hour-height:${timelineHourHeight}px"><div class="timeline-head"><span class="timeline-corner"></span>${headers}${allDayRow}</div>${renderTimeline(days)}</div>`;
}

function timelineScroller() {
  return state.view === 'day' ? $('#week-grid .day-event-list') : $('.calendar-panel');
}

function updateNowLine() {
  const line = $('#week-grid [data-now]');
  if (!line) return;
  const now = new Date();
  const label = $('#week-grid [data-now-label]');
  line.hidden = label.hidden = line.parentElement.dataset.timelineDay !== dateKey(now);
  if (line.hidden) return;
  const minute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const top = `${(minute * timelineHourHeight) / 60}px`;
  line.style.top = top;
  label.style.top = `${Math.max(10, (minute * timelineHourHeight) / 60)}px`;
  label.textContent = timeFormat.format(now);
  label.setAttribute('aria-label', `Current time, ${timeFormat.format(now)}`);
  document
    .querySelectorAll('#week-grid .timeline-hour')
    .forEach((hour) =>
      hour.classList.toggle('near-now', Math.abs(Number(hour.dataset.hour) * 60 - minute) < 15),
    );
}

function scrollTimeline() {
  const scroller = timelineScroller();
  const body = $('#week-grid .timeline-body');
  if (!scroller || !body) return;
  const headHeight = $('#week-grid .timeline-head')?.offsetHeight || 0;
  const offset =
    body.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop -
    headHeight;
  const now = $('#week-grid [data-now]');
  const items = [...body.querySelectorAll('.timeline-item')].map((item) => item.offsetTop);
  const first = items.length ? Math.min(...items) : 8 * timelineHourHeight;
  const target = now
    ? now.offsetTop - (scroller.clientHeight - headHeight) / 3
    : first - timelineHourHeight / 2;
  scroller.scrollTop = Math.max(0, offset + target);
  if (state.view === 'week') {
    if (now) {
      const day = now.parentElement.getBoundingClientRect();
      const gutter = $('#week-grid .timeline-hours').offsetWidth;
      const left = day.left - scroller.getBoundingClientRect().left + scroller.scrollLeft - gutter;
      scroller.scrollLeft = Math.max(0, left - (scroller.clientWidth - gutter - day.width) / 2);
    } else scroller.scrollLeft = 0;
  }
}

function renderCountdown() {
  const panel = $('#next-up');
  const next = state.reminderData?.events
    .filter((item) => visible(item))
    .map((item) => ({
      ...item,
      when: new Date(item.allDay ? `${item.start}T00:00:00` : item.start).getTime(),
    }))
    .filter((item) => item.when > Date.now())
    .sort((a, b) => a.when - b.when)[0];
  panel.hidden = !next;
  if (!next) return;
  const minutes = Math.ceil((next.when - Date.now()) / 60000);
  const label =
    minutes < 60
      ? `${minutes} min`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
        : `${Math.ceil(minutes / 1440)} days`;
  panel.innerHTML = `<span class="eyebrow">NEXT UP</span><strong>${escapeHtml(next.title)}</strong><small>In ${label}</small>`;
}

async function loadReminders() {
  if (!state.data) return;
  const today = new Date();
  try {
    state.reminderData = await api(
      `/api/state?from=${dateKey(today)}&to=${dateKey(addDays(today, 14))}`,
    );
    renderTodayMeals();
    renderCountdown();
    checkReminders();
  } catch (error) {
    if (!error.offline && error.status !== 401) showError(error.message);
  }
}

function playReminderChime() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  const context = new Audio();
  const tone = context.createOscillator();
  const volume = context.createGain();
  tone.frequency.value = 660;
  volume.gain.value = 0.08;
  tone.connect(volume).connect(context.destination);
  tone.start();
  tone.stop(context.currentTime + 0.2);
  tone.onended = () => context.close();
}

function showNextReminder() {
  const next = state.reminderQueue.shift();
  $('#reminder-panel').hidden = !next;
  if (!next) return;
  $('#reminder-title').textContent = next.title;
  $('#reminder-time').textContent = next.when;
  if (state.data.settings.reminder_chime === 'true') playReminderChime();
}

function checkReminders() {
  if (!state.reminderData || state.data?.settings.reminders_enabled !== 'true') return;
  const now = Date.now();
  const lead = Number(state.data.settings.reminder_minutes) * 60000;
  const due = [];
  for (const item of state.reminderData.events) {
    if (item.allDay || !visible(item)) continue;
    const start = Date.parse(item.start);
    if (now >= start - lead && now <= start + 300000) {
      due.push({
        key: `event:${item.id}:${item.start}`,
        title: item.title,
        when: `${timeFormat.format(new Date(start))} · ${profile(item.profileId)?.name || ''}`,
      });
    }
  }
  for (const task of state.reminderData.tasks) {
    if (!task.dueDate || !task.dueTime || task.completed || !visible(task)) continue;
    const start = new Date(`${task.dueDate}T${task.dueTime}:00`).getTime();
    if (now >= start - lead && now <= start + 300000) {
      due.push({
        key: `task:${task.id}:${task.dueDate}:${task.dueTime}`,
        title: task.title,
        when: `${timeFormat.format(new Date(start))} · ${profile(task.profileId)?.name || ''}`,
      });
    }
  }
  for (const item of due) {
    if (state.shownReminders.has(item.key)) continue;
    state.shownReminders.add(item.key);
    state.reminderQueue.push(item);
  }
  sessionStorage.setItem('enve-reminders', [...state.shownReminders].slice(-200).join('|'));
  if ($('#reminder-panel').hidden) showNextReminder();
}

async function searchEvents() {
  const query = $('#search-events').value.trim();
  const results = $('#search-results');
  const request = ++state.searchRequest;
  if (query.length < 2) {
    results.hidden = true;
    state.searchResults = [];
    return;
  }
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (request !== state.searchRequest) return;
    state.searchResults = [...result.events, ...result.connectedEvents].filter(visible);
    const coverage = (result.coverage || [])
      .map((item) => `${item.source}: ${item.from} to ${item.to}`)
      .join(' · ');
    const failures = (result.failures || []).map(
      (item) => `${item.calendar || item.source}: ${item.message}`,
    );
    const notes = `${coverage ? `<p>${escapeHtml(coverage)}</p>` : ''}${failures.length ? `<p class="search-failures">Not searched · ${escapeHtml(failures.join(' · '))}</p>` : ''}`;
    results.innerHTML =
      (state.searchResults.length
        ? state.searchResults
            .map(
              (item, index) =>
                `<button type="button" data-search-result="${index}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.allDay ? dayFormat.format(new Date(`${item.start}T12:00:00`)) : `${dayFormat.format(new Date(item.start))} · ${timeFormat.format(new Date(item.start))}`)} · ${escapeHtml(profile(item.profileId)?.name || '')}${item.calendarName ? ` · ${escapeHtml(item.calendarName)}` : ''}</small></button>`,
            )
            .join('')
        : '<p>No matching events.</p>') + notes;
    results.hidden = false;
  } catch (error) {
    if (request !== state.searchRequest) return;
    results.innerHTML = `<p>${escapeHtml(error.offline ? 'Search needs the Enve Family server. Try again when it’s back.' : error.message)}</p>`;
    results.hidden = false;
  }
}

function showEventDetail(item) {
  state.selectedEvent = item;
  $('#detail-title').textContent = item.title;
  $('#detail-time').textContent =
    `${item.allDay ? `${item.start} · All day` : `${dayFormat.format(new Date(item.start))} · ${timeFormat.format(new Date(item.start))}`}${item.repeatRule ? ` · Repeats ${item.repeatRule}` : ''}`;
  $('#detail-person').textContent =
    `${profile(item.profileId)?.name || ''}${item.calendarName ? ` · ${item.calendarName}` : ''}`;
  $('#detail-notes').textContent = item.notes || '';
  $('#delete-event').hidden = item.source !== 'local' && !item.writable;
  $('#edit-event').hidden = item.source !== 'local' && !item.writable;
  $('#event-dialog').showModal();
}

function habitStreak(task) {
  if (task.taskType !== 'habit') return 0;
  const today = dateKey(new Date());
  const series = state.data.tasks
    .filter((item) => item.seriesId === task.seriesId)
    .sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''));
  let streak = 0;
  for (const item of series) {
    if (!item.completed && item.dueDate >= today) continue;
    if (!item.completed || item.skipped) break;
    streak++;
  }
  return streak;
}

function renderTaskRow(task, context = 'all') {
  const person = profile(task.profileId);
  const nextId =
    task.rotationProfiles?.length > 1
      ? task.rotationProfiles[(task.rotationIndex + 1) % task.rotationProfiles.length]
      : null;
  const details =
    context === 'day'
      ? `${escapeHtml(person?.name || 'Anyone')}${task.dueTime ? ` · ${escapeHtml(task.dueTime)}` : ''}${task.dueDate && task.dueDate < dateKey(new Date()) && !task.completed ? ' · Overdue' : ''}${task.starValue ? ` · ★ ${task.starValue}` : ''}`
      : `${escapeHtml(person?.name || '')}${task.dueDate ? ` · ${escapeHtml(task.dueDate)}` : ''}${task.dueTime ? ` ${escapeHtml(task.dueTime)}` : ''} · ${escapeHtml(task.taskType)}${task.repeatRule !== 'none' ? ` · ${escapeHtml(task.repeatRule)}` : ''}${nextId ? ` · Next: ${escapeHtml(profile(nextId)?.name || '')}` : ''}${task.starValue ? ` · ★ ${task.starValue}` : ''}${habitStreak(task) ? ` · ${habitStreak(task)} streak` : ''}`;
  const claim = task.claimable && !task.claimedBy && !task.completed;
  return `<div class="task-row ${task.completed ? 'completed' : ''}">${claim ? '<span class="claim-dot">☆</span>' : `${context === 'day' ? '<label class="day-task-toggle">' : ''}<input class="task-check" type="checkbox" data-task="${task.id}" aria-label="Complete ${escapeHtml(task.title)}" ${task.completed ? 'checked' : ''}>${context === 'day' ? '</label>' : ''}`}<div class="task-copy"><strong>${escapeHtml(task.title)}</strong><small><span style="color:${person?.color || '#F5921A'}">●</span> ${details}${task.skipped ? ' · skipped' : ''}</small>${
    claim
      ? `<div class="claim-controls"><select data-claim-person="${task.id}" aria-label="Person claiming ${escapeHtml(task.title)}">${state.data.profiles
          .filter((item) => !['family', 'enve'].includes(item.id))
          .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
          .join(
            '',
          )}</select><button data-claim-task="${task.id}" class="secondary-button">Claim</button></div>`
      : ''
  }</div>${!task.completed && !claim && task.dueDate ? `<button class="task-skip" data-skip-task="${task.id}">Skip</button>` : ''}${context === 'day' ? '' : `<button class="task-delete" data-delete-task="${task.id}" aria-label="Delete ${escapeHtml(task.title)}">×</button>`}</div>`;
}

function renderTasksPage() {
  const tasks = state.data.tasks;
  const today = dateKey(new Date());
  $('#tasks-open-count').textContent = tasks.filter((task) => !task.completed).length;
  $('#tasks-due-count').textContent = tasks.filter(
    (task) => !task.completed && task.dueDate && task.dueDate <= today,
  ).length;
  $('#tasks-done-count').textContent = tasks.filter((task) => task.completed).length;
  const personSelect = $('#tasks-person-filter');
  const options =
    '<option value="all">Everyone</option>' +
    state.data.profiles
      .map(
        (person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`,
      )
      .join('');
  if (personSelect.innerHTML !== options) personSelect.innerHTML = options;
  personSelect.value = state.taskPerson;
  $('#tasks-type-filter').value = state.taskType;
  $('#tasks-status-tabs')
    .querySelectorAll('button')
    .forEach((button) =>
      button.classList.toggle('active', button.dataset.taskStatus === state.taskStatus),
    );
  const filtered = tasks
    .filter(
      (task) =>
        (state.taskStatus === 'all' || task.completed === (state.taskStatus === 'done')) &&
        (state.taskPerson === 'all' || task.profileId === state.taskPerson) &&
        (state.taskType === 'all' || task.taskType === state.taskType),
    )
    .sort(
      (a, b) =>
        Number(a.completed) - Number(b.completed) ||
        (a.dueDate || '9999').localeCompare(b.dueDate || '9999') ||
        a.title.localeCompare(b.title),
    );
  $('#all-task-list').innerHTML = filtered.length
    ? filtered.map((task) => renderTaskRow(task)).join('')
    : `<p class="empty-copy">${state.taskStatus === 'open' ? 'All caught up. Add a task when something comes to mind.' : 'No tasks match these filters.'}</p>`;
}

function render() {
  const { from, days } = viewRange();
  const end = addDays(from, days - 1);
  document.body.dataset.section = state.section;
  $('.page-head .eyebrow').textContent =
    state.section === 'calendar'
      ? 'FAMILY CALENDAR'
      : state.section === 'tasks'
        ? 'HOUSEHOLD TASKS'
        : state.section === 'lists'
          ? 'HOUSEHOLD LISTS'
          : state.section === 'meals'
            ? 'MEAL PLANNER'
            : state.section === 'import'
              ? 'BRING IT IN'
              : 'REWARDS';
  $('#week-title').textContent =
    state.section === 'tasks'
      ? 'Things to do'
      : state.section === 'lists'
        ? 'Shared lists'
        : state.section === 'meals'
          ? 'This week’s meals'
          : state.section === 'rewards'
            ? 'Little wins add up'
            : state.section === 'import'
              ? 'Make a draft'
              : state.view === 'day'
                ? dayFormat.format(state.cursor)
                : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
                    state.cursor,
                  );
  $('#date-subtitle').textContent =
    state.section === 'tasks'
      ? 'One place for chores, routines, and habits'
      : state.section === 'lists'
        ? 'For everything the family needs'
        : state.section === 'rewards'
          ? 'Celebrate completed chores together'
          : state.section === 'import'
            ? 'Turn text and documents into a plan'
            : state.section === 'meals'
              ? `${dayFormat.format(startOfWeek(state.cursor))} – ${dayFormat.format(addDays(startOfWeek(state.cursor), 6))}`
              : state.view === 'day'
                ? 'Your day at a glance'
                : state.view === 'month'
                  ? 'Choose a day to see everything planned'
                  : `${dayFormat.format(from)} – ${dayFormat.format(end)}`;
  $('#previous-week').setAttribute(
    'aria-label',
    state.view === 'month' && state.section === 'calendar'
      ? 'Previous month'
      : state.view === 'day' && state.section === 'calendar'
        ? 'Previous day'
        : 'Previous week',
  );
  $('#next-week').setAttribute(
    'aria-label',
    state.view === 'month' && state.section === 'calendar'
      ? 'Next month'
      : state.view === 'day' && state.section === 'calendar'
        ? 'Next day'
        : 'Next week',
  );
  $('#calendar-section').hidden = state.section !== 'calendar';
  $('#tasks-section').hidden = state.section !== 'tasks';
  $('#lists-section').hidden = state.section !== 'lists';
  $('#meals-section').hidden = state.section !== 'meals';
  $('#rewards-section').hidden = state.section !== 'rewards';
  $('#import-section').hidden = state.section !== 'import';
  $('#calendar-tools').hidden = state.section !== 'calendar';
  $('.view-picker').hidden = state.section !== 'calendar';
  $('#today-overview').hidden = state.section !== 'calendar';
  $('.page-actions').hidden = ['tasks', 'lists', 'rewards', 'import'].includes(state.section);
  $('#add-button').hidden = state.section !== 'calendar';
  document
    .querySelectorAll('[data-section]')
    .forEach((button) =>
      button.classList.toggle('active', button.dataset.section === state.section),
    );
  document
    .querySelector('#more-sections summary')
    .classList.toggle(
      'active',
      ['tasks', 'lists', 'meals', 'rewards', 'import'].includes(state.section),
    );
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  if (state.section === 'calendar') {
    $('#profile-filters').innerHTML = state.data.profiles
      .map(
        (person) =>
          `<button class="filter ${state.hiddenProfiles.has(person.id) ? '' : 'selected'}" data-profile="${person.id}" aria-pressed="${!state.hiddenProfiles.has(person.id)}" style="--person-color:${escapeHtml(person.color)}"><span class="filter-dot"></span>${escapeHtml(person.name)}</button>`,
      )
      .join('');
    const today = dateKey(new Date());
    const timelineKey = ['day', 'week'].includes(state.view)
      ? `${state.view}:${dateKey(from)}`
      : null;
    const previousScroll = timelineKey === state.timelineKey ? timelineScroller()?.scrollTop : null;
    $('#week-grid').className = `week-grid ${state.view}-view`;
    $('#week-grid').style.setProperty('--month-weeks', state.view === 'month' ? days / 7 : 6);
    $('#week-grid').style.setProperty('--timeline-min-height', `${timelineMinimumHeight()}px`);
    $('#week-grid').innerHTML =
      state.view === 'week'
        ? renderWeekTimeline(from)
        : Array.from({ length: days }, (_, index) => {
            const day = addDays(from, index);
            const key = dateKey(day);
            const events = state.data.events
              .filter((event) => visible(event) && eventOnDay(event, day))
              .sort(
                (a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start),
              );
            const meals = ['day', 'schedule'].includes(state.view)
              ? calendarMeals(state.data.meals, key)
              : [];
            const eventContent =
              state.view === 'month'
                ? `<div class="month-event-summary" aria-label="${events.length} events"><span class="month-dots">${events
                    .slice(0, 4)
                    .map((event) => `<i style="background:${eventColor(event)}"></i>`)
                    .join(
                      '',
                    )}</span>${events.length ? `<span>${events.length}</span>` : ''}</div><div class="month-event-preview">${events
                    .slice(0, 3)
                    .map(
                      (event) =>
                        `<span style="--event-color:${eventColor(event)}">${escapeHtml(event.title)}</span>`,
                    )
                    .join('')}</div>`
                : events.length
                  ? events
                      .map(
                        (event) =>
                          `<button class="day-event" style="--event-color:${eventColor(event)}" data-event="${escapeHtml(event.id)}" title="${escapeHtml(event.title)}"><strong>${escapeHtml(event.title)}</strong><span>${eventTime(event)} · ${escapeHtml(profile(event.profileId)?.name || '')}</span></button>`,
                      )
                      .join('')
                  : '<div class="empty-day">A little breathing room</div>';
            const mealContent = meals.length
              ? `<div class="day-meals" role="group" aria-label="Meals for ${escapeHtml(dayFormat.format(day))}"><span class="day-meals-label">On the menu</span>${meals.map((meal) => `<button type="button" class="day-meal" style="--meal-color:${mealColor(meal)}" data-calendar-meal="${escapeHtml(meal.day)}" aria-label="${escapeHtml(mealLabel(meal))}: ${escapeHtml(meal.title)}. Open meal plan"><small>${escapeHtml(mealLabel(meal))}</small><span>${escapeHtml(meal.title)}</span></button>`).join('')}</div>`
              : '';
            let content = `${eventContent}${mealContent}`;
            if (state.view === 'day') {
              const dailyTasks = state.data.tasks
                .filter(
                  (task) =>
                    visible(task) &&
                    ((task.dueDate === key &&
                      (!task.dueTime || (task.claimable && !task.claimedBy && !task.completed))) ||
                      (!task.completed && !task.dueDate) ||
                      (key === today && !task.completed && task.dueDate < key)),
                )
                .sort(
                  (a, b) =>
                    Number(a.completed) - Number(b.completed) ||
                    (a.dueDate || key).localeCompare(b.dueDate || key) ||
                    (a.dueTime || '23:59').localeCompare(b.dueTime || '23:59') ||
                    a.title.localeCompare(b.title),
                );
              const openTasks = dailyTasks.filter((task) => !task.completed).length;
              const allDay = events.filter((event) => event.allDay);
              const allDayContent = allDay.length
                ? `<div class="day-allday-list">${allDay.map((event) => `<button type="button" class="timeline-allday-event" style="--event-color:${eventColor(event)}" data-event="${escapeHtml(event.id)}" title="${escapeHtml(event.title)}"><small>All day</small> ${escapeHtml(event.title)}</button>`).join('')}</div>`
                : '';
              content = `<section class="day-agenda" aria-label="Daily schedule"><div class="day-plan-heading"><h2>Schedule</h2><span>${events.length} ${events.length === 1 ? 'event' : 'events'}</span></div>${allDayContent}<div class="day-event-list"><div class="timeline" style="--timeline-days:1;--hour-height:${timelineHourHeight}px">${renderTimeline([day])}</div></div></section><aside class="day-plan-side"><section class="day-task-panel" aria-label="Tasks for ${escapeHtml(dayFormat.format(day))}"><div class="day-plan-heading"><h2>To do</h2><button type="button" class="secondary-button" data-add-day-task="${key}">＋ Add task</button></div><div class="day-task-summary"><span>${openTasks ? `${openTasks} to do` : 'All caught up'}</span><button type="button" class="text-button" data-section="tasks">All tasks →</button></div><div class="day-task-list">${dailyTasks.length ? dailyTasks.map((task) => renderTaskRow(task, 'day')).join('') : '<p class="empty-copy">No tasks for this day.</p>'}</div></section>${mealContent}</aside>`;
            }
            return `<div class="day-column ${key === today ? 'today' : ''} ${day.getMonth() !== state.cursor.getMonth() && state.view === 'month' ? 'outside-month' : ''}" data-day-column="${key}"><button type="button" class="day-header" data-day="${key}" aria-label="Show ${escapeHtml(dayFormat.format(day))}, ${events.length} events"><span class="day-name">${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}</span><span class="day-number">${day.getDate()}</span></button>${content}</div>`;
          }).join('');
    if (timelineKey) {
      updateNowLine();
      if (previousScroll != null) timelineScroller().scrollTop = previousScroll;
      else {
        if (state.view === 'day') $('.calendar-panel').scrollTop = 0;
        scrollTimeline();
      }
    } else if (state.timelineKey) $('.calendar-panel').scrollTop = 0;
    state.timelineKey = timelineKey;
    const todayEvents = state.data.events
      .filter((event) => visible(event) && eventOnDay(event, new Date()))
      .sort((a, b) => a.start.localeCompare(b.start));
    const dueTasks = state.data.tasks.filter(
      (task) => visible(task) && !task.completed && (!task.dueDate || task.dueDate <= today),
    );
    $('#today-date').textContent = dayFormat.format(new Date());
    $('#event-count').textContent = todayEvents.length;
    $('#task-count').textContent = dueTasks.length;
    $('#today-events').innerHTML = todayEvents.length
      ? todayEvents
          .slice(0, 4)
          .map(
            (event) =>
              `<div class="today-event"><span class="event-dot" style="background:${eventColor(event)}"></span><div>${escapeHtml(event.title)}<small>${eventTime(event)}</small></div></div>`,
          )
          .join('')
      : '<div class="empty-copy">Nothing on the calendar today.</div>';
    renderTodayMeals();
    renderCountdown();
  } else state.timelineKey = null;
  if (state.section === 'tasks') renderTasksPage();
  if (state.section === 'lists') renderLists();
  if (state.section === 'meals') {
    renderMeals(startOfWeek(state.cursor), 7);
    renderRecipes();
  }
  if (state.section === 'rewards') renderRewards();
  if ($('#settings-dialog').open) renderSettings();
  else if ($('#calendar-connect-dialog').open) renderCalendarConnect();
  applyDisplay();
}

function renderLists() {
  $('#lists-grid').innerHTML = state.data.lists
    .map((list) => {
      const items = state.data.listItems.filter((item) => item.listId === list.id);
      if (list.sort_order === 'alpha') items.sort((a, b) => a.title.localeCompare(b.title));
      if (list.sort_order === 'checked')
        items.sort((a, b) => Number(a.checked) - Number(b.checked));
      const sections = [...new Set(items.map((item) => item.section || ''))];
      const rows = sections
        .map(
          (section) =>
            `${section ? `<h3 class="list-section-title">${escapeHtml(section)}</h3>` : ''}${items
              .filter((item) => (item.section || '') === section)
              .map(
                (item) =>
                  `<div class="task-row ${item.checked ? 'completed' : ''}"><input type="checkbox" data-list-item="${item.id}" aria-label="Check ${escapeHtml(item.title)}" ${item.checked ? 'checked' : ''}><strong>${escapeHtml(item.title)}</strong><button class="task-delete" data-delete-item="${item.id}" aria-label="Delete ${escapeHtml(item.title)}">×</button></div>`,
              )
              .join('')}`,
        )
        .join('');
      return `<section class="list-card"><div class="section-heading"><h2>${escapeHtml(list.name)}</h2>${list.id === 'groceries' ? '' : `<button class="task-delete" data-delete-list="${list.id}" aria-label="Delete ${escapeHtml(list.name)}">×</button>`}</div><label class="list-sort">Sort <select data-list-sort="${list.id}"><option value="added" ${list.sort_order === 'added' ? 'selected' : ''}>Date added</option><option value="alpha" ${list.sort_order === 'alpha' ? 'selected' : ''}>A to Z</option><option value="checked" ${list.sort_order === 'checked' ? 'selected' : ''}>Unchecked first</option></select></label><div class="list-items">${rows || '<p class="empty-copy">Nothing here yet.</p>'}</div><form class="inline-form" data-add-item="${list.id}"><input name="title" aria-label="New item for ${escapeHtml(list.name)}" placeholder="Add an item" maxlength="120" required><input name="section" aria-label="Section" placeholder="Section (optional)" maxlength="40"><button class="secondary-button">Add</button></form></section>`;
    })
    .join('');
}

function mealCategory(id) {
  return state.data.mealCategories.find((item) => item.id === id);
}

function mealLabel(meal) {
  return mealCategory(meal.category)?.name || meal.category;
}

function mealColor(meal) {
  const color = mealCategory(meal.category)?.color;
  return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#F5921A';
}

function mealRecipeIds(meal) {
  return meal.recipeIds || (meal.recipe_id ? [meal.recipe_id] : []);
}

function sortMeals(meals) {
  const order = state.data.mealCategories.map((item) => item.id);
  return [...meals].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}

function calendarMeals(meals, key) {
  return sortMeals(
    meals.filter((meal) => meal.day === key && mealCategory(meal.category)?.enabled !== false),
  );
}

function repeatLabel(meal) {
  if (!meal.repeatRule || meal.repeatRule === 'none') return '';
  return `Repeats ${meal.repeatRule}${meal.repeatUntil ? ` through ${new Date(`${meal.repeatUntil}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}`;
}

function renderTodayMeals() {
  const loadedToday = startOfWeek(new Date()).getTime() === startOfWeek(state.cursor).getTime();
  const meals = calendarMeals(
    loadedToday || !state.reminderData ? state.data.meals : state.reminderData.meals,
    dateKey(new Date()),
  );
  $('#today-meals').hidden = !meals.length;
  $('#today-meals').innerHTML =
    `<span class="eyebrow">ON THE MENU</span>${meals.map((meal) => `<div class="today-meal" style="--meal-color:${mealColor(meal)}"><small>${escapeHtml(mealLabel(meal))}</small><span>${escapeHtml(meal.title)}</span></div>`).join('')}`;
}

function renderMeals(from, days) {
  $('#meal-grid').innerHTML = Array.from({ length: days }, (_, index) => {
    const day = addDays(from, index);
    const key = dateKey(day);
    const meals = sortMeals(state.data.meals.filter((meal) => meal.day === key));
    return `<section class="meal-day" aria-label="${escapeHtml(dayFormat.format(day))}"><div class="meal-day-head"><h3>${dayFormat.format(day)}</h3><button type="button" class="round-add" data-add-meal="${key}" aria-label="Plan a meal for ${escapeHtml(dayFormat.format(day))}">＋</button></div>${
      meals
        .map((meal) => {
          const recipes = mealRecipeIds(meal)
            .map((id) => state.data.recipes.find((recipe) => recipe.id === id)?.title)
            .filter(Boolean);
          const details = [mealLabel(meal), meal.servings ? `Serves ${meal.servings}` : '']
            .filter(Boolean)
            .join(' · ');
          return `<div class="meal-row" style="--meal-color:${mealColor(meal)}"><div><small>${escapeHtml(details)}</small><strong>${escapeHtml(meal.title)}</strong>${recipes.length && recipes.join(' + ') !== meal.title ? `<span class="meal-recipes">${escapeHtml(recipes.join(' · '))}</span>` : ''}${repeatLabel(meal) ? `<span class="meal-repeat">↻ ${escapeHtml(repeatLabel(meal))}</span>` : ''}${meal.notes ? `<p>${escapeHtml(meal.notes)}</p>` : ''}</div><div class="meal-row-actions"><button type="button" class="secondary-button" data-edit-meal="${meal.id}" aria-label="Edit ${escapeHtml(meal.title)}">Edit</button><button type="button" class="task-delete" data-delete-meal="${meal.id}" aria-label="Delete ${escapeHtml(meal.title)}">×</button></div></div>`;
        })
        .join('') || '<p class="empty-copy">No meals planned.</p>'
    }</section>`;
  }).join('');
  $('#meal-groceries').disabled = !weekRecipeMeals().length;
  const checked = new Set(
    [...document.querySelectorAll('#suggest-categories input:checked')].map((input) => input.value),
  );
  if (!$('#suggest-categories').children.length) checked.add('Dinner');
  $('#suggest-categories').innerHTML = state.data.mealCategories
    .filter((item) => item.enabled)
    .map(
      (item) =>
        `<label><input type="checkbox" name="category" value="${escapeHtml(item.id)}" ${checked.has(item.id) ? 'checked' : ''}> ${escapeHtml(item.name)}</label>`,
    )
    .join('');
  if (!$('#meal-labels').open) renderMealCategorySettings();
  const cloudSource = $('#cloud-meal-source');
  cloudSource.disabled = !state.data.cloudMealIdeasConfigured;
  if (cloudSource.disabled && cloudSource.checked)
    $('#meal-suggestion-form [name=source][value=builtin]').checked = true;
  $('#cloud-meal-hint').textContent = cloudSource.disabled
    ? 'Cloud ideas are not available on this server.'
    : 'Cloud ideas send your selected meal types, dates, servings, and exclusions to OpenAI for suggestions.';
  const shownSuggestions = $('#meal-suggestions').querySelectorAll('[data-suggested]').length;
  if (
    $('#meal-suggestions').dataset.week !== dateKey(from) ||
    (shownSuggestions && shownSuggestions !== weekSuggestions(from, days).length)
  ) {
    renderMealSuggestions(from, days);
  }
}

function weekRecipeMeals() {
  const from = dateKey(startOfWeek(state.cursor));
  const to = dateKey(addDays(startOfWeek(state.cursor), 7));
  return state.data.meals.filter(
    (meal) => mealRecipeIds(meal).length && meal.day >= from && meal.day < to,
  );
}

function renderMealCategorySettings() {
  $('#meal-category-settings').innerHTML = state.data.mealCategories
    .map(
      (item) =>
        `<div class="meal-category-row" data-meal-category="${escapeHtml(item.id)}"><input type="color" name="color" value="${escapeHtml(item.color)}" aria-label="${escapeHtml(item.name)} color"><input name="name" value="${escapeHtml(item.name)}" maxlength="30" required aria-label="Label for ${escapeHtml(item.id)}"><label class="check-row"><input type="checkbox" name="enabled" ${item.enabled ? 'checked' : ''}> Show</label></div>`,
    )
    .join('');
}

function weekSuggestions(from, days) {
  return state.mealSuggestions.filter(
    (meal) =>
      meal.day >= dateKey(from) &&
      meal.day < dateKey(addDays(from, days)) &&
      !state.data.meals.some(
        (planned) => planned.day === meal.day && planned.category === meal.category,
      ),
  );
}

function renderMealSuggestions(from, days) {
  $('#meal-suggestions').dataset.week = dateKey(from);
  const suggestions = weekSuggestions(from, days);
  if (!suggestions.length) {
    $('#meal-suggestions').innerHTML =
      '<p class="empty-copy">Suggest from saved recipes, or ask for new ideas to review before anything is saved.</p>';
    return;
  }
  const options = state.data.recipes
    .map((recipe) => `<option value="${recipe.id}">${escapeHtml(recipe.title)}</option>`)
    .join('');
  $('#meal-suggestions').innerHTML =
    `<form id="suggestion-review"><p class="hint">Review each meal before adding it. Uncheck any you do not want. New ideas are saved to the recipe box when added.</p><div class="suggestion-grid">${suggestions
      .map((meal, index) => {
        const slot = `${dayFormat.format(new Date(`${meal.day}T12:00:00`))} · ${mealCategory(meal.category)?.name || meal.category}`;
        const draft = meal.draftRecipe;
        const fields = draft
          ? `<span class="suggestion-kind">New idea</span><label>Recipe name<input data-draft-title="${index}" value="${escapeHtml(draft.title)}" maxlength="120" required></label><label>Ingredients, one per line<textarea data-draft-ingredients="${index}" rows="4" maxlength="4000" required>${escapeHtml(draft.ingredients)}</textarea></label><label>Directions<textarea data-draft-directions="${index}" rows="3" maxlength="5000">${escapeHtml(draft.directions || '')}</textarea></label>`
          : `<span class="suggestion-kind">Saved recipe</span><select data-recipe="${index}" aria-label="Recipe for ${escapeHtml(slot)}">${options.replace(`value="${meal.recipeId}"`, `value="${meal.recipeId}" selected`)}</select>`;
        return `<div class="suggestion-card" style="--meal-color:${mealColor(meal)}"><label class="check-row"><input type="checkbox" data-suggested="${index}" checked> ${escapeHtml(slot)}</label>${fields}<label>Servings<input data-servings="${index}" type="number" min="1" max="24" value="${meal.servings}" required></label><label>Notes<input data-notes="${index}" maxlength="500" placeholder="Optional"></label></div>`;
      })
      .join(
        '',
      )}</div><div class="recipe-actions"><button class="primary-button">Add selected meals</button><button type="button" class="secondary-button" id="discard-suggestions">Discard suggestions</button></div></form>`;
}

function openMeal(
  day = startOfWeek(new Date()).getTime() === startOfWeek(state.cursor).getTime()
    ? new Date()
    : startOfWeek(state.cursor),
  meal = null,
  recipeId = null,
) {
  state.editingMeal = meal;
  const form = $('#meal-entry-form');
  form.reset();
  const categories = state.data.mealCategories.filter(
    (item) => item.enabled || item.id === meal?.category,
  );
  $('#meal-category').innerHTML = categories
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join('');
  const selected = new Set(meal ? mealRecipeIds(meal) : recipeId ? [recipeId] : []);
  $('#meal-recipe-options').innerHTML =
    state.data.recipes
      .map(
        (recipe) =>
          `<label class="check-row"><input type="checkbox" value="${recipe.id}" ${selected.has(recipe.id) ? 'checked' : ''}> ${escapeHtml(recipe.title)}</label>`,
      )
      .join('') || '<p class="hint">Save recipes in the recipe box to link them here.</p>';
  $('#meal-dialog-title').textContent = meal ? 'Edit meal' : 'Plan a meal';
  form.elements.day.value = meal?.day || dateKey(day);
  form.elements.category.value =
    meal?.category ||
    (categories.some((item) => item.id === 'Dinner') ? 'Dinner' : categories[0]?.id || '');
  form.elements.title.value = meal?.title || '';
  form.elements.title.dataset.auto = selectedRecipeNames();
  form.elements.notes.value = meal?.notes || '';
  const recipe = state.data.recipes.find((item) => item.id === recipeId);
  form.elements.servings.value =
    meal?.servings || (recipe && (state.recipeServings.get(recipe.id) || recipe.servings)) || 4;
  syncMealTitle();
  const series = Boolean(meal && repeatLabel(meal));
  $('#meal-repeat').hidden = Boolean(meal);
  $('#meal-series-note').hidden = !series;
  $('#meal-series-note').textContent = series
    ? `${repeatLabel(meal)}. To change how it repeats, delete the series and plan it again.`
    : '';
  $('#delete-meal').hidden = !meal;
  updateMealRepeat();
  $('#meal-error').textContent = '';
  $('#meal-dialog').showModal();
  form.elements.title.focus();
}

function selectedMealRecipes() {
  return [...document.querySelectorAll('#meal-recipe-options input:checked')].map(
    (input) => input.value,
  );
}

function selectedRecipeNames() {
  return selectedMealRecipes()
    .map((id) => state.data.recipes.find((recipe) => recipe.id === id)?.title)
    .filter(Boolean)
    .join(' + ');
}

function syncMealTitle() {
  const input = $('#meal-entry-form [name=title]');
  const names = selectedRecipeNames();
  if (!input.value || input.value === input.dataset.auto) input.value = names;
  input.dataset.auto = names;
  input.required = !names;
}

function updateMealRepeat() {
  $('#meal-repeat-until').disabled = $('#meal-repeat-rule').value === 'none';
  if ($('#meal-repeat-until').disabled) $('#meal-repeat-until').value = '';
}

async function deleteMeal(meal) {
  const scope =
    repeatLabel(meal) && meal.seriesId ? await chooseSeriesScope('Delete', 'meal') : 'occurrence';
  if (
    !scope ||
    !(await askToDelete(
      'Delete meal?',
      scope === 'series'
        ? 'Every date in this repeating meal will be removed from the plan.'
        : 'This meal will be removed from the plan.',
    ))
  )
    return false;
  await api(
    `/api/meals/${encodeURIComponent(meal.id)}${scope === 'series' ? '?scope=series' : ''}`,
    { method: 'DELETE' },
  );
  await load();
  return true;
}

function renderRecipes() {
  $('#recipes-grid').innerHTML = state.data.recipes.length
    ? state.data.recipes
        .map((recipe) => {
          const servings = state.recipeServings.get(recipe.id) || recipe.servings || 4;
          const ingredients = (
            state.recipeScaled.get(`${recipe.id}:${servings}`) || recipe.ingredients
          )
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          return `<article class="recipe-card">${recipe.photo_id ? `<img class="recipe-photo" src="/api/photos/${recipe.photo_id}" alt="${escapeHtml(recipe.title)}">` : ''}<h3>${escapeHtml(recipe.title)}</h3><label class="recipe-servings">Servings <select data-recipe-servings="${recipe.id}">${Array.from({ length: 24 }, (_, index) => `<option value="${index + 1}" ${servings === index + 1 ? 'selected' : ''}>${index + 1}</option>`).join('')}</select></label><strong>Ingredients</strong><ul>${ingredients.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>${recipe.directions ? `<strong>Directions</strong><p>${escapeHtml(recipe.directions)}</p>` : ''}<div class="recipe-actions"><button class="secondary-button" data-plan-recipe="${recipe.id}">Plan meal</button><button class="secondary-button" data-grocery-recipe="${recipe.id}">Add to groceries</button><button class="secondary-button" data-edit-recipe="${recipe.id}">Edit</button><button class="task-delete" data-delete-recipe="${recipe.id}" aria-label="Delete ${escapeHtml(recipe.title)}">×</button></div></article>`;
        })
        .join('')
    : '<p class="empty-copy">Save a favorite recipe to plan it again later.</p>';
}

function importDateValue(value, allDay) {
  if (allDay) return value.slice(0, 10);
  const date = new Date(value);
  return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function renderImportDrafts() {
  $('#import-drafts').innerHTML = state.importDrafts
    .map((draft, index) => {
      const personOptions = state.data.profiles
        .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
        .join('');
      const listOptions = state.data.lists
        .map((list) => `<option value="${list.id}">${escapeHtml(list.name)}</option>`)
        .join('');
      let fields = '';
      if (draft.type === 'event')
        fields = `<label>Title<input name="title" value="${escapeHtml(draft.title)}" maxlength="200" required></label><div class="form-pair"><label>Start<input name="start" type="${draft.allDay ? 'date' : 'datetime-local'}" value="${importDateValue(draft.start, draft.allDay)}" required></label><label>End<input name="end" type="${draft.allDay ? 'date' : 'datetime-local'}" value="${importDateValue(draft.end, draft.allDay)}" required></label></div><label class="check-row"><input name="allDay" type="checkbox" data-import-allday ${draft.allDay ? 'checked' : ''}> All day</label><div class="form-pair"><label>Person<select name="profileId">${personOptions}</select></label><label>Repeat<select name="repeatRule">${['none', 'daily', 'weekly', 'monthly', 'yearly'].map((rule) => `<option value="${rule}" ${draft.repeatRule === rule ? 'selected' : ''}>${rule === 'none' ? 'Never' : rule}</option>`).join('')}</select></label></div><label>Notes<textarea name="notes" rows="3">${escapeHtml(draft.notes || '')}</textarea></label>`;
      if (draft.type === 'task')
        fields = `<label>Title<input name="title" value="${escapeHtml(draft.title)}" maxlength="200" required></label><div class="form-pair"><label>Due date<input name="dueDate" type="date" value="${draft.dueDate || ''}"></label><label>Time<input name="dueTime" type="time" value="${draft.dueTime || ''}"></label></div><div class="form-pair"><label>Person<select name="profileId">${personOptions}</select></label><label>Type<select name="taskType"><option value="chore">Chore</option><option value="routine">Routine</option><option value="habit">Habit</option></select></label></div>`;
      if (draft.type === 'list')
        fields = `<label>Item<input name="title" value="${escapeHtml(draft.title)}" maxlength="120" required></label><div class="form-pair"><label>List<select name="listId">${listOptions}</select></label><label>Section<input name="section" maxlength="40" placeholder="Optional"></label></div>`;
      if (draft.type === 'recipe')
        fields = `<label>Recipe name<input name="title" value="${escapeHtml(draft.title)}" maxlength="120" required></label><label>Ingredients<textarea name="ingredients" rows="5" required>${escapeHtml(draft.ingredients)}</textarea></label><label>Directions<textarea name="directions" rows="4">${escapeHtml(draft.directions)}</textarea></label>`;
      return `<form class="import-card" data-import-draft="${index}"><div class="section-heading"><span class="eyebrow">${escapeHtml(draft.type.toUpperCase())} DRAFT ${index + 1}</span><button type="button" class="task-delete" data-remove-import="${index}" aria-label="Discard draft">×</button></div>${fields}<button class="primary-button">Save ${escapeHtml(draft.type)}</button></form>`;
    })
    .join('');
}

function renderRewards() {
  const selected = $('#reward-profile').value;
  const goalSelected = $('#goal-profile').value;
  $('#reward-profile').innerHTML = state.data.profiles
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join('');
  $('#goal-profile').innerHTML = $('#reward-profile').innerHTML;
  if (selected) $('#reward-profile').value = selected;
  if (goalSelected) $('#goal-profile').value = goalSelected;
  $('#rewards-grid').innerHTML = state.data.profiles
    .map((person) => {
      const balance =
        state.data.rewardBalances.find((row) => row.profileId === person.id)?.stars || 0;
      const rewards = state.data.rewards.filter((reward) => reward.profileId === person.id);
      const goals = state.data.goals.filter((goal) => goal.profileId === person.id);
      return `<section class="reward-card"><div class="reward-card-head"><div><span class="filter-dot" style="background:${person.color}"></span><h3>${escapeHtml(person.name)}</h3></div><strong>★ ${balance}</strong></div><div class="goal-options">${goals.map((goal) => `<div class="goal-row"><div><strong>${escapeHtml(goal.title)}</strong><small>${Math.min(balance, goal.target)} of ${goal.target} stars</small></div><button class="task-delete" data-delete-goal="${goal.id}" aria-label="Delete ${escapeHtml(goal.title)} goal">×</button><progress value="${Math.min(Math.max(balance, 0), goal.target)}" max="${goal.target}"></progress></div>`).join('')}</div><div class="reward-options">${rewards.length ? rewards.map((reward) => `<div class="reward-option"><div><strong>${escapeHtml(reward.title)}</strong><small>★ ${reward.cost}</small></div><div><button class="secondary-button" data-redeem-reward="${reward.id}" ${balance < reward.cost ? 'disabled' : ''}>Redeem</button><button class="task-delete" data-delete-reward="${reward.id}" aria-label="Delete ${escapeHtml(reward.title)}">×</button></div></div>`).join('') : '<p class="empty-copy">No rewards yet.</p>'}</div></section>`;
    })
    .join('');
  $('#reward-history-list').innerHTML = state.data.rewardHistory.length
    ? state.data.rewardHistory
        .map(
          (entry) =>
            `<div class="reward-entry"><span>${escapeHtml(profile(entry.profileId)?.name || '')} · ${escapeHtml(entry.label)}</span><strong>${entry.stars > 0 ? '+' : ''}${entry.stars} ★</strong></div>`,
        )
        .join('')
    : '<p class="empty-copy">Complete a task to earn the first stars.</p>';
}

async function loadSignIns() {
  const target = $('#user-settings');
  if (!target || !state.data) return;
  try {
    const { mode, users } = await api('/api/users');
    const options = state.data.profiles
      .filter((person) => !['family', 'enve'].includes(person.id))
      .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
      .join('');
    if (!users.length) {
      target.innerHTML = `<p class="hint">No password is on. Anyone who can reach this server can open and change your household information. Turn on a sign-in here whenever you want; phones will then need to sign in.</p>
        <form id="activate-sign-in" class="account-form"><label>Sign-in style<select name="mode"><option value="shared">One password or PIN for everyone</option><option value="individual">Individual adult sign-ins</option></select></label>
          <label class="individual-field" hidden>Owner sign-in name<input name="username" autocomplete="username" placeholder="alex"></label>
          <label class="individual-field" hidden>Owner name<input name="displayName" placeholder="Your name"></label>
          <label class="individual-field" hidden>Owner profile<select name="profileId">${options}</select></label>
          <p class="hint individual-field" hidden>Each adult signs in separately. Everyone still sees the same calendars, tasks, and meals. Children can be people on the calendar without an account.</p>
          <label>Password or PIN<input name="password" type="password" minlength="4" maxlength="128" autocomplete="new-password" required></label>
          <button class="secondary-button">Turn on sign-in</button></form>`;
      updateAccessMode();
      return;
    }
    target.innerHTML = `<p class="hint">${
      mode === 'individual'
        ? 'Each adult signs in separately. The owner manages accounts and calendar connections. Everyone sees the same shared household information.'
        : 'Everyone uses one household password or PIN. The wall display opens automatically.'
    }</p>
      ${users.map((user) => `<div class="account-row sign-in-row"><span><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.username)} · ${user.role}</small></span><input type="password" minlength="4" maxlength="128" placeholder="New password or PIN" aria-label="New password for ${escapeHtml(user.displayName)}"><button data-reset-user="${user.id}">Change password</button>${user.role === 'owner' ? '' : `<button data-remove-user="${user.id}">Remove</button>`}</div>`).join('')}
      ${mode === 'shared' ? `<form id="switch-to-individual" class="account-form"><h4>Give adults separate sign-ins</h4><p class="hint">Your current household password becomes your own password. Choose your sign-in name, then add other adults below.</p><label>Your sign-in name<input name="username" minlength="3" maxlength="30" placeholder="alex" required></label><label>Your name<input name="displayName" maxlength="30" required></label><label>Your person on the calendar<select name="profileId">${options}</select></label><button class="secondary-button">Use individual sign-ins</button></form>` : ''}
      ${mode === 'individual' ? `<form id="add-adult-sign-in" class="account-form"><h4>Add an adult sign-in</h4><label>Name<input name="displayName" maxlength="30" required></label><label>Sign-in name<input name="username" minlength="3" maxlength="30" required></label><label>Person<select name="profileId">${options}</select></label><label>Password or PIN<input name="password" type="password" minlength="4" maxlength="128" autocomplete="new-password" required></label><button class="secondary-button">Add sign-in</button></form>` : ''}
      <div class="sign-in-off"><p class="hint">Want everyone on your private network to open Enve without a password? Turning sign-ins off removes all adult accounts. People and their calendar colors stay.</p><button type="button" class="secondary-button" data-disable-sign-in>Turn off sign-ins</button></div>`;
  } catch (cause) {
    target.innerHTML = `<p class="hint">${escapeHtml(cause.status === 403 ? 'Only the household owner can manage sign-ins.' : cause.message)}</p>`;
  }
}

async function loadIntegrationKeys() {
  const section = $('#integration-settings');
  try {
    const { keys } = await api('/api/integrations/keys');
    $('#integration-key-form').hidden = false;
    $('#integration-keys').innerHTML = keys.length
      ? keys
          .map(
            (key) =>
              `<div class="account-row"><span><strong>${escapeHtml(key.name)}</strong><small>${key.scope === 'read' ? 'View only' : 'View and add or edit'}</small></span><button type="button" data-remove-integration="${key.id}">Remove</button></div>`,
          )
          .join('')
      : '<p class="hint">No programs connected yet.</p>';
    section.hidden = false;
  } catch (cause) {
    $('#integration-key-form').hidden = true;
    $('#integration-secret').hidden = true;
    $('#integration-keys').textContent =
      cause.status === 403 ? 'Only the household owner can manage connections.' : cause.message;
  }
}

function updateAccessMode() {
  const form = $('#activate-sign-in');
  if (!form) return;
  const individual = form.elements.mode.value === 'individual';
  form.querySelectorAll('.individual-field').forEach((label) => {
    label.hidden = !individual;
    const field = label.querySelector('input,select');
    if (field) {
      field.disabled = !individual;
      field.required = individual;
    }
  });
}

function renderAccentSelection(color) {
  document.querySelectorAll('#accent-options [data-accent]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.accent === color));
  });
}

const settingsGroups = {
  calendars: [
    'YOUR CALENDARS',
    'Connected calendars',
    'Add an account for each person, then choose the calendars that appear on your wall display.',
  ],
  people: [
    'YOUR HOUSEHOLD',
    'People & access',
    'Set up family members, their colors, and how adults sign in.',
  ],
  display: [
    'YOUR SCREEN',
    'Display',
    'Choose the look of your calendar and what happens when the screen is idle.',
  ],
  daily: ['EVERYDAY DETAILS', 'Daily life', 'Keep weather and timely reminders close at hand.'],
  device: [
    'THIS DEVICE',
    'Device & data',
    'Manage this display’s network, backups, and connected programs.',
  ],
};

function showSettingsGroup(group) {
  state.settingsGroup = group;
  const [eyebrow, title, description] = settingsGroups[group];
  $('#settings-group-eyebrow').textContent = eyebrow;
  $('#settings-group-title').textContent = title;
  $('#settings-group-description').textContent = description;
  $('#settings-calendar-summary').hidden = group !== 'calendars';
  $('#settings-calendar-access').hidden = group !== 'calendars';
  document.querySelectorAll('.settings-nav [data-settings-group]').forEach((button) => {
    if (button.dataset.settingsGroup === group) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.settings-scroll [data-settings-page]').forEach((section) => {
    section.style.display = section.dataset.settingsPage === group ? '' : 'none';
  });
}

function renderSettings() {
  const {
    settings,
    profiles,
    accounts,
    calendars,
    googleConfigured,
    outlookAccounts,
    outlookCalendars,
    outlookConfigured,
    icloudAccounts,
    icloudCalendars,
    feedCalendars,
  } = state.data;
  const localConnect = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  $('#theme-setting').value = settings.theme;
  $('#light-at').value = settings.light_at;
  $('#dark-at').value = settings.dark_at;
  renderAccentSelection(settings.accent_color || '#F5921A');
  $('#dim-after').value = settings.dim_after_minutes;
  $('#dim-amount').value = settings.dim_amount;
  $('#night-dim-amount').value = settings.night_dim_amount || '100';
  $('#display-density').value = settings.display_density || 'comfortable';
  $('#text-size').value = settings.text_size || 'normal';
  $('#layout-mode').value = settings.layout_mode || 'auto';
  $('#night-dim').checked = settings.night_dim === 'true';
  $('#sleep-enabled').checked = settings.sleep_enabled === 'true';
  $('#sleep-at').value = settings.sleep_at;
  $('#wake-at').value = settings.wake_at;
  $('#reminders-enabled').checked = settings.reminders_enabled === 'true';
  $('#reminder-minutes').value = settings.reminder_minutes;
  $('#reminder-chime').checked = settings.reminder_chime === 'true';
  $('#weather-city').value = settings.weather_city || '';
  $('#weather-units').value = settings.weather_units || 'fahrenheit';
  $('#photos-enabled').checked = settings.photos_enabled === 'true';
  $('#photos-after').value = settings.photos_after_minutes || '5';
  $('#people-settings').innerHTML =
    `<div class="people-block"><label>Household name<div class="inline-form"><input id="household-name" value="${escapeHtml(settings.household_name || 'Our Family')}" maxlength="60"><button data-save-household class="secondary-button">Save</button></div></label></div>
    <div class="people-block">${profiles.map((person) => `<div class="person-row"><input type="color" value="${person.color}" data-color="${person.id}" aria-label="${escapeHtml(person.name)} color"><input type="text" value="${escapeHtml(person.name)}" maxlength="30" data-name="${person.id}" aria-label="Name"><button data-save-person="${person.id}">Save</button>${['family', 'enve'].includes(person.id) ? '' : `<button data-remove-person="${person.id}">Remove</button>`}</div>`).join('')}
    <form id="add-person-form" class="inline-form"><input name="name" placeholder="Add another person" maxlength="30" required><input name="color" type="color" value="#73BFC1" aria-label="New person color"><button class="secondary-button">Add person</button></form></div>
    <div class="people-block"><h3>Sign-ins</h3><div id="user-settings"><p class="hint">Loading sign-ins…</p></div></div>`;
  $('#google-settings').innerHTML = googleConfigured
    ? `${
        accounts
          .map(
            (account) =>
              `<div class="account-card"><div class="account-row"><div><strong>${escapeHtml(account.email)}</strong><small>Shown for ${escapeHtml(profile(account.profileId)?.name || 'Family')}</small></div><button data-disconnect="${account.id}">Disconnect</button></div><div class="account-calendars">${
                calendars
                  .filter((calendar) => calendar.accountId === account.id)
                  .map(
                    (calendar) =>
                      `<label class="calendar-row"><input type="checkbox" data-calendar-toggle="${calendar.id}" ${calendar.enabled ? 'checked' : ''}>${escapeHtml(calendar.name)}${calendar.writable ? '' : ' · read only'}</label>`,
                  )
                  .join('') || '<p class="hint">No calendars found in this account.</p>'
              }</div></div>`,
          )
          .join('') || '<p class="hint">No Google accounts connected yet.</p>'
      }<div class="connect-row"><label>Show for<select id="connect-profile">${profiles.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join('')}</select></label><button id="connect-google" class="secondary-button">Add Google account</button></div>`
    : '<p class="hint">Calendar sign-in is not configured on this server yet. Ask the household owner to finish setup.</p>';
  if ($('#connect-google')) $('#connect-google').disabled = !localConnect;
  $('#outlook-settings').innerHTML = outlookConfigured
    ? `${
        outlookAccounts
          .map(
            (account) =>
              `<div class="account-card"><div class="account-row"><div><strong>${escapeHtml(account.email)}</strong><small>Shown for ${escapeHtml(profile(account.profileId)?.name || 'Family')}</small></div><button data-disconnect-outlook="${account.id}">Disconnect</button></div><div class="account-calendars">${
                outlookCalendars
                  .filter((calendar) => calendar.accountId === account.id)
                  .map(
                    (calendar) =>
                      `<label class="calendar-row"><input type="checkbox" data-outlook-toggle="${calendar.id}" ${calendar.enabled ? 'checked' : ''}>${escapeHtml(calendar.name)}</label>`,
                  )
                  .join('') || '<p class="hint">No calendars found in this account.</p>'
              }</div></div>`,
          )
          .join('') || '<p class="hint">No Outlook accounts connected yet.</p>'
      }<div class="connect-row"><label>Show for<select id="outlook-profile">${profiles.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join('')}</select></label><button id="connect-outlook" class="secondary-button">Add Outlook account</button></div>`
    : '<p class="hint">Calendar sign-in is not configured on this server yet. Ask the household owner to finish setup.</p>';
  if ($('#connect-outlook')) $('#connect-outlook').disabled = !localConnect;
  $('#icloud-settings').innerHTML =
    icloudAccounts
      .map(
        (account) =>
          `<div class="account-card"><div class="account-row"><div><strong>${escapeHtml(account.email)}</strong><small>Shown for ${escapeHtml(profile(account.profileId)?.name || 'Family')}</small></div><button data-disconnect-icloud="${account.id}">Disconnect</button></div><div class="account-calendars">${
            icloudCalendars
              .filter((calendar) => calendar.accountId === account.id)
              .map(
                (calendar) =>
                  `<label class="calendar-row"><input type="checkbox" data-icloud-toggle="${calendar.id}" ${calendar.enabled ? 'checked' : ''}>${escapeHtml(calendar.name)}</label>`,
              )
              .join('') || '<p class="hint">No calendars found in this account.</p>'
          }</div></div>`,
      )
      .join('') || '<p class="hint">No iCloud accounts connected yet.</p>';
  $('#icloud-profile').innerHTML = profiles
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join('');
  $('#icloud-connect-form button').disabled = !localConnect;
  $('#feed-profile').innerHTML = $('#icloud-profile').innerHTML;
  $('#feed-settings').innerHTML =
    feedCalendars
      .map(
        (calendar) =>
          `<div class="account-row"><label class="calendar-row"><input type="checkbox" data-feed-toggle="${calendar.id}" ${calendar.enabled ? 'checked' : ''}>${escapeHtml(calendar.name)} · ${escapeHtml(profile(calendar.profileId)?.name || '')}</label><button data-delete-feed="${calendar.id}">Remove</button></div>`,
      )
      .join('') || '<p class="hint">No calendar URLs added.</p>';
  const accountCount = accounts.length + outlookAccounts.length + icloudAccounts.length;
  const calendarCount = [
    ...calendars,
    ...outlookCalendars,
    ...icloudCalendars,
    ...feedCalendars,
  ].filter((calendar) => calendar.enabled).length;
  $('#settings-calendar-summary').textContent =
    `${accountCount} connected account${accountCount === 1 ? '' : 's'} · ${calendarCount} calendar${calendarCount === 1 ? '' : 's'} shown`;
  $('#settings-calendar-access').textContent = localConnect
    ? 'You can add more Google, Outlook, and iCloud accounts here at any time.'
    : 'Add accounts on the Enve device. You can choose which connected calendars appear from here.';
  $('#entry-profile').innerHTML = profiles
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join('');
  $('#entry-calendar').innerHTML = `<option value="local">Enve Family (local)</option>${calendars
    .filter((calendar) => calendar.enabled && calendar.writable)
    .map(
      (calendar) => `<option value="${calendar.id}">Google · ${escapeHtml(calendar.name)}</option>`,
    )
    .join('')}${icloudCalendars
    .filter((calendar) => calendar.enabled)
    .map(
      (calendar) => `<option value="${calendar.id}">iCloud · ${escapeHtml(calendar.name)}</option>`,
    )
    .join('')}`;
  renderCalendarConnect();
  showSettingsGroup(state.settingsGroup);
}

function renderCalendarConnect() {
  const {
    profiles,
    accounts,
    calendars,
    outlookAccounts,
    outlookCalendars,
    outlookConfigured,
    icloudAccounts,
    icloudCalendars,
    feedCalendars,
    googleConfigured,
  } = state.data;
  const select = $('#calendar-connect-profile');
  const selected = select.value;
  select.innerHTML = profiles
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join('');
  select.value = profiles.some((person) => person.id === selected)
    ? selected
    : profiles.find((person) => !['family', 'enve'].includes(person.id))?.id || profiles[0]?.id;
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  $('#calendar-connect-google').disabled = !googleConfigured || !local;
  $('#calendar-google-help').textContent = !googleConfigured
    ? 'Google sign-in needs the server’s Google connection configured first.'
    : local
      ? 'Google will open in this browser and return here when approved.'
      : 'Connect on the Enve device to finish Google sign-in.';
  $('#calendar-connect-outlook').disabled = !outlookConfigured || !local;
  $('#calendar-outlook-help').textContent = !outlookConfigured
    ? 'Microsoft sign-in needs the server’s Outlook connection configured first.'
    : local
      ? 'Microsoft will open in this browser and return here when approved.'
      : 'Connect through the private localhost address on the Enve device to finish Microsoft sign-in.';
  $('#calendar-connect-icloud button[type=submit]').disabled = !local;
  $('#calendar-icloud-help').textContent = local
    ? 'Use the new app-specific password from Apple, not your normal Apple Account password.'
    : 'Connect on the Enve device so the password stays off the home network.';
  $('#calendar-connected-list').innerHTML =
    [
      ...accounts.map(
        (account) =>
          `<div class="account-row"><span>Google · ${escapeHtml(account.email)} · ${calendars.filter((calendar) => calendar.accountId === account.id).length} calendars</span><button type="button" data-manage-calendar="google">Manage</button></div>`,
      ),
      ...outlookAccounts.map(
        (account) =>
          `<div class="account-row"><span>Outlook · ${escapeHtml(account.email)} · ${outlookCalendars.filter((calendar) => calendar.accountId === account.id).length} calendars</span><button type="button" data-manage-calendar="outlook">Manage</button></div>`,
      ),
      ...icloudAccounts.map(
        (account) =>
          `<div class="account-row"><span>iCloud · ${escapeHtml(account.email)} · ${icloudCalendars.filter((calendar) => calendar.accountId === account.id).length} calendars</span><button type="button" data-manage-calendar="icloud">Manage</button></div>`,
      ),
      ...feedCalendars.map(
        (calendar) =>
          `<div class="account-row"><span>Calendar link · ${escapeHtml(calendar.name)}</span><button type="button" data-manage-calendar="feed">Manage</button></div>`,
      ),
    ].join('') ||
    '<p class="hint">No calendars connected yet. Choose a service above to get started.</p>';
}

function applyDisplay() {
  if (!state.data) return;
  const settings = state.data.settings;
  const accent = /^#[0-9a-fA-F]{6}$/.test(settings.accent_color || '')
    ? settings.accent_color
    : '#F5921A';
  document.documentElement.style.setProperty('--accent', accent);
  const now = new Date();
  const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const lightPeriod =
    settings.light_at <= settings.dark_at
      ? current >= settings.light_at && current < settings.dark_at
      : current >= settings.light_at || current < settings.dark_at;
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && !lightPeriod);
  document.body.dataset.theme = dark ? 'dark' : 'light';
  document.body.dataset.density = settings.display_density;
  document.body.dataset.textSize = settings.text_size;
  document.body.dataset.layout = settings.layout_mode;
  $('#app').style.filter = dark && settings.night_dim === 'true' ? 'brightness(.82)' : '';
  const idleMinutes = Number(settings.dim_after_minutes);
  const dim = idleMinutes > 0 && Date.now() - state.idleAt >= idleMinutes * 60000;
  const sleepWindow =
    settings.sleep_at < settings.wake_at
      ? current >= settings.sleep_at && current < settings.wake_at
      : current >= settings.sleep_at || current < settings.wake_at;
  const sleeping =
    settings.sleep_enabled === 'true' &&
    settings.sleep_at !== settings.wake_at &&
    sleepWindow &&
    Date.now() >= state.sleepOverrideUntil;
  const layer = $('#dim-layer');
  const nightSleep =
    state.dimPreview === 'night' ||
    sleeping ||
    (dim && !lightPeriod && settings.night_dim === 'true');
  const showPhoto =
    !state.dimPreview &&
    !nightSleep &&
    state.photos.length > 0 &&
    (state.photoPreview ||
      (!sleeping &&
        settings.photos_enabled === 'true' &&
        Date.now() - state.idleAt >= Number(settings.photos_after_minutes) * 60000));
  $('#photo-layer').hidden = !showPhoto;
  layer.hidden = showPhoto || !(dim || sleeping || state.dimPreview);
  document.body.dataset.nightSleep = String(nightSleep && !layer.hidden);
  const strength = nightSleep
    ? Number(settings.night_dim_amount || 100)
    : Number(settings.dim_amount);
  layer.dataset.darkest = String(nightSleep && strength === 100);
  layer.style.background = `rgba(0,0,0,${strength / 100})`;
  layer.style.color = nightSleep ? (strength === 100 ? '#181818' : '#686868') : '';
  $('#dim-clock').textContent = timeFormat.format(now);
}

function setEntryType(type) {
  state.entryType = type;
  $('#event-fields').hidden = type !== 'event';
  $('#task-fields').hidden = type !== 'task';
  $('#event-tab').classList.toggle('active', type === 'event');
  $('#task-tab').classList.toggle('active', type === 'task');
  $('#entry-dialog h2').textContent = type === 'event' ? 'New event' : 'New task';
  $('#entry-form [name=start]').required = type === 'event';
  $('#entry-form [name=end]').required = type === 'event';
  updateRepeatVisibility();
  updateClaimVisibility();
}

function updateClaimVisibility() {
  const eligible =
    state.entryType === 'task' &&
    $('#entry-profile').value === 'family' &&
    $('#task-fields [name=taskType]').value === 'chore';
  $('#claimable-row').hidden = !eligible;
  if (!eligible) $('#task-fields [name=claimable]').checked = false;
  updateRotationVisibility();
}

function updateRotationVisibility() {
  const first = $('#entry-profile').value;
  const eligible =
    state.entryType === 'task' &&
    $('#task-fields [name=taskType]').value === 'chore' &&
    $('#task-fields [name=repeatRule]').value !== 'none' &&
    !['family', 'enve'].includes(first);
  $('#task-rotation').hidden = !eligible;
  if (!eligible) return;
  const selected = new Set(
    [...document.querySelectorAll('#rotation-options input:checked')].map((input) => input.value),
  );
  $('#rotation-options').innerHTML = state.data.profiles
    .filter((person) => !['family', 'enve', first].includes(person.id))
    .map(
      (person) =>
        `<label><input type="checkbox" value="${escapeHtml(person.id)}" ${selected.has(person.id) ? 'checked' : ''}>${escapeHtml(person.name)}</label>`,
    )
    .join('');
}

function updateRepeatVisibility() {
  const local = $('#entry-calendar').value === 'local';
  $('#event-repeat').hidden =
    state.entryType !== 'event' ||
    !local ||
    Boolean(state.editingEvent?.seriesId && state.editingScope === 'occurrence');
  $('#event-repeat-until').disabled = $('#event-repeat-rule').value === 'none';
}

function openEntry(type = 'event', day = new Date(), editing = null, scope = 'series') {
  if (!state.data) return;
  state.editingEvent = editing;
  state.editingScope = scope;
  $('#entry-form').reset();
  $('#rotation-options').replaceChildren();
  $('#entry-form [name=start]').type = 'datetime-local';
  $('#entry-form [name=end]').type = 'datetime-local';
  renderSettings();
  setEntryType(type);
  $('.entry-tabs').hidden = Boolean(editing);
  $('#entry-dialog h2').textContent = editing
    ? 'Edit event'
    : type === 'event'
      ? 'New event'
      : 'New task';
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
  const end = new Date(start.getTime() + 3600000);
  const localInput = (date) =>
    `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  $('#entry-form [name=start]').value = localInput(start);
  $('#entry-form [name=end]').value = localInput(end);
  $('#entry-form [name=dueDate]').value = dateKey(day);
  if (editing) {
    const shown =
      scope === 'series' && editing.seriesId
        ? { ...editing, start: editing.seriesStart, end: editing.seriesEnd }
        : editing;
    $('#entry-form [name=title]').value = editing.title;
    $('#entry-form [name=profileId]').value = editing.profileId;
    $('#entry-form [name=calendarId]').value = editing.calendarId || 'local';
    $('#entry-form [name=calendarId]').disabled = true;
    $('#entry-form [name=notes]').value = editing.notes || '';
    $('#entry-form [name=allDay]').checked = shown.allDay;
    for (const field of ['start', 'end']) {
      const input = $(`#entry-form [name=${field}]`);
      if (shown.allDay) {
        input.type = 'date';
        input.value =
          field === 'end' ? dateKey(addDays(new Date(`${shown.end}T12:00:00`), -1)) : shown.start;
      } else input.value = localInput(new Date(shown[field]));
    }
  } else $('#entry-form [name=calendarId]').disabled = false;
  $('#event-repeat-rule').value =
    editing?.repeatRule && scope === 'series' ? editing.repeatRule : 'none';
  $('#event-repeat-until').value =
    editing?.repeatUntil && scope === 'series' ? editing.repeatUntil : '';
  updateRepeatVisibility();
  updateClaimVisibility();
  $('#entry-error').textContent = '';
  $('#entry-dialog').showModal();
  $('#entry-form [name=title]').focus();
}

async function saveSetting(key, value) {
  try {
    state.data.settings = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ [key]: value }),
    });
    applyDisplay();
    if (key === 'accent_color') renderAccentSelection(state.data.settings.accent_color);
  } catch (error) {
    showError(error.message);
  }
}

$('#today-button').addEventListener('click', () => {
  state.cursor = new Date();
  state.timelineKey = null;
  load();
});
$('#previous-week').addEventListener('click', () => moveCursor(-1));
$('#next-week').addEventListener('click', () => moveCursor(1));
$('#app').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-section]');
  if (button) {
    state.section = button.dataset.section;
    $('#more-sections').open = false;
    render();
  }
});
$('#add-task-page').addEventListener('click', () => openEntry('task'));
$('#calendar-section').addEventListener('click', (event) => {
  const button = event.target.closest('[data-add-day-task]');
  if (button) openEntry('task', new Date(`${button.dataset.addDayTask}T12:00:00`));
});
$('#tasks-status-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-task-status]');
  if (button) {
    state.taskStatus = button.dataset.taskStatus;
    renderTasksPage();
  }
});
$('#tasks-person-filter').addEventListener('change', (event) => {
  state.taskPerson = event.target.value;
  renderTasksPage();
});
$('#tasks-type-filter').addEventListener('change', (event) => {
  state.taskType = event.target.value;
  renderTasksPage();
});
document.querySelector('.view-picker').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) {
    state.view = button.dataset.view;
    $('#more-sections').open = false;
    load();
  }
});
$('#add-button').addEventListener('click', () => openEntry('event', state.cursor));
$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#import-message').textContent = 'Reading and finding drafts…';
  try {
    const file = $('#import-file').files[0];
    const payload = { type: $('#import-type').value, text: $('#import-text').value };
    if (file) {
      if (file.size > 5_000_000) throw new Error('Choose a file under 5 MB.');
      if (/\.(ics|txt)$/i.test(file.name) || ['text/plain', 'text/calendar'].includes(file.type))
        payload.text = await file.text();
      else
        payload.data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
    }
    const result = await api('/api/import/drafts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    $('#import-file').value = '';
    $('#import-text').value = result.text;
    state.importDrafts = result.drafts;
    renderImportDrafts();
    $('#import-message').textContent =
      result.message ||
      `${result.drafts.length} draft${result.drafts.length === 1 ? '' : 's'} found. Review each before saving.`;
  } catch (error) {
    $('#import-message').textContent = error.message;
  }
});
$('#dictate-import').addEventListener('click', () => {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $('#import-message').textContent =
      'Dictation is unavailable in this browser. Paste a transcript instead.';
    return;
  }
  const recognition = new Recognition();
  recognition.lang = navigator.language || 'en-US';
  recognition.onresult = (event) => {
    $('#import-text').value +=
      `${$('#import-text').value ? '\n' : ''}${event.results[0][0].transcript}`;
  };
  recognition.onerror = () => {
    $('#import-message').textContent =
      'Dictation could not start. Check browser microphone access.';
  };
  recognition.start();
});
$('#import-drafts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-import]');
  if (!button) return;
  state.importDrafts.splice(Number(button.dataset.removeImport), 1);
  renderImportDrafts();
});
$('#import-drafts').addEventListener('change', (event) => {
  if (!event.target.matches('[data-import-allday]')) return;
  const form = event.target.closest('form');
  for (const name of ['start', 'end']) {
    const input = form.elements[name];
    const day = input.value.slice(0, 10);
    input.type = event.target.checked ? 'date' : 'datetime-local';
    input.value = event.target.checked ? day : `${day}T09:00`;
  }
});
$('#import-drafts').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-import-draft]');
  if (!form) return;
  event.preventDefault();
  const index = Number(form.dataset.importDraft);
  const type = state.importDrafts[index].type;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (type === 'event') {
      data.allDay = form.elements.allDay.checked;
      data.localStart = data.start;
      data.localEnd = data.end;
      data.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!data.allDay) {
        data.start = new Date(data.start).toISOString();
        data.end = new Date(data.end).toISOString();
      }
      await api('/api/events', { method: 'POST', body: JSON.stringify(data) });
    } else {
      const path = { task: '/api/tasks', list: '/api/list-items', recipe: '/api/recipes' }[type];
      await api(path, { method: 'POST', body: JSON.stringify(data) });
    }
    state.importDrafts.splice(index, 1);
    renderImportDrafts();
    $('#import-message').textContent = 'Saved. Review the remaining drafts.';
    await load();
  } catch (error) {
    $('#import-message').textContent = error.message;
  }
});
$('#settings-button').addEventListener('click', () => {
  state.settingsGroup = 'calendars';
  renderSettings();
  $('#settings-dialog').showModal();
  loadSignIns();
  loadIntegrationKeys();
  loadWifiSettings();
  loadTailscaleSettings();
});
$('.settings-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-settings-group]');
  if (!button) return;
  showSettingsGroup(button.dataset.settingsGroup);
  $('#settings-scroll').scrollTop = 0;
});
$('#settings-dialog').addEventListener('close', () => {
  clearTimeout(tailscaleRefreshTimer);
  $('#integration-token').value = '';
  $('#integration-secret').hidden = true;
});
$('#integration-key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $('#integration-status');
  status.textContent = '';
  try {
    const result = await api('/api/integrations/keys', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    $('#integration-token').value = result.token;
    $('#integration-secret').hidden = false;
    status.textContent = 'Connection created. Copy its key before closing Settings.';
    form.reset();
    await loadIntegrationKeys();
  } catch (cause) {
    status.textContent = cause.message;
  }
});
$('#integration-copy').addEventListener('click', async () => {
  const input = $('#integration-token');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
    else {
      input.select();
      if (!document.execCommand('copy')) throw new Error('Copy unavailable.');
    }
    $('#integration-status').textContent = 'Key copied.';
  } catch {
    input.select();
    $('#integration-status').textContent = 'Select and copy the key manually.';
  }
});
$('#integration-keys').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-remove-integration]');
  if (!button) return;
  if (
    !(await askToDelete(
      'Remove this connection?',
      'The program will immediately lose access to Enve Family.',
      'Remove',
    ))
  )
    return;
  try {
    await api(`/api/integrations/keys/${button.dataset.removeIntegration}`, { method: 'DELETE' });
    await loadIntegrationKeys();
    $('#integration-status').textContent = 'Connection removed.';
  } catch (cause) {
    $('#integration-status').textContent = cause.message;
  }
});
$('#add-calendar-button').addEventListener('click', () => {
  $('#more-sections').open = false;
  renderCalendarConnect();
  $('#calendar-connect-dialog').showModal();
});
$('#calendar-connect-done').addEventListener('click', () => $('#calendar-connect-dialog').close());
$('#calendar-connect-google').addEventListener('click', () => {
  window.location.href = `/api/google/start?profileId=${encodeURIComponent($('#calendar-connect-profile').value)}`;
});
$('#calendar-connect-outlook').addEventListener('click', () => {
  window.location.href = `/api/outlook/start?profileId=${encodeURIComponent($('#calendar-connect-profile').value)}`;
});
$('#calendar-connect-feed').addEventListener('click', () => {
  $('#calendar-connect-dialog').close();
  state.settingsGroup = 'calendars';
  renderSettings();
  $('#settings-dialog').showModal();
  $('#feed-settings').scrollIntoView({ block: 'center' });
});
$('#calendar-connect-icloud').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true;
  $('#calendar-connect-status').textContent = 'Connecting to iCloud…';
  try {
    await api('/api/icloud/accounts', {
      method: 'POST',
      body: JSON.stringify({
        ...Object.fromEntries(new FormData(event.target)),
        profileId: $('#calendar-connect-profile').value,
      }),
    });
    event.target.reset();
    await load();
    $('#calendar-connect-status').textContent =
      'iCloud connected. Choose which calendars to show below.';
  } catch (error) {
    $('#calendar-connect-status').textContent = error.message;
  }
  button.disabled = false;
});
$('#calendar-connected-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-manage-calendar]');
  if (!button) return;
  $('#calendar-connect-dialog').close();
  state.settingsGroup = 'calendars';
  renderSettings();
  $('#settings-dialog').showModal();
  $(`#${button.dataset.manageCalendar}-settings`).scrollIntoView({ block: 'center' });
});
$('#settings-done').addEventListener('click', () => $('#settings-dialog').close());
$('#preview-dim').addEventListener('click', () => {
  $('#settings-dialog').close();
  state.dimPreview = 'day';
  applyDisplay();
});
$('#preview-night-dim').addEventListener('click', () => {
  $('#settings-dialog').close();
  state.dimPreview = 'night';
  applyDisplay();
});
document
  .querySelectorAll('[data-close]')
  .forEach((button) =>
    button.addEventListener('click', () => $(`#${button.dataset.close}`).close()),
  );
$('#event-tab').addEventListener('click', () => setEntryType('event'));
$('#task-tab').addEventListener('click', () => setEntryType('task'));
$('#entry-calendar').addEventListener('change', updateRepeatVisibility);
$('#event-repeat-rule').addEventListener('change', updateRepeatVisibility);
$('#entry-profile').addEventListener('change', updateClaimVisibility);
$('#task-fields [name=taskType]').addEventListener('change', updateClaimVisibility);
$('#task-fields [name=repeatRule]').addEventListener('change', updateRotationVisibility);
$('#entry-form [name=allDay]').addEventListener('change', (event) => {
  for (const field of ['start', 'end']) {
    const input = $(`#entry-form [name=${field}]`);
    const date = input.value.slice(0, 10);
    input.type = event.target.checked ? 'date' : 'datetime-local';
    input.value = event.target.checked ? date : `${date}T${field === 'start' ? '09:00' : '10:00'}`;
  }
});
$('#profile-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-profile]');
  if (!button) return;
  state.hiddenProfiles.has(button.dataset.profile)
    ? state.hiddenProfiles.delete(button.dataset.profile)
    : state.hiddenProfiles.add(button.dataset.profile);
  render();
});
let searchTimer;
$('#search-events').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchEvents, 180);
});
$('#search-events').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.target.value = '';
    searchEvents();
  }
});
$('#search-results').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-search-result]');
  if (!button) return;
  const item = state.searchResults[Number(button.dataset.searchResult)];
  if (!item) return;
  $('#search-events').value = '';
  $('#search-results').hidden = true;
  state.searchRequest++;
  state.cursor = item.allDay ? new Date(`${item.start}T12:00:00`) : new Date(item.start);
  state.view = 'day';
  await load();
  showEventDetail(state.data?.events.find((event) => event.id === item.id) || item);
});
$('#week-grid').addEventListener('click', (event) => {
  const meal = event.target.closest('[data-calendar-meal]');
  if (meal) {
    state.section = 'meals';
    state.cursor = new Date(`${meal.dataset.calendarMeal}T12:00:00`);
    load();
    return;
  }
  const button = event.target.closest('[data-event]');
  if (button) {
    const item = state.data.events.find((row) => row.id === button.dataset.event);
    if (item) showEventDetail(item);
    return;
  }
  const day =
    event.target.closest('[data-day]') ||
    (state.view === 'month' ? event.target.closest('[data-day-column]') : null);
  if (!day) return;
  state.cursor = new Date(`${day.dataset.day || day.dataset.dayColumn}T12:00:00`);
  state.view = 'day';
  load();
});
$('#edit-event').addEventListener('click', async () => {
  const item = state.selectedEvent;
  if (!item) return;
  const scope = item.seriesId ? await chooseSeriesScope('Edit') : 'series';
  if (!scope) return;
  $('#event-dialog').close();
  openEntry('event', new Date(item.start), item, scope);
});
$('#delete-event').addEventListener('click', async () => {
  const item = state.selectedEvent;
  if (!item) return;
  const scope = item.seriesId ? await chooseSeriesScope('Delete') : 'series';
  if (
    !scope ||
    !(await askToDelete(
      'Delete event?',
      scope === 'occurrence'
        ? 'Only this date will be removed from the repeating series.'
        : 'This event will be removed from its calendar.',
    ))
  )
    return;
  try {
    const endpoint =
      item.source === 'local'
        ? `/api/events/${encodeURIComponent(item.seriesId || item.id)}${scope === 'occurrence' ? `?occurrence=${item.occurrenceDate}` : ''}`
        : item.source === 'icloud'
          ? '/api/icloud/events'
          : `/api/google/events/${encodeURIComponent(item.calendarId)}/${encodeURIComponent(item.googleEventId)}`;
    await api(endpoint, {
      method: 'DELETE',
      ...(item.source === 'icloud'
        ? {
            body: JSON.stringify({ calendarId: item.calendarId, objectUrl: item.objectUrl }),
          }
        : {}),
    });
    $('#event-dialog').close();
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#app').addEventListener('change', async (event) => {
  if (
    !event.target.matches('[data-task]') ||
    !event.target.closest('#all-task-list, .day-task-list, .timeline')
  )
    return;
  const task = state.data.tasks.find((item) => item.id === event.target.dataset.task);
  const completed = event.target.checked;
  try {
    await api(`/api/tasks/${event.target.dataset.task}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed }),
    });
    await load();
    if (completed && task) celebrateTask(task);
  } catch (error) {
    event.target.checked = !event.target.checked;
    showError(error.message);
  }
});
$('#app').addEventListener('click', async (event) => {
  if (!event.target.closest('#all-task-list, .day-task-list')) return;
  const claim = event.target.closest('[data-claim-task]');
  if (claim) {
    const profileId = claim.closest('.task-row').querySelector('[data-claim-person]').value;
    try {
      await api(`/api/tasks/${claim.dataset.claimTask}`, {
        method: 'PATCH',
        body: JSON.stringify({ claimProfileId: profileId }),
      });
      await load();
    } catch (error) {
      showError(error.message);
    }
    return;
  }
  const skip = event.target.closest('[data-skip-task]');
  if (skip) {
    try {
      await api(`/api/tasks/${skip.dataset.skipTask}`, {
        method: 'PATCH',
        body: JSON.stringify({ skipped: true }),
      });
      await load();
    } catch (error) {
      showError(error.message);
    }
    return;
  }
  const button = event.target.closest('[data-delete-task]');
  if (
    !button ||
    !(await askToDelete('Delete task?', 'This task will be removed from your household list.'))
  )
    return;
  try {
    await api(`/api/tasks/${button.dataset.deleteTask}`, { method: 'DELETE' });
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#new-list-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = new FormData(event.target).get('name');
  try {
    await api('/api/lists', { method: 'POST', body: JSON.stringify({ name }) });
    event.target.reset();
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#lists-grid').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-add-item]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const list = state.data.lists.find((item) => item.id === form.dataset.addItem);
  try {
    if (
      await createOrQueue(
        '/api/list-items',
        { listId: form.dataset.addItem, title: data.get('title'), section: data.get('section') },
        `${list?.name || 'List'} · ${data.get('title')}`,
      )
    )
      await load();
    else form.reset();
  } catch (error) {
    showError(error.message);
  }
});
$('#lists-grid').addEventListener('change', async (event) => {
  if (event.target.matches('[data-list-sort]')) {
    try {
      await api(`/api/lists/${event.target.dataset.listSort}`, {
        method: 'PATCH',
        body: JSON.stringify({ sortOrder: event.target.value }),
      });
      await load();
    } catch (error) {
      showError(error.message);
    }
    return;
  }
  if (!event.target.matches('[data-list-item]')) return;
  try {
    await api(`/api/list-items/${event.target.dataset.listItem}`, {
      method: 'PATCH',
      body: JSON.stringify({ checked: event.target.checked }),
    });
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#lists-grid').addEventListener('click', async (event) => {
  const item = event.target.closest('[data-delete-item]');
  const list = event.target.closest('[data-delete-list]');
  if (!item && !list) return;
  if (
    !(await askToDelete(
      item ? 'Delete item?' : 'Delete list?',
      item ? 'This item will be removed.' : 'The list and all its items will be removed.',
    ))
  )
    return;
  try {
    await api(
      item ? `/api/list-items/${item.dataset.deleteItem}` : `/api/lists/${list.dataset.deleteList}`,
      { method: 'DELETE' },
    );
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#add-meal').addEventListener('click', () => openMeal());
$('#meal-recipe-options').addEventListener('change', syncMealTitle);
$('#meal-repeat-rule').addEventListener('change', updateMealRepeat);
$('#meal-entry-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const editing = state.editingMeal;
  const payload = {
    day: form.elements.day.value,
    category: form.elements.category.value,
    title: form.elements.title.value.trim(),
    notes: form.elements.notes.value,
    recipeIds: selectedMealRecipes(),
    servings: Number(form.elements.servings.value),
  };
  if (!editing) {
    payload.repeatRule = form.elements.repeatRule.value;
    if (payload.repeatRule !== 'none' && form.elements.repeatUntil.value)
      payload.repeatUntil = form.elements.repeatUntil.value;
  }
  try {
    if (editing)
      await api(`/api/meals/${encodeURIComponent(editing.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    else if (
      !(await createOrQueue(
        '/api/meals',
        payload,
        `Meal · ${payload.title || selectedRecipeNames()}`,
      ))
    ) {
      $('#meal-dialog').close();
      return;
    }
    $('#meal-dialog').close();
    await load();
  } catch (error) {
    $('#meal-error').textContent = error.message;
  }
});
$('#delete-meal').addEventListener('click', async () => {
  try {
    if (await deleteMeal(state.editingMeal)) $('#meal-dialog').close();
  } catch (error) {
    $('#meal-error').textContent = error.message;
  }
});
$('#meal-labels').addEventListener('toggle', () => {
  if ($('#meal-labels').open) {
    renderMealCategorySettings();
    $('#meal-category-status').textContent = '';
  }
});
$('#save-meal-categories').addEventListener('click', async () => {
  const categories = [...document.querySelectorAll('[data-meal-category]')].map((row) => ({
    id: row.dataset.mealCategory,
    name: row.querySelector('[name=name]').value.trim(),
    color: row.querySelector('[name=color]').value,
    enabled: row.querySelector('[name=enabled]').checked,
  }));
  try {
    await api('/api/meal-categories', { method: 'PATCH', body: JSON.stringify(categories) });
    $('#meal-category-status').textContent = 'Labels saved.';
    await load();
    renderMealCategorySettings();
  } catch (error) {
    $('#meal-category-status').textContent = error.message;
  }
});
$('#meal-suggestion-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const source = form.get('source');
  const ideas = source !== 'saved';
  try {
    const result = await api(ideas ? '/api/meals/ideas' : '/api/meals/suggestions', {
      method: 'POST',
      body: JSON.stringify({
        startDay: dateKey(startOfWeek(state.cursor)),
        categories: form.getAll('category'),
        servings: Number(form.get('servings')),
        avoid: form.get('avoid'),
        ...(ideas ? { source } : {}),
      }),
    });
    state.mealSuggestions = result.suggestions;
    renderMealSuggestions(startOfWeek(state.cursor), 7);
    if (!result.suggestions.length)
      $('#meal-suggestions').innerHTML =
        '<p class="empty-copy">Every chosen meal already has a plan this week.</p>';
  } catch (error) {
    showError(error.message);
  }
});
$('#meal-suggestions').addEventListener('click', (event) => {
  if (event.target.id !== 'discard-suggestions') return;
  state.mealSuggestions = [];
  renderMealSuggestions(startOfWeek(state.cursor), 7);
});
$('#meal-suggestions').addEventListener('submit', async (event) => {
  if (event.target.id !== 'suggestion-review') return;
  event.preventDefault();
  const field = (name, index) => event.target.querySelector(`[data-${name}="${index}"]`).value;
  const meals = weekSuggestions(startOfWeek(state.cursor), 7).flatMap((meal, index) => {
    if (!event.target.querySelector(`[data-suggested="${index}"]`).checked) return [];
    const servings = Number(field('servings', index));
    const planned = {
      day: meal.day,
      category: meal.category,
      servings,
      notes: field('notes', index),
    };
    return [
      meal.draftRecipe
        ? {
            ...planned,
            draftRecipe: {
              title: field('draft-title', index),
              ingredients: field('draft-ingredients', index),
              directions: field('draft-directions', index),
              servings,
            },
          }
        : { ...planned, recipeId: field('recipe', index) },
    ];
  });
  if (!meals.length) {
    showError('Choose at least one meal.');
    return;
  }
  try {
    await api('/api/meals/plan', { method: 'POST', body: JSON.stringify({ meals }) });
    state.mealSuggestions = [];
    await load();
    renderMealSuggestions(startOfWeek(state.cursor), 7);
    $('#meal-status').textContent =
      `${meals.length} meal${meals.length === 1 ? '' : 's'} added to the plan.`;
  } catch (error) {
    showError(error.message);
  }
});
$('#meal-groceries').addEventListener('click', async () => {
  const mealIds = weekRecipeMeals().map((meal) => meal.id);
  if (!mealIds.length) return;
  try {
    const result = await api('/api/meals/groceries', {
      method: 'POST',
      body: JSON.stringify({ mealIds }),
    });
    const added = result.added || 0;
    const updated = result.updated || 0;
    $('#meal-status').textContent =
      added || updated
        ? `Groceries: ${added} added${updated ? `, ${updated} quantit${updated === 1 ? 'y' : 'ies'} updated` : ''}.`
        : 'Groceries already have everything for this week’s recipes.';
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#meal-grid').addEventListener('click', async (event) => {
  const add = event.target.closest('[data-add-meal]');
  if (add) {
    openMeal(new Date(`${add.dataset.addMeal}T12:00:00`));
    return;
  }
  const button = event.target.closest('[data-edit-meal],[data-delete-meal]');
  const meal =
    button &&
    state.data.meals.find(
      (item) => item.id === (button.dataset.editMeal || button.dataset.deleteMeal),
    );
  if (!meal) return;
  if (button.dataset.editMeal) {
    openMeal(undefined, meal);
    return;
  }
  try {
    await deleteMeal(meal);
  } catch (error) {
    showError(error.message);
  }
});
$('#recipe-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  try {
    const file = event.target.elements.photoFile.files[0];
    if (file) {
      if (file.size > 5_000_000 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
        throw new Error('Choose a recipe photo under 5 MB.');
      const encoded = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const photo = await api('/api/photos', {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          mime: file.type,
          data: encoded,
          purpose: 'recipe',
        }),
      });
      data.photoId = photo.id;
    }
    delete data.photoFile;
    await api(state.editingRecipe ? `/api/recipes/${state.editingRecipe}` : '/api/recipes', {
      method: state.editingRecipe ? 'PATCH' : 'POST',
      body: JSON.stringify(data),
    });
    state.editingRecipe = null;
    event.target.reset();
    $('#save-recipe').textContent = 'Save recipe';
    $('#cancel-recipe-edit').hidden = true;
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#cancel-recipe-edit').addEventListener('click', () => {
  state.editingRecipe = null;
  $('#recipe-form').reset();
  $('#save-recipe').textContent = 'Save recipe';
  $('#cancel-recipe-edit').hidden = true;
});
$('#recipes-grid').addEventListener('click', async (event) => {
  const button = event.target.closest(
    '[data-plan-recipe],[data-grocery-recipe],[data-edit-recipe],[data-delete-recipe]',
  );
  if (!button) return;
  const id =
    button.dataset.planRecipe ||
    button.dataset.groceryRecipe ||
    button.dataset.editRecipe ||
    button.dataset.deleteRecipe;
  const recipe = state.data.recipes.find((item) => item.id === id);
  if (!recipe) return;
  if (button.dataset.planRecipe) {
    openMeal(undefined, null, recipe.id);
    return;
  }
  if (button.dataset.editRecipe) {
    state.editingRecipe = id;
    for (const field of ['title', 'ingredients', 'directions'])
      $('#recipe-form [name=' + field + ']').value = recipe[field];
    $('#recipe-form [name=servings]').value = recipe.servings || 4;
    $('#recipe-form [name=photoId]').value = recipe.photo_id || '';
    $('#save-recipe').textContent = 'Save changes';
    $('#cancel-recipe-edit').hidden = false;
    $('#recipe-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#recipe-form [name=title]').focus();
    return;
  }
  if (
    button.dataset.deleteRecipe &&
    !(await askToDelete('Delete recipe?', `${recipe.title} will be removed from the recipe box.`))
  )
    return;
  try {
    await api(
      button.dataset.groceryRecipe ? `/api/recipes/${id}/groceries` : `/api/recipes/${id}`,
      {
        method: button.dataset.groceryRecipe ? 'POST' : 'DELETE',
        ...(button.dataset.groceryRecipe
          ? {
              body: JSON.stringify({
                servings: state.recipeServings.get(id) || recipe.servings || 4,
              }),
            }
          : {}),
      },
    );
    if (button.dataset.groceryRecipe) state.section = 'lists';
    if (state.editingRecipe === id) $('#cancel-recipe-edit').click();
    await load();
    if (button.dataset.groceryRecipe) window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    showError(error.message);
  }
});
$('#recipes-grid').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-recipe-servings]');
  if (!select) return;
  const id = select.dataset.recipeServings;
  const servings = Number(select.value);
  state.recipeServings.set(id, servings);
  const recipe = state.data.recipes.find((item) => item.id === id);
  if (servings !== recipe.servings) {
    try {
      const result = await api(`/api/recipes/${id}/scale?servings=${servings}`);
      state.recipeScaled.set(`${id}:${servings}`, result.ingredients);
    } catch (error) {
      showError(error.message);
    }
  }
  renderRecipes();
});
$('#reward-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/rewards', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
    });
    event.target.querySelector('[name=title]').value = '';
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#goal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/goals', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
    });
    event.target.querySelector('[name=title]').value = '';
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#rewards-grid').addEventListener('click', async (event) => {
  const goal = event.target.closest('[data-delete-goal]');
  if (goal) {
    if (
      !(await askToDelete(
        'Delete goal?',
        'This savings goal will be removed. Earned stars stay available.',
      ))
    )
      return;
    try {
      await api(`/api/goals/${goal.dataset.deleteGoal}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      showError(error.message);
    }
    return;
  }
  const redeem = event.target.closest('[data-redeem-reward]');
  const remove = event.target.closest('[data-delete-reward]');
  if (!redeem && !remove) return;
  const reward = state.data.rewards.find(
    (item) => item.id === (redeem?.dataset.redeemReward || remove.dataset.deleteReward),
  );
  if (!reward) return;
  if (
    !(await askToDelete(
      redeem ? 'Redeem reward?' : 'Delete reward?',
      redeem
        ? `${profile(reward.profileId)?.name || 'This person'} will spend ${reward.cost} stars on ${reward.title}.`
        : `${reward.title} will be removed. Past redemptions stay in the history.`,
      redeem ? 'Redeem' : 'Delete',
    ))
  )
    return;
  try {
    await api(redeem ? `/api/rewards/${reward.id}/redeem` : `/api/rewards/${reward.id}`, {
      method: redeem ? 'POST' : 'DELETE',
    });
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#entry-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const data = Object.fromEntries(form);
  try {
    if (state.entryType === 'task') {
      data.repeatRule = $('#task-fields [name=repeatRule]').value;
      if (!$('#task-rotation').hidden) {
        const others = [...document.querySelectorAll('#rotation-options input:checked')].map(
          (input) => input.value,
        );
        if (others.length) data.rotationProfiles = [data.profileId, ...others];
      }
      if (!(await createOrQueue('/api/tasks', data, `Task · ${data.title}`))) {
        $('#entry-dialog').close();
        return;
      }
    } else {
      const allDay = form.has('allDay');
      const payload = {
        ...data,
        allDay,
        localStart: data.start,
        localEnd: data.end,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        repeatRule: $('#event-repeat-rule').value,
      };
      if (allDay) payload.end = dateKey(addDays(new Date(`${data.end}T12:00:00`), 1));
      else {
        payload.start = new Date(data.start).toISOString();
        payload.end = new Date(data.end).toISOString();
      }
      const editing = state.editingEvent;
      if (editing) {
        payload.calendarId = editing.calendarId;
        payload.objectUrl = editing.objectUrl;
      }
      const endpoint =
        editing?.source === 'local'
          ? `/api/events/${encodeURIComponent(editing.seriesId || editing.id)}${state.editingScope === 'occurrence' ? `?occurrence=${editing.occurrenceDate}` : ''}`
          : editing?.source === 'google'
            ? `/api/google/events/${encodeURIComponent(editing.calendarId)}/${encodeURIComponent(editing.googleEventId)}`
            : editing?.source === 'icloud'
              ? '/api/icloud/events'
              : data.calendarId === 'local'
                ? '/api/events'
                : state.data.icloudCalendars.some((calendar) => calendar.id === data.calendarId)
                  ? '/api/icloud/events'
                  : '/api/google/events';
      if (endpoint === '/api/events') {
        if (!(await createOrQueue(endpoint, payload, `Event · ${payload.title}`))) {
          $('#entry-dialog').close();
          return;
        }
      } else
        await api(endpoint, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    }
    $('#entry-dialog').close();
    await load();
  } catch (error) {
    $('#entry-error').textContent = error.message;
  }
});
for (const [selector, key] of [
  ['#theme-setting', 'theme'],
  ['#light-at', 'light_at'],
  ['#dark-at', 'dark_at'],
  ['#dim-after', 'dim_after_minutes'],
  ['#dim-amount', 'dim_amount'],
  ['#night-dim-amount', 'night_dim_amount'],
  ['#display-density', 'display_density'],
  ['#text-size', 'text_size'],
  ['#layout-mode', 'layout_mode'],
  ['#sleep-at', 'sleep_at'],
  ['#wake-at', 'wake_at'],
  ['#reminder-minutes', 'reminder_minutes'],
]) {
  $(selector).addEventListener('change', (event) => saveSetting(key, event.target.value));
}
$('#accent-options').addEventListener('click', (event) => {
  const button = event.target.closest('[data-accent]');
  if (button) saveSetting('accent_color', button.dataset.accent);
});
$('#weather-city').addEventListener('change', async (event) => {
  await saveSetting('weather_city', event.target.value.trim());
  loadWeather();
});
$('#weather-units').addEventListener('change', async (event) => {
  await saveSetting('weather_units', event.target.value);
  loadWeather();
});
$('#photos-enabled').addEventListener('change', (event) =>
  saveSetting('photos_enabled', String(event.target.checked)),
);
$('#photos-after').addEventListener('change', (event) =>
  saveSetting('photos_after_minutes', event.target.value),
);
$('#photo-upload').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 5_000_000 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    showError('Choose a JPEG, PNG, or WebP under 5 MB.');
    return;
  }
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await api('/api/photos', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, mime: file.type, data }),
    });
    event.target.value = '';
    await loadPhotos();
  } catch (error) {
    showError(error.message);
  }
});
$('#photo-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-photo]');
  if (
    !button ||
    !(await askToDelete('Remove photo?', 'This photo will be removed from the local dashboard.'))
  )
    return;
  try {
    await api(`/api/photos/${button.dataset.deletePhoto}`, { method: 'DELETE' });
    await loadPhotos();
  } catch (error) {
    showError(error.message);
  }
});
$('#preview-photos').addEventListener('click', () => {
  if (!state.photos.length) {
    showError('Add a photo first.');
    return;
  }
  $('#settings-dialog').close();
  state.photoPreview = true;
  updatePhoto();
  applyDisplay();
});
$('#pin-save').addEventListener('click', async () => {
  const pin = $('#pin-new').value;
  if (!/^\d{4,8}$/.test(pin)) {
    showError('Choose a 4–8 digit PIN.');
    return;
  }
  try {
    await api('/api/pin', { method: 'POST', body: JSON.stringify({ pin }) });
    $('#pin-new').value = '';
    await loadPinStatus();
  } catch (error) {
    showError(error.message);
  }
});
$('#pin-remove').addEventListener('click', async () => {
  if (
    !(await askToDelete(
      'Remove edit PIN?',
      'Anyone who can open this dashboard will be able to edit household data.',
      'Remove PIN',
    ))
  )
    return;
  try {
    await api('/api/pin', { method: 'DELETE' });
    await loadPinStatus();
  } catch (error) {
    showError(error.message);
  }
});
$('#download-backup').addEventListener('click', async () => {
  try {
    const data = await api('/api/backup');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `enve-family-${dateKey(new Date())}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    showError(error.message);
  }
});
$('#restore-backup').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 30_000_000) {
    showError('Backup file is too large.');
    return;
  }
  if (
    !(await askToDelete(
      'Restore backup?',
      'This replaces local household events, tasks, lists, meals, rewards, photos, and display settings. Connected calendar accounts stay connected.',
      'Restore',
    ))
  )
    return;
  try {
    const backup = JSON.parse(await file.text());
    await api('/api/restore', { method: 'POST', body: JSON.stringify(backup) });
    await load();
    await loadPhotos();
    await loadWeather();
  } catch (error) {
    showError(error.message);
  }
});
$('#night-dim').addEventListener('change', (event) =>
  saveSetting('night_dim', String(event.target.checked)),
);
$('#sleep-enabled').addEventListener('change', (event) =>
  saveSetting('sleep_enabled', String(event.target.checked)),
);
$('#reminders-enabled').addEventListener('change', (event) =>
  saveSetting('reminders_enabled', String(event.target.checked)),
);
$('#reminder-chime').addEventListener('change', (event) =>
  saveSetting('reminder_chime', String(event.target.checked)),
);
$('#reminder-dismiss').addEventListener('click', showNextReminder);
$('#people-settings').addEventListener('click', async (event) => {
  const button = event.target.closest(
    '[data-save-person],[data-remove-person],[data-save-household],[data-remove-user],[data-reset-user],[data-disable-sign-in]',
  );
  if (!button) return;
  try {
    if (button.dataset.disableSignIn !== undefined) {
      if (
        !(await askToDelete(
          'Open Enve without a password?',
          'Anyone who can reach this server will be able to view and change calendars, tasks, and settings. All adult sign-ins will be removed; people and calendar colors stay.',
          'Turn off sign-ins',
        ))
      )
        return;
      await api('/api/users/disable', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    } else if (button.dataset.saveHousehold !== undefined) {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ household_name: $('#household-name').value }),
      });
    } else if (button.dataset.savePerson) {
      const id = button.dataset.savePerson;
      await api(`/api/profiles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $(`[data-name="${id}"]`).value,
          color: $(`[data-color="${id}"]`).value,
        }),
      });
    } else if (button.dataset.removePerson) {
      if (
        !(await askToDelete(
          'Remove this person?',
          'This works only after their events, tasks, and sign-in have been moved or removed.',
        ))
      )
        return;
      await api(`/api/profiles/${button.dataset.removePerson}`, { method: 'DELETE' });
    } else if (button.dataset.removeUser) {
      if (
        !(await askToDelete(
          'Remove this sign-in?',
          'This adult will no longer be able to sign in. Their calendar profile stays.',
        ))
      )
        return;
      await api(`/api/users/${button.dataset.removeUser}`, { method: 'DELETE' });
    } else if (button.dataset.resetUser) {
      const input = button.closest('.account-row').querySelector('input[type=password]');
      await api(`/api/users/${button.dataset.resetUser}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: input.value }),
      });
    }
    await load();
    loadSignIns();
  } catch (error) {
    showError(error.message);
  }
});
$('#people-settings').addEventListener('submit', async (event) => {
  const form = event.target;
  if (
    !['add-person-form', 'activate-sign-in', 'add-adult-sign-in', 'switch-to-individual'].includes(
      form.id,
    )
  )
    return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'add-person-form')
      await api('/api/profiles', { method: 'POST', body: JSON.stringify(data) });
    else if (form.id === 'activate-sign-in') {
      data.mode = form.elements.mode.value;
      await api('/api/users/activate', { method: 'POST', body: JSON.stringify(data) });
    } else if (form.id === 'switch-to-individual') {
      await api('/api/users/individual', { method: 'POST', body: JSON.stringify(data) });
    } else await api('/api/users', { method: 'POST', body: JSON.stringify(data) });
    await load();
    loadSignIns();
  } catch (error) {
    showError(error.message);
  }
});
$('#people-settings').addEventListener('change', (event) => {
  if (event.target.name === 'mode') updateAccessMode();
});
$('#google-settings').addEventListener('click', async (event) => {
  if (event.target.id === 'connect-google') {
    window.location.href = `/api/google/start?profileId=${encodeURIComponent($('#connect-profile').value)}`;
    return;
  }
  const disconnect = event.target.closest('[data-disconnect]');
  if (
    disconnect &&
    (await askToDelete(
      'Disconnect Google?',
      'This account and its calendars will be removed from Enve Family. Google Calendar events will remain in Google.',
    ))
  ) {
    try {
      await api(`/api/google/accounts/${disconnect.dataset.disconnect}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      showError(error.message);
    }
  }
});
$('#google-settings').addEventListener('change', async (event) => {
  const checkbox = event.target.closest('[data-calendar-toggle]');
  if (!checkbox) return;
  try {
    await api(`/api/google/calendars/${checkbox.dataset.calendarToggle}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: checkbox.checked }),
    });
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#outlook-settings').addEventListener('click', async (event) => {
  if (event.target.id === 'connect-outlook') {
    window.location.href = `/api/outlook/start?profileId=${encodeURIComponent($('#outlook-profile').value)}`;
    return;
  }
  const disconnect = event.target.closest('[data-disconnect-outlook]');
  if (
    disconnect &&
    (await askToDelete(
      'Disconnect Outlook?',
      'This account and its calendars will be removed from Enve Family. Outlook events will remain in Outlook.',
    ))
  ) {
    try {
      await api(`/api/outlook/accounts/${disconnect.dataset.disconnectOutlook}`, {
        method: 'DELETE',
      });
      await load();
    } catch (error) {
      showError(error.message);
    }
  }
});
$('#outlook-settings').addEventListener('change', async (event) => {
  const checkbox = event.target.closest('[data-outlook-toggle]');
  if (!checkbox) return;
  try {
    await api(`/api/outlook/calendars/${checkbox.dataset.outlookToggle}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: checkbox.checked }),
    });
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#icloud-connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#icloud-error').textContent = '';
  try {
    await api('/api/icloud/accounts', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
    });
    event.target.reset();
    await load();
  } catch (error) {
    $('#icloud-error').textContent = error.message;
  }
});
$('#icloud-settings').addEventListener('click', async (event) => {
  const disconnect = event.target.closest('[data-disconnect-icloud]');
  if (
    disconnect &&
    (await askToDelete(
      'Disconnect iCloud?',
      'This account and its saved app-specific password will be removed from Enve Family. iCloud events will remain in iCloud.',
    ))
  ) {
    try {
      await api(`/api/icloud/accounts/${disconnect.dataset.disconnectIcloud}`, {
        method: 'DELETE',
      });
      await load();
    } catch (error) {
      showError(error.message);
    }
  }
});
$('#icloud-settings').addEventListener('change', async (event) => {
  const checkbox = event.target.closest('[data-icloud-toggle]');
  if (!checkbox) return;
  try {
    await api(`/api/icloud/calendars/${checkbox.dataset.icloudToggle}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: checkbox.checked }),
    });
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#feed-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/feed-calendars', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
    });
    event.target.reset();
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#feed-settings').addEventListener('change', async (event) => {
  const checkbox = event.target.closest('[data-feed-toggle]');
  if (!checkbox) return;
  try {
    await api(`/api/feed-calendars/${checkbox.dataset.feedToggle}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: checkbox.checked }),
    });
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#feed-settings').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-feed]');
  if (
    !button ||
    !(await askToDelete(
      'Remove calendar URL?',
      'This subscription will be removed from Enve Family.',
    ))
  )
    return;
  try {
    await api(`/api/feed-calendars/${button.dataset.deleteFeed}`, { method: 'DELETE' });
    await load();
  } catch (error) {
    showError(error.message);
  }
});
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#login-name').value.trim(),
        key: $('#access-key').value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    $('#login-dialog').close();
    $('#access-key').value = '';
    await load();
    connectChanges();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});
let wakeBlockUntil = 0;
function wakeDisplay(event) {
  if (!state.data) return;
  const covered = !$('#dim-layer').hidden || !$('#photo-layer').hidden;
  state.idleAt = Date.now();
  if (covered) {
    state.sleepOverrideUntil = state.idleAt + 15 * 60000;
    state.photoPreview = false;
    state.dimPreview = null;
    wakeBlockUntil = state.idleAt + 500;
  }
  if (covered || (event.type !== 'mousemove' && state.idleAt < wakeBlockUntil)) {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  }
  applyDisplay();
}
for (const eventName of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click']) {
  document.addEventListener(eventName, wakeDisplay, { capture: true });
}
document.addEventListener(
  'mousemove',
  (event) => {
    if (!$('#dim-layer').hidden || !$('#photo-layer').hidden) wakeDisplay(event);
    else state.idleAt = Date.now();
  },
  { capture: true },
);
document.addEventListener(
  'wheel',
  () => {
    state.idleAt = Date.now();
  },
  { passive: true },
);
function tick() {
  const now = new Date();
  $('#clock').textContent = timeFormat.format(now);
  const today = dateKey(now);
  if (today !== state.todayKey) {
    state.todayKey = today;
    state.cursor = now;
    load();
    loadReminders();
  }
  if (state.data) {
    applyDisplay();
    if (state.section === 'calendar') {
      renderCountdown();
      updateNowLine();
    }
    checkReminders();
  }
}
tick();
setInterval(tick, 30000);
setInterval(applyDisplay, 1000);
setInterval(() => {
  if (state.data) {
    load();
    loadReminders();
  }
}, 120000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.data) {
    load();
    loadReminders();
  }
});
window.addEventListener('online', () => {
  if (state.data) load();
});
window.addEventListener('offline', () => setConnection(false));
window.addEventListener('storage', (event) => {
  if (event.key === outboxKey) renderConnection();
});
$('#connection-status').addEventListener('click', () => $('#outbox-dialog').showModal());
$('#outbox-list').addEventListener('click', async (event) => {
  const resend = event.target.closest('[data-resend]');
  const discard = event.target.closest('[data-discard]');
  if (resend) {
    updateOutboxItem(resend.dataset.resend, { attempted: false });
    flushOutbox();
  }
  if (
    discard &&
    (await askToDelete(
      'Discard change?',
      'This change has not been confirmed by the server and will be removed from this device.',
      'Discard',
    ))
  ) {
    updateOutboxItem(discard.dataset.discard, null);
  }
});
renderConnection();
setInterval(loadWeather, 30 * 60000);
setInterval(() => {
  if (state.photos.length) {
    state.photoIndex = (state.photoIndex + 1) % state.photos.length;
    updatePhoto();
  }
}, 20000);
openWallDisplay()
  .then(load)
  .then(() => {
    if (state.data) {
      connectChanges();
      loadReminders();
      loadWeather();
      loadPhotos();
      loadPinStatus();
      if (
        sessionStorage.getItem('enve-open-calendar-settings') ||
        new URLSearchParams(location.search).has('connected')
      ) {
        sessionStorage.removeItem('enve-open-calendar-settings');
        renderCalendarConnect();
        $('#calendar-connect-dialog').showModal();
        if (new URLSearchParams(location.search).has('connected')) {
          const provider =
            new URLSearchParams(location.search).get('connected') === 'outlook'
              ? 'Outlook'
              : 'Google';
          $('#calendar-connect-status').textContent =
            `${provider} connected. Choose which calendars to show below.`;
          history.replaceState(null, '', '/');
        }
      }
    }
  });
if (window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
