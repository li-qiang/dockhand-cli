#!/usr/bin/env node
/**
 * Dockhand CLI code generator.
 *
 * Reads the OpenAPI document (api/openapi.json by default, or straight from a
 * live server with `--fetch`) and emits src/commands.generated.json — the
 * command table the CLI dispatches on. Nothing here runs at request time, so
 * the CLI stays a thin, dependency-free shell around the generated data.
 *
 * Command naming rules (also documented in AGENTS.md):
 *   1. `/api` is stripped; the first remaining segment becomes the group.
 *   2. The remaining static segments become the action tokens, verbatim.
 *   3. `{placeholders}` become positional arguments, in path order.
 *   4. A method token (list/create/get/update/delete) is appended when a node
 *      would otherwise be ambiguous: several methods, several shapes, or
 *      sub-resources hanging off it.
 *   5. Operations that only differ in trailing path parameters collapse into a
 *      single command whose extra arguments are optional
 *      (`environments notifications <id> [notification-id]`).
 *
 * Usage:
 *   node scripts/generate.mjs                    # regenerate from api/openapi.json
 *   node scripts/generate.mjs --fetch            # re-download the spec, then generate
 *   node scripts/generate.mjs --fetch http://host:3000/openapi.json
 *   node scripts/generate.mjs --out other.json   # write somewhere else
 *   node scripts/generate.mjs --print            # dump the command table to stdout
 *   node scripts/generate.mjs --stats            # print generation statistics
 *   node scripts/generate.mjs --check            # fail if the committed table is stale
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
let SPEC_PATH = resolve(ROOT, 'api/openapi.json');
let OUT_PATH = resolve(ROOT, 'src/commands.generated.json');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Global flags the CLI owns; a spec field may never shadow one. */
const GLOBAL_FLAGS = new Set([
  'base-url', 'url', 'token', 'cookie', 'instance', 'i', 'output', 'o', 'verbose', 'quiet',
  'timeout', 'no-color', 'pretty', 'help', 'version', 'data', 'data-file',
  'stdin', 'form', 'file', 'raw', 'dry-run', 'public', 'api', 'method',
]);

/** Friendly shorthands for groups people type every day. */
const GROUP_ALIASES = {
  ctr: 'containers', container: 'containers',
  img: 'images', image: 'images',
  env: 'environments', environment: 'environments',
  net: 'networks', network: 'networks',
  vol: 'volumes', volume: 'volumes',
  stack: 'stacks', cfg: 'config-sets', conf: 'config-sets',
  reg: 'registries', registry: 'registries',
  sched: 'schedules', schedule: 'schedules',
  notif: 'notifications', notification: 'notifications',
  secret: 'secret-providers', prov: 'secret-providers',
  backups: 'backup', backup: 'backup', snap: 'backup',
  act: 'activity', evt: 'events', job: 'jobs',
  host: 'host', image2: 'images',
};

/** Spellings people reach for when a verb reads badly as a bare noun. */
const ACTION_ALIASES = {
  ls: 'list', new: 'create', add: 'create', rm: 'delete', del: 'delete',
  remove: 'delete', edit: 'update', describe: 'get', show: 'get',
  inspect: 'get', info: 'get', ps: 'list', set: 'update',
};

/** Inverted, so `containers list` also answers to `containers ls`. */
const CANONICAL_ALIASES = Object.entries(ACTION_ALIASES).reduce((acc, [alias, canonical]) => {
  (acc[canonical] ??= []).push(alias);
  return acc;
}, {});

// ---------------------------------------------------------------------------
// argument handling
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
let fetchUrl = null;
let printOnly = false;
let statsOnly = false;
let checkOnly = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--fetch') {
    // The CLI ships without a hard-coded host: take the instance from
    // DOCKHAND_URL, or make the caller pass one explicitly.
    fetchUrl = argv[++i] ?? process.env.DOCKHAND_URL;
    if (!fetchUrl) {
      console.error('--fetch needs a URL, e.g. --fetch https://dockhand.example.com/openapi.json');
      process.exit(2);
    }
    if (!/^https?:\/\//.test(fetchUrl)) fetchUrl = `https://${fetchUrl}/openapi.json`;
  } else if (a === '--out') {
    OUT_PATH = resolve(process.cwd(), argv[++i]);
  } else if (a === '--spec') {
    SPEC_PATH = resolve(process.cwd(), argv[++i]);
  } else if (a === '--print') {
    printOnly = true;
  } else if (a === '--stats') {
    statsOnly = true;
  } else if (a === '--check') {
    checkOnly = true;
  } else if (a === '--help' || a === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  } else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const clamp = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

