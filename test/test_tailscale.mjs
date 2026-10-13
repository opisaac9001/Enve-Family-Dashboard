import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'enve-tailscale-test-'));
const binary = join(directory, 'tailscale');
const statePath = join(directory, 'state.json');
const host = 'family.example.ts.net:443';
const target = 'http://127.0.0.1:4317';
const config = {
  TCP: { 443: { HTTPS: true } },
  Web: { [host]: { Handlers: { '/': { Proxy: target } } } },
};

try {
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.env.TEST_TAILSCALE_STATE, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'status') console.log(JSON.stringify({ BackendState: state.connected ? 'Running' : 'NeedsLogin', Self: { DNSName: 'family.example.ts.net.' } }));
else if (args[0] === 'up') console.log(JSON.stringify({ AuthURL: 'https://login.tailscale.com/a/123abc', QR: 'data:image/png;base64,AA==' }));
else if (args[0] === 'serve' && args[1] === 'status') console.log(JSON.stringify(state.serve));
else if (args[0] === 'serve' && args[1] === '--bg') { state.serve = ${JSON.stringify(config)}; fs.writeFileSync(process.env.TEST_TAILSCALE_STATE, JSON.stringify(state)); }
else if (args[0] === 'serve' && args[1] === '--https=443') { state.serve = {}; fs.writeFileSync(process.env.TEST_TAILSCALE_STATE, JSON.stringify(state)); }
else process.exit(1);
`,
  );
  await chmod(binary, 0o700);
  await writeFile(statePath, JSON.stringify({ connected: false, serve: {} }));
  process.env.ENVE_TAILSCALE_BIN = binary;
  process.env.TEST_TAILSCALE_STATE = statePath;
  process.env.PORT = '4317';
  const { tailscaleStatus, startTailscaleLogin, enableTailscaleServe, disableTailscaleServe } =
    await import('../tailscale.js');

  assert.equal((await tailscaleStatus()).connected, false);
  const login = await startTailscaleLogin();
  assert.equal(login.loginUrl, 'https://login.tailscale.com/a/123abc');
  assert.equal(login.loginQr, 'data:image/png;base64,AA==');
  await writeFile(statePath, JSON.stringify({ connected: true, serve: {} }));
  const enabled = await enableTailscaleServe();
  assert.equal(enabled.serving, true);
  assert.equal(enabled.url, 'https://family.example.ts.net');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).serve, config);
  assert.equal((await disableTailscaleServe()).serving, false);

  await writeFile(
    statePath,
    JSON.stringify({
      connected: true,
      serve: {
        TCP: { 443: { HTTPS: true } },
        Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
      },
    }),
  );
  await assert.rejects(enableTailscaleServe(), /already shares another service/);
  assert.equal(
    JSON.parse(await readFile(statePath, 'utf8')).serve.Web[host].Handlers['/'].Proxy,
    'http://127.0.0.1:9999',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
