/**
 * Hand-written commands. Everything in here is CLI-side plumbing — nothing
 * here is generated from the OpenAPI document, because it either has no HTTP
 * counterpart (help, completion, config) or is a deliberate escape hatch
 * (raw) for routes the generator has not seen.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, CliError, EXIT } from './client.js';
import { loadTable } from './commands.js';
import { DEFAULTS, maskSecret, readConfig, redact, writeConfig, configPath } from './config.js';
import { commandHelp, groupHelp, rootHelp } from './help.js';
import { render } from './render.js';
import { completionScript } from './completion.js';

/** The packaged agent skill, resolved relative to this module. */
const SKILL_PATH = resolvePath(fileURLToPath(new URL('../skills/dockhand/SKILL.md', import.meta.url)));

export async function runBuiltin(command, ctx) {
  switch (command.builtin) {
    case 'help':
      return help(ctx);
    case 'version':
      return version(ctx);
    case 'raw':
      return raw(ctx);
    case 'login':
      return login(ctx);
    case 'logout':
      return logout(ctx);
    case 'config.show':
      return configShow(ctx);
    case 'config.path':
      return console.log(configPath());
    case 'config.set':
      return configSet(ctx);
    case 'config.unset':
      return configUnset(ctx);
    case 'completion':
      return completion(ctx);
    case 'spec.path':
      return specPath(ctx);
    case 'spec.commands':
      return specCommands(ctx);
    case 'skill':
      return skill(ctx);
    case 'generate':
      return generate(ctx);
    default:
      throw new CliError(`unimplemented builtin: ${command.builtin}`, { exitCode: EXIT.USAGE });
  }
}

// ---------------------------------------------------------------------------

function help({ table, positionals }) {
  if (!positionals.length) {
    console.log(rootHelp(table));
    return;
  }
  const name = positionals.join(' ');
  const exact = table.commands.find((c) => c.name === name || c.aliases?.includes(name));
  if (exact) {
    console.log(commandHelp(table, exact));
    return;
  }
  const group = table.groups.find((g) => g === positionals[0]);
  if (group) {
    console.log(groupHelp(table, group));
    return;
  }
  console.log(rootHelp(table));
}

function version({ table, settings }) {
  console.log(`${table.cli.name} ${table.cli.version}`);
  console.log(`api    ${table.api.title} v${table.api.version}`);
  console.log(`spec   ${table.cli.specSource}`);
  console.log(
    `url    ${settings.baseUrl}${settings.baseUrlConfigured
      ? ''
      : dim('  (not configured — set with `dockhand config set base-url <url>`)', settings.color)}`,
  );
}

const dim = (text, color) => (color ? `\x1b[2m${text}\x1b[0m` : text);

async function raw({ table, positionals, flags, passthrough, settings }) {
  const [methodArg, pathArg, ...extra] = positionals;
  if (!methodArg || !pathArg) {
    throw new CliError(
      'usage: dockhand raw <METHOD> <path> [--query k=v] [--header k=v] [--data <json>] [--stdin]\n' +
      '  example: dockhand raw GET /api/containers --query env=1',
      { exitCode: EXIT.USAGE },
    );
  }

  const method = methodArg.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
    throw new CliError(`unsupported HTTP method "${methodArg}"`, { exitCode: EXIT.USAGE });
  }
  if (extra.length) {
    throw new CliError(`unexpected extra arguments: ${extra.join(' ')}`, { exitCode: EXIT.USAGE });
  }

  const query = {};
  for (const pair of valuesOf(flags, 'query')) {
    const index = String(pair).indexOf('=');
    const key = index === -1 ? String(pair) : String(pair).slice(0, index);
    const value = index === -1 ? '' : String(pair).slice(index + 1);
    if (query[key] === undefined) query[key] = value;
    else if (Array.isArray(query[key])) query[key].push(value);
    else query[key] = [query[key], value];
  }

  const headers = {};
  for (const pair of valuesOf(flags, 'header')) {
    const index = String(pair).indexOf('=');
    if (index === -1) throw new CliError(`--header expects key=value, got "${pair}"`, { exitCode: EXIT.USAGE });
    headers[String(pair).slice(0, index)] = String(pair).slice(index + 1);
  }

  let body;
  if (flags.has('data')) {
    const text = String(valuesOf(flags, 'data').at(-1));
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new CliError(`--data is not valid JSON: ${error.message}`, { exitCode: EXIT.USAGE });
    }
  } else if (flags.has('data-file')) {
    const source = String(valuesOf(flags, 'data-file').at(-1));
    const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(resolvePath(source), 'utf8');
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new CliError(`--data-file is not valid JSON: ${error.message}`, { exitCode: EXIT.USAGE });
    }
  } else if (flags.has('stdin') || passthrough.length) {
    const text = passthrough.length ? passthrough.join('\n') : readFileSync(0, 'utf8');
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new CliError(`stdin payload is not valid JSON: ${error.message}`, { exitCode: EXIT.USAGE });
    }
  }

  const client = new Client(settings);
  if (settings.dryRun) {
    console.log(`${method} ${client.buildUrl(pathArg.startsWith('/') ? pathArg : `/api/${pathArg}`, query)}`);
    if (body !== undefined) console.log(JSON.stringify(body, null, 2));
    return;
  }

  const result = await client.request({
    method,
    path: pathArg.startsWith('/') ? pathArg : `/api/${pathArg}`,
    query,
    body,
    headers,
  });

  if (result.eventStream) {
    await client.streamSse(result.response);
    return;
  }

  const outFile = valuesOf(flags, 'out-file').at(-1);
  if (outFile) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolvePath(String(outFile)), result.binary ?? Buffer.from(result.text ?? '', 'utf8'));
    return;
  }
  const fieldsFlag = valuesOf(flags, 'fields').at(-1);
  const fields = fieldsFlag ? String(fieldsFlag).split(',').map((f) => f.trim()).filter(Boolean) : undefined;
  let output;
  try {
    output = render(result, settings.output, { color: settings.color, fields });
  } catch (error) {
    throw new CliError(error.message, { exitCode: EXIT.USAGE });
  }
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
}

