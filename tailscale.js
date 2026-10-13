import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

const binary = process.env.ENVE_TAILSCALE_BIN || 'tailscale';
const target = `http://127.0.0.1:${Number(process.env.PORT || 4317)}`;
let loginProcess = null;
let loginUrl = '';
let loginQr = '';

function command(args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(errors.trim() || `Tailscale exited with ${code}.`));
    });
  });
}

function authUrl(value) {
  return typeof value === 'string' &&
    /^https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+$/.test(value)
    ? value
    : '';
}

function serveDetails(config, dnsName) {
  config ||= {};
  const web = config.Web || {};
  const tcp = config.TCP || {};
  const entries = Object.entries(web);
  const [host, site] = entries[0] || [];
  const handlers = site?.Handlers || {};
  const proxy = handlers['/']?.Proxy;
  const own =
    entries.length === 1 &&
    Object.keys(handlers).length === 1 &&
    proxy === target &&
    Object.keys(tcp).length === 1 &&
    tcp['443']?.HTTPS === true &&
    !config.AllowFunnel &&
    !config.Services;
  const occupied = Object.keys(config).length > 0;
  const name = dnsName?.replace(/\.$/, '');
  return {
    serving: own,
    conflict: occupied && !own,
    url: own && name && host === `${name}:443` ? `https://${name}` : '',
  };
}

export async function tailscaleStatus() {
  const operatorCommand =
    process.platform === 'linux' ? `sudo tailscale set --operator=${userInfo().username}` : '';
  let status;
  try {
    status = JSON.parse(await command(['status', '--json']));
  } catch (cause) {
    return {
      installed: cause.code !== 'ENOENT',
      connected: false,
      state: 'Unavailable',
      message:
        cause.code === 'ENOENT' ? '' : 'Tailscale is installed but its service is not available.',
      operatorCommand,
    };
  }
  const connected = status.BackendState === 'Running';
  let serve = { serving: false, conflict: false, url: '' };
  if (connected) {
    try {
      serve = serveDetails(
        JSON.parse(await command(['serve', 'status', '--json'])),
        status.Self?.DNSName,
      );
    } catch {
      serve = {
        serving: false,
        conflict: true,
        url: '',
        message: 'Could not inspect this device’s Tailscale Serve settings.',
      };
    }
  }
  return {
    installed: true,
    connected,
    state: status.BackendState || 'Unknown',
    loginUrl: authUrl(status.AuthURL) || loginUrl,
    loginQr,
    operatorCommand,
    ...serve,
  };
}

export async function startTailscaleLogin() {
  const status = await tailscaleStatus();
  if (!status.installed) throw new Error('Install Tailscale on this device first.');
  if (status.connected) return status;
  if (loginProcess) return status;
  loginUrl = '';
  loginQr = '';
  const child = spawn(binary, ['up', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  loginProcess = child;
  let output = '';
  let errors = '';
  let settled = false;
  let readyTimer;
  const ready = new Promise((resolve, reject) => {
    const finish = (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      if (cause) reject(cause);
      else resolve();
    };
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-32768);
      const start = output.indexOf('{');
      const end = output.indexOf('}', start);
      if (start >= 0 && end > start) {
        let data;
        try {
          data = JSON.parse(output.slice(start, end + 1));
        } catch {
          return;
        }
        loginUrl = authUrl(data.AuthURL);
        loginQr =
          typeof data.QR === 'string' && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(data.QR)
            ? data.QR
            : '';
        finish();
      }
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.once('error', (cause) => {
      loginProcess = null;
      finish(cause);
    });
    child.once('close', (code) => {
      loginProcess = null;
      if (code !== 0) finish(new Error(errors.trim() || 'Could not start Tailscale sign-in.'));
      else finish();
    });
    readyTimer = setTimeout(() => finish(), 12000);
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 300000);
  child.once('close', () => clearTimeout(timer));
  try {
    await ready;
  } catch (cause) {
    if (/permission|access denied|not allowed/i.test(cause.message))
      throw new Error('Give the Enve service user Tailscale operator permission, then try again.');
    throw new Error('Could not start Tailscale sign-in. Check that its service is running.');
  }
  const updated = await tailscaleStatus();
  if (!updated.loginUrl && !updated.connected)
    throw new Error(
      'Tailscale sign-in is taking longer than expected. Refresh its status shortly.',
    );
  return updated;
}

export async function enableTailscaleServe() {
  const status = await tailscaleStatus();
  if (!status.connected) throw new Error('Connect this device to Tailscale first.');
  if (status.serving) return status;
  if (status.conflict)
    throw new Error(
      'This device already shares another service through Tailscale. Review its Serve configuration before changing it.',
    );
  try {
    await command(['serve', '--bg', target], 30000);
  } catch (cause) {
    if (/permission|access denied|not allowed/i.test(cause.message))
      throw new Error('Give the Enve service user Tailscale operator permission, then try again.');
    throw new Error('Could not enable private access. Check Tailscale Serve and HTTPS settings.');
  }
  return tailscaleStatus();
}

export async function disableTailscaleServe() {
  const status = await tailscaleStatus();
  if (!status.serving) throw new Error('Enve is not currently sharing through Tailscale Serve.');
  await command(['serve', '--https=443', 'off']);
  return tailscaleStatus();
}
