import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const nmcli = process.env.ENVE_NMCLI_BIN || '/usr/bin/nmcli';

function run(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(nmcli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      error += chunk;
    });
    child.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(error || `NetworkManager exited with ${code}.`));
    });
  });
}

function fields(line) {
  const result = [];
  let field = '';
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      field += character;
      escaped = false;
    } else if (character === '\\') escaped = true;
    else if (character === ':') {
      result.push(field);
      field = '';
    } else field += character;
  }
  result.push(field);
  return result;
}

export async function scanWifi() {
  if (process.platform !== 'linux') return { available: false, networks: [] };
  const output = await run(
    [
      '--terse',
      '--escape',
      'yes',
      '--fields',
      'IN-USE,SSID,SIGNAL,SECURITY',
      'device',
      'wifi',
      'list',
      'ifname',
      'wlan0',
      '--rescan',
      'yes',
    ],
    15000,
  );
  const networks = new Map();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [used, ssid, signal, security] = fields(line);
    if (!ssid || Buffer.byteLength(ssid) > 32) continue;
    const protection =
      security === '--'
        ? 'open'
        : /802\.1X|WEP|OWE/i.test(security)
          ? 'unsupported'
          : /WPA/i.test(security)
            ? 'personal'
            : 'unsupported';
    const entry = {
      ssid,
      signal: Math.min(100, Math.max(0, Number(signal) || 0)),
      security: protection,
      connected: used === '*',
      keyManagement:
        protection === 'open'
          ? null
          : /WPA3/i.test(security) && !/WPA2/i.test(security)
            ? 'sae'
            : 'wpa-psk',
    };
    const previous = networks.get(ssid);
    if (!previous || entry.connected || entry.signal > previous.signal) networks.set(ssid, entry);
  }
  return {
    available: true,
    networks: [...networks.values()].sort(
      (a, b) => Number(b.connected) - Number(a.connected) || b.signal - a.signal,
    ),
  };
}

export async function connectWifi(ssid, password) {
  if (process.platform !== 'linux') throw new Error('Wi-Fi setup is available on the Pi display.');
  if (typeof ssid !== 'string' || !ssid || Buffer.byteLength(ssid) > 32 || /[\r\n\0]/.test(ssid))
    throw new Error('Choose a Wi-Fi network.');
  const network = (await scanWifi()).networks.find((item) => item.ssid === ssid);
  if (!network) throw new Error('That Wi-Fi network is no longer visible. Scan again.');
  if (network.security === 'unsupported')
    throw new Error('This Wi-Fi security type is not supported.');
  const security = network.security;
  if (
    security === 'personal' &&
    (typeof password !== 'string' ||
      password.length < 8 ||
      password.length > 63 ||
      /[\r\n\0]/.test(password))
  )
    throw new Error('Enter a Wi-Fi password of 8–63 characters.');
  const profile = `enve-${randomUUID()}`;
  let directory;
  try {
    const args = [
      'connection',
      'add',
      'type',
      'wifi',
      'ifname',
      'wlan0',
      'con-name',
      profile,
      'ssid',
      ssid,
      '802-11-wireless.band',
      'bg',
      '802-11-wireless.powersave',
      '2',
      'connection.autoconnect',
      'yes',
    ];
    if (security === 'personal') {
      args.push('wifi-sec.key-mgmt', network.keyManagement);
      directory = await mkdtemp(join(tmpdir(), 'enve-wifi-'));
      await writeFile(join(directory, 'secret'), `802-11-wireless-security.psk:${password}\n`, {
        mode: 0o600,
      });
    }
    await run(args, 10000);
    try {
      const activation = ['--wait', '25', 'connection', 'up', 'id', profile, 'ifname', 'wlan0'];
      if (directory) activation.push('passwd-file', join(directory, 'secret'));
      await run(activation, 30000);
    } catch (cause) {
      await run(['connection', 'delete', 'id', profile], 10000).catch(() => {});
      throw cause;
    }
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new Error('NetworkManager is not installed on this device.');
    if (/not authorized|not permitted|permission/i.test(cause.message))
      throw new Error('Enve needs permission to change Wi-Fi on this device.');
    throw new Error(
      'Could not join this network. Check the password and whether it allows 2.4 GHz WPA2 devices.',
    );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return { connected: true, ssid };
}