async function login({ flags, settings }) {
  const username = first(flags, 'username') ?? first(flags, 'user') ?? settings.username;
  const password = first(flags, 'password') ?? settings.password;
  const mfaToken = first(flags, 'mfa-token');
  const provider = first(flags, 'provider');

  if (!username) {
    throw new CliError('missing --username (or set DOCKHAND_USERNAME)', { exitCode: EXIT.USAGE });
  }
  if (!password && !settings.cookie && !settings.token) {
    throw new CliError('missing --password (or set DOCKHAND_PASSWORD)', { exitCode: EXIT.USAGE });
  }

  const client = new Client({ ...settings, token: undefined });
  const body = { username };
  if (password) body.password = password;
  if (mfaToken) body.mfaToken = mfaToken;
  if (provider) body.provider = provider;

  const result = await client.request({ method: 'POST', path: '/api/auth/login', body });

  if (result.data?.requiresMfa && !mfaToken) {
    throw new CliError('this account requires MFA; re-run with --mfa-token <code>', { exitCode: EXIT.AUTH });
  }

  const setCookies = client.setCookieHeader(result.headers ?? new Headers());
  const session = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('dockhand_session='));
  if (!session) {
    throw new CliError('login succeeded but the server did not set a dockhand_session cookie', {
      exitCode: EXIT.AUTH,
    });
  }

  const patch = { cookie: session };
  const saved = writeConfig(patch);

  let tokenSaved = null;
  const tokenName = first(flags, 'save-token');
  if (tokenName) {
    const tokenClient = new Client({ ...settings, cookie: session, token: undefined });
    const tokenResult = await tokenClient.request({
      method: 'POST',
      path: '/api/auth/tokens',
      body: { name: String(tokenName), ...(password ? { password } : {}) },
    });
    const token = tokenResult.data?.token ?? tokenResult.data?.apiToken ?? tokenResult.data?.value;
    if (!token) {
      throw new CliError('token created but the response contained no token field; copy it from the response above', {
        exitCode: EXIT.ERROR,
      });
    }
    writeConfig({ token });
    tokenSaved = { name: tokenName, token };
  }

  const output = {
    success: true,
    user: result.data?.user ?? null,
    configFile: saved.path,
    cookie: maskSecret(session),
    token: tokenSaved ? maskSecret(tokenSaved.token) : '(unchanged)',
  };
  console.log(JSON.stringify(output, null, 2));
  if (!settings.quiet) {
    process.stderr.write(`credentials stored in ${saved.path}\n`);
  }
}

async function logout({ settings }) {
  const client = new Client(settings);
  try {
    await client.request({ method: 'POST', path: '/api/auth/logout' });
  } catch {
    // Logging out locally matters more than the server acknowledging it.
  }
  const { path } = writeConfig({ cookie: null, token: null });
  console.log(JSON.stringify({ success: true, cleared: ['cookie', 'token'], configFile: path }, null, 2));
}

function configShow({ settings }) {
  console.log(JSON.stringify({
    baseUrl: settings.baseUrl,
    output: settings.output,
    timeout: settings.timeout,
    token: settings.token ? maskSecret(settings.token) : null,
    cookie: settings.cookie ? maskSecret(settings.cookie) : null,
    configFile: settings.configPath,
    fileConfig: redact(settings.fileConfig ?? {}),
    environment: {
      DOCKHAND_URL: process.env.DOCKHAND_URL ?? null,
      DOCKHAND_TOKEN: process.env.DOCKHAND_TOKEN ? maskSecret(process.env.DOCKHAND_TOKEN) : null,
      DOCKHAND_CONFIG: process.env.DOCKHAND_CONFIG ?? null,
    },
  }, null, 2));
}

