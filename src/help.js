/**
 * Help rendering for the root command, a group, and a single command.
 * Everything shown here is derived from the generated command table, so help
 * cannot drift from what the CLI actually accepts.
 */

import { DEFAULTS } from './config.js';

let COLOR = false;

/** Colour is off unless the CLI turns it on for a TTY. */
export function setColor(enabled) {
  COLOR = Boolean(enabled);
}

const GLOBAL_FLAG_HELP = [
  ['--base-url <url>', `Dockhand base URL (default ${DEFAULTS.baseUrl}, env DOCKHAND_URL)`],
  ['--token <token>', 'API token sent as `Authorization: Bearer …` (env DOCKHAND_TOKEN)'],
  ['--cookie <value>', 'Session cookie; a bare value is sent as dockhand_session'],
  ['-i, --instance <name>', 'Named instance from the config file: its URL and pre-configured credentials apply'],
  ['-e, --env <id>', 'Shorthand for the `env` query parameter used by most endpoints'],
  ['-o, --output <fmt>', 'json (default) | table | ndjson | raw | auto'],
  ['--timeout <ms>', `Request timeout in milliseconds (default ${DEFAULTS.timeout})`],
  ['--data <json>', 'Request body as a JSON string'],
  ['--data-file <path>', 'Request body read from a file ("-" for stdin)'],
  ['--stdin', 'Read the request body from stdin'],
  ['--file <path>', 'Upload a file (multipart or tar, depending on the endpoint)'],
  ['--form <k=v>', 'Add one multipart form field (repeatable)'],
  ['--public', 'Use the public (unauthenticated) alias of the route when one exists'],
  ['--dry-run', 'Print the request that would be sent and exit'],
  ['--pretty', 'Pretty-print JSON output'],
  ['--verbose', 'Log the HTTP request and response to stderr'],
  ['--quiet', 'Suppress non-essential output'],
  ['--no-color', 'Disable ANSI colour'],
  ['-h, --help', 'Show help for the current command'],
  ['-v, --version', 'Print the CLI and API versions'],
];

export function rootHelp(table) {
  const lines = [];
  lines.push(`${table.cli.name} — command-line client for ${table.api.title} v${table.api.version}`);
  lines.push('');
  lines.push('USAGE');
  lines.push('  dockhand <group> [<action>…] [<arguments>…] [flags]');
  lines.push('');
  lines.push('GROUPS');
  const width = Math.max(...table.groups.map((g) => g.length));
  for (const group of table.groups) {
    lines.push(`  ${group.padEnd(width + 2)}${describeGroup(table, group)}`);
  }
  lines.push('');
  lines.push('EXTRA COMMANDS');
  const extras = table.commands.filter((c) => c.builtin && c.builtin !== 'help' && c.builtin !== 'version');
  // Multi-word builtin names ("config instance list") can run longer than any
  // group, so the column width accounts for them too.
  const extraWidth = Math.max(width, ...extras.map((c) => c.name.length));
  for (const cmd of extras) {
    lines.push(`  ${cmd.name.padEnd(extraWidth + 2)}${cmd.summary}`);
  }
  lines.push('');
  lines.push('GLOBAL FLAGS');
  lines.push(...flagBlock(GLOBAL_FLAG_HELP));
  lines.push('');
  lines.push('ENVIRONMENT');
  lines.push('  DOCKHAND_URL        Base URL of the Dockhand instance');
  lines.push('  DOCKHAND_TOKEN      API token sent as Bearer (store one with `dockhand login --token`)');
  lines.push('  DOCKHAND_INSTANCE   Named instance to use (same as --instance)');
  lines.push('  DOCKHAND_CONFIG     Config file path (default ~/.config/dockhand/config.json)');
  lines.push('  DOCKHAND_OUTPUT     Default output format');
  lines.push('  NO_COLOR            Disable colour');
  lines.push('');
  lines.push('EXAMPLES');
  lines.push('  dockhand login --token dh_xxx                    # long-lived API token (`--token -` reads stdin)');
  lines.push('  dockhand login --username admin --password "$PASS"');
  lines.push('  dockhand login --username admin --password "$PASS" --save-token ci');
  lines.push('  dockhand config instance set prod base-url https://dockhand.example.com');
  lines.push('  dockhand config instance set prod token dh_xxx   # pre-configured credentials');
  lines.push('  dockhand containers list                         # uses the default instance');
  lines.push('  dockhand --instance prod containers list         # or -i prod');
  lines.push('  dockhand environments list');
  lines.push('  dockhand containers list -e 1');
  lines.push('  dockhand containers restart web --env 1');
  lines.push('  dockhand stacks deploy immich --output table');
  lines.push('  dockhand raw GET /api/containers -e 1');
  lines.push('');
  lines.push('Run `dockhand help <group>` or `dockhand help <group> <action>` for details.');
  return lines.join('\n');
}

