/**
 * Config resolution: CLI flag > environment variable > config file > default.
 * Nothing here reads the network, and secrets are only written to the config
 * file (mode 0600), never to stdout unless explicitly asked.
 *
 * There is no built-in host: point the CLI at your own Dockhand web UI with
 * `dockhand config set base-url <url>`, `DOCKHAND_URL`, or `--base-url`. The
 * localhost default only covers a local development instance.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULTS = {
  baseUrl: 'http://localhost:3000',
  output: 'json',
  timeout: 30_000,
};

export function configPath() {
  return process.env.DOCKHAND_CONFIG
    ? resolve(process.env.DOCKHAND_CONFIG)
    : join(homedir(), '.config', 'dockhand', 'config.json');
}

export function readConfig() {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`config file ${path} is not valid JSON: ${error.message}`);
  }
}

export function writeConfig(patch) {
  const path = configPath();
  const current = readConfig();
  const next = { ...current, ...patch };
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || value === '') delete next[key];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Filesystems without POSIX modes (e.g. some network mounts) — ignore.
  }
  return { path, config: next };
}

const SECRET_KEYS = new Set(['token', 'cookie', 'password']);

export function redact(config) {
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    out[key] = SECRET_KEYS.has(key) ? maskSecret(value) : value;
  }
  return out;
}

export function maskSecret(value) {
  const text = String(value);
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}…${text.slice(-4)} (${text.length} chars)`;
}

/**
 * Resolve the effective settings for a run. `flags` are already-parsed CLI flags.
 */
export function resolveSettings(flags = new Map()) {
  const file = readConfig();
  const flag = (name) => {
    const values = flags.get(name);
    return values ? values[values.length - 1] : undefined;
  };
  const env = process.env;

  const baseUrl = String(
    flag('base-url') || flag('url') || env.DOCKHAND_URL || file.baseUrl || env.DOCKHAND_BASE_URL || DEFAULTS.baseUrl,
  ).replace(/\/+$/, '');
  // True when the user never pointed the CLI at their own instance; used to
  // turn a bare connection failure into an actionable message.
  const baseUrlConfigured = Boolean(
    flag('base-url') || flag('url') || env.DOCKHAND_URL || env.DOCKHAND_BASE_URL || file.baseUrl,
  );
  const token = flag('token') || env.DOCKHAND_TOKEN || file.token || undefined;
  const cookie = flag('cookie') || env.DOCKHAND_COOKIE || file.cookie || undefined;
  const output = String(flag('output') || env.DOCKHAND_OUTPUT || DEFAULTS.output);
  const timeoutRaw = flag('timeout') || env.DOCKHAND_TIMEOUT;
  const timeout = timeoutRaw === undefined ? DEFAULTS.timeout : Number(timeoutRaw);
  const password = flag('password') || env.DOCKHAND_PASSWORD || undefined;
  const username = flag('username') || flag('user') || env.DOCKHAND_USERNAME || undefined;

  return {
    baseUrl,
    baseUrlConfigured,
    token,
    cookie,
    output,
    timeout: Number.isFinite(timeout) ? timeout : DEFAULTS.timeout,
    username,
    password,
    verbose: Boolean(flag('verbose')) || env.DOCKHAND_VERBOSE === '1',
    quiet: Boolean(flag('quiet')) || env.DOCKHAND_QUIET === '1',
    color: flag('no-color') ? false : process.stdout.isTTY === true && env.NO_COLOR === undefined,
    dryRun: Boolean(flag('dry-run')),
    publicRoute: Boolean(flag('public')),
    configFile: file,
    configPath: configPath(),
    fileConfig: file,
  };
}