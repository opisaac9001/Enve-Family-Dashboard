import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'enve-wifi-test-'));
const binary = join(directory, 'nmcli');
const log = join(directory, 'commands');
const capturedSecret = join(directory, 'captured-secret');
await writeFile(
  binary,
  `#!/bin/sh
printf '%s\n' "$*" >> "$TEST_NMCLI_LOG"
case "$*" in
  *"device wifi list"*) printf '*:Home\\:Family:80:WPA2\\n:Guest:35:--\\n:Office:95:WPA2 802.1X\\n' ;;
  *"connection up"*)
    if [ "$TEST_FAIL_UP" = 1 ]; then exit 4; fi
    for arg do last="$arg"; done
    cp "$last" "$TEST_SECRET_COPY" ;;
esac
`,
);
await chmod(binary, 0o700);
process.env.ENVE_NMCLI_BIN = binary;
process.env.TEST_NMCLI_LOG = log;
process.env.TEST_SECRET_COPY = capturedSecret;
const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux' });

try {
  const { scanWifi, connectWifi } = await import('../wifi.js');
  const result = await scanWifi();
  assert.deepEqual(
    result.networks.map((item) => [item.ssid, item.security]),
    [
      ['Home:Family', 'personal'],
      ['Office', 'unsupported'],
      ['Guest', 'open'],
    ],
  );
  await connectWifi('Home:Family', 'samplepass123');
  const commands = await readFile(log, 'utf8');
  assert.ok(!commands.includes('samplepass123'));
  assert.match(commands, /802-11-wireless\.band bg/);
  assert.match(commands, /802-11-wireless\.powersave 2/);
  assert.equal(
    await readFile(capturedSecret, 'utf8'),
    '802-11-wireless-security.psk:samplepass123\n',
  );
  const secretPath = commands
    .split('\n')
    .find((line) => line.includes('connection up'))
    .split('passwd-file ')[1];
  await assert.rejects(access(secretPath));
  await assert.rejects(connectWifi('Home:Family', 'short'), /8–63/);
  process.env.TEST_FAIL_UP = '1';
  await assert.rejects(connectWifi('Home:Family', 'samplepass123'), /Could not join this network/);
  assert.match(await readFile(log, 'utf8'), /connection delete id enve-/);
} finally {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  await rm(directory, { recursive: true, force: true });
}