const CONFIG_KEYS = {
  'base-url': 'baseUrl',
  baseurl: 'baseUrl',
  url: 'baseUrl',
  token: 'token',
  cookie: 'cookie',
  output: 'output',
};

function configSet({ positionals }) {
  const [rawKey, ...rest] = positionals;
  const key = CONFIG_KEYS[String(rawKey ?? '').toLowerCase()];
  if (!key) {
    throw new CliError(
      `unknown config key "${rawKey ?? ''}"\n  usage: dockhand config set <base-url|token|cookie|output> <value>`,
      { exitCode: EXIT.USAGE },
    );
  }
  const value = rest.join(' ');
  if (!value) {
    throw new CliError(`missing value for \`dockhand config set ${rawKey}\``, { exitCode: EXIT.USAGE });
  }
  const { path, config } = writeConfig({ [key]: value });
  console.log(`${key} = ${key === 'token' || key === 'cookie' ? maskSecret(value) : value}  (${path})`);
  return config;
}

function configUnset({ positionals }) {
  const key = CONFIG_KEYS[String(positionals[0] ?? '').toLowerCase()];
  if (!key) {
    throw new CliError(
      `unknown config key "${positionals[0] ?? ''}"\n  usage: dockhand config unset <base-url|token|cookie|output>`,
      { exitCode: EXIT.USAGE },
    );
  }
  const { path } = writeConfig({ [key]: null });
  console.log(`removed ${key} (${path})`);
}

function completion({ positionals }) {
  const shell = String(positionals[0] ?? 'bash').toLowerCase();
  if (!['bash', 'zsh', 'fish'].includes(shell)) {
    throw new CliError(`unsupported shell "${shell}" (bash, zsh or fish)`, { exitCode: EXIT.USAGE });
  }
  const table = loadTable();
  process.stdout.write(completionScript(table, shell));
}

function specPath() {
  if (!existsSync(specPath_())) {
    throw new CliError(
      'this installation does not bundle the OpenAPI snapshot (it is kept in the repository, not in the npm package)\n'
      + `  fetch it from your instance instead:\n    dockhand generate --fetch ${'https://<your-dockhand>/openapi.json'}`,
      { exitCode: EXIT.USAGE },
    );
  }
  console.log(specPath_());
}

const specPath_ = () => resolvePath(fileURLToPath(new URL('../api/openapi.json', import.meta.url)));

function specCommands({ table }) {
  console.log(JSON.stringify(table, null, 2));
}

/**
 * Print (or locate) the packaged agent skill so it can be dropped into a
 * skills directory: `dockhand skill > ~/.claude/skills/dockhand/SKILL.md`.
 */
function skill({ positionals, flags }) {
  const mode = String(positionals[0] ?? (flags.has('path') ? '--path' : ''));
  if (mode === '--path' || mode === 'path') {
    console.log(SKILL_PATH);
    return;
  }
  console.log(readFileSync(SKILL_PATH, 'utf8').trimEnd());
}

/**
 * Regenerate the command table from an instance: `dockhand generate --fetch`.
 * The generator is shipped with the package so a published install can track
 * a server upgrade without cloning this repo.
 */
async function generate({ flags, settings }) {
  const generator = resolvePath(fileURLToPath(new URL('../scripts/generate.mjs', import.meta.url)));
  if (!existsSync(generator)) {
    throw new CliError('scripts/generate.mjs is not part of this installation', { exitCode: EXIT.USAGE });
  }
  const spec = resolvePath(fileURLToPath(new URL('../api/openapi.json', import.meta.url)));
  if (!existsSync(spec)) {
    throw new CliError(
      'this installation does not bundle the OpenAPI snapshot, so the command table can only be '
      + 'regenerated from a live instance:\n'
      + '    dockhand generate --fetch https://<your-dockhand>/openapi.json',
      { exitCode: EXIT.USAGE },
    );
  }
  const args = [];
  const fetchUrl = first(flags, 'fetch');
  if (fetchUrl) {
    args.push('--fetch', String(fetchUrl));
  } else if (settings.baseUrlConfigured) {
    args.push('--fetch', `${settings.baseUrl}/openapi.json`);
  } else {
    throw new CliError(
      'specify the instance to generate from:\n'
      + '  dockhand generate --fetch https://dockhand.example.com/openapi.json\n'
      + '  (or configure `dockhand config set base-url <url>` first)',
      { exitCode: EXIT.USAGE },
    );
  }
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [generator, ...args], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? EXIT.ERROR);
}

// ---------------------------------------------------------------------------

function valuesOf(flags, name) {
  return (flags.get(name) ?? []).map(String);
}

function first(flags, name) {
  const values = flags.get(name);
  return values ? values[values.length - 1] : undefined;
}

export { readConfig };
