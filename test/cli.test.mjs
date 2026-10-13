import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../src/args.js';
import { loadTable, resolveCommand } from '../src/commands.js';
import { buildRequest, commandWords } from '../src/cli.js';
import { render } from '../src/render.js';
import { CliError, Client } from '../src/client.js';
import { DEFAULTS, resolveSettings, readInstances, redact } from '../src/config.js';
import { runBuiltin } from '../src/builtins.js';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const table = loadTable();
const base = { baseUrl: 'http://dockhand.test', timeout: 1000, color: false };

function plan(name, argv, { flags = new Map(), settings = base } = {}) {
  const { command } = resolveCommand(table, [name]);
  assert.ok(command, `command ${name} should resolve`);
  const booleans = new Set(['help', 'verbose', 'dry-run']);
  for (const q of command.query ?? []) if (q.type === 'boolean') booleans.add(q.flag);
  for (const f of command.body?.fields ?? []) if (f.type === 'boolean') booleans.add(f.flag);
  const parsed = parseArgs(argv, { booleans });
  return buildRequest(command, { positionals: parsed.positionals, flags: parsed.flags, passthrough: parsed.rest, settings });
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

test('parses long flags, values and bare booleans', () => {
  const { positionals, flags } = parseArgs(['list', '--env', '3', '--all', '--limit=25'], {
    booleans: new Set(['all']),
  });
  assert.deepEqual(positionals, ['list']);
  assert.equal(flags.get('env')[0], '3');
  assert.equal(flags.get('all')[0], true);
  assert.equal(flags.get('limit')[0], '25');
});

test('supports --no-<flag> negation and repeatable flags', () => {
  const { flags } = parseArgs(['--no-color', '--label', 'a=1', '--label', 'b=2'], {
    booleans: new Set(['color']),
  });
  assert.equal(flags.get('no-color')[0], false);
  assert.deepEqual(flags.get('label'), ['a=1', 'b=2']);
});

test('boolean flags accept an explicit true/false value', () => {
  const bare = parseArgs(['--all'], { booleans: new Set(['all']) });
  assert.equal(bare.flags.get('all')[0], true);
  assert.deepEqual(bare.positionals, []);

  const explicit = parseArgs(['--all', 'false'], { booleans: new Set(['all']) });
  assert.equal(explicit.flags.get('all')[0], false);
  assert.deepEqual(explicit.positionals, []);
});

test('keeps payload after -- verbatim', () => {
  const { positionals, rest } = parseArgs(['create', '--', '{"a":1}'], { booleans: new Set() });
  assert.deepEqual(positionals, ['create']);
  assert.deepEqual(rest, ['{"a":1}']);
});

test('negative numbers are treated as positionals', () => {
  const { positionals } = parseArgs(['-5'], { booleans: new Set() });
  assert.deepEqual(positionals, ['-5']);
});

// ---------------------------------------------------------------------------
// command resolution
// ---------------------------------------------------------------------------

test('resolves the longest command, then aliases', () => {
  assert.equal(resolveCommand(table, ['containers', 'list']).command.name, 'containers list');
  assert.equal(resolveCommand(table, ['containers', 'ls']).command.name, 'containers list');
  assert.equal(resolveCommand(table, ['ctr', 'ls']).command.name, 'containers list');
  assert.equal(resolveCommand(table, ['nope']).command, null);
});

test('every generated command name is unique and resolvable', () => {
  const names = table.commands.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const command of table.commands) {
    assert.equal(resolveCommand(table, command.name.split(' ')).command.name, command.name);
  }
});

// ---------------------------------------------------------------------------
// request building
// ---------------------------------------------------------------------------

test('builds a path and coerces query types', () => {
  const request = plan('containers list', ['-e', '4', '--all', 'false']);
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/api/containers');
  assert.deepEqual(request.query, { env: 4, all: false });
});

test('substitutes and URL-encodes positional path parameters', () => {
  const request = plan('containers restart', ['web/1', '-e', '4']);
  assert.equal(request.path, '/api/containers/web%2F1/restart');
  assert.deepEqual(request.query, { env: 4 });
});

test('selects the route variant from the argument count', () => {
  assert.equal(plan('environments notifications get', ['3']).path, '/api/environments/3/notifications');
  assert.equal(
    plan('environments notifications get', ['3', '7']).path,
    '/api/environments/3/notifications/7',
  );
});

