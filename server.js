import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  canEditICloudObject,
  iCloudCalendarUrl,
  iCloudClient,
  iCloudEvents,
  newICloudObject,
  updatedICloudObject,
} from './icloud.js';
import { expandLocalEvent, recurrenceFields } from './recurrence.js';
import { importDrafts } from './imports.js';
import { extractLinuxDocumentText } from './ocr-linux.js';
import {
  aggregateIngredients,
  formatIngredient,
  ingredientPart,
  scaleIngredients,
} from './recipes.js';
import { mealIdeas } from './meal-ideas.js';
import { generateCloudMealIdeas } from './cloud-meal-ideas.js';
import { feedEvents, fetchFeed, validateFeedUrl } from './feeds.js';
import { scanWifi, connectWifi } from './wifi.js';
import {
  tailscaleStatus,
  startTailscaleLogin,
  enableTailscaleServe,
  disableTailscaleServe,
} from './tailscale.js';

const root = dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4317);
const accessKey = process.env.ACCESS_KEY || '';
const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const outlookClientId = process.env.OUTLOOK_CLIENT_ID || '';
const outlookClientSecret = process.env.OUTLOOK_CLIENT_SECRET || '';
const redirectUri =
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/google/callback`;
const outlookRedirectUri = `http://localhost:${port}/api/outlook/callback`;
const oauthStates = new Map();
const sessions = new Map();
const loginFailures = new Map();
const changeStreams = new Set();
const googleColorRefresh = new Map();
let googlePalette = { expiresAt: 0, colors: null };
const pinSessions = new Map();
const pinFailures = new Map();
let weatherCache = { key: '', expires: 0, data: null };
const backupTables = [
  'profiles',
  'settings',
  'local_events',
  'event_exceptions',
  'tasks',
  'rewards',
  'reward_entries',
  'goals',
  'household_lists',
  'list_items',
  'photos',
  'recipes',
  'meal_series',
  'meals',
  'meal_recipes',
  'meal_series_skips',
  'meal_grocery_transfers',
];
const optionalBackupTables = [
  'goals',
  'meal_series',
  'meal_recipes',
  'meal_series_skips',
  'meal_grocery_transfers',
];

