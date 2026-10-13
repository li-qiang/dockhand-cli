/**
 * Entry point: resolve argv against the generated command table, build the
 * request, run it, render the result. See AGENTS.md for the conventions.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { parseArgs, BOOLEAN_GLOBAL_FLAGS, SHORT_FLAGS } from './args.js';
import { cliVersion, loadTable, resolveCommand } from './commands.js';
import { CliError, Client, EXIT } from './client.js';
import { resolveSettings, readInstances } from './config.js';
import { commandHelp, groupHelp, rootHelp, setColor, unknownCommandHelp, usageFor } from './help.js';
import { render } from './render.js';
import { runBuiltin } from './builtins.js';

/** Flags consumed by the CLI itself; everything else belongs to the endpoint. */
const RESERVED_FLAGS = new Set([
  'base-url', 'url', 'token', 'cookie', 'instance', 'output', 'verbose', 'quiet', 'timeout',
  'no-color', 'pretty', 'help', 'version', 'dry-run', 'public', 'stdin',
  'confirm', 'out-file', 'accept', 'fields',
]);

/** Flags that carry a payload rather than an endpoint field. */
const PAYLOAD_FLAGS = new Set(['data', 'data-file', 'form', 'file']);

export async function main(argv) {
  try {
    await run(argv);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      if (process.env.DOCKHAND_DEBUG === '1' && error.details !== undefined) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = EXIT.ERROR;
  }
}

async function run(argv) {
  const table = loadTable();
  const settings0 = resolveSettings();
  setColor(settings0.color);

  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const wantsVersion = argv.includes('--version') || argv.includes('-v');

  // Command words may be preceded by global flags (`dockhand --base-url URL
  // containers list`), so scan past flags — and their values — first.
  const words = commandWords(argv);

  if (argv.length === 0 || words.length === 0) {
    if (wantsVersion && !wantsHelp) {
      console.log(`${table.cli.name} ${cliVersion()} (${table.api.title} v${table.api.version})`);
      return;
    }
    console.log(rootHelp(table));
    return;
  }

  const { command, matched } = resolveCommand(table, words.map((w) => w.token));
  // Everything except the command words themselves stays in argv order, so a
  // global flag written before the command is still seen.
  const consumed = new Set(words.slice(0, matched).map((w) => w.index));
  const rest = argv.filter((_, index) => !consumed.has(index));
  if (!command) {
    if (wantsHelp) {
      console.log(rootHelp(table));
      return;
    }
    // A bare group name (and nothing else) asks for that group's command list.
    const first = words[0].token;
    if (words.length === 1 && table.groups.includes(first)) {
      console.log(groupHelp(table, first));
      return;
    }
    // A group name with an action that does not exist: show what does.
    if (table.groups.includes(first)) {
      process.stderr.write(`dockhand: unknown action "${words[1]?.token ?? first}" for \`dockhand ${first}\`\n\n`);
      console.error(groupHelp(table, first));
      process.exit(EXIT.USAGE);
    }
    process.stderr.write(`${unknownCommandHelp(table, first)}\n`);
    process.exit(EXIT.USAGE);
  }

  const booleans = new Set(BOOLEAN_GLOBAL_FLAGS);
  for (const q of command.query ?? []) if (q.type === 'boolean') booleans.add(q.flag);
  for (const f of command.body?.fields ?? []) if (f.type === 'boolean') booleans.add(f.flag);

  const { positionals, flags, rest: passthrough } = parseArgs(rest, { booleans });

  if (lastFlag(flags, 'version') === true && !command.builtin) {
    console.log(`${table.cli.name} ${cliVersion()} (${table.api.title} v${table.api.version})`);
    return;
  }

  const settings = resolveSettings(flags);
  setColor(settings.color);

  if (lastFlag(flags, 'help') === true) {
    console.log(commandHelp(table, command));
    return;
  }

  // `login` is allowed to name an instance that does not exist yet (it creates
  // the entry); everything else fails fast instead of hitting the wrong server.
  if (settings.instanceUnknown && command.builtin !== 'login') {
    const known = Object.keys(readInstances());
    throw new CliError(
      `unknown instance "${settings.instanceUnknown}"`
        + (known.length
          ? `\n  configured instances: ${known.join(', ')}`
          : '\n  no instances configured yet — see `dockhand config instance set <name> base-url <url>`'),
      { exitCode: EXIT.USAGE },
    );
  }

  if (command.builtin) {
    await runBuiltin(command, { table, positionals, flags, passthrough, settings });
    return;
  }

  const plan = buildRequest(command, { positionals, flags, passthrough, settings });
  const client = new Client(settings);

  if (settings.dryRun) {
    printDryRun(plan, settings);
    return;
  }

  const result = await client.request(plan);

  if (result.eventStream) {
    await client.streamSse(result.response);
    return;
  }

  emit(result, plan, settings);
}