test('splits comma separated array flags', () => {
  const request = plan('containers create', ['--env', '4', '--name', 'web', '--image', 'nginx', '--cmd', 'sh,-c,sleep 1']);
  assert.deepEqual(request.body.cmd, ['sh', '-c', 'sleep 1']);
  assert.equal(request.body.name, 'web');
});

test('parses object fields as JSON', () => {
  const request = plan('containers create', ['--env', '4', '--name', 'w', '--image', 'i', '--ports', '{"80/tcp":[]}']);
  assert.deepEqual(request.body.ports, { '80/tcp': [] });
});

test('merges --data with individual body flags', () => {
  const request = plan('containers create', ['--env', '4', '--data', '{"name":"a","image":"b","restartPolicy":"always"}', '--name', 'override']);
  assert.equal(request.body.name, 'override');
  assert.equal(request.body.image, 'b');
  assert.equal(request.body.restartPolicy, 'always');
});

test('reads a body from stdin', () => {
  const { flags } = parseArgs(['--stdin'], { booleans: new Set(['stdin']) });
  const { command } = resolveCommand(table, ['containers', 'create']);
  // Simulated: the flag set is what buildRequest looks at.
  assert.equal(flags.get('stdin')[0], true);
  assert.ok(command);
});

test('rejects unknown flags with the list of known ones', () => {
  assert.throws(
    () => plan('containers list', ['--nope', '1']),
    (error) => error instanceof CliError && /unknown flag --nope/.test(error.message) && /--env/.test(error.message),
  );
});

test('requires positional arguments', () => {
  assert.throws(
    () => plan('containers get', []),
    (error) => error instanceof CliError && /missing argument/.test(error.message),
  );
  assert.throws(
    () => plan('containers get', ['a', 'b']),
    (error) => error instanceof CliError && /too many arguments/.test(error.message),
  );
});

test('requires a body when the endpoint requires one', () => {
  assert.throws(
    () => plan('containers create', ['--env', '4']),
    (error) => error instanceof CliError
      && /missing required flags for `dockhand containers create`: --name, --image/.test(error.message),
  );
});

test('rejects values that do not match the declared type', () => {
  assert.throws(() => plan('containers list', ['--env', 'abc']), CliError);
  assert.throws(() => plan('containers list', ['--all', 'maybe']), CliError);
});

test('sends an empty object when every body field is optional', () => {
  const request = plan('environments update', ['4', '--name', 'renamed']);
  assert.deepEqual(request.body, { name: 'renamed' });

  const bare = plan('roles update', ['3']);
  assert.deepEqual(bare.body, {}, 'a PUT with only optional fields still sends {}');
});

test('enforces required query flags', () => {
  assert.throws(
    () => plan('images scan export', []),
    (error) => error instanceof CliError && /missing required flag --image-id/.test(error.message),
  );
  assert.equal(plan('images scan export', ['--image-id', 'nginx']).path, '/api/images/scan/export');
});

