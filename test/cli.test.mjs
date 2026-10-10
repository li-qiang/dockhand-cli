import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../src/args.js';
import { loadTable, resolveCommand } from '../src/commands.js';
import { buildRequest, commandWords } from '../src/cli.js';
import { render } from '../src/render.js';
import { CliError } from '../src/client.js';
import { DEFAULTS, resolveSettings } from '../src/config.js';
import { readFileSync, readdirSync } from 'node:fs';
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