// ---------------------------------------------------------------------------
// request construction
// ---------------------------------------------------------------------------

export function buildRequest(command, { positionals, flags, passthrough, settings }) {
  const variant = selectVariant(command, positionals);

  const fill = (template) => {
    let path = template;
    variant.args.forEach((arg, index) => {
      path = path.replace(`{${arg.name}}`, encodeURIComponent(String(positionals[index] ?? '')));
    });
    return path;
  };

  let path = fill(variant.path);
  if (settings.publicRoute) {
    const publicTransport = variant.paths?.find((p) => p.public);
    if (publicTransport) path = fill(publicTransport.path);
  }

  const query = buildQuery(command, variant, flags);
  const payload = buildBody(command, variant, flags, passthrough);

  return { method: command.method, path, query, flags, ...payload, variant, command };
}

/**
 * Leading non-flag tokens, with their argv index, skipping global flags and
 * the values they consume. Command-specific flags always come after the
 * command words, so this never has to know the endpoint's own flags.
 */
export function commandWords(argv) {
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (!token.startsWith('-') || token === '-') {
      words.push({ token, index: i });
      continue;
    }
    const long = token.replace(/^--?/, '');
    const name = SHORT_FLAGS[long] ?? long;
    const isBoolean = BOOLEAN_GLOBAL_FLAGS.has(long) || BOOLEAN_GLOBAL_FLAGS.has(name);
    const hasInlineValue = token.includes('=');
    if (!isBoolean && !hasInlineValue) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) i++;
    }
  }
  return words;
}

function selectVariant(command, positionals) {
  const required = (command.args ?? []).filter((a) => a.required).length;
  const variants = command.variants ?? [];
  const maxArity = Math.max(0, ...variants.map((v) => v.args.length));
  const arities = [...new Set(variants.map((v) => v.args.length))].sort((a, b) => a - b);
  const arityList = arities.map((n) => (n === 0 ? 'none' : `${n}`)).join(' or ');

  if (positionals.length > maxArity) {
    throw new CliError(
      `too many arguments for \`dockhand ${command.name}\`: expected ${arityList}, got ${positionals.length}\n  usage: ${usageFor(command)}`,
      { exitCode: EXIT.USAGE },
    );
  }
  if (positionals.length < required) {
    throw new CliError(
      `missing argument${required - positionals.length > 1 ? 's' : ''} for \`dockhand ${command.name}\`\n  usage: ${usageFor(command)}`,
      { exitCode: EXIT.USAGE },
    );
  }

  const match = variants.find((v) => v.args.length === positionals.length) ?? variants[0];
  if (!match) {
    throw new CliError(`no route matches ${positionals.length} argument(s) for \`dockhand ${command.name}\``, {
      exitCode: EXIT.USAGE,
    });
  }
  return match;
}

function buildQuery(command, variant, flags) {
  const query = {};
  const known = new Map((command.query ?? []).map((q) => [q.flag, q]));

  const bodyFields = new Set((command.body?.fields ?? []).map((f) => f.flag));

  for (const [name, values] of flags) {
    if (RESERVED_FLAGS.has(name) || PAYLOAD_FLAGS.has(name) || name === 'env') continue;
    const spec = known.get(name);
    // Body flags are consumed by buildBody(); they are not query parameters.
    if (!spec && bodyFields.has(name)) continue;
    if (!spec) {
      const available = [...known.keys(), ...bodyFields].map((f) => `--${f}`);
      throw new CliError(
        `unknown flag --${name} for \`dockhand ${command.name}\`\n` +
        `  known flags: ${available.length ? available.join(' ') : '(none — use --data)'}\n` +
        '  use --data to send a body field that is not in the spec',
        { exitCode: EXIT.USAGE },
      );
    }
    query[spec.name] = coerce(spec.type, values);
  }

  const envFlag = flags.get('env');
  if (envFlag && known.has('env')) {
    query.env = coerceScalar(known.get('env').type, envFlag[envFlag.length - 1]);
  }

  for (const flagName of variant.requiredQuery ?? []) {
    const spec = known.get(flagName);
    const name = spec?.name ?? flagName;
    if (query[name] === undefined) {
      throw new CliError(`missing required flag --${flagName} for \`dockhand ${command.name}\``, {
        exitCode: EXIT.USAGE,
      });
    }
  }

  return query;
}

