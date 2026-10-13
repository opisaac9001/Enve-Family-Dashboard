import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'enve-device-'));
process.env.ENVE_DEVICE_CONTROL_SOCKET = join(directory, 'control.sock');
const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux' });
const requests = [];
let reply = '{"accepted":true}\n';
const server = createServer((socket) => {
  socket.once('data', (data) => {
    requests.push(JSON.parse(data));
    socket.end(reply);
  });
});
await new Promise((resolve) => server.listen(process.env.ENVE_DEVICE_CONTROL_SOCKET, resolve));
try {
  const { deviceAction } = await import('../device.js');
  assert.deepEqual(await deviceAction('restart-display'), { accepted: true });
  assert.deepEqual(requests, [['restart-display']]);
  await assert.rejects(deviceAction('reboot; id'), /supported device action/);
  assert.equal(requests.length, 1);
  reply = '{"accepted":false}\n';
  await assert.rejects(deviceAction('reboot'), /Could not apply/);
  reply = 'invalid';
  await assert.rejects(deviceAction('poweroff'), /Could not apply/);
} finally {
  await new Promise((resolve) => server.close(resolve));
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  await rm(directory, { recursive: true, force: true });
}
