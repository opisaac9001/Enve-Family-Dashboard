import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { hostname, networkInterfaces, uptime } from 'node:os';
import { createConnection } from 'node:net';

const execute = promisify(execFile);
const socketPath = process.env.ENVE_DEVICE_CONTROL_SOCKET || '/run/enve-family-device.sock';
const services = [
  ['enve-family.service', 'Calendar server'],
  ['enve-family-full-display.service', 'Full display'],
  ['enve-family-display.service', 'Native display'],
  ['tailscaled.service', 'Tailscale'],
  ['NetworkManager.service', 'Wi-Fi service'],
];

export async function deviceStatus() {
  if (process.platform !== 'linux') return { available: false, controls: false };
  const [model, release, memory, temperature, clock] = await Promise.all([
    readFile('/proc/device-tree/model', 'utf8').catch(() => 'Linux device'),
    readFile('/etc/os-release', 'utf8'),
    readFile('/proc/meminfo', 'utf8'),
    readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8').catch(() => ''),
    execute('timedatectl', ['show', '--property=Timezone', '--value'], { timeout: 5000 }).catch(
      () => ({ stdout: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    ),
  ]);
  const memoryValue = (key) =>
    Number(memory.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
  const status = await Promise.all(
    services.map(async ([id, label]) => {
      const result = await execute('systemctl', ['is-active', id], { timeout: 5000 }).catch(() => ({
        stdout: '',
      }));
      return { id, label, active: result.stdout.trim() === 'active' };
    }),
  );
  return {
    available: true,
    controls: await access(socketPath).then(
      () => true,
      () => false,
    ),
    model: model.replaceAll('\0', '').trim(),
    hostname: hostname(),
    os: release.match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1] || 'Linux',
    timeZone: clock.stdout.trim(),
    uptimeSeconds: uptime(),
    memory: { totalBytes: memoryValue('MemTotal'), availableBytes: memoryValue('MemAvailable') },
    temperatureC: temperature.trim() ? Number(temperature) / 1000 : null,
    addresses: Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
      (addresses || [])
        .filter((item) => item.family === 'IPv4' && !item.internal)
        .map((item) => ({ name, address: item.address })),
    ),
    services: status,
  };
}

export async function deviceTimeZones() {
  if (process.platform !== 'linux') return { timeZones: [] };
  const { stdout } = await execute('timedatectl', ['list-timezones'], { timeout: 5000 });
  return { timeZones: stdout.trim().split('\n').filter(Boolean) };
}

async function control(args) {
  if (process.platform !== 'linux')
    throw new Error('Device controls are only available on the wall display.');
  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let output = '';
      socket.setTimeout(15000, () => socket.destroy(new Error('Device action timed out')));
      socket.on('connect', () => socket.write(`${JSON.stringify(args)}\n`));
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        output += chunk;
        if (output.length > 4096) socket.destroy(new Error('Invalid device response'));
      });
      socket.on('end', () => {
        try {
          if (JSON.parse(output).accepted) resolve();
          else reject(new Error('Device action rejected'));
        } catch (cause) {
          reject(cause);
        }
      });
    });
  } catch {
    throw new Error(
      'Could not apply this change. Check that device management is installed and try again.',
    );
  }
}

export async function setDeviceTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !(await deviceTimeZones()).timeZones.includes(timeZone))
    throw new Error('Choose a time zone from the list.');
  await control(['timezone', timeZone]);
  return deviceStatus();
}

export async function deviceAction(action) {
  if (!['restart-display', 'reboot', 'poweroff'].includes(action))
    throw new Error('Choose a supported device action.');
  await control([action]);
  return { accepted: true };
}