process.umask(0o077);
const databasePath = resolve(process.env.DATABASE_PATH || join(root, 'data', 'family.sqlite'));
await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
const deviceKeyPath = resolve(
  process.env.ENVE_DEVICE_KEY_PATH || join(dirname(databasePath), '.device-key'),
);
let deviceKey;
try {
  deviceKey = (await readFile(deviceKeyPath, 'utf8')).trim();
} catch (cause) {
  if (cause.code !== 'ENOENT') throw cause;
  deviceKey = randomBytes(32).toString('hex');
  await writeFile(deviceKeyPath, deviceKey, { mode: 0o600, flag: 'wx' });
}
if (!/^[0-9a-f]{64}$/.test(deviceKey)) throw new Error('The local device key is invalid.');
await chmod(deviceKeyPath, 0o600);
const db = new DatabaseSync(databasePath);
await chmod(databasePath, 0o600);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_events (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0, profile_id TEXT NOT NULL REFERENCES profiles(id),
    notes TEXT NOT NULL DEFAULT '', repeat_rule TEXT NOT NULL DEFAULT 'none',
    repeat_until TEXT, time_zone TEXT, local_start TEXT, local_end TEXT
  );
  CREATE TABLE IF NOT EXISTS event_exceptions (
    event_id TEXT NOT NULL REFERENCES local_events(id) ON DELETE CASCADE,
    occurrence_date TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    payload TEXT, PRIMARY KEY(event_id, occurrence_date)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, due_date TEXT, profile_id TEXT NOT NULL REFERENCES profiles(id),
    completed INTEGER NOT NULL DEFAULT 0, repeat_rule TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL, next_generated INTEGER NOT NULL DEFAULT 0,
    star_value INTEGER NOT NULL DEFAULT 1, due_time TEXT,
    task_type TEXT NOT NULL DEFAULT 'chore', claimable INTEGER NOT NULL DEFAULT 0,
    claimed_by TEXT, skipped INTEGER NOT NULL DEFAULT 0, series_id TEXT,
    rotation_profiles TEXT NOT NULL DEFAULT '[]', rotation_index INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rewards (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
    title TEXT NOT NULL, cost INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reward_entries (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
    task_id TEXT UNIQUE, reward_id TEXT, label TEXT NOT NULL,
    stars INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
    title TEXT NOT NULL, target INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    profile_id TEXT REFERENCES profiles(id), role TEXT NOT NULL,
    password_salt TEXT NOT NULL, password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integration_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL,
    content BLOB NOT NULL, created_at TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'gallery'
  );
  CREATE TABLE IF NOT EXISTS household_lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
    sort_order TEXT NOT NULL DEFAULT 'added'
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES household_lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS meals (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, category TEXT NOT NULL,
    title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL, servings INTEGER
  );
  CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, ingredients TEXT NOT NULL,
    directions TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    servings INTEGER NOT NULL DEFAULT 4,
    photo_id TEXT REFERENCES photos(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS meal_recipes (
    meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(meal_id, recipe_id)
  );
  CREATE TABLE IF NOT EXISTS meal_series (
    id TEXT PRIMARY KEY, start_day TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '', servings INTEGER, recipe_ids TEXT NOT NULL DEFAULT '[]',
    repeat_rule TEXT NOT NULL, repeat_until TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meal_series_skips (
    series_id TEXT NOT NULL REFERENCES meal_series(id) ON DELETE CASCADE,
    occurrence_day TEXT NOT NULL, PRIMARY KEY(series_id, occurrence_day)
  );
  CREATE TABLE IF NOT EXISTS meal_grocery_transfers (
    meal_id TEXT PRIMARY KEY REFERENCES meals(id) ON DELETE CASCADE,
    transferred_at TEXT NOT NULL, lines TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS google_accounts (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
    email TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS google_calendars (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
    google_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    writable INTEGER NOT NULL DEFAULT 0, color TEXT, UNIQUE(account_id, google_id)
  );
  CREATE TABLE IF NOT EXISTS outlook_accounts (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
    email TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outlook_calendars (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES outlook_accounts(id) ON DELETE CASCADE,
    outlook_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(account_id, outlook_id)
  );
  CREATE TABLE IF NOT EXISTS icloud_accounts (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
    email TEXT NOT NULL, app_password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS icloud_calendars (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
    url TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(account_id, url)
  );
  CREATE TABLE IF NOT EXISTS feed_calendars (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
    name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    ics_text TEXT NOT NULL DEFAULT '', fetched_at INTEGER NOT NULL DEFAULT 0
  );
`);
if (
  !db
    .prepare('PRAGMA table_info(tasks)')
    .all()
    .some((column) => column.name === 'next_generated')
) {
  db.exec('ALTER TABLE tasks ADD COLUMN next_generated INTEGER NOT NULL DEFAULT 0');
}
if (
  !db
    .prepare('PRAGMA table_info(tasks)')
    .all()
    .some((column) => column.name === 'star_value')
) {
  db.exec('ALTER TABLE tasks ADD COLUMN star_value INTEGER NOT NULL DEFAULT 1');
}
if (
  !db
    .prepare('PRAGMA table_info(tasks)')
    .all()
    .some((column) => column.name === 'due_time')
) {
  db.exec('ALTER TABLE tasks ADD COLUMN due_time TEXT');
}
if (
  !db
    .prepare('PRAGMA table_info(google_calendars)')
    .all()
    .some((column) => column.name === 'color')
) {
  db.exec('ALTER TABLE google_calendars ADD COLUMN color TEXT');
}
for (const [name, definition] of [
  ['task_type', "TEXT NOT NULL DEFAULT 'chore'"],
  ['claimable', 'INTEGER NOT NULL DEFAULT 0'],
  ['claimed_by', 'TEXT'],
  ['skipped', 'INTEGER NOT NULL DEFAULT 0'],
  ['series_id', 'TEXT'],
  ['rotation_profiles', "TEXT NOT NULL DEFAULT '[]'"],
  ['rotation_index', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  if (
    !db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .some((column) => column.name === name)
  ) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
}
if (
  !db
    .prepare('PRAGMA table_info(household_lists)')
    .all()
    .some((column) => column.name === 'sort_order')
) {
  db.exec("ALTER TABLE household_lists ADD COLUMN sort_order TEXT NOT NULL DEFAULT 'added'");
}
if (
  !db
    .prepare('PRAGMA table_info(list_items)')
    .all()
    .some((column) => column.name === 'section')
) {
  db.exec("ALTER TABLE list_items ADD COLUMN section TEXT NOT NULL DEFAULT ''");
}
if (
  !db
    .prepare('PRAGMA table_info(photos)')
    .all()
    .some((column) => column.name === 'purpose')
) {
  db.exec("ALTER TABLE photos ADD COLUMN purpose TEXT NOT NULL DEFAULT 'gallery'");
}
for (const [name, definition] of [
  ['servings', 'INTEGER NOT NULL DEFAULT 4'],
  ['photo_id', 'TEXT REFERENCES photos(id) ON DELETE SET NULL'],
]) {
  if (
    !db
      .prepare('PRAGMA table_info(recipes)')
      .all()
      .some((column) => column.name === name)
  ) {
    db.exec(`ALTER TABLE recipes ADD COLUMN ${name} ${definition}`);
  }
}
for (const [name, definition] of [
  ['recipe_id', 'TEXT REFERENCES recipes(id) ON DELETE SET NULL'],
  ['servings', 'INTEGER'],
  ['series_id', 'TEXT'],
  ['occurrence_day', 'TEXT'],
  ['detached', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  if (
    !db
      .prepare('PRAGMA table_info(meals)')
      .all()
      .some((column) => column.name === name)
  ) {
    db.exec(`ALTER TABLE meals ADD COLUMN ${name} ${definition}`);
  }
}
for (const [name, definition] of [
  ['repeat_rule', "TEXT NOT NULL DEFAULT 'none'"],
  ['repeat_until', 'TEXT'],
  ['time_zone', 'TEXT'],
  ['local_start', 'TEXT'],
  ['local_end', 'TEXT'],
]) {
  if (
    !db
      .prepare('PRAGMA table_info(local_events)')
      .all()
      .some((column) => column.name === name)
  ) {
    db.exec(`ALTER TABLE local_events ADD COLUMN ${name} ${definition}`);
  }
}
const existingProfiles = db.prepare('SELECT COUNT(*) AS total FROM profiles').get().total;
db.exec('CREATE INDEX IF NOT EXISTS meals_slot ON meals(day, category)');
db.exec('CREATE INDEX IF NOT EXISTS meals_series ON meals(series_id, occurrence_day)');
backfillMealRecipes();

function backfillMealRecipes() {
  db.exec(`INSERT OR IGNORE INTO meal_recipes (meal_id, recipe_id, position)
    SELECT m.id, m.recipe_id, 0 FROM meals m JOIN recipes r ON r.id = m.recipe_id
    WHERE NOT EXISTS (SELECT 1 FROM meal_recipes x WHERE x.meal_id = m.id)`);
}

db.prepare("INSERT OR IGNORE INTO settings VALUES ('setup_complete', ?)").run(
  existingProfiles || process.env.ENVE_DEMO_SEED === '1' ? 'true' : 'false',
);
if (process.env.ENVE_DEMO_SEED === '1' && !existingProfiles) {
  for (const profile of [
    ['alex', 'Alex', '#6CA8DF'],
    ['sam', 'Sam', '#A88ADD'],
    ['jamie', 'Jamie', '#E89AB5'],
  ])
    db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run(...profile);
}
if (!existingProfiles) {
  db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run('family', 'Family', '#8EBF83');
  db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run('enve', 'Enve', '#F5921A');
}
db.prepare('INSERT OR IGNORE INTO household_lists (id, name, created_at) VALUES (?, ?, ?)').run(
  'groceries',
  'Groceries',
  new Date().toISOString(),
);
for (const [key, value] of Object.entries({
  theme: 'auto',
  accent_color: '#F5921A',
  light_at: '07:00',
  dark_at: '19:00',
  dim_after_minutes: '10',
  night_dim: 'true',
  dim_amount: '75',
  sleep_enabled: 'true',
  sleep_at: '22:00',
  wake_at: '06:00',
  reminders_enabled: 'true',
  reminder_minutes: '15',
  reminder_chime: 'false',
  weather_city: '',
  weather_units: 'fahrenheit',
  photos_enabled: 'false',
  photos_after_minutes: '5',
  display_density: 'comfortable',
  text_size: 'normal',
  layout_mode: 'auto',
  household_name: 'Our Family',
})) {
  db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run(key, value);
}

if (
  !['127.0.0.1', 'localhost', '::1'].includes(host) &&
  accessKey.length < 12 &&
  db.prepare("SELECT value FROM settings WHERE key = 'setup_complete'").get()?.value === 'true' &&
  !db.prepare('SELECT 1 FROM users LIMIT 1').get() &&
  db.prepare("SELECT value FROM settings WHERE key = 'sign_in_mode'").get()?.value !== 'none'
) {
  throw new Error(
    'Set ACCESS_KEY to at least 12 characters before exposing the server on a network.',
  );
}

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

function error(response, status, message) {
  json(response, status, { error: message });
}

function equalSecret(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function setupComplete() {
  return (
    db.prepare("SELECT value FROM settings WHERE key = 'setup_complete'").get()?.value === 'true'
  );
}

function localRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
}

function deviceAuthorized(request) {
  return (
    localRequest(request) &&
    equalSecret(String(request.headers['x-enve-device-key'] || ''), deviceKey)
  );
}

function bootstrapAuthorized(request) {
  return (
    !setupComplete() &&
    accessKey.length >= 12 &&
    equalSecret(String(request.headers['x-enve-bootstrap-key'] || ''), accessKey)
  );
}

function localSetupBrowser(request) {
  return (
    localRequest(request) &&
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(String(request.headers.host || ''))
  );
}

function wifiAuthorized(request) {
  return (
    localRequest(request) &&
    (setupComplete()
      ? ownerAuthorized(request) ||
        (localSetupBrowser(request) && sessionFor(request)?.role === 'display')
      : localSetupBrowser(request) || deviceAuthorized(request))
  );
}

function tailscaleAuthorized(request) {
  return setupComplete() && localSetupBrowser(request) && ownerAuthorized(request);
}

function sessionFor(request) {
  const token = request.headers.cookie?.match(/(?:^|; )enve_session=([^;]+)/)?.[1];
  return token ? sessions.get(token) : null;
}

function integrationKeyFor(request) {
  const token = /^Bearer (envf_[0-9a-f]{64})$/i.exec(
    String(request.headers.authorization || ''),
  )?.[1];
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  return (
    db.prepare('SELECT id, name, scope FROM integration_keys WHERE token_hash = ?').get(hash) ||
    null
  );
}

function integrationWritePath(path, method) {
  const suffix = path.slice('/api/integrations/v1'.length);
  if (
    method === 'POST' &&
    ['/tasks', '/events', '/list-items', '/lists', '/meals', '/rewards', '/goals'].includes(suffix)
  ) {
    return `/api${suffix}`;
  }
  if (
    method === 'PATCH' &&
    /^\/(?:tasks|events|list-items|meals)\/[a-zA-Z0-9_-]{1,100}$/.test(suffix)
  ) {
    return `/api${suffix}`;
  }
  return null;
}

function authenticated(request) {
  if (!setupComplete()) return false;
  if (sessionFor(request)) return true;
  if (ownerAuthorized(request)) return true;
  return !accessKey && !db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

function ownerAuthorized(request) {
  return (
    sessionFor(request)?.role === 'owner' ||
    (settings().sign_in_mode === 'none' && !db.prepare('SELECT 1 FROM users LIMIT 1').get())
  );
}

function issueSession(request, response, user) {
  const token = cryptoId();
  sessions.set(token, user);
  response.setHeader(
    'Set-Cookie',
    `enve_session=${token}; HttpOnly; SameSite=Strict; Path=/${request.socket.encrypted ? '; Secure' : ''}`,
  );
}

function requireOwner(request) {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get() && !ownerAuthorized(request)) {
    throw Object.assign(new Error('An owner must manage sign-ins.'), { status: 403 });
  }
}

function passwordParts(password) {
  if (typeof password !== 'string' || password.length < 4 || password.length > 128) {
    throw new Error('Use a password or PIN of 4 to 128 characters.');
  }
  const salt = randomBytes(16).toString('hex');
  return [salt, scryptSync(password, salt, 32).toString('hex')];
}

function loginName(value) {
  const name = requireString(value, 'Sign-in name', 30).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(name))
    throw new Error('Use 3–30 letters, numbers, dots, dashes, or underscores for a sign-in name.');
  return name;
}

function pinHash() {
  return db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get()?.value;
}
function pinUnlocked(request) {
  const cookie = request.headers.cookie?.match(/(?:^|; )enve_pin=([^;]+)/)?.[1];
  return Boolean(cookie && pinSessions.get(cookie) > Date.now());
}
function pinResponse(request) {
  return { enabled: Boolean(pinHash()), unlocked: pinUnlocked(request) };
}

async function body(request, maxLength = 65536) {
  let content = '';
  for await (const chunk of request) {
    content += chunk;
    if (content.length > maxLength) throw new Error('Request is too large.');
  }
  return JSON.parse(content || '{}');
}

function requireString(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function requireProfile(id) {
  if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id))
    throw new Error('Choose a person.');
  return id;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function extractDocumentText(bytes) {
  if (process.platform === 'linux') return extractLinuxDocumentText(bytes);
  return new Promise((resolve, reject) => {
    const child = spawn('swift', [join(root, 'ocr.swift')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 30000) child.kill();
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && output.trim()) resolve(output.trim().slice(0, 20000));
      else
        reject(
          new Error(
            code === 0
              ? 'No text was found in that file.'
              : 'The file could not be read. Try a clearer image or PDF.',
          ),
        );
    });
    child.stdin.end(bytes);
  });
}

function localBackup() {
  const tables = Object.fromEntries(
    backupTables.map((table) => [
      table,
      db
        .prepare(
          `SELECT * FROM ${table}${table === 'settings' ? " WHERE key NOT LIKE 'pin_%'" : ''}`,
        )
        .all()
        .map((row) =>
          table === 'photos'
            ? { ...row, content: Buffer.from(row.content).toString('base64') }
            : row,
        ),
    ]),
  );
  return { format: 'enve-family-backup', version: 1, createdAt: new Date().toISOString(), tables };
}

function restoreLocalBackup(input) {
  if (
    input?.format !== 'enve-family-backup' ||
    input.version !== 1 ||
    !input.tables ||
    backupTables.some(
      (table) => !optionalBackupTables.includes(table) && !Array.isArray(input.tables[table]),
    )
  ) {
    throw new Error('Choose an Enve Family backup file.');
  }
  const rows = input.tables;
  for (const table of optionalBackupTables) rows[table] ||= [];
  if (!rows.household_lists.some((row) => row.id === 'groceries'))
    throw new Error('Backup is missing the grocery list.');
  for (const table of backupTables) {
    if (
      rows[table].length > 100000 ||
      rows[table].some((row) => !row || typeof row !== 'object' || Array.isArray(row))
    ) {
      throw new Error('Backup contains invalid rows.');
    }
  }
  if (rows.settings.some((row) => typeof row.key !== 'string' || row.key.startsWith('pin_'))) {
    throw new Error('Backup contains unsupported settings.');
  }
  db.exec('BEGIN');
  try {
    for (const table of [...backupTables].reverse()) {
      if (table !== 'profiles' && table !== 'settings') db.exec(`DELETE FROM ${table}`);
    }
    for (const table of backupTables) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
      const conflict =
        table === 'profiles' || table === 'settings'
          ? ` ON CONFLICT(${table === 'profiles' ? 'id' : 'key'}) DO UPDATE SET ${columns
              .slice(1)
              .map((column) => `${column}=excluded.${column}`)
              .join(',')}`
          : '';
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})${conflict}`,
      );
      for (const row of rows[table]) {
        const values = columns.map((column) => {
          if (!(column in row)) {
            if (table === 'photos' && column === 'purpose') return 'gallery';
            if (table === 'recipes' && column === 'servings') return 4;
            if (table === 'recipes' && column === 'photo_id') return null;
            if (
              table === 'meals' &&
              ['recipe_id', 'servings', 'series_id', 'occurrence_day'].includes(column)
            )
              return null;
            if (table === 'meals' && column === 'detached') return 0;
            if (table === 'tasks' && column === 'rotation_profiles') return '[]';
            if (table === 'tasks' && column === 'rotation_index') return 0;
            throw new Error('Backup is missing data.');
          }
          if (table === 'photos' && column === 'content') {
            if (typeof row.content !== 'string' || row.content.length > 7_000_000)
              throw new Error('Backup photo is invalid.');
            return Buffer.from(row.content, 'base64');
          }
          if (typeof row[column] === 'object' && row[column] !== null)
            throw new Error('Backup contains invalid data.');
          return row[column];
        });
        insert.run(...values);
      }
    }
    backfillMealRecipes();
    try {
      mealCategoryList();
    } catch {
      throw new Error('Backup contains invalid meal categories.');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function localEvent(input) {
  const title = requireString(input.title, 'Title');
  const profileId = requireProfile(input.profileId);
  const allDay = Boolean(input.allDay);
  const start = requireString(input.start, 'Start', 40);
  const end = requireString(input.end, 'End', 40);
  if (
    allDay
      ? !(validDate(start) && validDate(end) && end > start)
      : !(
          Number.isFinite(Date.parse(start)) &&
          Number.isFinite(Date.parse(end)) &&
          Date.parse(end) > Date.parse(start)
        )
  ) {
    throw new Error('Enter a valid start and end.');
  }
  return {
    id: cryptoId(),
    title,
    profileId,
    allDay,
    start,
    end,
    notes: String(input.notes || '').slice(0, 2000),
  };
}

function recipeInput(input) {
  const title = requireString(input.title, 'Recipe name', 120);
  const ingredients = requireString(input.ingredients, 'Ingredients', 4000);
  const lines = ingredients
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 30 || lines.some((line) => line.length > 120)) {
    throw new Error('Keep recipes to 30 ingredients of at most 120 characters each.');
  }
  const servings = Number(input.servings || 4);
  if (!Number.isInteger(servings) || servings < 1 || servings > 24)
    throw new Error('Choose 1 to 24 servings.');
  const photoId = input.photoId || null;
  if (
    photoId &&
    !db.prepare("SELECT 1 FROM photos WHERE id = ? AND purpose = 'recipe'").get(photoId)
  ) {
    throw new Error('Choose a recipe photo.');
  }
  return {
    title,
    ingredients: lines.join('\n'),
    directions: String(input.directions || '').slice(0, 5000),
    servings,
    photoId,
  };
}

function insertRecipe(recipe) {
  const id = cryptoId();
  db.prepare(
    'INSERT INTO recipes (id, title, ingredients, directions, created_at, servings, photo_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    recipe.title,
    recipe.ingredients,
    recipe.directions,
    new Date().toISOString(),
    recipe.servings,
    recipe.photoId,
  );
  return id;
}

const mealCategoryIds = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const defaultMealCategories = [
  { id: 'Breakfast', name: 'Breakfast', color: '#F2B84B', enabled: true },
  { id: 'Lunch', name: 'Lunch', color: '#8EBF83', enabled: true },
  { id: 'Dinner', name: 'Dinner', color: '#F5921A', enabled: true },
  { id: 'Snack', name: 'Snack', color: '#6CA8DF', enabled: true },
];
const mealRepeatRules = ['none', 'daily', 'weekly', 'monthly'];
const mealSeriesHorizonDays = 42;

function validMealCategories(input) {
  if (!Array.isArray(input) || input.length !== mealCategoryIds.length) {
    throw new Error('Send all four meal categories.');
  }
  const categories = input.map((item) => {
    if (!item || typeof item !== 'object' || !mealCategoryIds.includes(item.id))
      throw new Error('Choose a valid meal category.');
    const name = requireString(item.name, 'Meal category name', 30);
    if (!validColor(item.color)) throw new Error('Choose a valid meal category color.');
    if (typeof item.enabled !== 'boolean')
      throw new Error('Meal category visibility must be true or false.');
    return { id: item.id, name, color: item.color.toUpperCase(), enabled: item.enabled };
  });
  if (new Set(categories.map((item) => item.id)).size !== categories.length)
    throw new Error('Meal categories must be unique.');
  if (new Set(categories.map((item) => item.name.toLowerCase())).size !== categories.length) {
    throw new Error('Give each meal category a different name.');
  }
  if (!categories.some((item) => item.enabled))
    throw new Error('Keep at least one meal category visible.');
  return categories;
}

function mealCategoryList() {
  const stored = db
    .prepare("SELECT value FROM settings WHERE key = 'meal_categories'")
    .get()?.value;
  return stored ? validMealCategories(JSON.parse(stored)) : defaultMealCategories;
}

function requireMealCategory(value) {
  if (!mealCategoryIds.includes(value)) throw new Error('Choose a meal.');
  return value;
}

function addDays(day, count) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
}

function transaction(work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
}

function mealRecipes(input) {
  const ids =
    input.recipeIds !== undefined ? input.recipeIds : input.recipeId ? [input.recipeId] : [];
  if (
    !Array.isArray(ids) ||
    ids.length > 6 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !id)
  ) {
    throw new Error('Choose up to 6 different recipes.');
  }
  const lookup = db.prepare('SELECT id, title, servings FROM recipes WHERE id = ?');
  return ids.map((id) => {
    const recipe = lookup.get(id);
    if (!recipe) throw new Error('Choose a saved recipe.');
    return recipe;
  });
}

function mealInput(input) {
  if (!validDate(input.day)) throw new Error('Choose a valid day.');
  requireMealCategory(input.category);
  const recipes = mealRecipes(input);
  const namedTitle = typeof input.title === 'string' && input.title.trim();
  const legacySingleRecipe =
    input.recipeId && !Array.isArray(input.recipeIds) && recipes.length === 1;
  const title = legacySingleRecipe
    ? recipes[0].title
    : namedTitle
      ? requireString(input.title, 'Meal', 120)
      : recipes.length
        ? recipes
            .map((recipe) => recipe.title)
            .join(' + ')
            .slice(0, 120)
        : requireString(input.title, 'Meal', 120);
  const servings = recipes.length ? Number(input.servings || recipes[0].servings) : null;
  if (recipes.length && (!Number.isInteger(servings) || servings < 1 || servings > 24))
    throw new Error('Choose 1 to 24 servings.');
  return {
    day: input.day,
    category: input.category,
    title,
    notes: String(input.notes || '').slice(0, 500),
    servings,
    recipeIds: recipes.map((recipe) => recipe.id),
  };
}

function mealRepeat(input, day) {
  const repeatRule = input.repeatRule || 'none';
  if (!mealRepeatRules.includes(repeatRule)) throw new Error('Choose how the meal repeats.');
  const repeatUntil = repeatRule === 'none' ? null : input.repeatUntil || null;
  if (repeatUntil && (!validDate(repeatUntil) || repeatUntil < day))
    throw new Error('Choose a repeat end on or after the meal day.');
  return { repeatRule, repeatUntil };
}

function plannedMeal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Choose a suggested meal.');
  if (input.draftRecipe === undefined) {
    const meal = mealInput(input);
    if (!meal.recipeIds.length) throw new Error('Choose a saved recipe.');
    return { ...meal, id: cryptoId() };
  }
  if (!validDate(input.day)) throw new Error('Choose a valid day.');
  requireMealCategory(input.category);
  if (
    !input.draftRecipe ||
    typeof input.draftRecipe !== 'object' ||
    Array.isArray(input.draftRecipe)
  ) {
    throw new Error('Choose a recipe idea.');
  }
  const draft = recipeInput({ ...input.draftRecipe, photoId: null });
  const servings = Number(input.servings || draft.servings);
  if (!Number.isInteger(servings) || servings < 1 || servings > 24)
    throw new Error('Choose 1 to 24 servings.');
  return {
    id: cryptoId(),
    day: input.day,
    category: input.category,
    title: draft.title,
    notes: String(input.notes || '').slice(0, 500),
    servings,
    recipeIds: [],
    draft,
  };
}

function slotTaken(day, category, exceptId = '') {
  return Boolean(
    db
      .prepare('SELECT 1 FROM meals WHERE day = ? AND category = ? AND id != ?')
      .get(day, category, exceptId),
  );
}

function requireOpenSlot(day, category, exceptId) {
  if (slotTaken(day, category, exceptId)) {
    const name = mealCategoryList().find((item) => item.id === category).name;
    throw new Error(`${name} is already planned for ${day}.`);
  }
}

function setMealRecipes(mealId, recipeIds) {
  db.prepare('DELETE FROM meal_recipes WHERE meal_id = ?').run(mealId);
  const insert = db.prepare(
    'INSERT INTO meal_recipes (meal_id, recipe_id, position) VALUES (?, ?, ?)',
  );
  recipeIds.forEach((recipeId, index) => insert.run(mealId, recipeId, index));
  db.prepare('UPDATE meals SET recipe_id = ? WHERE id = ?').run(recipeIds[0] ?? null, mealId);
}

function insertMeal(meal) {
  db.prepare(
    `INSERT INTO meals (id, day, category, title, notes, servings, series_id, occurrence_day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    meal.id,
    meal.day,
    meal.category,
    meal.title,
    meal.notes,
    meal.servings,
    meal.seriesId ?? null,
    meal.occurrenceDay ?? null,
  );
  setMealRecipes(meal.id, meal.recipeIds);
}

function updateMeal(id, meal, detached) {
  db.prepare(
    'UPDATE meals SET day = ?, category = ?, title = ?, notes = ?, servings = ?, detached = ? WHERE id = ?',
  ).run(meal.day, meal.category, meal.title, meal.notes, meal.servings, Number(detached), id);
  setMealRecipes(id, meal.recipeIds);
}

function seriesDays(series, from, to) {
  const end =
    series.repeat_until && series.repeat_until < to ? addDays(series.repeat_until, 1) : to;
  const start = Date.parse(`${series.start_day}T00:00:00Z`);
  const first = new Date(start);
  const days = [];
  const step = series.repeat_rule === 'daily' ? 1 : 7;
  let index =
    series.repeat_rule === 'monthly'
      ? Math.max(
          0,
          (Number(from.slice(0, 4)) - first.getUTCFullYear()) * 12 +
            Number(from.slice(5, 7)) -
            1 -
            first.getUTCMonth() -
            1,
        )
      : Math.max(0, Math.floor((Date.parse(`${from}T00:00:00Z`) - start) / (step * 86400000)));
  for (; ; index++) {
    let day;
    if (series.repeat_rule === 'monthly') {
      const month = first.getUTCMonth() + index;
      const length = new Date(Date.UTC(first.getUTCFullYear(), month + 1, 0)).getUTCDate();
      day = new Date(Date.UTC(first.getUTCFullYear(), month, Math.min(first.getUTCDate(), length)))
        .toISOString()
        .slice(0, 10);
    } else day = addDays(series.start_day, index * step);
    if (day >= end) break;
    if (day >= from) days.push(day);
  }
  return days;
}

function generateOccurrences(series, from, to) {
  const existing = db.prepare('SELECT 1 FROM meals WHERE series_id = ? AND occurrence_day = ?');
  const skipped = db.prepare(
    'SELECT 1 FROM meal_series_skips WHERE series_id = ? AND occurrence_day = ?',
  );
  const recipeIds = JSON.parse(series.recipe_ids).filter((id) =>
    db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(id),
  );
  const created = [];
  for (const day of seriesDays(series, from, to)) {
    if (
      existing.get(series.id, day) ||
      skipped.get(series.id, day) ||
      slotTaken(day, series.category)
    )
      continue;
    const id = cryptoId();
    insertMeal({
      id,
      day,
      category: series.category,
      title: series.title,
      notes: series.notes,
      servings: recipeIds.length ? series.servings : null,
      recipeIds,
      seriesId: series.id,
      occurrenceDay: day,
    });
    created.push(id);
  }
  return created;
}

function ensureMealOccurrences(from, to) {
  const series = db
    .prepare(
      'SELECT * FROM meal_series WHERE start_day < ? AND (repeat_until IS NULL OR repeat_until >= ?)',
    )
    .all(to, from);
  if (series.length) transaction(() => series.forEach((row) => generateOccurrences(row, from, to)));
}

function insertMealSeries(meal, repeat, id = cryptoId()) {
  db.prepare('INSERT INTO meal_series VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    meal.day,
    meal.category,
    meal.title,
    meal.notes,
    meal.servings,
    JSON.stringify(meal.recipeIds),
    repeat.repeatRule,
    repeat.repeatUntil,
    new Date().toISOString(),
  );
  return db.prepare('SELECT * FROM meal_series WHERE id = ?').get(id);
}

function attachMealToSeries(id, meal, repeat, seriesId) {
  const series = insertMealSeries(meal, repeat, seriesId);
  updateMeal(id, meal, false);
  db.prepare('UPDATE meals SET series_id = ?, occurrence_day = ? WHERE id = ?').run(
    series.id,
    meal.day,
    id,
  );
  return {
    id,
    seriesId: series.id,
    ids: [id, ...generateOccurrences(series, meal.day, addDays(meal.day, mealSeriesHorizonDays))],
  };
}

function mealRecipeIds(mealId) {
  return db
    .prepare('SELECT recipe_id FROM meal_recipes WHERE meal_id = ? ORDER BY position')
    .all(mealId)
    .map((row) => row.recipe_id);
}

function suggestionRequest(input) {
  if (!validDate(input.startDay)) throw new Error('Choose a valid first day.');
  const categories = input.categories === undefined ? ['Dinner'] : input.categories;
  if (
    !Array.isArray(categories) ||
    !categories.length ||
    categories.length > 4 ||
    new Set(categories).size !== categories.length ||
    categories.some((category) => !mealCategoryIds.includes(category))
  ) {
    throw new Error('Choose one or more meal types.');
  }
  const servings = Number(input.servings || 4);
  if (!Number.isInteger(servings) || servings < 1 || servings > 24)
    throw new Error('Choose 1 to 24 servings.');
  const avoid = String(input.avoid || '')
    .slice(0, 200)
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const lastDay = addDays(input.startDay, 7);
  ensureMealOccurrences(input.startDay, lastDay);
  const occupied = new Set(
    db
      .prepare('SELECT day, category FROM meals WHERE day >= ? AND day < ?')
      .all(input.startDay, lastDay)
      .map((meal) => `${meal.day}:${meal.category}`),
  );
  const slots = [];
  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const day = addDays(input.startDay, dayIndex);
    categories.forEach((category, categoryIndex) => {
      if (!occupied.has(`${day}:${category}`))
        slots.push({ day, dayIndex, category, categoryIndex });
    });
  }
  return {
    categories,
    servings,
    avoid,
    slots,
    week: Math.floor(Date.parse(`${input.startDay}T00:00:00Z`) / (7 * 86400000)),
  };
}

function cryptoId() {
  return randomBytes(16).toString('hex');
}

function settings() {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT key, value FROM settings WHERE key NOT LIKE 'pin_%' AND key != 'meal_categories'",
      )
      .all()
      .map((row) => [row.key, row.value]),
  );
}

function starBalance(profileId) {
  return db
    .prepare('SELECT COALESCE(SUM(stars), 0) AS total FROM reward_entries WHERE profile_id = ?')
    .get(profileId).total;
}

async function googleRequest(account, url, options = {}) {
  let token = account.access_token;
  if (Date.now() >= account.expires_at - 60000) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: account.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error('Google connection expired. Reconnect the account.');
    token = data.access_token;
    db.prepare('UPDATE google_accounts SET access_token = ?, expires_at = ? WHERE id = ?').run(
      token,
      Date.now() + data.expires_in * 1000,
      account.id,
    );
  }
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!response.ok) throw new Error(`Google Calendar returned ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

async function calendarList(account) {
  const calendars = [];
  let pageToken;
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await googleRequest(account, url);
    calendars.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return calendars;
}

function validColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

async function googleColors(account) {
  if (googlePalette.expiresAt > Date.now()) return googlePalette.colors;
  try {
    const colors = await googleRequest(
      account,
      new URL('https://www.googleapis.com/calendar/v3/colors'),
    );
    googlePalette = { expiresAt: Date.now() + 60 * 60 * 1000, colors };
    return colors;
  } catch {
    googlePalette = { expiresAt: Date.now() + 10 * 60 * 1000, colors: null };
    return null;
  }
}

async function refreshGoogleCalendarColors(calendars, colors) {
  const accounts = new Map(calendars.map((calendar) => [calendar.account_id, calendar]));
  await Promise.all(
    [...accounts].map(async ([accountId, calendar]) => {
      if ((googleColorRefresh.get(accountId) || 0) > Date.now()) return;
      try {
        const entries = await calendarList({ ...calendar, id: accountId });
        const update = db.prepare(
          'UPDATE google_calendars SET color = ? WHERE account_id = ? AND google_id = ?',
        );
        for (const entry of entries) {
          const color =
            validColor(entry.backgroundColor) ||
            validColor(colors?.calendar?.[entry.colorId]?.background);
          if (color) update.run(color, accountId, entry.id);
        }
        googleColorRefresh.set(accountId, Date.now() + 60 * 60 * 1000);
      } catch {
        googleColorRefresh.set(accountId, Date.now() + 10 * 60 * 1000);
      }
    }),
  );
}

async function googleEvents(from, to, search = '') {
  const query = db
    .prepare(
      `SELECT c.*, a.profile_id, a.access_token, a.refresh_token, a.expires_at
    FROM google_calendars c JOIN google_accounts a ON a.id = c.account_id WHERE c.enabled = 1`,
    )
    .all();
  const colors = query.length ? await googleColors({ ...query[0], id: query[0].account_id }) : null;
  if (query.length) await refreshGoogleCalendarColors(query, colors);
  const calendars = query.length
    ? db
        .prepare(
          `SELECT c.*, a.profile_id, a.access_token, a.refresh_token, a.expires_at
    FROM google_calendars c JOIN google_accounts a ON a.id = c.account_id WHERE c.enabled = 1`,
        )
        .all()
    : [];
  const events = [];
  const failures = [];
  await Promise.all(
    calendars.map(async (calendar) => {
      try {
        let pageToken;
        do {
          const url = new URL(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.google_id)}/events`,
          );
          url.searchParams.set('timeMin', new Date(`${from}T00:00:00`).toISOString());
          url.searchParams.set('timeMax', new Date(`${to}T00:00:00`).toISOString());
          url.searchParams.set('singleEvents', 'true');
          url.searchParams.set('orderBy', 'startTime');
          url.searchParams.set('maxResults', search ? '100' : '2500');
          if (search) url.searchParams.set('q', search);
          if (pageToken) url.searchParams.set('pageToken', pageToken);
          const data = await googleRequest({ ...calendar, id: calendar.account_id }, url);
          events.push(
            ...(data.items || [])
              .filter((item) => item.status !== 'cancelled')
              .map((item) => ({
                id: `google:${calendar.id}:${item.id}`,
                title: item.summary || '(Untitled)',
                start: item.start?.dateTime || item.start?.date,
                end: item.end?.dateTime || item.end?.date,
                allDay: Boolean(item.start?.date),
                profileId: calendar.profile_id,
                calendarId: calendar.id,
                calendarName: calendar.name,
                googleEventId: item.id,
                notes: item.description || '',
                writable: Boolean(calendar.writable),
                source: 'google',
                color:
                  validColor(colors?.event?.[item.colorId]?.background) ||
                  validColor(calendar.color),
              })),
          );
          pageToken = search ? undefined : data.nextPageToken;
        } while (pageToken);
      } catch (cause) {
        failures.push({ calendar: calendar.name, message: cause.message });
      }
    }),
  );
  return { events, failures };
}

async function outlookRequest(account, url) {
  let token = account.access_token;
  if (Date.now() >= account.expires_at - 60000) {
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: outlookClientId,
        client_secret: outlookClientSecret,
        refresh_token: account.refresh_token,
        grant_type: 'refresh_token',
        scope: 'offline_access User.Read Calendars.Read',
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error('Outlook connection expired. Reconnect the account.');
    token = data.access_token;
    db.prepare(
      'UPDATE outlook_accounts SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?',
    ).run(
      token,
      data.refresh_token || account.refresh_token,
      Date.now() + data.expires_in * 1000,
      account.id,
    );
  }
  const target = new URL(url);
  if (target.origin !== 'https://graph.microsoft.com' || !target.pathname.startsWith('/v1.0/')) {
    throw new Error('Unexpected Outlook calendar link.');
  }
  const response = await fetch(target, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
  });
  if (!response.ok) throw new Error(`Outlook Calendar returned ${response.status}.`);
  return response.json();
}

async function outlookPages(account, url) {
  const items = [];
  let next = url;
  while (next) {
    const data = await outlookRequest(account, next);
    items.push(...(data.value || []));
    next = data['@odata.nextLink'];
  }
  return items;
}

function outlookDate(value, allDay) {
  if (allDay) return value.dateTime.slice(0, 10);
  const normalized = value.dateTime.replace(/(\.\d{3})\d+/, '$1');
  return new Date(
    /[Zz]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`,
  ).toISOString();
}

async function outlookEvents(from, to) {
  const calendars = db
    .prepare(
      `SELECT c.*, a.profile_id, a.access_token, a.refresh_token, a.expires_at
    FROM outlook_calendars c JOIN outlook_accounts a ON a.id = c.account_id WHERE c.enabled = 1`,
    )
    .all();
  const events = [];
  const failures = [];
  await Promise.all(
    calendars.map(async (calendar) => {
      try {
        const url = new URL(
          `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.outlook_id)}/calendarView`,
        );
        url.searchParams.set('startDateTime', new Date(`${from}T00:00:00`).toISOString());
        url.searchParams.set('endDateTime', new Date(`${to}T00:00:00`).toISOString());
        url.searchParams.set('$top', '1000');
        const items = await outlookPages({ ...calendar, id: calendar.account_id }, url);
        events.push(
          ...items
            .filter((item) => !item.isCancelled)
            .map((item) => ({
              id: `outlook:${calendar.id}:${item.id}`,
              title: item.subject || '(Untitled)',
              start: outlookDate(item.start, item.isAllDay),
              end: outlookDate(item.end, item.isAllDay),
              allDay: Boolean(item.isAllDay),
              profileId: calendar.profile_id,
              calendarId: calendar.id,
              calendarName: calendar.name,
              notes: item.bodyPreview || '',
              source: 'outlook',
            })),
        );
      } catch (cause) {
        failures.push({ calendar: calendar.name, message: cause.message });
      }
    }),
  );
  return { events, failures };
}

async function connectedICloudEvents(from, to) {
  const calendars = db
    .prepare(
      `SELECT c.*, a.email, a.app_password, a.profile_id
    FROM icloud_calendars c JOIN icloud_accounts a ON a.id = c.account_id WHERE c.enabled = 1`,
    )
    .all();
  const clients = new Map();
  const events = [];
  const failures = [];
  await Promise.all(
    calendars.map(async (calendar) => {
      try {
        if (!clients.has(calendar.account_id)) {
          clients.set(calendar.account_id, iCloudClient(calendar.email, calendar.app_password));
        }
        const client = await clients.get(calendar.account_id);
        events.push(...(await iCloudEvents(client, calendar, from, to)));
      } catch (cause) {
        failures.push({ calendar: calendar.name, message: cause.message });
      }
    }),
  );
  return { events, failures };
}

async function connectedFeedEvents(from, to) {
  const rows = db.prepare('SELECT * FROM feed_calendars WHERE enabled = 1').all();
  const results = await Promise.all(
    rows.map(async (calendar) => {
      let text = calendar.ics_text;
      let failure;
      if (!text || Date.now() - calendar.fetched_at > 30 * 60000) {
        try {
          text = await fetchFeed(calendar.url);
          feedEvents(text, from, to, calendar);
          db.prepare('UPDATE feed_calendars SET ics_text = ?, fetched_at = ? WHERE id = ?').run(
            text,
            Date.now(),
            calendar.id,
          );
        } catch (error) {
          failure = { calendar: calendar.name, message: error.message };
        }
      }
      if (!text) return { events: [], failure };
      try {
        return { events: feedEvents(text, from, to, calendar), failure };
      } catch (error) {
        return { events: [], failure: { calendar: calendar.name, message: error.message } };
      }
    }),
  );
  return {
    events: results.flatMap((result) => result.events),
    failures: results.map((result) => result.failure).filter(Boolean),
  };
}

function requireLocalConnection(request) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
    throw new Error('Connect iCloud from the server device using localhost.');
  }
}

function staticFile(pathname, response) {
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (file === 'index.html' && !setupComplete()) file = 'setup.html';
  if (
    ![
      'index.html',
      'setup.html',
      'setup.js',
      'setup.css',
      'onscreen-keyboard.js',
      'onscreen-keyboard.css',
      'offline.html',
      'app.js',
      'sw.js',
      'style.css',
      'manifest.webmanifest',
      'icon-180.png',
      'icon-192.png',
      'icon-512.png',
    ].includes(file)
  )
    return false;
  const type = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
  }[extname(file)];
  readFile(join(root, 'public', file))
    .then((content) => {
      response.writeHead(200, {
        'Content-Type': type === 'image/png' ? type : `${type}; charset=utf-8`,
        'Cache-Control': 'no-cache',
      });
      response.end(content);
    })
    .catch(() => error(response, 404, 'Not found.'));
  return true;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  let path = url.pathname;
  let integrationKey = null;
  try {
    if (path.startsWith('/api/integrations/v1/')) {
      if (!setupComplete()) return error(response, 409, 'Complete setup first.');
      integrationKey = integrationKeyFor(request);
      if (!integrationKey) return error(response, 401, 'Invalid integration key.');
      const suffix = path.slice('/api/integrations/v1'.length);
      if (request.method === 'GET') {
        if (suffix === '/profiles') {
          return json(response, 200, {
            profiles: db.prepare('SELECT id, name, color FROM profiles ORDER BY name').all(),
          });
        }
        if (suffix === '/tasks') {
          return json(response, 200, {
            tasks: db
              .prepare(
                `SELECT id, title, due_date AS dueDate,
            due_time AS dueTime, profile_id AS profileId, completed, repeat_rule AS repeatRule,
            task_type AS taskType, star_value AS starValue FROM tasks ORDER BY due_date, due_time LIMIT 500`,
              )
              .all(),
          });
        }
        if (suffix === '/events') {
          const from = url.searchParams.get('from');
          const to = url.searchParams.get('to');
          if (
            !validDate(from) ||
            !validDate(to) ||
            to <= from ||
            Date.parse(to) - Date.parse(from) > 43 * 86400000
          ) {
            return error(response, 400, 'Choose a date range of up to 43 days.');
          }
          const events = db
            .prepare(
              `SELECT * FROM local_events WHERE
            (repeat_rule = 'none' AND start < ? AND end > ?) OR
            (repeat_rule != 'none' AND start < ?) ORDER BY start`,
            )
            .all(to, from, to)
            .flatMap((row) =>
              expandLocalEvent(
                row,
                from,
                to,
                db.prepare('SELECT * FROM event_exceptions WHERE event_id = ?').all(row.id),
              ),
            );
          return json(response, 200, { events });
        }
        if (suffix === '/lists') {
          return json(response, 200, {
            lists: db.prepare('SELECT id, name FROM household_lists ORDER BY name').all(),
            items: db
              .prepare(
                `SELECT id, list_id AS listId, title, section, checked FROM list_items
              ORDER BY created_at LIMIT 1000`,
              )
              .all(),
          });
        }
        if (suffix === '/meals') {
          const from = url.searchParams.get('from');
          const to = url.searchParams.get('to');
          if (
            !validDate(from) ||
            !validDate(to) ||
            to <= from ||
            Date.parse(to) - Date.parse(from) > 43 * 86400000
          ) {
            return error(response, 400, 'Choose a date range of up to 43 days.');
          }
          return json(response, 200, {
            meals: db
              .prepare(
                `SELECT id, day, category, title, notes,
            recipe_id AS recipeId, servings FROM meals WHERE day >= ? AND day < ? ORDER BY day, category`,
              )
              .all(from, to),
          });
        }
        return error(response, 404, 'Integration route not found.');
      }
      path = integrationWritePath(path, request.method);
      if (!path) return error(response, 404, 'Integration route not found.');
      if (integrationKey.scope !== 'read_write')
        return error(response, 403, 'This key is read only.');
    }
    if (
      path.startsWith('/api/') &&
      ['POST', 'PATCH', 'DELETE'].includes(request.method) &&
      !['/api/login', '/api/pin/unlock', '/api/import/drafts'].includes(path)
    ) {
      response.once('finish', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          for (const stream of changeStreams) stream.write('data: refresh\n\n');
        }
      });
    }
    if (path === '/api/setup/status' && request.method === 'GET') {
      return json(response, 200, {
        needed: !setupComplete(),
        browserSetupAllowed: localSetupBrowser(request) || accessKey.length >= 12,
        bootstrapRequired: !localSetupBrowser(request) && accessKey.length >= 12,
      });
    }
    if (path === '/api/setup/network' && request.method === 'GET') {
      if (
        (!localSetupBrowser(request) &&
          !deviceAuthorized(request) &&
          !bootstrapAuthorized(request)) ||
        setupComplete()
      )
        return error(response, 403, 'Network setup is only available during setup.');
      const interfaces = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
        (addresses || [])
          .filter((address) => address.family === 'IPv4' && !address.internal)
          .map((address) => ({ name, address: address.address })),
      );
      return json(response, 200, { interfaces });
    }
    if (path === '/api/wifi/networks' && request.method === 'GET') {
      if (!wifiAuthorized(request))
        return error(
          response,
          403,
          'Wi-Fi settings are available to the owner on the Enve device.',
        );
      try {
        return json(response, 200, await scanWifi());
      } catch {
        return error(response, 503, 'Could not scan for Wi-Fi networks. Try again.');
      }
    }
    if (path === '/api/wifi/connect' && request.method === 'POST') {
      if (!wifiAuthorized(request))
        return error(
          response,
          403,
          'Wi-Fi settings are available to the owner on the Enve device.',
        );
      const input = await body(request);
      try {
        return json(response, 200, await connectWifi(input.ssid, input.password));
      } catch (cause) {
        return error(response, 400, cause.message);
      }
    }
    if (path.startsWith('/api/tailscale/')) {
      if (!tailscaleAuthorized(request))
        return error(
          response,
          403,
          'Private access can only be set up by the owner on the Enve device.',
        );
      try {
        if (path === '/api/tailscale/status' && request.method === 'GET')
          return json(response, 200, await tailscaleStatus());
        if (path === '/api/tailscale/login' && request.method === 'POST')
          return json(response, 200, await startTailscaleLogin());
        if (path === '/api/tailscale/serve' && request.method === 'POST')
          return json(response, 200, await enableTailscaleServe());
        if (path === '/api/tailscale/serve' && request.method === 'DELETE')
          return json(response, 200, await disableTailscaleServe());
      } catch (cause) {
        return error(response, 400, cause.message);
      }
      return error(response, 404, 'Private access route not found.');
    }
    if (path === '/api/setup/complete' && request.method === 'POST') {
      if (
        !localSetupBrowser(request) &&
        !deviceAuthorized(request) &&
        !bootstrapAuthorized(request)
      )
        return error(response, 403, 'Finish setup on the Enve device or enter its setup key.');
      if (setupComplete()) return error(response, 409, 'This household is already set up.');
      const input = await body(request);
      const householdName = requireString(input.householdName, 'Household name', 60);
      const mode = input.signInMode;
      if (!['none', 'shared', 'individual'].includes(mode))
        throw new Error('Choose how adults sign in.');
      const owner = input.owner || {};
      const ownerName = requireString(owner.name, 'Your name', 30);
      const ownerColor = requireString(owner.color, 'Your color', 7);
      if (!/^#[0-9a-fA-F]{6}$/.test(ownerColor)) throw new Error('Choose a valid color.');
      const ownerUsername = mode === 'individual' ? loginName(owner.username) : 'household';
      const ownerPassword = mode === 'none' ? null : passwordParts(owner.password);
      if (!Array.isArray(input.people) || input.people.length > 11)
        throw new Error('Add up to 11 other people.');
      const people = input.people.map((person) => {
        const name = requireString(person.name, 'Person name', 30);
        const color = requireString(person.color, 'Person color', 7);
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Choose a valid color.');
        if (person.username || person.password) {
          if (mode !== 'individual' || person.adult !== true)
            throw new Error('Only adults can have individual sign-ins.');
          const username = loginName(person.username);
          const [salt, hash] = passwordParts(person.password);
          return { name, color, username, salt, hash };
        }
        return { name, color };
      });
      const usernames = [ownerUsername, ...people.map((person) => person.username).filter(Boolean)];
      if (new Set(usernames).size !== usernames.length)
        throw new Error('Give each adult a different sign-in name.');
      const display = input.display || {};
      const theme = display.theme || 'auto';
      if (!['auto', 'light', 'dark'].includes(theme)) throw new Error('Choose a display theme.');
      const lightAt = display.lightAt || '07:00';
      const darkAt = display.darkAt || '19:00';
      if (![lightAt, darkAt].every((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)))
        throw new Error('Choose valid theme times.');
      const ownerId = cryptoId();
      const ownerProfileId = cryptoId();
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run(
          ownerProfileId,
          ownerName,
          ownerColor,
        );
        if (ownerPassword)
          db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            ownerId,
            ownerUsername,
            mode === 'shared' ? householdName : ownerName,
            mode === 'shared' ? null : ownerProfileId,
            'owner',
            ...ownerPassword,
          );
        for (const person of people) {
          const profileId = cryptoId();
          db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run(
            profileId,
            person.name,
            person.color,
          );
          if (person.username)
            db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run(
              cryptoId(),
              person.username,
              person.name,
              profileId,
              'member',
              person.salt,
              person.hash,
            );
        }
        db.prepare("UPDATE settings SET value = ? WHERE key = 'household_name'").run(householdName);
        db.prepare("UPDATE settings SET value = ? WHERE key = 'theme'").run(theme);
        db.prepare("UPDATE settings SET value = ? WHERE key = 'light_at'").run(lightAt);
        db.prepare("UPDATE settings SET value = ? WHERE key = 'dark_at'").run(darkAt);
        db.prepare("INSERT INTO settings VALUES ('sign_in_mode', ?) ").run(mode);
        db.prepare("UPDATE settings SET value = 'true' WHERE key = 'setup_complete'").run();
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
      if (ownerPassword) issueSession(request, response, { id: ownerId, role: 'owner' });
      return json(response, 201, { ok: true });
    }
    if (path === '/api/login' && request.method === 'POST') {
      const input = await body(request);
      const address = request.socket.remoteAddress || 'local';
      const failures = loginFailures.get(address) || { count: 0, until: 0 };
      if (failures.until > Date.now()) return error(response, 429, 'Try again in a minute.');
      let user;
      const accounts = db.prepare('SELECT * FROM users').all();
      if (accounts.length) {
        const username = String(
          input.username ||
            (settings().sign_in_mode !== 'individual' && accounts.length === 1
              ? accounts[0].username
              : ''),
        ).toLowerCase();
        const account = accounts.find((item) => item.username === username);
        const candidate = typeof input.key === 'string' ? input.key : '';
        const hash = scryptSync(candidate, account?.password_salt || 'invalid', 32).toString('hex');
        if (account && equalSecret(hash, account.password_hash))
          user = { id: account.id, role: account.role };
      } else if (accessKey && equalSecret(String(input.key || ''), accessKey)) {
        user = { id: 'legacy', role: 'owner' };
      }
      if (!user) {
        const count = failures.count + 1;
        loginFailures.set(address, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
        return error(response, 401, 'Incorrect sign-in details.');
      }
      loginFailures.delete(address);
      issueSession(request, response, user);
      return json(response, 200, { ok: true });
    }
    if (path === '/api/device/session' && request.method === 'POST') {
      if (!deviceAuthorized(request) || !setupComplete())
        return error(response, 403, 'Device session unavailable.');
      issueSession(request, response, { id: 'display', role: 'display' });
      return json(response, 200, { ok: true });
    }
    if (path === '/api/kiosk/session' && request.method === 'POST') {
      if (!localSetupBrowser(request) || !setupComplete())
        return error(response, 403, 'Wall display session unavailable.');
      issueSession(request, response, { id: 'display', role: 'display' });
      return json(response, 200, { ok: true });
    }
    if (path.startsWith('/api/') && !setupComplete())
      return error(response, 409, 'Complete setup on the Enve display first.');
    if (
      path.startsWith('/api/') &&
      !['/api/google/callback', '/api/outlook/callback'].includes(path) &&
      !integrationKey &&
      !authenticated(request)
    ) {
      return error(response, 401, 'Sign in to continue.');
    }
    if (path === '/api/changes' && request.method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      changeStreams.add(response);
      const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25000);
      response.on('close', () => {
        clearInterval(heartbeat);
        changeStreams.delete(response);
      });
      return;
    }
    if (path === '/api/pin' && request.method === 'GET')
      return json(response, 200, pinResponse(request));
    if (path === '/api/pin/unlock' && request.method === 'POST') {
      const hash = pinHash();
      if (!hash) return error(response, 400, 'No edit PIN is set.');
      const address = request.socket.remoteAddress || 'local';
      const failures = pinFailures.get(address) || { count: 0, until: 0 };
      if (failures.until > Date.now()) return error(response, 429, 'Try again in a minute.');
      const input = await body(request);
      const salt = db.prepare("SELECT value FROM settings WHERE key = 'pin_salt'").get().value;
      const entered =
        typeof input.pin === 'string' && /^\d{4,8}$/.test(input.pin)
          ? scryptSync(input.pin, salt, 32).toString('hex')
          : '';
      if (!entered || !equalSecret(entered, hash)) {
        const count = failures.count + 1;
        pinFailures.set(address, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
        return error(response, 401, 'Incorrect edit PIN.');
      }
      pinFailures.delete(address);
      const token = cryptoId();
      pinSessions.set(token, Date.now() + 15 * 60000);
      response.setHeader(
        'Set-Cookie',
        `enve_pin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`,
      );
      return json(response, 200, { enabled: true, unlocked: true });
    }
    if (path === '/api/pin' && request.method === 'POST') {
      if (pinHash() && !pinUnlocked(request)) return error(response, 423, 'Unlock edits first.');
      const input = await body(request);
      if (typeof input.pin !== 'string' || !/^\d{4,8}$/.test(input.pin))
        throw new Error('Choose a 4–8 digit PIN.');
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(input.pin, salt, 32).toString('hex');
      db.prepare(
        "INSERT INTO settings VALUES ('pin_salt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(salt);
      db.prepare(
        "INSERT INTO settings VALUES ('pin_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(hash);
      pinSessions.clear();
      return json(response, 200, { enabled: true, unlocked: false });
    }
    if (path === '/api/pin' && request.method === 'DELETE') {
      if (!pinUnlocked(request)) return error(response, 423, 'Unlock edits first.');
      db.prepare("DELETE FROM settings WHERE key IN ('pin_salt', 'pin_hash')").run();
      pinSessions.clear();
      response.setHeader('Set-Cookie', 'enve_pin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(response, 200, { enabled: false, unlocked: false });
    }
    if (
      path.startsWith('/api/') &&
      ['POST', 'PATCH', 'DELETE'].includes(request.method) &&
      !['/api/login', '/api/pin', '/api/pin/unlock'].includes(path) &&
      !(path.startsWith('/api/tasks/') && request.method === 'PATCH') &&
      !integrationKey &&
      pinHash() &&
      !pinUnlocked(request)
    )
      return error(response, 423, 'Unlock edits first.');
    if (path === '/api/integrations/keys' && request.method === 'GET') {
      if (!ownerAuthorized(request))
        return error(response, 403, 'Only the owner can manage integrations.');
      return json(response, 200, {
        keys: db
          .prepare(
            `SELECT id, name, scope, created_at AS createdAt
        FROM integration_keys ORDER BY created_at DESC`,
          )
          .all(),
      });
    }
    if (path === '/api/integrations/keys' && request.method === 'POST') {
      if (!ownerAuthorized(request))
        return error(response, 403, 'Only the owner can manage integrations.');
      const input = await body(request);
      const name = requireString(input.name, 'Connection name', 60);
      if (!['read', 'read_write'].includes(input.scope))
        throw new Error('Choose a valid access level.');
      if (db.prepare('SELECT count(*) AS count FROM integration_keys').get().count >= 20) {
        throw new Error('Remove an old connection before adding another.');
      }
      const token = `envf_${randomBytes(32).toString('hex')}`;
      const id = cryptoId();
      db.prepare('INSERT INTO integration_keys VALUES (?, ?, ?, ?, ?)').run(
        id,
        name,
        createHash('sha256').update(token).digest('hex'),
        input.scope,
        new Date().toISOString(),
      );
      return json(response, 201, { id, token });
    }
    if (path.startsWith('/api/integrations/keys/') && request.method === 'DELETE') {
      if (!ownerAuthorized(request))
        return error(response, 403, 'Only the owner can manage integrations.');
      const result = db
        .prepare('DELETE FROM integration_keys WHERE id = ?')
        .run(path.slice('/api/integrations/keys/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Connection not found.');
    }
    if (path === '/api/state' && request.method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (
        !validDate(from) ||
        !validDate(to) ||
        to <= from ||
        Date.parse(to) - Date.parse(from) > 43 * 86400000
      ) {
        return error(response, 400, 'Choose a date range of up to 43 days.');
      }
      const eventFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000)
        .toISOString()
        .slice(0, 10);
      const eventTo = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      const localRows = db
        .prepare(
          `SELECT * FROM local_events WHERE
        (repeat_rule = 'none' AND start < ? AND end > ?) OR
        (repeat_rule != 'none' AND start < ?)
        ORDER BY start`,
        )
        .all(eventTo, eventFrom, eventTo);
      const local = localRows.flatMap((row) =>
        expandLocalEvent(
          row,
          eventFrom,
          eventTo,
          db.prepare('SELECT * FROM event_exceptions WHERE event_id = ?').all(row.id),
        ),
      );
      const google = await googleEvents(eventFrom, eventTo);
      const outlook = await outlookEvents(eventFrom, eventTo);
      const icloud = await connectedICloudEvents(eventFrom, eventTo);
      const feeds = await connectedFeedEvents(eventFrom, eventTo);
      ensureMealOccurrences(from, to);
      const mealRecipeRows = db
        .prepare(
          `SELECT x.meal_id, x.recipe_id FROM meal_recipes x JOIN meals m ON m.id = x.meal_id
        WHERE m.day >= ? AND m.day < ? ORDER BY x.position`,
        )
        .all(from, to);
      const meals = db
        .prepare(
          `SELECT m.*, s.repeat_rule, s.repeat_until FROM meals m
        LEFT JOIN meal_series s ON s.id = m.series_id WHERE m.day >= ? AND m.day < ? ORDER BY m.day, m.category`,
        )
        .all(from, to)
        .map((row) => {
          const recipeIds = mealRecipeRows
            .filter((link) => link.meal_id === row.id)
            .map((link) => link.recipe_id);
          return {
            id: row.id,
            day: row.day,
            category: row.category,
            title: row.title,
            notes: row.notes,
            recipe_id: recipeIds[0] ?? null,
            servings: row.servings,
            recipeIds,
            seriesId: row.series_id,
            occurrenceDay: row.occurrence_day,
            repeatRule: row.repeat_rule || 'none',
            repeatUntil: row.repeat_until ?? null,
            detached: Boolean(row.detached),
          };
        });
      return json(response, 200, {
        profiles: db.prepare('SELECT * FROM profiles').all(),
        settings: settings(),
        tasks: db
          .prepare('SELECT * FROM tasks ORDER BY completed, due_date, created_at')
          .all()
          .map((row) => ({
            ...row,
            profileId: row.claimed_by || row.profile_id,
            ownerProfileId: row.profile_id,
            dueDate: row.due_date,
            dueTime: row.due_time,
            repeatRule: row.repeat_rule,
            starValue: row.star_value,
            taskType: row.task_type,
            claimable: Boolean(row.claimable),
            claimedBy: row.claimed_by,
            skipped: Boolean(row.skipped),
            seriesId: row.series_id || row.id,
            rotationProfiles: JSON.parse(row.rotation_profiles),
            rotationIndex: row.rotation_index,
            completed: Boolean(row.completed),
          })),
        rewards: db
          .prepare(
            'SELECT id, profile_id AS profileId, title, cost FROM rewards ORDER BY created_at',
          )
          .all(),
        goals: db
          .prepare(
            'SELECT id, profile_id AS profileId, title, target FROM goals ORDER BY created_at',
          )
          .all(),
        rewardBalances: db
          .prepare(
            'SELECT profile_id AS profileId, COALESCE(SUM(stars), 0) AS stars FROM reward_entries GROUP BY profile_id',
          )
          .all(),
        rewardHistory: db
          .prepare(
            'SELECT profile_id AS profileId, label, stars, created_at AS createdAt FROM reward_entries ORDER BY created_at DESC LIMIT 20',
          )
          .all(),
        events: [...local, ...google.events, ...outlook.events, ...icloud.events, ...feeds.events],
        syncFailures: [
          ...google.failures,
          ...outlook.failures,
          ...icloud.failures,
          ...feeds.failures,
        ],
        accounts: db
          .prepare('SELECT id, profile_id AS profileId, email FROM google_accounts')
          .all(),
        calendars: db
          .prepare(
            'SELECT id, account_id AS accountId, name, enabled, writable FROM google_calendars',
          )
          .all()
          .map((row) => ({
            ...row,
            enabled: Boolean(row.enabled),
            writable: Boolean(row.writable),
          })),
        lists: db.prepare('SELECT * FROM household_lists ORDER BY created_at').all(),
        listItems: db
          .prepare(
            'SELECT id, list_id AS listId, title, checked, section FROM list_items ORDER BY created_at',
          )
          .all()
          .map((row) => ({ ...row, checked: Boolean(row.checked) })),
        meals,
        mealCategories: mealCategoryList(),
        recipes: db.prepare('SELECT * FROM recipes ORDER BY title COLLATE NOCASE').all(),
        cloudMealIdeasConfigured: Boolean(process.env.OPENAI_API_KEY),
        googleConfigured: Boolean(googleClientId && googleClientSecret),
        outlookAccounts: db
          .prepare('SELECT id, profile_id AS profileId, email FROM outlook_accounts')
          .all(),
        outlookCalendars: db
          .prepare('SELECT id, account_id AS accountId, name, enabled FROM outlook_calendars')
          .all()
          .map((row) => ({ ...row, enabled: Boolean(row.enabled) })),
        outlookConfigured: Boolean(outlookClientId && outlookClientSecret),
        icloudAccounts: db
          .prepare('SELECT id, profile_id AS profileId, email FROM icloud_accounts')
          .all(),
        icloudCalendars: db
          .prepare('SELECT id, account_id AS accountId, name, enabled FROM icloud_calendars')
          .all()
          .map((row) => ({ ...row, enabled: Boolean(row.enabled) })),
        feedCalendars: db
          .prepare(
            'SELECT id, profile_id AS profileId, name, enabled FROM feed_calendars ORDER BY name',
          )
          .all()
          .map((row) => ({ ...row, enabled: Boolean(row.enabled) })),
      });
    }
    if (path === '/api/feed-calendars' && request.method === 'POST') {
      const input = await body(request);
      const name = requireString(input.name, 'Calendar name', 80);
      const profileId = requireProfile(input.profileId);
      const feedUrl = validateFeedUrl(requireString(input.url, 'Calendar URL', 2000)).toString();
      const contents = await fetchFeed(feedUrl);
      const id = cryptoId();
      feedEvents(contents, '2000-01-01', '2000-01-02', { id, name, profile_id: profileId });
      db.prepare('INSERT INTO feed_calendars VALUES (?, ?, ?, ?, 1, ?, ?)').run(
        id,
        profileId,
        name,
        feedUrl,
        contents,
        Date.now(),
      );
      return json(response, 201, { id });
    }
    if (path.startsWith('/api/feed-calendars/') && request.method === 'PATCH') {
      const input = await body(request);
      if (typeof input.enabled !== 'boolean') throw new Error('Enabled must be true or false.');
      const result = db
        .prepare('UPDATE feed_calendars SET enabled = ? WHERE id = ?')
        .run(Number(input.enabled), path.slice('/api/feed-calendars/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Calendar not found.');
    }
    if (path.startsWith('/api/feed-calendars/') && request.method === 'DELETE') {
      const result = db
        .prepare('DELETE FROM feed_calendars WHERE id = ?')
        .run(path.slice('/api/feed-calendars/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Calendar not found.');
    }
    if (path === '/api/weather' && request.method === 'GET') {
      const config = settings();
      const city = config.weather_city.trim();
      if (!city) return json(response, 200, { configured: false });
      const key = `${city}|${config.weather_units}`;
      if (weatherCache.key === key && weatherCache.expires > Date.now())
        return json(response, 200, weatherCache.data);
      const places = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
      );
      if (!places.ok) throw new Error('Weather location is temporarily unavailable.');
      const place = (await places.json()).results?.[0];
      if (!place) throw new Error('Weather location was not found.');
      const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
      forecastUrl.search = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current: 'temperature_2m,weather_code',
        daily: 'temperature_2m_max,temperature_2m_min,weather_code',
        temperature_unit: config.weather_units,
        timezone: place.timezone,
        forecast_days: '5',
      }).toString();
      const forecast = await fetch(forecastUrl);
      if (!forecast.ok) throw new Error('Weather forecast is temporarily unavailable.');
      const values = await forecast.json();
      const data = {
        configured: true,
        city: `${place.name}${place.admin1 ? `, ${place.admin1}` : ''}`,
        unit: config.weather_units === 'celsius' ? '°C' : '°F',
        current: values.current,
        days: values.daily.time.map((date, index) => ({
          date,
          high: values.daily.temperature_2m_max[index],
          low: values.daily.temperature_2m_min[index],
          code: values.daily.weather_code[index],
        })),
      };
      weatherCache = { key, expires: Date.now() + 30 * 60000, data };
      return json(response, 200, data);
    }
    if (path === '/api/import/drafts' && request.method === 'POST') {
      const input = await body(request, 8_000_000);
      if (!['event', 'task', 'list', 'recipe'].includes(input.type))
        throw new Error('Choose an import type.');
      let text = typeof input.text === 'string' ? input.text.slice(0, 20000) : '';
      if (input.data) {
        if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))
          throw new Error('Invalid file.');
        const bytes = Buffer.from(input.data, 'base64');
        if (!bytes.length || bytes.length > 5_000_000) throw new Error('File must be under 5 MB.');
        const isPdf = bytes.subarray(0, 4).toString() === '%PDF';
        const isImage =
          bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ||
          (bytes.subarray(0, 4).toString() === 'RIFF' &&
            bytes.subarray(8, 12).toString() === 'WEBP');
        if (!isPdf && !isImage) throw new Error('Choose a PDF, JPEG, PNG, or WebP file.');
        text = await extractDocumentText(bytes);
      }
      try {
        return json(response, 200, { text, drafts: importDrafts(text, input.type) });
      } catch (cause) {
        return json(response, 200, { text, drafts: [], message: cause.message });
      }
    }
    if (path === '/api/photos' && request.method === 'GET') {
      return json(
        response,
        200,
        db
          .prepare(
            "SELECT id, name, created_at AS createdAt FROM photos WHERE purpose = 'gallery' ORDER BY created_at DESC",
          )
          .all(),
      );
    }
    if (path === '/api/backup' && request.method === 'GET')
      return json(response, 200, localBackup());
    if (path === '/api/restore' && request.method === 'POST') {
      restoreLocalBackup(await body(request, 30_000_000));
      return json(response, 200, { ok: true });
    }
    if (path === '/api/photos' && request.method === 'POST') {
      const input = await body(request, 7_000_000);
      const name = requireString(input.name, 'Photo name', 120);
      const purpose = input.purpose || 'gallery';
      if (!['gallery', 'recipe'].includes(purpose)) throw new Error('Choose a photo use.');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.mime))
        throw new Error('Choose a JPEG, PNG, or WebP photo.');
      if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))
        throw new Error('Invalid photo.');
      const bytes = Buffer.from(input.data, 'base64');
      if (!bytes.length || bytes.length > 5_000_000) throw new Error('Photo must be under 5 MB.');
      const valid =
        input.mime === 'image/png'
          ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          : input.mime === 'image/jpeg'
            ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
            : bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP';
      if (!valid) throw new Error('Photo file does not match its format.');
      const id = cryptoId();
      db.prepare(
        'INSERT INTO photos (id, name, mime, content, created_at, purpose) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, name, input.mime, bytes, new Date().toISOString(), purpose);
      return json(response, 201, { id });
    }
    if (path.startsWith('/api/photos/') && request.method === 'GET') {
      const photo = db
        .prepare('SELECT mime, content FROM photos WHERE id = ?')
        .get(path.slice('/api/photos/'.length));
      if (!photo) return error(response, 404, 'Photo not found.');
      response.writeHead(200, {
        'Content-Type': photo.mime,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      return response.end(photo.content);
    }
    if (path.startsWith('/api/photos/') && request.method === 'DELETE') {
      const result = db
        .prepare('DELETE FROM photos WHERE id = ?')
        .run(path.slice('/api/photos/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Photo not found.');
    }
    if (path === '/api/search' && request.method === 'GET') {
      const query = requireString(url.searchParams.get('q'), 'Search', 100).toLowerCase();
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      const rows = db
        .prepare(
          `SELECT * FROM local_events
        WHERE lower(title) LIKE ? ESCAPE '\\' OR lower(notes) LIKE ? ESCAPE '\\'
        ORDER BY ABS(julianday(substr(start, 1, 10)) - julianday('now')) LIMIT 50`,
        )
        .all(pattern, pattern);
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.parse(`${today}T00:00:00Z`) + 400 * 86400000)
        .toISOString()
        .slice(0, 10);
      const events = rows
        .map((row) => {
          if (row.repeat_rule === 'none')
            return {
              id: row.id,
              title: row.title,
              start: row.start,
              end: row.end,
              allDay: Boolean(row.all_day),
              profileId: row.profile_id,
              notes: row.notes,
              source: 'local',
            };
          const exceptions = db
            .prepare('SELECT * FROM event_exceptions WHERE event_id = ?')
            .all(row.id);
          return (
            expandLocalEvent(row, today, future, exceptions)[0] ||
            expandLocalEvent(
              row,
              row.local_start.slice(0, 10),
              new Date(Date.parse(`${row.local_start.slice(0, 10)}T00:00:00Z`) + 2 * 86400000)
                .toISOString()
                .slice(0, 10),
              exceptions,
            )[0]
          );
        })
        .filter(Boolean);
      const queryRange = { from: addDays(today, -365), to: addDays(today, 730) };
      const scanRange = { from: addDays(today, -90), to: addDays(today, 365) };
      const [google, outlook, icloud, feeds] = await Promise.all([
        googleEvents(queryRange.from, queryRange.to, query),
        outlookEvents(scanRange.from, scanRange.to),
        connectedICloudEvents(scanRange.from, scanRange.to),
        connectedFeedEvents(scanRange.from, scanRange.to),
      ]);
      const matches = (item) => `${item.title}\n${item.notes || ''}`.toLowerCase().includes(query);
      const now = Date.now();
      const connectedEvents = [
        ...google.events,
        ...[...outlook.events, ...icloud.events, ...feeds.events].filter(matches),
      ]
        .sort((a, b) => Math.abs(Date.parse(a.start) - now) - Math.abs(Date.parse(b.start) - now))
        .slice(0, 100);
      const coverage = [
        ['google', 'google_calendars', 'query', queryRange],
        ['outlook', 'outlook_calendars', 'range', scanRange],
        ['icloud', 'icloud_calendars', 'range', scanRange],
        ['feed', 'feed_calendars', 'range', scanRange],
      ]
        .map(([source, table, method, range]) => ({
          source,
          method,
          ...range,
          calendars: db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE enabled = 1`).get()
            .count,
          ...(method === 'query' ? { limitPerCalendar: 100 } : {}),
        }))
        .filter((item) => item.calendars);
      const failures = [
        ['google', google],
        ['outlook', outlook],
        ['icloud', icloud],
        ['feed', feeds],
      ].flatMap(([source, result]) => result.failures.map((failure) => ({ source, ...failure })));
      return json(response, 200, { events, connectedEvents, coverage, failures });
    }
    if (path === '/api/lists' && request.method === 'POST') {
      const input = await body(request);
      const name = requireString(input.name, 'List name', 60);
      const id = cryptoId();
      db.prepare('INSERT INTO household_lists (id, name, created_at) VALUES (?, ?, ?)').run(
        id,
        name,
        new Date().toISOString(),
      );
      return json(response, 201, { id });
    }
    if (path.startsWith('/api/lists/') && request.method === 'PATCH') {
      const input = await body(request);
      if (!['added', 'alpha', 'checked'].includes(input.sortOrder))
        throw new Error('Choose a valid list sort.');
      const result = db
        .prepare('UPDATE household_lists SET sort_order = ? WHERE id = ?')
        .run(input.sortOrder, path.slice('/api/lists/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'List not found.');
    }
    if (path.startsWith('/api/lists/') && request.method === 'DELETE') {
      const id = path.slice('/api/lists/'.length);
      if (id === 'groceries') throw new Error('The grocery list cannot be deleted.');
      const result = db.prepare('DELETE FROM household_lists WHERE id = ?').run(id);
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'List not found.');
    }
    if (path === '/api/list-items' && request.method === 'POST') {
      const input = await body(request);
      const title = requireString(input.title, 'Item', 120);
      const listId = requireString(input.listId, 'List', 40);
      const section = String(input.section || '')
        .trim()
        .slice(0, 40);
      if (!db.prepare('SELECT 1 FROM household_lists WHERE id = ?').get(listId))
        throw new Error('Choose a list.');
      const id = cryptoId();
      db.prepare(
        'INSERT INTO list_items (id, list_id, title, created_at, section) VALUES (?, ?, ?, ?, ?)',
      ).run(id, listId, title, new Date().toISOString(), section);
      return json(response, 201, { id });
    }
    if (path.startsWith('/api/list-items/') && request.method === 'PATCH') {
      const input = await body(request);
      if (typeof input.checked !== 'boolean') throw new Error('Checked must be true or false.');
      const result = db
        .prepare('UPDATE list_items SET checked = ? WHERE id = ?')
        .run(Number(input.checked), path.slice('/api/list-items/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Item not found.');
    }
    if (path.startsWith('/api/list-items/') && request.method === 'DELETE') {
      const result = db
        .prepare('DELETE FROM list_items WHERE id = ?')
        .run(path.slice('/api/list-items/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Item not found.');
    }
    if (path === '/api/meal-categories' && request.method === 'PATCH') {
      const input = await body(request);
      const categories = validMealCategories(Array.isArray(input) ? input : input.mealCategories);
      db.prepare(
        "INSERT INTO settings VALUES ('meal_categories', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(categories));
      return json(response, 200, { mealCategories: categories });
    }
    if (path === '/api/meals/suggestions' && request.method === 'POST') {
      const plan = suggestionRequest(await body(request));
      const recipes = db
        .prepare(
          'SELECT id, title, ingredients, servings FROM recipes ORDER BY title COLLATE NOCASE',
        )
        .all()
        .filter((recipe) =>
          plan.avoid.every(
            (term) => !`${recipe.title}\n${recipe.ingredients}`.toLowerCase().includes(term),
          ),
        );
      if (!recipes.length)
        throw new Error('Save a recipe that matches your ingredient exclusions first.');
      const suggestions = plan.slots.map((slot) => {
        const recipe =
          recipes[
            (plan.week + slot.dayIndex * plan.categories.length + slot.categoryIndex) %
              recipes.length
          ];
        return {
          day: slot.day,
          category: slot.category,
          recipeId: recipe.id,
          recipeIds: [recipe.id],
          title: recipe.title,
          servings: plan.servings,
          ingredients: scaleIngredients(recipe.ingredients, recipe.servings, plan.servings).split(
            '\n',
          ),
        };
      });
      return json(response, 200, { suggestions });
    }
    if (path === '/api/meals/ideas' && request.method === 'POST') {
      const input = await body(request);
      if (input.source !== undefined && !['builtin', 'cloud'].includes(input.source)) {
        throw new Error('Choose built-in or cloud meal ideas.');
      }
      const plan = suggestionRequest(input);
      if (input.source === 'cloud') {
        if (!plan.slots.length) return json(response, 200, { suggestions: [] });
        if (plan.slots.length > 14)
          throw new Error('Choose no more than 14 open meal slots for cloud ideas.');
        const ideas = await generateCloudMealIdeas({
          slots: plan.slots.map(({ day, category }) => ({ day, category })),
          servings: plan.servings,
          avoid: plan.avoid,
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.OPENAI_MEAL_MODEL || 'gpt-6-luna',
        });
        return json(response, 200, {
          suggestions: ideas.map((idea) => ({
            ...idea,
            title: idea.recipeDraft.title,
            ingredients: idea.recipeDraft.ingredients.split('\n'),
            draftRecipe: idea.recipeDraft,
          })),
        });
      }
      const saved = new Set(
        db
          .prepare('SELECT lower(title) AS title FROM recipes')
          .all()
          .map((row) => row.title),
      );
      const ideas = mealIdeas.filter(
        (idea) =>
          !saved.has(idea.title.toLowerCase()) &&
          plan.avoid.every(
            (term) =>
              !`${idea.title}\n${idea.ingredients.join('\n')}\n${idea.contains.join('\n')}`
                .toLowerCase()
                .includes(term),
          ),
      );
      const used = new Map();
      const suggestions = plan.slots.flatMap((slot) => {
        const pool = ideas.filter((idea) => idea.category === slot.category);
        if (!pool.length) return [];
        const count = used.get(slot.category) || 0;
        used.set(slot.category, count + 1);
        const idea = pool[(plan.week * 7 + count) % pool.length];
        const ingredients = idea.ingredients.join('\n');
        return [
          {
            day: slot.day,
            category: slot.category,
            ideaId: idea.id,
            recipeId: null,
            title: idea.title,
            servings: plan.servings,
            ingredients: scaleIngredients(ingredients, idea.servings, plan.servings).split('\n'),
            draftRecipe: {
              title: idea.title,
              ingredients,
              directions: idea.directions,
              servings: idea.servings,
            },
          },
        ];
      });
      if (plan.slots.length && !suggestions.length)
        throw new Error('No new recipe ideas match those meals and exclusions.');
      return json(response, 200, { suggestions });
    }
    if (path === '/api/meals/plan' && request.method === 'POST') {
      const input = await body(request);
      if (!Array.isArray(input.meals) || !input.meals.length || input.meals.length > 28) {
        throw new Error('Choose 1 to 28 suggested meals.');
      }
      const meals = input.meals.map(plannedMeal);
      const slots = meals.map((meal) => `${meal.day}:${meal.category}`);
      if (
        new Set(slots).size !== slots.length ||
        meals.some((meal) => slotTaken(meal.day, meal.category))
      ) {
        throw new Error('A meal is already planned in one of these slots.');
      }
      const createdRecipeIds = transaction(() => {
        const created = [];
        const drafts = new Map();
        const existing = db.prepare(
          'SELECT id FROM recipes WHERE lower(title) = lower(?) AND ingredients = ?',
        );
        for (const meal of meals) {
          if (meal.draft) {
            const key = `${meal.draft.title.toLowerCase()}\n${meal.draft.ingredients}`;
            let recipeId =
              drafts.get(key) || existing.get(meal.draft.title, meal.draft.ingredients)?.id;
            if (!recipeId) {
              recipeId = insertRecipe(meal.draft);
              created.push(recipeId);
            }
            drafts.set(key, recipeId);
            meal.recipeIds = [recipeId];
          }
          insertMeal(meal);
        }
        return created;
      });
      return json(response, 201, { ids: meals.map((meal) => meal.id), createdRecipeIds });
    }
    if (path === '/api/meals/groceries' && request.method === 'POST') {
      const input = await body(request);
      if (
        !Array.isArray(input.mealIds) ||
        !input.mealIds.length ||
        input.mealIds.length > 28 ||
        new Set(input.mealIds).size !== input.mealIds.length ||
        input.mealIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id))
      ) {
        throw new Error('Choose 1 to 28 planned meals.');
      }
      const mealLookup = db.prepare('SELECT servings FROM meals WHERE id = ?');
      const recipeLookup = db.prepare(`SELECT r.ingredients, r.servings FROM meal_recipes x
        JOIN recipes r ON r.id = x.recipe_id WHERE x.meal_id = ? ORDER BY x.position`);
      const transferred = db.prepare('SELECT 1 FROM meal_grocery_transfers WHERE meal_id = ?');
      const pending = [];
      const skippedMealIds = [];
      for (const id of input.mealIds) {
        const meal = mealLookup.get(id);
        const recipes = meal ? recipeLookup.all(id) : [];
        if (!recipes.length) throw new Error('Choose planned meals linked to saved recipes.');
        if (transferred.get(id)) {
          skippedMealIds.push(id);
          continue;
        }
        pending.push({
          id,
          lines: recipes.flatMap((recipe) =>
            scaleIngredients(
              recipe.ingredients,
              recipe.servings,
              meal.servings || recipe.servings,
            ).split('\n'),
          ),
        });
      }
      const combined = aggregateIngredients(pending.flatMap((meal) => meal.lines));
      const counts = transaction(() => {
        const now = new Date().toISOString();
        const mealPlanItems = db
          .prepare(
            `SELECT id, title FROM list_items
          WHERE list_id = 'groceries' AND checked = 0 AND section = 'Meal plan' ORDER BY created_at`,
          )
          .all();
        const unchecked = new Set(
          db
            .prepare(
              "SELECT lower(title) AS title FROM list_items WHERE list_id = 'groceries' AND checked = 0",
            )
            .all()
            .map((row) => row.title),
        );
        const insert = db.prepare(
          'INSERT INTO list_items (id, list_id, title, created_at, section) VALUES (?, ?, ?, ?, ?)',
        );
        const rename = db.prepare('UPDATE list_items SET title = ? WHERE id = ?');
        let added = 0;
        let updated = 0;
        for (const line of combined) {
          const part = ingredientPart(line);
          const match =
            part && mealPlanItems.find((item) => ingredientPart(item.title)?.key === part.key);
          if (match) {
            const current = ingredientPart(match.title);
            match.title = formatIngredient({
              ...current,
              quantity: current.quantity + part.quantity,
            });
            rename.run(match.title, match.id);
            updated++;
          } else if (part || !unchecked.has(line.toLowerCase())) {
            const id = cryptoId();
            insert.run(id, 'groceries', line, now, 'Meal plan');
            if (part) mealPlanItems.push({ id, title: line });
            unchecked.add(line.toLowerCase());
            added++;
          }
        }
        const ledger = db.prepare('INSERT INTO meal_grocery_transfers VALUES (?, ?, ?)');
        for (const meal of pending) ledger.run(meal.id, now, JSON.stringify(meal.lines));
        return { added, updated };
      });
      return json(response, 200, { ...counts, ingredients: combined, skippedMealIds });
    }
    if (path === '/api/meals' && request.method === 'POST') {
      const input = await body(request);
      const meal = mealInput(input);
      const repeat = mealRepeat(input, meal.day);
      requireOpenSlot(meal.day, meal.category);
      const result = transaction(() => {
        const id = cryptoId();
        insertMeal({ ...meal, id });
        return repeat.repeatRule === 'none' ? { id } : attachMealToSeries(id, meal, repeat);
      });
      return json(response, 201, result);
    }
    if (path.startsWith('/api/meals/') && ['PATCH', 'DELETE'].includes(request.method)) {
      const id = path.slice('/api/meals/'.length);
      const current = db.prepare('SELECT * FROM meals WHERE id = ?').get(id);
      if (!current) return error(response, 404, 'Meal not found.');
      const scope = url.searchParams.get('scope') || 'occurrence';
      if (!['occurrence', 'series'].includes(scope))
        throw new Error('Choose this meal or the whole series.');
      const series =
        current.series_id &&
        db.prepare('SELECT * FROM meal_series WHERE id = ?').get(current.series_id);
      const pivot = current.occurrence_day;
      if (request.method === 'DELETE') {
        transaction(() => {
          if (series && scope === 'series') {
            db.prepare(
              'DELETE FROM meals WHERE id = ? OR (series_id = ? AND occurrence_day >= ?)',
            ).run(id, series.id, pivot);
            if (pivot <= series.start_day)
              db.prepare('DELETE FROM meal_series WHERE id = ?').run(series.id);
            else {
              db.prepare('UPDATE meal_series SET repeat_until = ? WHERE id = ?').run(
                addDays(pivot, -1),
                series.id,
              );
              db.prepare(
                'DELETE FROM meal_series_skips WHERE series_id = ? AND occurrence_day >= ?',
              ).run(series.id, pivot);
            }
          } else {
            db.prepare('DELETE FROM meals WHERE id = ?').run(id);
            if (series)
              db.prepare('INSERT OR IGNORE INTO meal_series_skips VALUES (?, ?)').run(
                series.id,
                pivot,
              );
          }
        });
        return json(response, 200, { ok: true });
      }
      const input = await body(request);
      const recipesChanged = input.recipeIds !== undefined || input.recipeId !== undefined;
      const keepTitle =
        !recipesChanged ||
        !(Array.isArray(input.recipeIds) ? input.recipeIds.length : input.recipeId);
      const meal = mealInput({
        day: input.day ?? current.day,
        category: input.category ?? current.category,
        notes: input.notes ?? current.notes,
        servings: input.servings ?? current.servings ?? undefined,
        title: input.title ?? (keepTitle ? current.title : ''),
        ...(recipesChanged
          ? { recipeIds: input.recipeIds, recipeId: input.recipeId }
          : { recipeIds: mealRecipeIds(id) }),
      });
      if (series && scope === 'occurrence') {
        if (
          (input.repeatRule !== undefined && input.repeatRule !== series.repeat_rule) ||
          (input.repeatUntil !== undefined && (input.repeatUntil || null) !== series.repeat_until)
        ) {
          throw new Error('Change repeat settings for the whole series.');
        }
        requireOpenSlot(meal.day, meal.category, id);
        transaction(() => updateMeal(id, meal, true));
        return json(response, 200, { ok: true, id, seriesId: series.id });
      }
      if (!series) {
        const repeat = mealRepeat(input, meal.day);
        requireOpenSlot(meal.day, meal.category, id);
        const result = transaction(() => {
          updateMeal(id, meal, false);
          db.prepare('UPDATE meals SET series_id = NULL, occurrence_day = NULL WHERE id = ?').run(
            id,
          );
          return repeat.repeatRule === 'none' ? { id } : attachMealToSeries(id, meal, repeat);
        });
        return json(response, 200, { ok: true, ...result });
      }
      const repeat = mealRepeat(
        {
          repeatRule: input.repeatRule ?? series.repeat_rule,
          repeatUntil: input.repeatUntil !== undefined ? input.repeatUntil : series.repeat_until,
        },
        meal.day,
      );
      const result = transaction(() => {
        db.prepare(
          'DELETE FROM meals WHERE id != ? AND series_id = ? AND occurrence_day >= ? AND detached = 0',
        ).run(id, series.id, pivot);
        const restart = pivot <= series.start_day;
        if (restart) db.prepare('DELETE FROM meal_series WHERE id = ?').run(series.id);
        else {
          db.prepare('UPDATE meal_series SET repeat_until = ? WHERE id = ?').run(
            addDays(pivot, -1),
            series.id,
          );
          db.prepare(
            'DELETE FROM meal_series_skips WHERE series_id = ? AND occurrence_day >= ?',
          ).run(series.id, pivot);
        }
        requireOpenSlot(meal.day, meal.category, id);
        updateMeal(id, meal, false);
        db.prepare('UPDATE meals SET series_id = NULL, occurrence_day = NULL WHERE id = ?').run(id);
        return repeat.repeatRule === 'none'
          ? { id }
          : attachMealToSeries(id, meal, repeat, restart ? series.id : undefined);
      });
      return json(response, 200, { ok: true, ...result });
    }
    if (path === '/api/recipes' && request.method === 'POST') {
      return json(response, 201, { id: insertRecipe(recipeInput(await body(request))) });
    }
    if (path.startsWith('/api/recipes/') && path.endsWith('/scale') && request.method === 'GET') {
      const id = path.slice('/api/recipes/'.length, -'/scale'.length);
      const recipe = db.prepare('SELECT ingredients, servings FROM recipes WHERE id = ?').get(id);
      if (!recipe) return error(response, 404, 'Recipe not found.');
      const servings = Number(url.searchParams.get('servings'));
      if (!Number.isInteger(servings) || servings < 1 || servings > 24)
        throw new Error('Choose 1 to 24 servings.');
      return json(response, 200, {
        ingredients: scaleIngredients(recipe.ingredients, recipe.servings, servings),
      });
    }
    if (
      path.startsWith('/api/recipes/') &&
      path.endsWith('/groceries') &&
      request.method === 'POST'
    ) {
      const id = path.slice('/api/recipes/'.length, -'/groceries'.length);
      const recipe = db.prepare('SELECT ingredients, servings FROM recipes WHERE id = ?').get(id);
      if (!recipe) return error(response, 404, 'Recipe not found.');
      const input = await body(request);
      const servings = Number(input.servings || recipe.servings);
      if (!Number.isInteger(servings) || servings < 1 || servings > 24)
        throw new Error('Choose 1 to 24 servings.');
      const ingredients = scaleIngredients(recipe.ingredients, recipe.servings, servings)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (ingredients.length > 30 || ingredients.some((line) => line.length > 120)) {
        throw new Error('Keep recipes to 30 ingredients of at most 120 characters each.');
      }
      const existing = new Set(
        db
          .prepare(
            "SELECT lower(title) AS title FROM list_items WHERE list_id = 'groceries' AND checked = 0",
          )
          .all()
          .map((row) => row.title),
      );
      let added = 0;
      for (const ingredient of ingredients) {
        if (existing.has(ingredient.toLowerCase())) continue;
        db.prepare(
          'INSERT INTO list_items (id, list_id, title, created_at) VALUES (?, ?, ?, ?)',
        ).run(cryptoId(), 'groceries', ingredient, new Date().toISOString());
        existing.add(ingredient.toLowerCase());
        added++;
      }
      return json(response, 200, { added });
    }
    if (path.startsWith('/api/recipes/') && request.method === 'PATCH') {
      const id = path.slice('/api/recipes/'.length);
      const { title, ingredients, directions, servings, photoId } = recipeInput(
        await body(request),
      );
      const result = db
        .prepare(
          'UPDATE recipes SET title = ?, ingredients = ?, directions = ?, servings = ?, photo_id = ? WHERE id = ?',
        )
        .run(title, ingredients, directions, servings, photoId, id);
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Recipe not found.');
    }
    if (path.startsWith('/api/recipes/') && request.method === 'DELETE') {
      const result = db
        .prepare('DELETE FROM recipes WHERE id = ?')
        .run(path.slice('/api/recipes/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Recipe not found.');
    }
    if (path === '/api/events' && request.method === 'POST') {
      const input = await body(request);
      const event = localEvent(input);
      const repeat = recurrenceFields(input, event);
      db.prepare(
        `INSERT INTO local_events
        (id, title, start, end, all_day, profile_id, notes, repeat_rule, repeat_until, time_zone, local_start, local_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.id,
        event.title,
        event.start,
        event.end,
        Number(event.allDay),
        event.profileId,
        event.notes,
        repeat.repeatRule,
        repeat.repeatUntil,
        repeat.timeZone,
        repeat.localStart,
        repeat.localEnd,
      );
      return json(response, 201, event);
    }
    if (path.startsWith('/api/events/') && request.method === 'PATCH') {
      const id = path.slice('/api/events/'.length);
      const input = await body(request);
      const event = localEvent(input);
      const occurrence = url.searchParams.get('occurrence');
      if (occurrence) {
        if (!validDate(occurrence)) throw new Error('Choose a valid occurrence.');
        const series = db
          .prepare('SELECT * FROM local_events WHERE id = ? AND repeat_rule != ?')
          .get(id, 'none');
        if (!series) return error(response, 404, 'Recurring event not found.');
        const prior = db
          .prepare('SELECT 1 FROM event_exceptions WHERE event_id = ? AND occurrence_date = ?')
          .get(id, occurrence);
        const nextDay = new Date(Date.parse(`${occurrence}T00:00:00Z`) + 86400000)
          .toISOString()
          .slice(0, 10);
        if (
          !prior &&
          !expandLocalEvent(series, occurrence, nextDay).some(
            (item) => item.occurrenceDate === occurrence,
          )
        ) {
          throw new Error('That date is not in this repeating series.');
        }
        const payload = JSON.stringify({
          title: event.title,
          profileId: event.profileId,
          notes: event.notes,
          allDay: event.allDay,
          start: event.start,
          end: event.end,
        });
        db.prepare(
          `INSERT INTO event_exceptions VALUES (?, ?, 0, ?)
          ON CONFLICT(event_id, occurrence_date) DO UPDATE SET deleted = 0, payload = excluded.payload`,
        ).run(id, occurrence, payload);
        return json(response, 200, { ok: true });
      }
      const repeat = recurrenceFields(input, event);
      const result = db
        .prepare(
          `UPDATE local_events SET title = ?, start = ?, end = ?, all_day = ?, profile_id = ?, notes = ?,
        repeat_rule = ?, repeat_until = ?, time_zone = ?, local_start = ?, local_end = ? WHERE id = ?`,
        )
        .run(
          event.title,
          event.start,
          event.end,
          Number(event.allDay),
          event.profileId,
          event.notes,
          repeat.repeatRule,
          repeat.repeatUntil,
          repeat.timeZone,
          repeat.localStart,
          repeat.localEnd,
          id,
        );
      if (result.changes) db.prepare('DELETE FROM event_exceptions WHERE event_id = ?').run(id);
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Event not found.');
    }
    if (path.startsWith('/api/events/') && request.method === 'DELETE') {
      const id = path.slice('/api/events/'.length);
      const occurrence = url.searchParams.get('occurrence');
      if (occurrence) {
        if (!validDate(occurrence)) throw new Error('Choose a valid occurrence.');
        const series = db
          .prepare('SELECT * FROM local_events WHERE id = ? AND repeat_rule != ?')
          .get(id, 'none');
        if (!series) return error(response, 404, 'Recurring event not found.');
        const nextDay = new Date(Date.parse(`${occurrence}T00:00:00Z`) + 86400000)
          .toISOString()
          .slice(0, 10);
        const prior = db
          .prepare('SELECT 1 FROM event_exceptions WHERE event_id = ? AND occurrence_date = ?')
          .get(id, occurrence);
        if (
          !prior &&
          !expandLocalEvent(series, occurrence, nextDay).some(
            (item) => item.occurrenceDate === occurrence,
          )
        ) {
          throw new Error('That date is not in this repeating series.');
        }
        db.prepare(
          `INSERT INTO event_exceptions VALUES (?, ?, 1, NULL)
          ON CONFLICT(event_id, occurrence_date) DO UPDATE SET deleted = 1, payload = NULL`,
        ).run(id, occurrence);
        return json(response, 200, { ok: true });
      }
      const result = db.prepare('DELETE FROM local_events WHERE id = ?').run(id);
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Event not found.');
    }
    if (path === '/api/tasks' && request.method === 'POST') {
      const input = await body(request);
      const title = requireString(input.title, 'Title');
      const profileId = requireProfile(input.profileId);
      const dueDate = input.dueDate || null;
      if (dueDate && !validDate(dueDate)) throw new Error('Enter a valid due date.');
      const dueTime = input.dueTime || null;
      if (dueTime && (!dueDate || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)))
        throw new Error('Choose a valid task time and due date.');
      const repeatRule = ['none', 'daily', 'weekly', 'monthly'].includes(input.repeatRule)
        ? input.repeatRule
        : 'none';
      const starValue = input.starValue === undefined ? 1 : Number(input.starValue);
      if (!Number.isInteger(starValue) || starValue < 0 || starValue > 5)
        throw new Error('Choose 0 to 5 stars.');
      const taskType = input.taskType || 'chore';
      if (!['chore', 'routine', 'habit'].includes(taskType)) throw new Error('Choose a task type.');
      const claimable = input.claimable === true || input.claimable === 'on';
      if (claimable && (taskType !== 'chore' || profileId !== 'family')) {
        throw new Error('Only family chores can be claimed.');
      }
      const rotationProfiles = input.rotationProfiles === undefined ? [] : input.rotationProfiles;
      if (
        !Array.isArray(rotationProfiles) ||
        rotationProfiles.length > 8 ||
        (rotationProfiles.length > 0 &&
          (rotationProfiles.length < 2 ||
            taskType !== 'chore' ||
            repeatRule === 'none' ||
            !dueDate ||
            claimable ||
            rotationProfiles[0] !== profileId ||
            new Set(rotationProfiles).size !== rotationProfiles.length ||
            rotationProfiles.some(
              (id) =>
                !db
                  .prepare("SELECT 1 FROM profiles WHERE id = ? AND id NOT IN ('family', 'enve')")
                  .get(id),
            )))
      ) {
        throw new Error(
          'Choose two or more household members in rotation order for a repeating chore.',
        );
      }
      const id = cryptoId();
      db.prepare(
        `INSERT INTO tasks (id, title, due_date, profile_id, completed, repeat_rule, created_at,
        star_value, due_time, task_type, claimable, series_id, rotation_profiles, rotation_index)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        id,
        title,
        dueDate,
        profileId,
        repeatRule,
        new Date().toISOString(),
        starValue,
        dueTime,
        taskType,
        Number(claimable),
        id,
        JSON.stringify(rotationProfiles),
      );
      return json(response, 201, { id });
    }
    if (path.startsWith('/api/tasks/') && request.method === 'PATCH') {
      const id = path.slice('/api/tasks/'.length);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) return error(response, 404, 'Task not found.');
      const input = await body(request);
      if (input.claimProfileId !== undefined) {
        if (!task.claimable || task.completed || task.claimed_by)
          throw new Error('This chore cannot be claimed.');
        const claimant = requireProfile(input.claimProfileId);
        if (claimant === 'family' || claimant === 'enve')
          throw new Error('Choose a household member.');
        db.prepare('UPDATE tasks SET claimed_by = ? WHERE id = ?').run(claimant, id);
        return json(response, 200, { ok: true });
      }
      if (typeof input.completed !== 'boolean' && input.skipped !== true)
        throw new Error('Choose complete or skip.');
      if (input.skipped === true && task.completed)
        throw new Error('This task is already finished.');
      const completed = input.skipped === true || input.completed === true;
      if (task.claimable && !task.claimed_by && completed && !input.skipped)
        throw new Error('Claim this chore before completing it.');
      const awardProfile = task.claimed_by || task.profile_id;
      if (task.completed && !completed) {
        const award = db.prepare('SELECT stars FROM reward_entries WHERE task_id = ?').get(id);
        if (award && starBalance(awardProfile) < award.stars) {
          throw new Error(
            'This task’s stars have been spent. Keep it completed or add more stars first.',
          );
        }
        db.prepare('DELETE FROM reward_entries WHERE task_id = ?').run(id);
      }
      db.prepare('UPDATE tasks SET completed = ?, skipped = ? WHERE id = ?').run(
        Number(completed),
        Number(input.skipped === true),
        id,
      );
      if (completed && !task.completed && !input.skipped && task.star_value > 0) {
        db.prepare('INSERT INTO reward_entries VALUES (?, ?, ?, NULL, ?, ?, ?)').run(
          cryptoId(),
          awardProfile,
          id,
          `Completed ${task.title}`,
          task.star_value,
          new Date().toISOString(),
        );
      }
      if (
        completed &&
        !task.completed &&
        !task.next_generated &&
        task.repeat_rule !== 'none' &&
        task.due_date
      ) {
        const next = new Date(`${task.due_date}T12:00:00Z`);
        if (task.repeat_rule === 'daily') next.setUTCDate(next.getUTCDate() + 1);
        if (task.repeat_rule === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
        if (task.repeat_rule === 'monthly') {
          const day = next.getUTCDate();
          next.setUTCDate(1);
          next.setUTCMonth(next.getUTCMonth() + 1);
          next.setUTCDate(
            Math.min(
              day,
              new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate(),
            ),
          );
        }
        const rotationProfiles = JSON.parse(task.rotation_profiles);
        const rotationIndex = rotationProfiles.length
          ? (task.rotation_index + 1) % rotationProfiles.length
          : 0;
        const nextProfileId = rotationProfiles[rotationIndex] || task.profile_id;
        db.prepare(
          `INSERT INTO tasks (id, title, due_date, profile_id, completed, repeat_rule, created_at,
          star_value, due_time, task_type, claimable, series_id, rotation_profiles, rotation_index)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cryptoId(),
          task.title,
          next.toISOString().slice(0, 10),
          nextProfileId,
          task.repeat_rule,
          new Date().toISOString(),
          task.star_value,
          task.due_time,
          task.task_type,
          task.claimable,
          task.series_id || task.id,
          task.rotation_profiles,
          rotationIndex,
        );
        db.prepare('UPDATE tasks SET next_generated = 1 WHERE id = ?').run(id);
      }
      return json(response, 200, { ok: true });
    }
    if (path.startsWith('/api/tasks/') && request.method === 'DELETE') {
      const result = db
        .prepare('DELETE FROM tasks WHERE id = ?')
        .run(path.slice('/api/tasks/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Task not found.');
    }
    if (path === '/api/rewards' && request.method === 'POST') {
      const input = await body(request);
      const title = requireString(input.title, 'Reward', 120);
      const profileId = requireProfile(input.profileId);
      const cost = Number(input.cost);
      if (!Number.isInteger(cost) || cost < 1 || cost > 1000)
        throw new Error('Choose a cost from 1 to 1000 stars.');
      const id = cryptoId();
      db.prepare('INSERT INTO rewards VALUES (?, ?, ?, ?, ?)').run(
        id,
        profileId,
        title,
        cost,
        new Date().toISOString(),
      );
      return json(response, 201, { id });
    }
    if (path === '/api/goals' && request.method === 'POST') {
      const input = await body(request);
      const title = requireString(input.title, 'Goal', 120);
      const profileId = requireProfile(input.profileId);
      const target = Number(input.target);
      if (!Number.isInteger(target) || target < 1 || target > 1000)
        throw new Error('Choose a target from 1 to 1000 stars.');
      const id = cryptoId();
      db.prepare('INSERT INTO goals VALUES (?, ?, ?, ?, ?)').run(
        id,
        profileId,
        title,
        target,
        new Date().toISOString(),
      );
      return json(response, 201, { id });
    }
    if (path.startsWith('/api/goals/') && request.method === 'DELETE') {
      const result = db
        .prepare('DELETE FROM goals WHERE id = ?')
        .run(path.slice('/api/goals/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Goal not found.');
    }
    if (path.startsWith('/api/rewards/') && path.endsWith('/redeem') && request.method === 'POST') {
      const id = path.slice('/api/rewards/'.length, -'/redeem'.length);
      const reward = db.prepare('SELECT * FROM rewards WHERE id = ?').get(id);
      if (!reward) return error(response, 404, 'Reward not found.');
      if (starBalance(reward.profile_id) < reward.cost) throw new Error('Not enough stars yet.');
      db.prepare('INSERT INTO reward_entries VALUES (?, ?, NULL, ?, ?, ?, ?)').run(
        cryptoId(),
        reward.profile_id,
        id,
        `Redeemed ${reward.title}`,
        -reward.cost,
        new Date().toISOString(),
      );
      return json(response, 200, { ok: true });
    }
    if (path.startsWith('/api/rewards/') && request.method === 'DELETE') {
      const result = db
        .prepare('DELETE FROM rewards WHERE id = ?')
        .run(path.slice('/api/rewards/'.length));
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Reward not found.');
    }
    if (path === '/api/settings' && request.method === 'PATCH') {
      const input = await body(request);
      const allowed = {
        theme: ['auto', 'light', 'dark'],
        night_dim: ['true', 'false'],
        sleep_enabled: ['true', 'false'],
        reminders_enabled: ['true', 'false'],
        reminder_chime: ['true', 'false'],
        weather_units: ['fahrenheit', 'celsius'],
        photos_enabled: ['true', 'false'],
        display_density: ['comfortable', 'compact'],
        text_size: ['small', 'normal', 'large'],
        layout_mode: ['auto', 'portrait', 'landscape'],
      };
      for (const [key, value] of Object.entries(input)) {
        const string = String(value);
        if (allowed[key] && !allowed[key].includes(string)) throw new Error(`Invalid ${key}.`);
        if (
          key === 'accent_color' &&
          !['#F5921A', '#62C9AC', '#8DBBF1', '#C0A6F1', '#F2A6B6'].includes(string)
        )
          throw new Error('Choose an accent color.');
        if (
          ['light_at', 'dark_at', 'sleep_at', 'wake_at'].includes(key) &&
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(string)
        )
          throw new Error(`Invalid ${key}.`);
        if (key === 'dim_after_minutes' && !(Number(string) >= 1 && Number(string) <= 120))
          throw new Error(`Invalid ${key}.`);
        if (key === 'dim_amount' && !(Number(string) >= 10 && Number(string) <= 95))
          throw new Error(`Invalid ${key}.`);
        if (key === 'reminder_minutes' && !['0', '5', '15', '30', '60'].includes(string))
          throw new Error('Choose a reminder time.');
        if (key === 'weather_city' && string.length > 80) throw new Error('Location is too long.');
        if (key === 'household_name' && (!string.trim() || string.length > 60))
          throw new Error('Choose a household name.');
        if (key === 'photos_after_minutes' && !['1', '5', '10', '30'].includes(string))
          throw new Error('Choose an idle photo time.');
        if (
          ![
            'household_name',
            'theme',
            'accent_color',
            'light_at',
            'dark_at',
            'night_dim',
            'dim_after_minutes',
            'dim_amount',
            'sleep_enabled',
            'sleep_at',
            'wake_at',
            'reminders_enabled',
            'reminder_minutes',
            'reminder_chime',
            'weather_city',
            'weather_units',
            'photos_enabled',
            'photos_after_minutes',
            'display_density',
            'text_size',
            'layout_mode',
          ].includes(key)
        )
          throw new Error(`Unknown setting ${key}.`);
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(string, key);
      }
      return json(response, 200, settings());
    }
    if (path === '/api/profiles' && request.method === 'POST') {
      const input = await body(request);
      const name = requireString(input.name, 'Name', 30);
      const color = requireString(input.color, 'Color', 7);
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Choose a valid color.');
      const id = cryptoId();
      db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run(id, name, color);
      return json(response, 201, { id });
    }
    if (path.startsWith('/api/profiles/') && request.method === 'DELETE') {
      const id = path.slice('/api/profiles/'.length);
      if (['family', 'enve'].includes(id))
        return error(response, 400, 'This built-in profile cannot be removed.');
      if (db.prepare('SELECT 1 FROM users WHERE profile_id = ?').get(id))
        return error(response, 400, 'Remove this person’s sign-in first.');
      const result = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      return result.changes
        ? json(response, 200, { ok: true })
        : error(response, 404, 'Person not found.');
    }
    if (path.startsWith('/api/profiles/') && request.method === 'PATCH') {
      const id = path.slice('/api/profiles/'.length);
      requireProfile(id);
      const input = await body(request);
      const name = requireString(input.name, 'Name', 30);
      const color = requireString(input.color, 'Color', 7);
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Choose a valid color.');
      db.prepare('UPDATE profiles SET name = ?, color = ? WHERE id = ?').run(name, color, id);
      return json(response, 200, { ok: true });
    }
    if (path === '/api/users' && request.method === 'GET') {
      requireOwner(request);
      return json(response, 200, {
        mode: settings().sign_in_mode || null,
        users: db
          .prepare(
            'SELECT id, username, display_name AS displayName, profile_id AS profileId, role FROM users ORDER BY role, username',
          )
          .all(),
      });
    }
    if (path === '/api/users/activate' && request.method === 'POST') {
      if (db.prepare('SELECT 1 FROM users LIMIT 1').get())
        return error(response, 409, 'Sign-ins are already configured.');
      if (!ownerAuthorized(request))
        return error(response, 403, 'Only the household owner can turn on sign-ins.');
      const input = await body(request);
      if (!['shared', 'individual'].includes(input.mode)) throw new Error('Choose a sign-in mode.');
      const username = input.mode === 'shared' ? 'household' : loginName(input.username);
      const profileId = input.mode === 'shared' ? null : requireProfile(input.profileId);
      const displayName =
        input.mode === 'shared'
          ? settings().household_name
          : requireString(input.displayName, 'Name', 30);
      const [salt, hash] = passwordParts(input.password);
      const id = cryptoId();
      db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        username,
        displayName,
        profileId,
        'owner',
        salt,
        hash,
      );
      db.prepare(
        "INSERT INTO settings VALUES ('sign_in_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(input.mode);
      sessions.clear();
      issueSession(request, response, { id, role: 'owner' });
      return json(response, 201, { id });
    }
    if (path === '/api/users/disable' && request.method === 'POST') {
      requireOwner(request);
      if (!db.prepare('SELECT 1 FROM users LIMIT 1').get())
        return error(response, 409, 'Sign-ins are already off.');
      if ((await body(request)).confirm !== true)
        throw new Error('Confirm that anyone who can reach this server may open the household.');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM users').run();
        db.prepare(
          "INSERT INTO settings VALUES ('sign_in_mode', 'none') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run();
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
      sessions.clear();
      return json(response, 200, { ok: true });
    }
    if (path === '/api/users/individual' && request.method === 'POST') {
      requireOwner(request);
      if (settings().sign_in_mode !== 'shared')
        return error(
          response,
          409,
          'Start with a shared sign-in to switch to individual accounts.',
        );
      const input = await body(request);
      const username = loginName(input.username);
      const displayName = requireString(input.displayName, 'Name', 30);
      const profileId = requireProfile(input.profileId);
      db.exec('BEGIN');
      try {
        db.prepare(
          "UPDATE users SET username = ?, display_name = ?, profile_id = ? WHERE role = 'owner'",
        ).run(username, displayName, profileId);
        db.prepare("UPDATE settings SET value = 'individual' WHERE key = 'sign_in_mode'").run();
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
      return json(response, 200, { ok: true });
    }
    if (path === '/api/users' && request.method === 'POST') {
      requireOwner(request);
      if (settings().sign_in_mode !== 'individual')
        throw new Error('Choose individual sign-ins during setup to add adult accounts.');
      const input = await body(request);
      const username = loginName(input.username);
      const displayName = requireString(input.displayName, 'Name', 30);
      const profileId = requireProfile(input.profileId);
      const [salt, hash] = passwordParts(input.password);
      const id = cryptoId();
      db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        username,
        displayName,
        profileId,
        'member',
        salt,
        hash,
      );
      return json(response, 201, { id });
    }
    if (path.startsWith('/api/users/') && request.method === 'PATCH') {
      requireOwner(request);
      const id = path.slice('/api/users/'.length);
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id))
        return error(response, 404, 'Sign-in not found.');
      const input = await body(request);
      const [salt, hash] = passwordParts(input.password);
      const ownerSession = sessionFor(request);
      db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(
        salt,
        hash,
        id,
      );
      sessions.clear();
      issueSession(request, response, ownerSession || { id: 'legacy', role: 'owner' });
      return json(response, 200, { ok: true });
    }
    if (path.startsWith('/api/users/') && request.method === 'DELETE') {
      requireOwner(request);
      const id = path.slice('/api/users/'.length);
      const user = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
      if (!user) return error(response, 404, 'Sign-in not found.');
      if (user.role === 'owner')
        return error(response, 400, 'Keep an owner sign-in for this household.');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      for (const [token, session] of sessions) if (session.id === id) sessions.delete(token);
      return json(response, 200, { ok: true });
    }
    if (path === '/api/google/start' && request.method === 'GET') {
      if (!googleClientId || !googleClientSecret)
        return error(response, 400, 'Google OAuth is not configured.');
      const profileId = requireProfile(url.searchParams.get('profileId'));
      const state = cryptoId();
      oauthStates.set(state, { provider: 'google', profileId, expiresAt: Date.now() + 600000 });
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries({
        client_id: googleClientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        state,
        scope:
          'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
      })) {
        auth.searchParams.set(key, value);
      }
      response.writeHead(302, { Location: auth.toString() });
      return response.end();
    }
    if (path === '/api/google/callback' && request.method === 'GET') {
      const state = url.searchParams.get('state');
      const pending = oauthStates.get(state);
      oauthStates.delete(state);
      if (
        !pending ||
        pending.provider !== 'google' ||
        pending.expiresAt < Date.now() ||
        !url.searchParams.get('code')
      )
        throw new Error('Google connection was cancelled or expired.');
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: url.searchParams.get('code'),
          client_id: googleClientId,
          client_secret: googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || !tokens.refresh_token)
        throw new Error('Google did not provide offline access. Reconnect and approve access.');
      const account = {
        id: cryptoId(),
        profile_id: pending.profileId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
      };
      const calendars = await calendarList(account);
      const primary = calendars.find((calendar) => calendar.primary);
      account.email = primary?.id || 'Google account';
      const previous = db
        .prepare('SELECT id FROM google_accounts WHERE email = ?')
        .get(account.email);
      if (previous) db.prepare('DELETE FROM google_accounts WHERE id = ?').run(previous.id);
      db.prepare('INSERT INTO google_accounts VALUES (?, ?, ?, ?, ?, ?)').run(
        account.id,
        account.profile_id,
        account.email,
        account.access_token,
        account.refresh_token,
        account.expires_at,
      );
      for (const calendar of calendars) {
        db.prepare(
          'INSERT INTO google_calendars (id, account_id, google_id, name, enabled, writable, color) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          cryptoId(),
          account.id,
          calendar.id,
          calendar.summary || calendar.id,
          Number(Boolean(calendar.primary)),
          Number(['owner', 'writer'].includes(calendar.accessRole)),
          validColor(calendar.backgroundColor),
        );
      }
      response.writeHead(302, { Location: '/?connected=1' });
      return response.end();
    }
    if (path.startsWith('/api/google/calendars/') && request.method === 'PATCH') {
      const id = path.slice('/api/google/calendars/'.length);
      const input = await body(request);
      if (typeof input.enabled !== 'boolean') throw new Error('Enabled must be true or false.');
      db.prepare('UPDATE google_calendars SET enabled = ? WHERE id = ?').run(
        Number(input.enabled),
        id,
      );
      return json(response, 200, { ok: true });
    }
    if (path.startsWith('/api/google/accounts/') && request.method === 'DELETE') {
      db.prepare('DELETE FROM google_accounts WHERE id = ?').run(
        path.slice('/api/google/accounts/'.length),
      );
      return json(response, 200, { ok: true });
    }
    if (path === '/api/outlook/start' && request.method === 'GET') {
      if (!outlookClientId || !outlookClientSecret)
        return error(response, 400, 'Outlook OAuth is not configured.');
      const profileId = requireProfile(url.searchParams.get('profileId'));
      const state = cryptoId();
      const verifier = randomBytes(48).toString('base64url');
      oauthStates.set(state, {
        provider: 'outlook',
        profileId,
        verifier,
        expiresAt: Date.now() + 600000,
      });
      const auth = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      for (const [key, value] of Object.entries({
        client_id: outlookClientId,
        redirect_uri: outlookRedirectUri,
        response_type: 'code',
        response_mode: 'query',
        prompt: 'select_account',
        state,
        scope: 'offline_access User.Read Calendars.Read',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) {
        auth.searchParams.set(key, value);
      }
      response.writeHead(302, { Location: auth.toString() });
      return response.end();
    }
    if (path === '/api/outlook/callback' && request.method === 'GET') {
      const state = url.searchParams.get('state');
      const pending = oauthStates.get(state);
      oauthStates.delete(state);
      if (
        !pending ||
        pending.provider !== 'outlook' ||
        pending.expiresAt < Date.now() ||
        !url.searchParams.get('code')
      ) {
        throw new Error('Outlook connection was cancelled or expired.');
      }
      const tokenResponse = await fetch(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: outlookClientId,
            client_secret: outlookClientSecret,
            code: url.searchParams.get('code'),
            code_verifier: pending.verifier,
            redirect_uri: outlookRedirectUri,
            grant_type: 'authorization_code',
            scope: 'offline_access User.Read Calendars.Read',
          }),
        },
      );
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || !tokens.refresh_token)
        throw new Error('Outlook did not provide offline access. Reconnect and approve access.');
      const account = {
        id: cryptoId(),
        profile_id: pending.profileId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
      };
      const me = await outlookRequest(account, 'https://graph.microsoft.com/v1.0/me');
      account.email = me.mail || me.userPrincipalName || me.id;
      const calendars = await outlookPages(
        account,
        'https://graph.microsoft.com/v1.0/me/calendars',
      );
      const previous = db
        .prepare('SELECT id FROM outlook_accounts WHERE email = ?')
        .get(account.email);
      if (previous) db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(previous.id);
      db.prepare('INSERT INTO outlook_accounts VALUES (?, ?, ?, ?, ?, ?)').run(
        account.id,
        account.profile_id,
        account.email,
        account.access_token,
        account.refresh_token,
        account.expires_at,
      );
      for (const calendar of calendars) {
        db.prepare('INSERT INTO outlook_calendars VALUES (?, ?, ?, ?, 1)').run(
          cryptoId(),
          account.id,
          calendar.id,
          calendar.name || 'Outlook calendar',
        );
      }
      response.writeHead(302, { Location: '/?connected=outlook' });
      return response.end();
    }
    if (path.startsWith('/api/outlook/calendars/') && request.method === 'PATCH') {
      const id = path.slice('/api/outlook/calendars/'.length);
      const input = await body(request);
      if (typeof input.enabled !== 'boolean') throw new Error('Enabled must be true or false.');
      db.prepare('UPDATE outlook_calendars SET enabled = ? WHERE id = ?').run(
        Number(input.enabled),
        id,
      );
      return json(response, 200, { ok: true });
    }
    if (path.startsWith('/api/outlook/accounts/') && request.method === 'DELETE') {
      db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(
        path.slice('/api/outlook/accounts/'.length),
      );
      return json(response, 200, { ok: true });
    }
    if (path === '/api/icloud/accounts' && request.method === 'POST') {
      requireLocalConnection(request);
      const input = await body(request);
      const email = requireString(input.email, 'Apple Account email', 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new Error('Enter a valid Apple Account email.');
      const password = requireString(input.appPassword, 'App-specific password', 100);
      const profileId = requireProfile(input.profileId);
      let calendars;
      try {
        const client = await iCloudClient(email, password);
        calendars = await client.fetchCalendars();
      } catch {
        throw new Error('Could not connect to iCloud. Check the email and app-specific password.');
      }
      const usable = calendars.filter(
        (calendar) => !calendar.components || calendar.components.includes('VEVENT'),
      );
      if (!usable.length) throw new Error('No iCloud event calendars were found.');
      const accountId = cryptoId();
      const previous = db.prepare('SELECT id FROM icloud_accounts WHERE email = ?').get(email);
      if (previous) db.prepare('DELETE FROM icloud_accounts WHERE id = ?').run(previous.id);
      db.prepare('INSERT INTO icloud_accounts VALUES (?, ?, ?, ?)').run(
        accountId,
        profileId,
        email,
        password,
      );
      for (const calendar of usable) {
        db.prepare('INSERT INTO icloud_calendars VALUES (?, ?, ?, ?, 1)').run(
          cryptoId(),
          accountId,
          iCloudCalendarUrl(calendar.url),
          typeof calendar.displayName === 'string' ? calendar.displayName : 'iCloud calendar',
        );
      }
      return json(response, 201, { ok: true });
    }
    if (path.startsWith('/api/icloud/calendars/') && request.method === 'PATCH') {
      const id = path.slice('/api/icloud/calendars/'.length);
      const input = await body(request);
      if (typeof input.enabled !== 'boolean') throw new Error('Enabled must be true or false.');
      db.prepare('UPDATE icloud_calendars SET enabled = ? WHERE id = ?').run(
        Number(input.enabled),
        id,
      );
      return json(response, 200, { ok: true });
    }
    if (path.startsWith('/api/icloud/accounts/') && request.method === 'DELETE') {
      db.prepare('DELETE FROM icloud_accounts WHERE id = ?').run(
        path.slice('/api/icloud/accounts/'.length),
      );
      return json(response, 200, { ok: true });
    }
    if (path === '/api/icloud/events' && request.method === 'POST') {
      const input = await body(request);
      const event = localEvent(input);
      const calendar = db
        .prepare(
          `SELECT c.*, a.email, a.app_password FROM icloud_calendars c
        JOIN icloud_accounts a ON a.id = c.account_id WHERE c.id = ?`,
        )
        .get(input.calendarId);
      if (!calendar) throw new Error('Choose an iCloud calendar.');
      const client = await iCloudClient(calendar.email, calendar.app_password);
      const object = newICloudObject(event);
      const result = await client.createCalendarObject({
        calendar: { url: iCloudCalendarUrl(calendar.url) },
        iCalString: object.data,
        filename: `${object.uid}.ics`,
      });
      if (!result.ok) throw new Error(`iCloud Calendar returned ${result.status}.`);
      return json(response, 201, { ok: true });
    }
    if (path === '/api/icloud/events' && ['PATCH', 'DELETE'].includes(request.method)) {
      const input = await body(request);
      const calendar = db
        .prepare(
          `SELECT c.*, a.email, a.app_password FROM icloud_calendars c
        JOIN icloud_accounts a ON a.id = c.account_id WHERE c.id = ?`,
        )
        .get(input.calendarId);
      if (!calendar) throw new Error('Choose an iCloud calendar.');
      const objectUrl = iCloudCalendarUrl(requireString(input.objectUrl, 'Event link', 2000));
      const calendarUrl = new URL(iCloudCalendarUrl(calendar.url));
      const objectLocation = new URL(objectUrl);
      if (
        objectLocation.origin !== calendarUrl.origin ||
        !objectLocation.pathname.startsWith(`${calendarUrl.pathname.replace(/\/$/, '')}/`)
      ) {
        throw new Error('Event does not belong to this iCloud calendar.');
      }
      const client = await iCloudClient(calendar.email, calendar.app_password);
      const objects = await client.fetchCalendarObjects({
        calendar: { url: calendar.url },
        objectUrls: [objectUrl],
      });
      const object = objects[0];
      if (!object) return error(response, 404, 'Event not found.');
      if (!canEditICloudObject(object.data))
        throw new Error('Edit recurring events and invitations in Apple Calendar.');
      let result;
      if (request.method === 'DELETE')
        result = await client.deleteCalendarObject({ calendarObject: object });
      else {
        const event = localEvent(input);
        result = await client.updateCalendarObject({
          calendarObject: {
            ...object,
            data: updatedICloudObject(object.data, event),
          },
        });
      }
      if (!result.ok) throw new Error(`iCloud Calendar returned ${result.status}.`);
      return json(response, 200, { ok: true });
    }
    if (path === '/api/google/events' && request.method === 'POST') {
      const input = await body(request);
      const event = localEvent(input);
      const calendar = db
        .prepare(
          `SELECT c.*, a.access_token, a.refresh_token, a.expires_at
        FROM google_calendars c JOIN google_accounts a ON a.id = c.account_id WHERE c.id = ? AND c.writable = 1`,
        )
        .get(input.calendarId);
      if (!calendar) throw new Error('Choose a writable Google calendar.');
      const payload = {
        summary: event.title,
        description: event.notes,
        start: event.allDay ? { date: event.start } : { dateTime: event.start },
        end: event.allDay ? { date: event.end } : { dateTime: event.end },
      };
      await googleRequest(
        { ...calendar, id: calendar.account_id },
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.google_id)}/events`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      return json(response, 201, { ok: true });
    }
    if (path.startsWith('/api/google/events/') && ['PATCH', 'DELETE'].includes(request.method)) {
      const parts = path.slice('/api/google/events/'.length).split('/');
      if (parts.length !== 2) throw new Error('Choose an event.');
      const [calendarId, eventId] = parts.map(decodeURIComponent);
      const calendar = db
        .prepare(
          `SELECT c.*, a.access_token, a.refresh_token, a.expires_at
        FROM google_calendars c JOIN google_accounts a ON a.id = c.account_id WHERE c.id = ? AND c.writable = 1`,
        )
        .get(calendarId);
      if (!calendar) throw new Error('Choose a writable Google calendar.');
      const endpoint = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.google_id)}/events/${encodeURIComponent(eventId)}`;
      if (request.method === 'DELETE') {
        await googleRequest({ ...calendar, id: calendar.account_id }, endpoint, {
          method: 'DELETE',
        });
      } else {
        const event = localEvent(await body(request));
        const payload = {
          summary: event.title,
          description: event.notes,
          start: event.allDay ? { date: event.start } : { dateTime: event.start },
          end: event.allDay ? { date: event.end } : { dateTime: event.end },
        };
        await googleRequest({ ...calendar, id: calendar.account_id }, endpoint, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      }
      return json(response, 200, { ok: true });
    }
    if (path.startsWith('/api/')) return error(response, 404, 'Not found.');
    if (!staticFile(path, response)) return error(response, 404, 'Not found.');
  } catch (cause) {
    error(response, cause.status || 400, cause.message || 'Request failed.');
  }
});

server.listen(port, host, () => console.log(`Enve Family Dashboard: http://localhost:${port}`));