function coerce(type, values) {
  const cleaned = values.filter((v) => v !== '');
  if (type === 'array') {
    return cleaned
      .flatMap((value) => (typeof value === 'string' ? value.split(',') : [value]))
      .map((value) => (typeof value === 'boolean' ? value : String(value)));
  }
  if (cleaned.length > 1) return cleaned.map((value) => coerceScalar(type, value));
  return coerceScalar(type, cleaned[0]);
}

function coerceScalar(type, value) {
  if (value === undefined) return undefined;
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const text = String(value).toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
    throw new CliError(`expected a boolean, got "${value}"`, { exitCode: EXIT.USAGE });
  }
  if (type === 'integer' || type === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new CliError(`expected a ${type}, got "${value}"`, { exitCode: EXIT.USAGE });
    return num;
  }
  if (type === 'object') {
    try {
      return JSON.parse(String(value));
    } catch (error) {
      throw new CliError(`expected JSON for an object field: ${error.message}`, { exitCode: EXIT.USAGE });
    }
  }
  return value;
}

function buildBody(command, variant, flags, passthrough) {
  const contentType = variant.contentType ?? command.body?.contentType;

  if (contentType && contentType !== 'application/json') return buildUpload(command, variant, flags, contentType);

  if (!command.body && !hasPayload(flags) && !passthrough.length) return {};

  let body;
  const inline = flags.get('data');
  if (inline?.length) body = parseJson(String(inline[inline.length - 1]), '--data');

  const dataFile = flags.get('data-file');
  if (dataFile?.length) {
    const source = String(dataFile[dataFile.length - 1]);
    body = parseJson(source === '-' ? readStdin() : readFileSync(resolvePath(source), 'utf8'), '--data-file');
  }

  if (flags.get('stdin')?.length) {
    if (passthrough.length) {
      throw new CliError('--stdin cannot be combined with arguments after `--`', { exitCode: EXIT.USAGE });
    }
    body = parseJson(readStdin(), '--stdin');
  }

  if (passthrough.length) body = parseJson(passthrough.join('\n'), 'the payload after `--`');

  body ??= {};

  const fields = new Map((command.body?.fields ?? []).map((f) => [f.flag, f]));
  for (const [name, values] of flags) {
    if (RESERVED_FLAGS.has(name) || PAYLOAD_FLAGS.has(name) || name === 'env') continue;
    const spec = fields.get(name);
    if (!spec) continue;
    body[spec.name] = coerce(spec.type, values);
  }

  const missing = (variant.requiredFields ?? [])
    .map((flagName) => fields.get(flagName))
    .filter((spec) => spec && body[spec.name] === undefined);
  if (missing.length) {
    throw new CliError(
      `missing required flag${missing.length > 1 ? 's' : ''} for \`dockhand ${command.name}\`: ` +
      missing.map((spec) => `--${spec.flag}`).join(', ') +
      '\n  or pass the whole payload with --data <json>, --data-file <path>, --stdin, or `--` followed by JSON',
      { exitCode: EXIT.USAGE },
    );
  }

  if (!Object.keys(body).length) {
    // Every field is optional: send an empty object rather than nothing, since
    // the endpoint declares the body itself as required.
    return command.body?.required ? { body: {}, contentType: 'application/json' } : {};
  }

  return { body, contentType: 'application/json' };
}