function describeGroup(table, group) {
  const members = table.commands.filter((c) => c.group === group && !c.builtin);
  const count = `${members.length} command${members.length === 1 ? '' : 's'}`;
  const summary = table.groupDescriptions?.[group] ?? members[0]?.summary ?? '';
  return `${truncate(summary, 96)} ${dim(`(${count})`)}`.trimEnd();
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function groupHelp(table, group) {
  const members = table.commands.filter((c) => c.group === group);
  const lines = [];
  lines.push(`dockhand ${group} — ${table.groupDescriptions?.[group] ?? members[0]?.summary ?? ''}`);
  lines.push('');
  lines.push('COMMANDS');
  const width = Math.max(...members.map((c) => c.name.length));
  for (const cmd of members) {
    const signature = signatureFor(cmd);
    lines.push(`  ${(cmd.name === group ? group : cmd.name).padEnd(width + 2)}${cmd.summary}`);
    if (signature) lines.push(`  ${' '.repeat(width + 2)}${dim(signature)}`);
  }
  lines.push('');
  lines.push(`Run \`dockhand ${group} <command> --help\` for flags and examples.`);
  return lines.join('\n');
}

export function commandHelp(table, cmd) {
  const lines = [];
  lines.push(`dockhand ${cmd.name} — ${cmd.summary}`);
  lines.push('');
  lines.push('USAGE');
  lines.push(`  ${usageFor(cmd)}`);
  if (cmd.aliases?.length) {
    lines.push('');
    lines.push('ALIASES');
    lines.push(`  ${cmd.aliases.join('\n  ')}`);
  }
  if (cmd.args?.length) {
    lines.push('');
    lines.push('ARGUMENTS');
    lines.push(...flagBlock(cmd.args.map((arg) => [
      arg.required ? `<${arg.arg}>` : `[${arg.arg}]`,
      arg.description || arg.name,
    ])));
    if (cmd.variants?.length > 1) {
      lines.push('');
      lines.push('  routes:');
      for (const variant of cmd.variants) {
        const args = variant.args.map((a) => `<${a.arg}>`).join(' ');
        lines.push(`    ${variant.path}${args ? ' ' + args : ''}`);
      }
    }
  }
  if (cmd.query?.length) {
    lines.push('');
    lines.push('QUERY FLAGS');
    lines.push(...flagBlock(cmd.query.map((q) => [
      `--${q.flag} <${q.type}>`,
      [q.description, q.required ? '(required)' : '', q.enum ? `one of: ${q.enum.join(', ')}` : '']
        .filter(Boolean).join(' ') || q.hint,
    ])));
  }
  if (cmd.body) {
    lines.push('');
    lines.push(`BODY${cmd.body.required ? ' (required)' : ''} — ${cmd.body.schemaType}, content-type ${cmd.body.contentType}`);
    if (cmd.body.fields?.length) {
      lines.push(...flagBlock(cmd.body.fields.map((f) => [
        `--${f.flag} <${f.type}>`,
        [f.description, f.required ? '(required)' : '', f.hint !== f.type ? f.hint : '']
          .filter(Boolean).join(' ') || f.hint,
      ])));
    } else {
      lines.push('  (free-form — pass the payload with --data, --data-file or --stdin)');
    }
    if (cmd.body.example !== undefined) {
      lines.push('');
      lines.push('  example:');
      for (const line of JSON.stringify(cmd.body.example, null, 2).split('\n')) {
        lines.push(`    ${line}`);
      }
    }
  }
  if (cmd.hasPublicVariant) {
    lines.push('');
    lines.push('  Add --public to call the unauthenticated alias of this route.');
  }
  const responseCodes = Object.entries(cmd.responses ?? {});
  if (responseCodes.length) {
    lines.push('');
    lines.push('RESPONSES');
    lines.push(...flagBlock(responseCodes.map(([code, info]) => [code, `${info.shape} — ${info.description}`])));
  }
  lines.push('');
  lines.push('GLOBAL FLAGS');
  lines.push(`  run \`dockhand --help\` for the full list; most used: --output, --token, --base-url, --dry-run`);
  return lines.join('\n');
}

export function unknownCommandHelp(table, token) {
  const candidates = table.groups.filter((group) => group.startsWith(token) || token.startsWith(group));
  const lines = [`dockhand: unknown command "${token}"`];
  if (candidates.length) {
    lines.push('');
    lines.push('Did you mean:');
    for (const candidate of candidates.slice(0, 8)) lines.push(`  dockhand ${candidate}`);
  }
  lines.push('');
  lines.push(`Run \`dockhand --help\` for the list of groups.`);
  return lines.join('\n');
}

export function usageFor(cmd) {
  const parts = ['dockhand', cmd.name];
  for (const arg of cmd.args ?? []) parts.push(arg.required ? `<${arg.arg}>` : `[${arg.arg}]`);
  const flags = [...(cmd.query ?? []).map((q) => `--${q.flag}`), ...(cmd.body?.fields ?? []).map((f) => `--${f.flag}`)];
  if (flags.length) parts.push(`[${flags.slice(0, 6).join('] [')}${flags.length > 6 ? ' …' : ''}]`);
  return parts.join(' ');
}

function signatureFor(cmd) {
  const method = cmd.method ? `${cmd.method} ` : '';
  const args = (cmd.variants ?? []).map((v) => (v.args ?? []).map((a) => `<${a.arg}>`).join(' ')).join(' | ');
  return `${method}${(cmd.paths ?? []).join(' | ')}${args ? ` ${args}` : ''}`;
}

function flagBlock(rows) {
  if (!rows.length) return [];
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right ?? ''}`.trimEnd());
}

function dim(text) {
  return COLOR ? `\x1b[2m${text}\x1b[0m` : text;
}