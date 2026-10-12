const form = document.querySelector('#setup-form');
const steps = [...document.querySelectorAll('.step')];
const error = document.querySelector('#setup-error');
let step = 0;
let nextColor = 0;
const colors = ['#A88ADD', '#E89AB5', '#8EBF83', '#73BFC1', '#F5A65B', '#B2A7E5'];
let selectedWifi = null;

async function scanWifi() {
  const scan = document.querySelector('#wifi-scan');
  const list = document.querySelector('#wifi-networks');
  const message = document.querySelector('#wifi-message');
  scan.disabled = true;
  message.textContent = 'Looking for nearby networks…';
  list.replaceChildren();
  selectedWifi = null;
  document.querySelector('#wifi-password-field').hidden = true;
  try {
    const response = await fetch('/api/wifi/networks');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not scan Wi-Fi.');
    if (!result.available) {
      document.querySelector('#wifi-setup').hidden = true;
      return;
    }
    message.textContent = result.networks.length
      ? 'Choose a network.'
      : 'No networks found. Check Wi-Fi and try scanning again.';
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
        const passwordField = document.querySelector('#wifi-password-field');
        passwordField.hidden = network.connected;
        const password = document.querySelector('#wifi-password');
        password.value = '';
        password.required = network.security === 'personal';
        password.closest('label').hidden = network.security === 'open';
        if (passwordField.hidden) message.textContent = `Already connected to ${network.ssid}.`;
        else if (network.security === 'personal') password.focus();
      });
      list.append(button);
    }
  } catch (cause) {
    message.textContent = cause.message;
  } finally {
    scan.disabled = false;
  }
}

document.querySelector('#wifi-scan').addEventListener('click', scanWifi);
document.querySelector('#wifi-connect').addEventListener('click', async () => {
  if (!selectedWifi) return;
  const password = document.querySelector('#wifi-password');
  if (selectedWifi.security === 'personal' && !password.reportValidity()) return;
  const connect = document.querySelector('#wifi-connect');
  const message = document.querySelector('#wifi-message');
  connect.disabled = true;
  message.textContent = `Connecting to ${selectedWifi.ssid}…`;
  try {
    const response = await fetch('/api/wifi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: selectedWifi.ssid, password: password.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not connect to Wi-Fi.');
    password.value = '';
    message.textContent = `Connected to ${result.ssid}.`;
    document.querySelector('#wifi-password-field').hidden = true;
    await loadNetwork();
    await scanWifi();
  } catch (cause) {
    message.textContent = cause.message;
  } finally {
    connect.disabled = false;
  }
});