function buildUpload(command, variant, flags, contentType) {
  const fileValues = (flags.get('file') ?? []).map(String);
  const formValues = (flags.get('form') ?? []).map(String);

  if (contentType === 'multipart/form-data') {
    const form = new FormData();
    for (const item of fileValues) {
      const split = item.match(/^([^=]+)=(.*)$/);
      const name = split && !existsSafe(split[1]) ? split[1] : 'files';
      const path = split && !existsSafe(split[1]) ? split[2] : item;
      form.append(name, new Blob([readFileSync(resolvePath(path))]), path.split('/').pop());
    }
    for (const pair of formValues) {
      const index = pair.indexOf('=');
      const key = index === -1 ? pair : pair.slice(0, index);
      const value = index === -1 ? '' : pair.slice(index + 1);
      form.append(key, value);
    }
    if (!formValues.length && !fileValues.length) {
      throw new CliError(`\`dockhand ${command.name}\` uploads files: pass --file <path> (repeatable) and/or --form k=v`, {
        exitCode: EXIT.USAGE,
      });
    }
    const provided = new Set([
      ...formValues.map((pair) => String(pair).split('=')[0]),
      ...fileValues.map((item) => (item.includes('=') && !existsSafe(item.split('=')[0]) ? item.split('=')[0] : 'files')),
    ]);
    for (const fieldName of variant.requiredFields ?? []) {
      if (!provided.has(fieldName)) {
        throw new CliError(`missing required upload field "${fieldName}" — pass --form ${fieldName}=<value> or --file ${fieldName}=<path>`, {
          exitCode: EXIT.USAGE,
        });
      }
    }
    return { rawBody: form };
  }

  if (!fileValues.length) {
    throw new CliError(`\`dockhand ${command.name}\` uploads with --file <path> (content-type ${contentType})`, {
      exitCode: EXIT.USAGE,
    });
  }
  const first = fileValues[0];
  const path = first.includes('=') ? first.split(/=(.*)/s)[1] : first;
  return { rawBody: readFileSync(resolvePath(path)), headers: { 'content-type': contentType } };
}

function hasPayload(flags) {
  return flags.has('data') || flags.has('data-file') || flags.has('stdin');
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${source} is not valid JSON: ${error.message}`, { exitCode: EXIT.USAGE });
  }
}

function existsSafe(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function emit(result, plan, settings) {
  const outFile = lastFlag(plan.flags, 'out-file');

  if (result.binary) {
    if (outFile) {
      writeFileSync(resolvePath(outFile), result.binary);
      process.stderr.write(`wrote ${result.binary.length} bytes to ${outFile}\n`);
      return;
    }
    if (process.stdout.isTTY) {
      throw new CliError(`response is binary (${result.contentType}); redirect stdout or pass --out-file <path>`, {
        exitCode: EXIT.USAGE,
      });
    }
    process.stdout.write(result.binary);
    return;
  }

  if (outFile) {
    writeFileSync(resolvePath(outFile), result.text ?? '');
    process.stderr.write(`wrote ${result.text.length} bytes to ${outFile}\n`);
    return;
  }

  const fieldsFlag = lastFlag(plan.flags, 'fields');
  const fields = fieldsFlag ? String(fieldsFlag).split(',').map((f) => f.trim()).filter(Boolean) : undefined;
  let output;
  try {
    output = render(result, settings.output, { color: settings.color, fields });
  } catch (error) {
    throw new CliError(error.message, { exitCode: EXIT.USAGE });
  }
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
}

function printDryRun(plan, settings) {
  const url = new URL(plan.path, `${settings.baseUrl}/`);
  for (const [key, value] of Object.entries(plan.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  const lines = [`${plan.method} ${url.toString()}`];
  if (settings.token) lines.push('Authorization: Bearer <redacted>');
  if (settings.cookie) lines.push('Cookie: <redacted>');
  if (plan.body !== undefined) {
    lines.push(`Content-Type: ${plan.contentType ?? 'application/json'}`, '', JSON.stringify(plan.body, null, 2));
  }
  if (plan.rawBody) {
    const kind = plan.rawBody instanceof FormData ? 'multipart/form-data' : (plan.contentType ?? 'binary');
    const size = plan.rawBody instanceof FormData
      ? [...plan.rawBody.entries()].reduce((total, [, value]) => total + (value.size ?? String(value).length), 0)
      : (plan.rawBody.byteLength ?? plan.rawBody.length ?? 0);
    lines.push(`Content-Type: ${kind}`, `<uploaded body: ${size} bytes>`);
  }
  console.log(lines.join('\n'));
}

function lastFlag(flags, name) {
  const values = flags.get(name);
  return values ? values[values.length - 1] : undefined;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}