/**
 * Config resolution: CLI flag > named instance > environment variable >
 * top-level config > default. Nothing here reads the network, and secrets are
 * only written to the config file (mode 0600), never to stdout unless
 * explicitly asked.
 *
 * Multiple Dockhand instances are supported through named `instances` entries,
 * each holding its own baseUrl and pre-configured credentials:
 *
 *   { "baseUrl": "https://default.example.com", "token": "…",
 *     "instances": { "prod": { "baseUrl": "…", "token": "…" } } }
 *
 * Select one with `--instance <name>` / `DOCKHAND_INSTANCE`, or point
 * `--base-url` / `DOCKHAND_URL` at a configured URL and its credentials apply
 * automatically. There is no built-in host: the localhost default only covers
 * a local development instance.
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
    if (key === 'instances' && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry)]));
      continue;
    }
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
 *
 * Per-field precedence: CLI flag > named instance > environment variable >
 * top-level config > fallback env > default. A named instance is chosen with
 * `--instance <name>` or `DOCKHAND_INSTANCE`; without one, a base URL that
 * matches a configured instance pulls in that instance's credentials, so
 * `--base-url https://prod…` needs no token on the command line.
 */
export function resolveSettings(flags = new Map()) {
  const file = readConfig();
  const instances = readInstances(file);
  const flag = (name) => {
    const values = flags.get(name);
    return values ? values[values.length - 1] : undefined;
  };
  const env = process.env;

  // -- instance selection --------------------------------------------------
  const instanceArg = flag('instance') ?? env.DOCKHAND_INSTANCE;
  const requestedInstance = instanceArg === undefined || instanceArg === '' ? null : String(instanceArg);
  const selected = requestedInstance ? instances[requestedInstance] ?? null : null;
  // Surfaced instead of thrown so `help`/`completion` keep working; callers
  // that need a real instance reject it before sending anything (`login`
  // treats it as the name of an instance to create).
  const instanceUnknown = requestedInstance && !selected ? requestedInstance : null;

  // -- base URL ------------------------------------------------------------
  const flagUrl = flag('base-url') || flag('url') || null;
  const envUrl = env.DOCKHAND_URL || null;
  const fileUrl = file.baseUrl || null;
  const rawUrl = flagUrl || selected?.baseUrl || envUrl || fileUrl || env.DOCKHAND_BASE_URL || DEFAULTS.baseUrl;
  const baseUrl = normalizeBaseUrl(rawUrl);
  const baseUrlConfigured = Boolean(flagUrl || selected?.baseUrl || envUrl || fileUrl);

  // -- credentials ---------------------------------------------------------
  // An explicitly requested instance wins over ambient env so a stray
  // DOCKHAND_URL/DOCKHAND_TOKEN can never mix two instances' identities; a
  // URL-matched instance beats a stale top-level token.
  const matched = selected ?? matchInstance(instances, baseUrl);
  const token = flag('token') || selected?.token || matched?.token || env.DOCKHAND_TOKEN || file.token || undefined;
  const cookie = flag('cookie') || selected?.cookie || matched?.cookie || env.DOCKHAND_COOKIE || file.cookie || undefined;

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
    instanceName: selected ? requestedInstance : matched?.name ?? null,
    instanceUnknown,
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

/** Strip trailing slashes so configured and requested URLs compare equal. */
export function normalizeBaseUrl(url) {
  return String(url).replace(/\/+$/, '');
}

/** Validated map of named instances; throws on a malformed config section. */
export function readInstances(file = readConfig()) {
  const raw = file.instances;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`"instances" in ${configPath()} must be an object of named entries`);
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`instances.${name} in ${configPath()} must be an object with baseUrl/token/cookie`);
    }
  }
  return raw;
}

/** Match a configured instance by normalized base URL. */
export function matchInstance(instances, baseUrl) {
  const wanted = normalizeBaseUrl(baseUrl);
  for (const [name, entry] of Object.entries(instances)) {
    if (entry.baseUrl && normalizeBaseUrl(entry.baseUrl) === wanted) return { name, ...entry };
  }
  return null;
}

/**
 * Create/update one named instance (`patch` merged into its entry; null
 * values clear fields), or remove it entirely with `patch === null`. An
 * entry left with no fields is dropped, and an empty instances map is not
 * written back to the file.
 */
export function writeInstance(name, patch) {
  if (!name || typeof name !== 'string') throw new Error('instance name is required');
  const instances = { ...readInstances() };
  if (patch === null) {
    delete instances[name];
  } else {
    const entry = { ...(instances[name] ?? {}), ...patch };
    for (const [key, value] of Object.entries(entry)) {
      if (value === null || value === undefined || value === '') delete entry[key];
    }
    if (Object.keys(entry).length) instances[name] = entry;
    else delete instances[name];
  }
  return writeConfig({ instances: Object.keys(instances).length ? instances : null });
}