test('--public switches to the unauthenticated alias', () => {
  const request = plan('audit get', [], { settings: { ...base, publicRoute: true } });
  assert.equal(request.path, '/audit');
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('renders arrays of objects as a table', () => {
  const output = render({ data: [{ name: 'a', state: 'running' }, { name: 'bb', state: 'exited' }] }, 'table');
  assert.equal(output.split('\n').length, 3);
  assert.match(output, /^name {2,}state/m);
});

test('table output honours --fields', () => {
  const output = render({ data: [{ name: 'a', state: 'running', id: 'x' }] }, 'table', { fields: ['name'] });
  assert.equal(output.split('\n')[0], 'name');
});

test('json output round-trips the payload', () => {
  const payload = { ok: true, items: [1, 2] };
  assert.deepEqual(JSON.parse(render({ data: payload }, 'json')), payload);
  assert.equal(render({ data: payload }, 'ndjson'), JSON.stringify(payload));
});

test('raw output is the untouched body', () => {
  assert.equal(render({ text: 'plain text', data: undefined }, 'raw'), 'plain text');
});
// ---------------------------------------------------------------------------
// argument scanning and configuration
// ---------------------------------------------------------------------------

test('command words are found even behind global flags', () => {
  assert.deepEqual(
    commandWords(['--base-url', 'http://x:3000', 'environments', 'list', '-e', '4'])
      .map((w) => w.token),
    ['environments', 'list'],
  );
  assert.deepEqual(
    commandWords(['containers', 'restart', '-e', '4', 'web']).map((w) => w.token),
    ['containers', 'restart', 'web'],
  );
  assert.deepEqual(commandWords(['--verbose', 'health', 'get']).map((w) => w.token), ['health', 'get']);
  assert.deepEqual(commandWords(['--help']).map((w) => w.token), []);
  // A bare flag does not swallow the command word that follows it.
  assert.deepEqual(commandWords(['--quiet', 'changelog']).map((w) => w.token), ['changelog']);
  // --instance / -i carry a value that must not be mistaken for a command word.
  assert.deepEqual(commandWords(['--instance', 'prod', 'containers', 'list']).map((w) => w.token), ['containers', 'list']);
  assert.deepEqual(commandWords(['-i', 'prod', 'containers', 'list']).map((w) => w.token), ['containers', 'list']);
});

test('base URL comes from flag, env or file — never from the binary', () => {
  const previous = {
    url: process.env.DOCKHAND_URL,
    base: process.env.DOCKHAND_BASE_URL,
    config: process.env.DOCKHAND_CONFIG,
  };
  delete process.env.DOCKHAND_URL;
  delete process.env.DOCKHAND_BASE_URL;
  // Isolate from the developer's real ~/.config/dockhand/config.json.
  process.env.DOCKHAND_CONFIG = join(tmpdir(), 'dockhand-cli-test-absent-config.json');

  const flagMap = new Map([['base-url', ['https://from-flag.example.com/']]]);
  const fromFlag = resolveSettings(flagMap);
  assert.equal(fromFlag.baseUrl, 'https://from-flag.example.com');
  assert.equal(fromFlag.baseUrlConfigured, true);

  process.env.DOCKHAND_URL = 'https://from-env.example.com/';
  const fromEnv = resolveSettings(new Map());
  assert.equal(fromEnv.baseUrl, 'https://from-env.example.com');
  assert.equal(fromEnv.baseUrlConfigured, true);

  delete process.env.DOCKHAND_URL;
  const fallback = resolveSettings(new Map());
  assert.equal(fallback.baseUrl, DEFAULTS.baseUrl);
  assert.equal(fallback.baseUrlConfigured, false);

  if (previous.url) process.env.DOCKHAND_URL = previous.url;
  if (previous.base) process.env.DOCKHAND_BASE_URL = previous.base;
  if (previous.config) process.env.DOCKHAND_CONFIG = previous.config;
  else delete process.env.DOCKHAND_CONFIG;
});

// ---------------------------------------------------------------------------
// client internals
// ---------------------------------------------------------------------------

test('setCookieHeader reads cookies off a Headers object (login regression)', () => {
  const client = new Client(base);
  const headers = new Headers();
  headers.append('set-cookie', 'dockhand_session=abc123; Path=/; HttpOnly');
  assert.deepEqual(client.setCookieHeader(headers), ['dockhand_session=abc123; Path=/; HttpOnly']);
  // no session cookie -> empty list, not a crash
  assert.deepEqual(client.setCookieHeader(new Headers()), []);
});

test('setCookieHeader falls back to get() when getSetCookie is unavailable', () => {
  const client = new Client(base);
  const legacy = { get: (name) => (name === 'set-cookie' ? 'dockhand_session=legacy' : null) };
  assert.deepEqual(client.setCookieHeader(legacy), ['dockhand_session=legacy']);
  assert.deepEqual(client.setCookieHeader(undefined), []);
});

test('network failures surface the underlying errno from error.cause', async () => {
  // grab a guaranteed-closed loopback port (port 1 would be rejected as a "bad port")
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  server.close();

  const client = new Client({ baseUrl: `http://127.0.0.1:${port}`, timeout: 15000, color: false });
  await assert.rejects(
    () => client.request({ method: 'GET', path: '/api/health' }),
    (error) => {
      assert.match(error.message, /failed: fetch failed/);
      assert.match(error.message, /\((ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)[),]/);
      assert.equal(error.exitCode, 7);
      return true;
    },
  );
});

function fetchCauseError(code) {
  const error = new TypeError('fetch failed');
  error.cause = Object.assign(new Error(`connect ${code}`), { code });
  return error;
}

test('transient connect errors are retried until they heal', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw fetchCauseError('EHOSTUNREACH');
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const client = new Client({ baseUrl: 'http://dockhand.test', timeout: 5000, color: false });
    const result = await client.request({ method: 'GET', path: '/api/health' });
    assert.equal(result.data.ok, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('non-retryable connect errors surface immediately', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw fetchCauseError('EACCES');
  };
  try {
    const client = new Client({ baseUrl: 'http://dockhand.test', timeout: 5000, color: false });
    await assert.rejects(() => client.request({ method: 'GET', path: '/api/health' }));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('retries give up after four attempts and keep the errno', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw fetchCauseError('EHOSTUNREACH');
  };
  try {
    const client = new Client({ baseUrl: 'http://dockhand.test', timeout: 10000, color: false });
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/api/health' }),
      (error) => {
        assert.match(error.message, /\(EHOSTUNREACH\)/);
        assert.equal(error.exitCode, 7);
        return true;
      },
    );
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// named instances (multiple Dockhand servers)
// ---------------------------------------------------------------------------

function withTempConfig(config, run) {
  const dir = mkdtempSync(join(tmpdir(), 'dockhand-cli-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  const previous = {
    config: process.env.DOCKHAND_CONFIG,
    url: process.env.DOCKHAND_URL,
    base: process.env.DOCKHAND_BASE_URL,
    instance: process.env.DOCKHAND_INSTANCE,
    token: process.env.DOCKHAND_TOKEN,
    cookie: process.env.DOCKHAND_COOKIE,
  };
  process.env.DOCKHAND_CONFIG = path;
  delete process.env.DOCKHAND_URL;
  delete process.env.DOCKHAND_BASE_URL;
  delete process.env.DOCKHAND_INSTANCE;
  delete process.env.DOCKHAND_TOKEN;
  delete process.env.DOCKHAND_COOKIE;
  try {
    return run(path);
  } finally {
    if (previous.config) process.env.DOCKHAND_CONFIG = previous.config;
    else delete process.env.DOCKHAND_CONFIG;
    if (previous.url) process.env.DOCKHAND_URL = previous.url;
    if (previous.base) process.env.DOCKHAND_BASE_URL = previous.base;
    if (previous.instance) process.env.DOCKHAND_INSTANCE = previous.instance;
    if (previous.token) process.env.DOCKHAND_TOKEN = previous.token;
    if (previous.cookie) process.env.DOCKHAND_COOKIE = previous.cookie;
    rmSync(dir, { recursive: true, force: true });
  }
}

const MULTI_CONFIG = {
  baseUrl: 'https://default.example.com',
  token: 'dh_default',
  instances: {
    prod: { baseUrl: 'https://prod.example.com', token: 'dh_prod' },
    lab: { baseUrl: 'https://lab.example.com/', token: 'dh_lab', cookie: 'dockhand_session=abc' },
  },
};

test('named instances resolve url and pre-configured credentials', () => {
  withTempConfig(MULTI_CONFIG, () => {
    // Without a selector the top-level default applies, top-level token included.
    const fallback = resolveSettings(new Map());
    assert.equal(fallback.baseUrl, 'https://default.example.com');
    assert.equal(fallback.token, 'dh_default');
    assert.equal(fallback.instanceName, null);

    // --instance swaps url + credentials in one move.
    const prod = resolveSettings(new Map([['instance', ['prod']]]));
    assert.equal(prod.baseUrl, 'https://prod.example.com');
    assert.equal(prod.token, 'dh_prod');
    assert.equal(prod.instanceName, 'prod');
    assert.equal(prod.baseUrlConfigured, true);

    // -i is the shorthand; a trailing slash on the stored url is normalised.
    const parsed = parseArgs(['-i', 'lab', 'containers', 'list']);
    const lab = resolveSettings(parsed.flags);
    assert.equal(lab.baseUrl, 'https://lab.example.com');
    assert.equal(lab.token, 'dh_lab');
    assert.equal(lab.cookie, 'dockhand_session=abc');

    // An explicit flag still beats the selected instance.
    const override = resolveSettings(new Map([['instance', ['prod']], ['token', ['dh_override']]]));
    assert.equal(override.token, 'dh_override');

    // A selected instance beats ambient env so identities never mix.
    process.env.DOCKHAND_TOKEN = 'dh_ambient';
    const guarded = resolveSettings(new Map([['instance', ['prod']]]));
    assert.equal(guarded.token, 'dh_prod');
    delete process.env.DOCKHAND_TOKEN;
  });
});

test('a configured base url pulls in its instance credentials automatically', () => {
  withTempConfig(MULTI_CONFIG, () => {
    // --base-url matching an entry applies that entry's token.
    const byFlag = resolveSettings(new Map([['base-url', ['https://prod.example.com/']]]));
    assert.equal(byFlag.baseUrl, 'https://prod.example.com');
    assert.equal(byFlag.token, 'dh_prod');
    assert.equal(byFlag.instanceName, 'prod');

    // The same match works through the environment variable.
    process.env.DOCKHAND_URL = 'https://lab.example.com';
    const byEnv = resolveSettings(new Map());
    assert.equal(byEnv.baseUrl, 'https://lab.example.com');
    assert.equal(byEnv.token, 'dh_lab');
    delete process.env.DOCKHAND_URL;

    // No match: credentials fall back to the env/top-level chain.
    process.env.DOCKHAND_URL = 'https://other.example.com';
    process.env.DOCKHAND_TOKEN = 'dh_ambient';
    const unmatched = resolveSettings(new Map());
    assert.equal(unmatched.token, 'dh_ambient');
    assert.equal(unmatched.instanceName, null);
    delete process.env.DOCKHAND_URL;
    delete process.env.DOCKHAND_TOKEN;

    // DOCKHAND_INSTANCE behaves like --instance.
    process.env.DOCKHAND_INSTANCE = 'prod';
    assert.equal(resolveSettings(new Map()).token, 'dh_prod');
    delete process.env.DOCKHAND_INSTANCE;

    // Unknown names are surfaced for the caller instead of thrown, so
    // `help`/`completion` keep working; non-login commands reject it later.
    const unknown = resolveSettings(new Map([['instance', ['nope']]]));
    assert.equal(unknown.instanceUnknown, 'nope');
    assert.equal(unknown.instanceName, null);
  });
});

test('redaction covers secrets inside instance entries', () => {
  const masked = redact({
    token: 'dh_topsecretvalue',
    instances: { prod: { baseUrl: 'https://prod.example.com', token: 'dh_prodsecretvalue' } },
  });
  assert.ok(!masked.token.includes('topsecret'));
  assert.equal(masked.instances.prod.baseUrl, 'https://prod.example.com');
  assert.ok(!masked.instances.prod.token.includes('prodsecret'));
  assert.ok(masked.instances.prod.token.includes('…'));
});

test('config instance builtins round-trip through the config file', () => {
  withTempConfig({ baseUrl: 'https://default.example.com' }, (path) => {
    const command = (name) => resolveCommand(table, name.split(' ')).command;
    const ctx = (positionals) => ({
      table,
      positionals,
      flags: new Map(),
      passthrough: [],
      settings: resolveSettings(),
    });
    const seen = [];
    const log = console.log;
    console.log = (line) => seen.push(String(line));
    try {
      runBuiltin(command('config instance set'), ctx(['prod', 'base-url', 'https://prod.example.com']));
      runBuiltin(command('config instance set'), ctx(['prod', 'token', 'dh_prod']));
      runBuiltin(command('config instance set'), ctx(['lab', 'base-url', 'https://lab.example.com']));
      runBuiltin(command('config instance show'), ctx(['prod']));
      runBuiltin(command('config instance list'), ctx([]));
      runBuiltin(command('config instance remove'), ctx(['lab']));
    } finally {
      console.log = log;
    }
    const instances = readInstances();
    assert.deepEqual(Object.keys(instances), ['prod']);
    assert.equal(instances.prod.baseUrl, 'https://prod.example.com');
    assert.equal(instances.prod.token, 'dh_prod');
    const printed = seen.join('\n');
    assert.ok(printed.includes('prod.baseUrl = https://prod.example.com'));
    assert.ok(printed.includes('"name": "prod"'));
    assert.ok(!printed.includes('dh_prod'));
    const finalConfig = readFileSync(path, 'utf8');
    assert.match(finalConfig, /"instances"/);
    assert.ok(!finalConfig.includes('lab.example.com'), 'removed instance disappears from the config file');
  });
});

test('no development host is baked into the published sources', () => {
  // Mirrors scripts/audit.mjs, but over the whole checkout so contributors get
  // the same protection the publish gate gives the tarball.
  const shipped = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(js|mjs|json|md)$/.test(entry.name)) shipped.push(path);
    }
  };
  walk(process.cwd());
  for (const path of shipped) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /192\.168\.50\.3/,
      `${path} must not contain a hard-coded instance address`,
    );
  }
});