function showStep(index) {
  step = index;
  steps.forEach((section, number) => {
    section.hidden = number !== index;
  });
  document.querySelector('#step-count').textContent = `Step ${index + 1} of ${steps.length}`;
  document.querySelector('#progress-track i').style.width =
    `${((index + 1) * 100) / steps.length}%`;
  document.querySelector('#back-button').hidden = index === 0;
  document.querySelector('#next-button').hidden = index === steps.length - 1;
  document.querySelector('#finish-button').hidden = index !== steps.length - 1;
  error.textContent = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function selectedMode() {
  return form.elements.signInMode.value;
}

function updateMode() {
  const mode = selectedMode();
  const individual = mode === 'individual';
  const needsPassword = mode !== 'none';
  const username = form.elements.ownerUsername;
  document.querySelector('#owner-username-field').hidden = !individual;
  username.required = individual;
  username.disabled = !individual;
  document.querySelectorAll('.owner-password-field').forEach((label) => {
    label.hidden = !needsPassword;
  });
  for (const input of [form.elements.ownerPassword, form.elements.confirmPassword]) {
    input.required = needsPassword;
    input.disabled = !needsPassword;
  }
  document.querySelector('#sign-in-explanation').textContent =
    mode === 'none'
      ? 'Anyone who can reach this Enve device can open calendars, tasks, and settings. Keep it on a trusted private network. You can turn on sign-ins later.'
      : individual
        ? 'Each adult gets their own sign-in. You manage accounts and calendar connections; everyone shares the same household data. A 4-digit PIN works, but a longer password offers more protection.'
        : 'Everyone uses this one password or PIN on their phones. A 4-digit PIN works; a longer password offers more protection.';
  document.querySelector('#sign-in-summary').textContent =
    mode === 'none'
      ? 'Sign-in: no password. Phones and computers on your network will open Enve directly.'
      : individual
        ? 'Sign-in: each adult uses their own account. The wall display opens automatically.'
        : 'Sign-in: one shared password or PIN. The wall display opens automatically.';
  document.querySelectorAll('.adult-access').forEach((label) => {
    label.hidden = !individual;
  });
  document.querySelectorAll('.person-card').forEach(updatePerson);
}

function updatePerson(card) {
  const enabled = selectedMode() === 'individual' && card.querySelector('[name=adult]').checked;
  const fields = card.querySelector('.adult-fields');
  fields.hidden = !enabled;
  fields.querySelectorAll('input').forEach((input) => {
    input.required = enabled;
    input.disabled = !enabled;
  });
}

function addPerson() {
  if (document.querySelectorAll('.person-card').length >= 11) return;
  const card = document.createElement('div');
  card.className = 'person-card';
  card.innerHTML = `<label>Name<input name="name" maxlength="30" placeholder="Person’s name" required></label>
    <label>Color<input name="color" type="color" value="${colors[nextColor++ % colors.length]}"></label>
    <button class="remove-person" type="button" aria-label="Remove person">Remove</button>
    <label class="adult-access"><input name="adult" type="checkbox"> Give this adult a sign-in</label>
    <div class="adult-fields" hidden><label>Sign-in name<input name="username" minlength="3" maxlength="30" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,29}" autocomplete="off"></label>
      <label>Password or PIN<input name="password" type="password" minlength="4" maxlength="128" autocomplete="new-password"></label></div>`;
  card.querySelector('.remove-person').addEventListener('click', () => card.remove());
  card.querySelector('[name=adult]').addEventListener('change', () => updatePerson(card));
  document.querySelector('#people-list').append(card);
  updateMode();
  card.querySelector('[name=name]').focus();
}

function validateStep(index) {
  if (
    index === 1 &&
    selectedMode() !== 'none' &&
    form.elements.ownerPassword.value !== form.elements.confirmPassword.value
  ) {
    if (step !== index) showStep(index);
    error.textContent = 'The passwords do not match.';
    form.elements.confirmPassword.focus();
    return false;
  }
  for (const input of steps[index].querySelectorAll('input,select')) {
    if (!input.disabled && !input.checkValidity()) {
      if (step !== index) showStep(index);
      input.reportValidity();
      return false;
    }
  }
  return true;
}

document.querySelector('#next-button').addEventListener('click', () => {
  if (validateStep(step)) showStep(step + 1);
});
document.querySelector('#back-button').addEventListener('click', () => showStep(step - 1));
document.querySelector('#add-person').addEventListener('click', addPerson);
form
  .querySelectorAll('[name=signInMode]')
  .forEach((input) => input.addEventListener('change', updateMode));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!steps.every((_, index) => validateStep(index))) return;
  const people = [...document.querySelectorAll('.person-card')].map((card) => {
    const person = {
      name: card.querySelector('[name=name]').value.trim(),
      color: card.querySelector('[name=color]').value,
    };
    if (selectedMode() === 'individual' && card.querySelector('[name=adult]').checked) {
      Object.assign(person, {
        adult: true,
        username: card.querySelector('[name=username]').value.trim(),
        password: card.querySelector('[name=password]').value,
      });
    }
    return person;
  });
  const payload = {
    householdName: form.elements.householdName.value.trim(),
    signInMode: selectedMode(),
    owner: {
      name: form.elements.ownerName.value.trim(),
      color: form.elements.ownerColor.value,
      username: form.elements.ownerUsername.value.trim(),
      password: selectedMode() === 'none' ? '' : form.elements.ownerPassword.value,
    },
    people,
    display: {
      theme: form.elements.theme.value,
      lightAt: form.elements.lightAt.value,
      darkAt: form.elements.darkAt.value,
    },
  };
  const button = document.querySelector('#finish-button');
  button.disabled = true;
  error.textContent = '';
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (form.elements.bootstrapKey.value)
      headers['X-Enve-Bootstrap-Key'] = form.elements.bootstrapKey.value;
    const response = await fetch('/api/setup/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Setup could not finish.');
    if (form.querySelector('[name=provider]:checked'))
      sessionStorage.setItem('enve-open-calendar-settings', '1');
    window.location.replace('/');
  } catch (cause) {
    error.textContent = cause.message;
    button.disabled = false;
  }
});

fetch('/api/setup/status')
  .then((response) => response.json())
  .then((status) => {
    if (!status.needed) {
      window.location.replace('/');
      return;
    }
    if (!status.browserSetupAllowed) {
      document.querySelector('#device-wait').hidden = false;
      document.querySelector('.progress').hidden = true;
      form.hidden = true;
      setInterval(async () => {
        const latest = await fetch('/api/setup/status')
          .then((response) => response.json())
          .catch(() => null);
        if (latest && !latest.needed) window.location.replace('/');
      }, 3000);
    } else if (status.bootstrapRequired) {
      document.querySelector('#bootstrap-field').hidden = false;
      form.elements.bootstrapKey.required = true;
    }
    if (status.needed && !status.bootstrapRequired && status.browserSetupAllowed) {
      document.querySelector('#wifi-setup').hidden = false;
      scanWifi();
    }
  })
  .catch(() => {
    error.textContent = 'Can’t reach the Enve Family server.';
  });
async function loadNetwork() {
  const headers = form.elements.bootstrapKey.value
    ? { 'X-Enve-Bootstrap-Key': form.elements.bootstrapKey.value }
    : {};
  try {
    const response = await fetch('/api/setup/network', { headers });
    if (!response.ok) throw new Error();
    const network = await response.json();
    document.querySelector('#network-status').textContent = network.interfaces?.length
      ? `Connected: ${network.interfaces.map((item) => `${item.name} · ${item.address}`).join(', ')}`
      : 'No network address yet. Connect Ethernet or configure Wi-Fi on this device.';
  } catch {
    document.querySelector('#network-status').textContent =
      'Enter the setup key to see the server network address.';
  }
}
form.elements.bootstrapKey.addEventListener('change', loadNetwork);
loadNetwork();
updateMode();
showStep(0);