function kebab(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_.]+/g, '-')
    .toLowerCase();
}

/** `containerName` inside the `containers` group is just `name` to the user. */
function shortenParam(paramName, group) {
  const camelGroup = group.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  const singular = camelGroup.replace(/s$/, '');
  const camel = paramName.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (camel !== singular && camel.startsWith(singular) && camel.length > singular.length) {
    const tail = camel.slice(singular.length);
    if (/^[A-Z]/.test(tail)) return kebab(tail);
  }
  return kebab(paramName);
}

function schemaOf(param) {
  if (!param) return { type: 'string' };
  if (param.schema) return param.schema;
  if (param.content) {
    const first = Object.values(param.content)[0];
    if (first?.schema) return first.schema;
  }
  return { type: 'string' };
}

function describeSchema(schema) {
  const s = schema || {};
  if (Array.isArray(s.enum) && s.enum.length) {
    return `one of: ${s.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  if (s.type === 'array') {
    const items = s.items?.type ? `${s.items.type}[]` : 'array';
    return s.description ? `${items} — ${s.description}` : items;
  }
  if (s.type === 'object' && (s.properties || s.additionalProperties)) return 'object — pass with --data';
  return s.type ? String(s.type) : 'string';
}

function firstContent(requestBody) {
  if (!requestBody) return null;
  const entries = Object.entries(requestBody.content || {});
  if (entries.length === 0) return null;
  const [contentType, media] = entries[0];
  return { contentType, media };
}

function queryParams(op) {
  return (op.parameters || [])
    .filter((p) => p.in === 'query')
    .map((p) => {
      const s = schemaOf(p);
      const type = Array.isArray(s.type) ? String(s.type[0]) : String(s.type || 'string');
      return {
        name: p.name,
        flag: kebab(p.name),
        type,
        required: Boolean(p.required),
        description: clamp(p.description || s.description, 400),
        hint: describeSchema(s),
        enum: Array.isArray(s.enum) ? s.enum : undefined,
      };
    });
}

function bodyFields(requestBody) {
  const content = firstContent(requestBody);
  if (!content) return null;
  const { contentType, media } = content;
  const schema = media.schema || {};
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const fields = Object.entries(properties).map(([name, prop]) => {
    const type = Array.isArray(prop.type) ? String(prop.type[0]) : String(prop.type || 'string');
    return {
      name,
      flag: kebab(name),
      type,
      required: required.has(name),
      description: clamp(prop.description, 400),
      hint: describeSchema(prop),
      enum: Array.isArray(prop.enum) ? prop.enum : undefined,
    };
  });
  return {
    required: Boolean(requestBody.required),
    contentType,
    schemaType: schema.type || 'object',
    fields,
    example: media.example,
  };
}

function pathParams(op, template, group) {
  const declared = new Map(
    (op.parameters || []).filter((p) => p.in === 'path').map((p) => [p.name, p]),
  );
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => {
    const name = m[1];
    const declared_ = declared.get(name);
    return {
      name,
      arg: kebab(name),
      short: shortenParam(name, group),
      description: clamp(declared_?.description, 300),
    };
  });
}

function responseSummary(op) {
  const out = {};
  for (const [code, res] of Object.entries(op.responses || {})) {
    const schema = res.content?.['application/json']?.schema;
    const shape = !schema
      ? 'empty'
      : schema.type === 'array'
        ? 'array'
        : schema.type === 'object'
          ? 'object'
          : String(schema.type ?? 'json');
    out[code] = { description: clamp(res.description, 240), shape };
  }
  return out;
}

/**
 * Heuristic, documentation-only: the runtime decides by response content type.
 * Binary downloads and Accept-negotiated endpoints are deliberately excluded.
 */
function isSseOperation(urlPath, summary = '') {
  if (/Accept application\/json/.test(summary)) return false;
  if (/\/(export|download|dump|diff|icon)$/.test(urlPath)) return false;
  return /\/(stream|events)$/.test(urlPath) || /Server-Sent Events|\bSSE\b/i.test(summary);
}

/** A GET whose 200 payload is an array deserves the `list` verb. */
function returnsCollection(op) {
  const ok = op.responses?.['200'] ?? op.responses?.['201'];
  return ok?.content?.['application/json']?.schema?.type === 'array';
}

function defaultVerb(method, params, isCollection) {
  const m = String(method).toLowerCase();
  if (m === 'get') return params.length === 0 && isCollection ? 'list' : 'get';
  if (m === 'post') return 'create';
  if (m === 'put' || m === 'patch') return 'update';
  if (m === 'delete') return 'delete';
  if (m === 'head') return 'head';
  return 'options';
}

// ---------------------------------------------------------------------------
// load the spec
// ---------------------------------------------------------------------------

async function loadSpec() {
  if (!fetchUrl) {
    if (!existsSync(SPEC_PATH)) {
      console.error(`no local spec at ${SPEC_PATH}\n`
        + '  fetch one from an instance instead:\n'
        + '    node scripts/generate.mjs --fetch https://<your-dockhand>/openapi.json');
      process.exit(2);
    }
    return JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
  }
  const res = await fetch(fetchUrl);
  if (!res.ok) {
    console.error(`failed to download spec: ${res.status} ${res.statusText} (${fetchUrl})`);
    process.exit(1);
  }
  const spec = await res.json();
  writeFileSync(SPEC_PATH, `${JSON.stringify(spec, null, 2)}\n`);
  console.error(`spec saved to ${SPEC_PATH}`);
  return spec;
}

const spec = await loadSpec();
const tagDescriptions = new Map((spec.tags || []).map((t) => [t.name, t.description || '']));

// ---------------------------------------------------------------------------
// collect operations
// ---------------------------------------------------------------------------

/** nodeKey -> operations sharing group + static tokens */
const nodes = new Map();

for (const [urlPath, item] of Object.entries(spec.paths || {})) {
  const isPublic = !urlPath.startsWith('/api');
  const stripped = urlPath.replace(/^\/api/, '') || '/';
  const segments = stripped.split('/').filter(Boolean);
  const group = kebab(segments[0] ?? 'root');
  const statics = segments.slice(1).filter((s) => !s.startsWith('{')).map(kebab);

  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;

    const params = pathParams(op, stripped, group);
    const node = {
      key: [group, ...statics].join('/'),
      group,
      statics,
      method: method.toUpperCase(),
      params,
      path: isPublic ? stripped : `/api${stripped}`,
      public: isPublic,
      summary: clamp(op.summary || op.description || '', 320),
      operationId: op.operationId || '',
      tags: (op.tags || []).map(kebab),
      tagDescription: clamp(tagDescriptions.get(op.tags?.[0]) || '', 240),
      security: op.security === undefined ? null : (op.security || []),
      deprecated: Boolean(op.deprecated),
      query: queryParams(op),
      body: bodyFields(op.requestBody),
      responses: responseSummary(op),
      isCollection: returnsCollection(op),
      // Server-Sent Events endpoints are piped instead of buffered; the runtime
      // still decides by content type, this flag is for documentation and help.
      stream: isSseOperation(urlPath, op.summary),
    };
    if (!nodes.has(node.key)) nodes.set(node.key, []);
    nodes.get(node.key).push(node);
  }
}

const childKeys = new Set();
for (const key of nodes.keys()) {
  const idx = key.lastIndexOf('/');
  if (idx > 0) childKeys.add(key.slice(0, idx));
}

const isPrefix = (base, full) =>
  base.length <= full.length && base.every((p, i) => full[i] === p);

/**
 * Collapse operations that differ only in trailing path parameters into one
 * command with optional trailing arguments. Collection `list` operations stay
 * on their own so `containers list` never becomes `containers get <id>`.
 */
function clusterOperations(ops) {
  const zeroArg = [];
  const rest = [];
  const hasMemberGet = ops.some((o) => o.method === 'GET' && o.params.length > 0);
  for (const op of ops) {
    // A collection GET keeps its own command even when a member GET sits at the
    // same node, so `stacks list` never becomes `stacks get <id>`.
    const standalone = op.method === 'GET' && op.params.length === 0;
    if (standalone) op.pairedWithMember = hasMemberGet;
    (standalone ? zeroArg : rest).push(op);
  }

  const bySig = new Map();
  for (const op of rest) {
    const sig = op.params.map((p) => p.name).join(',');
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(op);
  }

  const sigs = [...bySig.keys()].sort(
    (a, b) => a.split(',').length - b.split(',').length || a.localeCompare(b),
  );

  // Two 0-arg GETs with the same shape (e.g. /api/audit/users and its public
  // /audit/users alias) are one command with two transports.
  const listGroups = new Map();
  for (const op of zeroArg) {
    if (!listGroups.has(op.params.map((p) => p.name).join(','))) listGroups.set(op.params.map((p) => p.name).join(','), []);
    listGroups.get(op.params.map((p) => p.name).join(',')).push(op);
  }
  const clusters = [...listGroups.values()].map((group_) => ({
    base: [],
    signatures: [[]],
    ops: group_,
  }));

  const consumed = new Set();
  for (const sig of sigs) {
    if (consumed.has(sig)) continue;
    const base = sig === '' ? [] : sig.split(',');
    const family = sigs.filter((s) => {
      if (s === '') return base.length === 0;
      return isPrefix(base, s.split(','));
    });
    for (const f of family) consumed.add(f);
    const ordered = [sig, ...family.filter((f) => f !== sig)];
    clusters.push({
      base,
      signatures: ordered.map((s) => (s === '' ? [] : s.split(','))),
      ops: ordered.flatMap((s) => bySig.get(s)),
    });
  }

  return clusters;
}

/** Operations sharing a signature but exposed on both /api and a public alias. */
function transportsOf(ops) {
  const ordered = [...ops].sort((a, b) => Number(a.public) - Number(b.public));
  return ordered.map((o) => ({ path: o.path, public: o.public }));
}

// ---------------------------------------------------------------------------
// build commands
// ---------------------------------------------------------------------------

const commands = [];
const collisions = [];
let disambiguationCounter = 0;

for (const [key, ops] of nodes) {
  const group = ops[0].group;
  const statics = ops[0].statics;
  const hasChildren = childKeys.has(key);

  const byMethod = new Map();
  for (const op of ops) {
    if (!byMethod.has(op.method)) byMethod.set(op.method, []);
    byMethod.get(op.method).push(op);
  }

  // One entry per (method, parameter shape) that survives clustering.
  const entries = [];
  for (const [method, methodOps] of byMethod) {
    for (const cluster of clusterOperations(methodOps)) {
      const primary = cluster.ops.find((o) => !o.public) ?? cluster.ops[0];
      const widest = cluster.signatures.reduce((a, b) => (b.length > a.length ? b : a), cluster.base);
      entries.push({
        method,
        cluster,
        primary,
        verb: defaultVerb(method, widest, primary.isCollection || primary.pairedWithMember),
      });
    }
  }

  const needsMethodToken = byMethod.size > 1 || entries.length > 1 || hasChildren;
  for (const entry of entries) {
    commands.push({ group, statics, needsMethodToken, key, ...entry });
  }

  // Disambiguate verbs that collide inside one node: `get-by-id` / `get-by-name`.
  const byVerb = new Map();
  for (const entry of commands) {
    if (entry.key !== key) continue;
    if (!byVerb.has(entry.verb)) byVerb.set(entry.verb, []);
    byVerb.get(entry.verb).push(entry);
  }
  for (const [verb, siblings] of byVerb) {
    if (siblings.length < 2) continue;
    collisions.push(`${siblings.map((e) => e.primary.path).join('  vs  ')} → ${verb}`);
    for (const entry of siblings) {
      const widest = entry.cluster.signatures.reduce((a, b) => (b.length > a.length ? b : a), []);
      const last = widest[widest.length - 1];
      entry.verb = last ? `${verb}-by-${last.short}` : `${verb}-by-path-${++disambiguationCounter}`;
    }
  }
}

const finalCommands = commands.map((entry) => {
  const { group, statics, method, verb, needsMethodToken, cluster, primary } = entry;
  const tokens = needsMethodToken ? [...statics, verb] : [...statics];
  const name = [group, ...tokens].join(' ');

  const widestSig = cluster.signatures.reduce((a, b) => (b.length > a.length ? b : a), cluster.base);
  const argDefs = widestSig.map((p) => {
    const declared = cluster.ops
      .flatMap((o) => o.params)
      .find((x) => x.name === p);
    return {
      name: p,
      arg: declared?.arg ?? kebab(p),
      required: cluster.base.includes(p),
      description: declared?.description ?? '',
    };
  });

  const variants = cluster.signatures
    .map((sig) => {
      const ops = cluster.ops.filter(
        (o) => o.params.map((x) => x.name).join(',') === sig.join(','),
      );
      const lead = ops.find((o) => !o.public) ?? ops[0];
      return {
        args: argDefs.filter((a) => sig.includes(a.name)),
        paths: transportsOf(ops),
        path: lead.path,
        query: lead.query,
        body: lead.body,
        summary: lead.summary,
        responses: lead.responses,
        deprecated: lead.deprecated,
      };
    })
    .sort((a, b) => a.args.length - b.args.length);

  const seenQuery = new Set();
  const queryUnion = [];
  for (const v of variants) {
    for (const q of v.query) {
      const k = `${q.name}:${q.flag}`;
      if (seenQuery.has(k)) continue;
      seenQuery.add(k);
      queryUnion.push({ ...q, shared: variants.every((x) => x.query.some((y) => y.name === q.name)) });
    }
  }

  const seenField = new Set();
  const fieldUnion = [];
  for (const v of variants) {
    for (const f of v.body?.fields ?? []) {
      const k = `${f.name}:${f.flag}`;
      if (seenField.has(k)) continue;
      seenField.add(k);
      fieldUnion.push({ ...f, shared: variants.every((x) => (x.body?.fields ?? []).some((y) => y.name === f.name)) });
    }
  }

  const method_ = method; // eslint-disable-line no-unused-vars -- kept for readability
  const taken = new Set([...GLOBAL_FLAGS]);
  const query = queryUnion.map((q) => {
    const clash = taken.has(q.flag);
    const flag = clash ? `query-${q.flag}` : q.flag;
    taken.add(flag);
    return { ...q, flag };
  });
  const body = variants.some((v) => v.body)
    ? {
      required: variants.every((v) => v.body?.required),
      contentType: variants.find((v) => v.body)?.body.contentType,
      schemaType: variants.find((v) => v.body)?.body.schemaType,
      example: variants.find((v) => v.body?.example)?.body.example,
      fields: fieldUnion.map((f) => {
        const clash = taken.has(f.flag);
        const flag = clash ? `body-${f.flag}` : f.flag;
        taken.add(flag);
        return { ...f, flag };
      }),
    }
    : null;

  const hasPublicVariant = variants.some((v) => v.paths.some((p) => p.public));
  const transports = [...new Set(variants.flatMap((v) => v.paths.map((p) => p.path)))];

  return {
    name,
    group,
    tokens,
    verb,
    method: method_,
    args: argDefs,
    arities: variants.map((v) => v.args.length),
    paths: transports,
    summary: primary.summary,
    operationId: primary.operationId,
    tags: primary.tags,
    tagDescription: primary.tagDescription,
    security: primary.security,
    public: primary.public,
    hasPublicVariant,
    deprecated: primary.deprecated,
    query,
    body,
    // Only what differs per arity is stored here; the union above is the
    // single source of truth for flags, which keeps the table small.
    // Any operation in the family that streams makes the whole command stream.
    stream: cluster.ops.some((o) => o.stream),
    variants: variants.map((v) => ({
      args: v.args,
      path: v.path,
      paths: v.paths,
      summary: v.summary,
      responses: v.responses,
      requiredQuery: v.query.filter((q) => q.required).map((q) => q.flag),
      requiredFields: (v.body?.fields ?? []).filter((f) => f.required).map((f) => f.flag),
      contentType: v.body?.contentType,
      schemaType: v.body?.schemaType,
      example: v.body?.example,
      deprecated: v.deprecated,
    })),
  };
});

// Integrity check: a duplicate name would make one command unreachable.
const seen = new Map();
for (const c of finalCommands) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
const dupes = [...seen].filter(([, n]) => n > 1);
if (dupes.length) {
  console.error('ERROR: duplicate command names produced by the generator:');
  for (const [name] of dupes) {
    console.error(`  ${name}`);
    for (const c of finalCommands.filter((x) => x.name === name)) {
      console.error(`      ${c.method} ${c.paths.join(', ')} — ${c.summary}`);
    }
  }
  process.exit(1);
}

finalCommands.sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------
// aliases
// ---------------------------------------------------------------------------

const realGroups = [...new Set(finalCommands.map((c) => c.group))].sort();

function aliasesFor(cmd) {
  const out = new Set();
  const words = cmd.name.split(' ');
  if (words.length > 1) {
    for (let i = 1; i < words.length; i++) {
      for (const alias of CANONICAL_ALIASES[words[i]] ?? []) {
        out.add([...words.slice(0, i), alias].join(' '));
      }
    }
    // `x list` and `x get` read equally well on a collection endpoint.
    const last = words[words.length - 1];
    if ((last === 'list' || last === 'get') && cmd.variants?.some((v) => v.args.length === 0)) {
      out.add([...words.slice(0, -1), last === 'list' ? 'get' : 'list'].join(' '));
    }
  }
  return [...out].filter((a) => a !== cmd.name);
}

for (const cmd of finalCommands) cmd.aliases = aliasesFor(cmd);

const groupAliases = Object.fromEntries(
  Object.entries(GROUP_ALIASES).filter(([, target]) => realGroups.includes(target)),
);

// One line per group for the top-level help. The shortest command name in the
// group is usually the group's headline operation (`containers list`).
const groupDescriptions = Object.fromEntries(
  realGroups.map((group) => {
    const members = finalCommands.filter((c) => c.group === group);
    const headline = [...members].sort(
      (a, b) =>
        Number(b.verb === 'list') - Number(a.verb === 'list')
        || a.name.length - b.name.length
        || a.name.localeCompare(b.name),
    )[0];
    return [group, headline?.summary ?? ''];
  }),
);

// ---------------------------------------------------------------------------
// hand-written commands
// ---------------------------------------------------------------------------

const meta = (name, tokens, method, summary, builtin, args = []) => ({
  name,
  group: '_meta',
  tokens,
  verb: null,
  method,
  args,
  paths: [],
  summary,
  builtin,
  query: [],
  body: null,
  aliases: [],
});

const builtinCommands = [
  meta('raw', ['raw'], null, 'Call any Dockhand API path directly — the escape hatch for routes the generator has not seen', 'raw'),
  meta('help', ['help'], null, 'Show help for the CLI, for a group, or for a single command', 'help'),
  meta('version', ['version'], null, 'Print the CLI version and the API version the command table was generated from', 'version'),
  meta('login', ['login'], 'POST', 'Authenticate and store a session cookie or API token in the config file', 'login'),
  meta('logout', ['logout'], 'POST', 'Drop the stored session cookie and API token', 'logout'),
  meta('config show', ['config'], null, 'Show the resolved configuration with secrets redacted', 'config.show'),
  meta('config path', ['config'], null, 'Print the config file path', 'config.path'),
  meta('config set', ['config'], null, 'Set a config value (--base-url, --token, --cookie)', 'config.set'),
  meta('config unset', ['config'], null, 'Remove a config value', 'config.unset'),
  meta('config instance list', ['config'], null, 'List the named instances configured in the config file (secrets redacted)', 'config.instance.list'),
  meta('config instance set', ['config'], null, 'Configure a named instance: base-url, token or cookie — then select it with --instance <name>', 'config.instance.set', [
    { name: 'name', arg: 'name', required: true, description: 'Instance name to select with --instance' },
    { name: 'key', arg: 'key', required: true, description: 'base-url | token | cookie' },
    { name: 'value', arg: 'value', required: true, description: 'Value to store' },
  ]),
  meta('config instance show', ['config'], null, 'Show one named instance with secrets redacted', 'config.instance.show', [
    { name: 'name', arg: 'name', required: true, description: 'Instance name' },
  ]),
  meta('config instance remove', ['config'], null, 'Remove a named instance from the config file', 'config.instance.remove', [
    { name: 'name', arg: 'name', required: true, description: 'Instance name' },
  ]),
  meta('completion', ['completion'], null, 'Print a shell completion script (bash, zsh or fish)', 'completion', [{ name: 'shell', arg: 'shell', required: false, description: 'bash | zsh | fish' }]),
  meta('spec path', ['spec'], null, 'Print the path of the bundled OpenAPI document', 'spec.path'),
  meta('spec commands', ['spec'], null, 'Dump the whole generated command table as JSON (handy for agents)', 'spec.commands'),
  meta('skill', ['skill'], null, 'Print the packaged agent skill (SKILL.md) so it can be installed into a skills directory', 'skill'),
  meta('generate', ['generate'], null, 'Regenerate the command table from an instance: `dockhand generate --fetch <url>`', 'generate'),
];

const output = {
  $generated: 'DO NOT EDIT — regenerate with `npm run generate` (scripts/generate.mjs).',
  cli: {
    name: 'dockhand',
    // The CLI's own version comes from package.json; the runtime reads it from
    // there directly, so this field is informational only.
    version: pkg.version,
    apiTitle: spec.info?.title ?? 'Dockhand API',
    apiVersion: spec.info?.version ?? '0.0.0',
    // Never record the machine the spec came from: only the bundled snapshot.
    specSource: 'api/openapi.json',
    openApiPath: '/openapi.json',
  },
  api: {
    title: spec.info?.title ?? 'Dockhand API',
    version: spec.info?.version ?? '0.0.0',
    description: clamp(spec.info?.description, 600),
  },
  securitySchemes: spec.components?.securitySchemes ?? {},
  groups: realGroups,
  groupAliases,
  groupDescriptions,
  commands: [...builtinCommands, ...finalCommands].sort((a, b) => a.name.localeCompare(b.name)),
};

if (statsOnly) {
  const withBody = finalCommands.filter((c) => c.body).length;
  const withQuery = finalCommands.filter((c) => c.query.length).length;
  const withArgs = finalCommands.filter((c) => c.args.length).length;
  const multiVariant = finalCommands.filter((c) => c.variants.length > 1).length;
  console.error(
    `groups=${realGroups.length} commands=${finalCommands.length} ` +
    `builtin=${builtinCommands.length} withBody=${withBody} withQuery=${withQuery} ` +
    `withArgs=${withArgs} multiVariant=${multiVariant} disambiguations=${collisions.length}`,
  );
  if (collisions.length) console.error(`  disambiguated: ${collisions.join('; ')}`);
  process.exit(0);
}

if (printOnly) {
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

const serialized = `${JSON.stringify(output, null, 2)}\n`;

// `--check` is what `npm run verify` (and prepublishOnly) uses to prove the
// committed command table still matches api/openapi.json.
if (checkOnly) {
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : '';
  // cli.version follows package.json, not the spec, so a version bump between
  // `generate` and `--check` is not spec drift. Everything else must match.
  const comparable = (text) => {
    try {
      const table = JSON.parse(text);
      if (table.cli) delete table.cli.version;
      return JSON.stringify(table);
    } catch {
      return text;
    }
  };
  if (current && comparable(current) === comparable(serialized)) {
    console.error(`ok: ${OUT_PATH} is up to date with ${SPEC_PATH}`);
    process.exit(0);
  }
  console.error(`out of date: ${OUT_PATH} does not match ${SPEC_PATH}`);
  if (!current) console.error('  (file is missing — run `npm run generate`)');
  else console.error(`  run \`npm run generate\` and commit the result`);
  process.exit(1);
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, serialized);
console.error(
  `wrote ${OUT_PATH}\n` +
  `  api        ${output.api.title} v${output.api.version}\n` +
  `  groups     ${realGroups.length}\n` +
  `  commands   ${finalCommands.length} generated + ${builtinCommands.length} builtin`,
);